import {
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  formatTextWithAttachmentLinks,
  readJsonBodyWithLimit,
  registerPluginHttpRoute,
  resolveOutboundMediaUrls,
} from "openclaw/plugin-sdk";
import type {
  ChannelOutboundContext,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  OutboundDeliveryResult,
  PluginRuntime,
} from "openclaw/plugin-sdk";

const CHANNEL_ID = "vocechat";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_PRIVATE_PATH_TEMPLATE = "/api/bot/send_to_user/{id}";
const DEFAULT_GROUP_PATH_TEMPLATE = "/api/bot/send_to_group/{id}";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_WEBHOOK_PATH = "/vocechat/webhook";
const DEFAULT_INBOUND_ACK_TEXT = "已收到，正在处理中...";
const DEFAULT_INBOUND_BLOCKED_TYPES = ["system", "event", "notice", "typing", "status", "reaction", "like"];
const RECENT_MESSAGE_TTL_MS = 15 * 60 * 1000;

type InboundParseMode = "legacy" | "balanced" | "strict";

type VoceChatAccountConfig = {
  enabled?: boolean;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  privatePathTemplate?: string;
  groupPathTemplate?: string;
  ackReaction?: string;
  defaultTo?: string;
  timeoutMs?: number;
  inboundEnabled?: boolean;
  inboundAckEnabled?: boolean;
  inboundAckText?: string;
  inboundParseMode?: InboundParseMode;
  inboundBlockedTypes?: unknown;
  inboundMinTextLength?: number;
  inboundMaxTextLength?: number;
  inboundAllowTypelessText?: boolean;
  inboundParseDebug?: boolean;
  webhookPath?: string;
  webhookApiKey?: string;
  allowFrom?: unknown;
  groupAllowFrom?: unknown;
};

type VoceChatChannelConfig = VoceChatAccountConfig & {
  accounts?: Record<string, VoceChatAccountConfig>;
};

type ResolvedAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  apiKey: string;
  privatePathTemplate: string;
  groupPathTemplate: string;
  defaultTo?: string;
  timeoutMs: number;
  inboundEnabled: boolean;
  inboundAckEnabled: boolean;
  inboundAckText: string;
  inboundParseMode: InboundParseMode;
  inboundBlockedTypes: string[];
  inboundMinTextLength: number;
  inboundMaxTextLength: number;
  inboundAllowTypelessText: boolean;
  inboundParseDebug: boolean;
  webhookPath: string;
  webhookApiKey?: string;
  allowFrom: string[];
  groupAllowFrom: string[];
};

type TargetKind = "user" | "group";
type ParsedTarget = {
  kind: TargetKind;
  id: string;
};

type InboundEvent = {
  messageId: string;
  fromUid: string;
  chatType: "direct" | "group";
  conversationId: string;
  groupId?: string;
  text: string;
  timestamp: number;
  replyTarget: string;
};

let runtimeRef: PluginRuntime | null = null;
const activeRouteUnregisters = new Map<string, () => void>();
const recentOutboundMessageIds = new Map<string, number>();
const recentInboundMessageIds = new Map<string, number>();

function setVoceChatRuntime(runtime: PluginRuntime): void {
  runtimeRef = runtime;
}

function getVoceChatRuntime(): PluginRuntime {
  if (!runtimeRef) throw new Error("vocechat runtime not initialized");
  return runtimeRef;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "bigint") return value.toString();
  return normalizeString(value);
}

function parseTimestampMs(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  if (raw < 10_000_000_000) return Math.trunc(raw * 1000);
  return Math.trunc(raw);
}

function firstNonEmptyString(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized) return normalized;
  }
  return "";
}

function firstNonEmptyId(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const parsed = parseId(candidate);
    if (parsed) return parsed;
  }
  return "";
}

function clipAuditSegment(value: unknown, max = 120): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "-";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function normalizeInboundType(value: unknown): string {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return "";
  return normalized.replace(/\s+/g, "").replace(/-/g, "_");
}

function isSupportedInboundTextType(typeValue: unknown): boolean {
  const normalizedType = normalizeInboundType(typeValue);
  if (!normalizedType) return true;

  const supportedTypes = new Set([
    "normal",
    "reply",
    "text",
    "text_message",
    "plain_message",
    "plain",
    "plaintext",
    "markdown",
    "md",
    "message_text",
  ]);

  return supportedTypes.has(normalizedType) || normalizedType.startsWith("text/");
}

function summarizeInboundPayloadForAudit(raw: unknown, accountId: string): string {
  const payload = asRecord(raw);
  const detail = asRecord(payload.detail);
  const typeValues = [detail.type, detail.message_type, payload.type, payload.message_type]
    .map((value) => normalizeString(value))
    .filter(Boolean);
  const uniqueTypes = Array.from(new Set(typeValues));

  const textCandidates = [detail.content, detail.text, payload.content, payload.text, detail.preview, payload.preview];
  const hasTextField = textCandidates.some((value) => value !== undefined && value !== null);

  const topKeys = Object.keys(payload).join(",");
  const detailKeys = Object.keys(detail).join(",");

  return [
    `account=${clipAuditSegment(accountId)}`,
    `types=${clipAuditSegment(uniqueTypes.join("|"))}`,
    `hasTextField=${hasTextField ? "yes" : "no"}`,
    `topKeys=${clipAuditSegment(topKeys)}`,
    `detailKeys=${clipAuditSegment(detailKeys)}`,
  ].join(" ");
}

function normalizeAccountId(input?: string | null): string {
  const raw = normalizeString(input);
  return raw || DEFAULT_ACCOUNT_ID;
}

function sanitizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/g, "");
}

function parseTimeoutMs(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 1000) return DEFAULT_TIMEOUT_MS;
  return Math.floor(Math.min(120000, numeric));
}

function parseAllowEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseId(entry))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const raw = normalizeString(value);
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseInboundParseMode(value: unknown): InboundParseMode {
  const raw = normalizeString(value).toLowerCase();
  if (raw === "legacy" || raw === "strict") return raw;
  return "balanced";
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < min || n > max) return fallback;
  return n;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseInboundTypeEntries(value: unknown): string[] {
  const entries = parseAllowEntries(value).map((entry) => normalizeInboundType(entry)).filter(Boolean);
  return Array.from(new Set(entries));
}

function normalizeInboundText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeWebhookPath(value: unknown): string {
  const raw = normalizeString(value);
  if (!raw) return DEFAULT_WEBHOOK_PATH;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function nowMs(): number {
  return Date.now();
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function makeMessageKey(accountId: string, messageId: string): string {
  return `${accountId}:${messageId}`;
}

function cleanupRecentMessageCache(cache: Map<string, number>): void {
  const cutoff = nowMs() - RECENT_MESSAGE_TTL_MS;
  for (const [key, ts] of cache.entries()) {
    if (ts < cutoff) cache.delete(key);
  }
}

function rememberRecentMessage(cache: Map<string, number>, key: string): void {
  cleanupRecentMessageCache(cache);
  cache.set(key, nowMs());
}

function hasRecentMessage(cache: Map<string, number>, key: string): boolean {
  cleanupRecentMessageCache(cache);
  const seenAt = cache.get(key);
  if (!seenAt) return false;
  return nowMs() - seenAt <= RECENT_MESSAGE_TTL_MS;
}

function getChannelConfig(cfg: OpenClawConfig): VoceChatChannelConfig {
  return asRecord(cfg.channels?.[CHANNEL_ID]) as VoceChatChannelConfig;
}

function listVoceChatAccountIds(cfg: OpenClawConfig): string[] {
  const section = getChannelConfig(cfg);
  const accounts = asRecord(section.accounts);
  const ids = Object.keys(accounts).map((id) => normalizeAccountId(id));
  if (!ids.includes(DEFAULT_ACCOUNT_ID)) ids.unshift(DEFAULT_ACCOUNT_ID);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

function resolveVoceChatAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  const resolvedAccountId = normalizeAccountId(accountId);
  const section = getChannelConfig(cfg);
  const accounts = asRecord(section.accounts);
  const account = asRecord(accounts[resolvedAccountId]);

  const { accounts: _ignored, ...baseConfig } = section;
  const merged = {
    ...asRecord(baseConfig),
    ...account,
  };

  const baseEnabled = section.enabled !== false;
  const accountEnabled = merged.enabled !== false;

  return {
    accountId: resolvedAccountId,
    enabled: baseEnabled && accountEnabled,
    name: normalizeString(merged.name) || undefined,
    baseUrl: sanitizeBaseUrl(normalizeString(merged.baseUrl)),
    apiKey: normalizeString(merged.apiKey),
    privatePathTemplate: normalizeString(merged.privatePathTemplate) || DEFAULT_PRIVATE_PATH_TEMPLATE,
    groupPathTemplate: normalizeString(merged.groupPathTemplate) || DEFAULT_GROUP_PATH_TEMPLATE,
    defaultTo: normalizeString(merged.defaultTo) || undefined,
    timeoutMs: parseTimeoutMs(merged.timeoutMs),
    inboundEnabled: merged.inboundEnabled !== false,
    inboundAckEnabled: merged.inboundAckEnabled === true,
    inboundAckText: normalizeString(merged.inboundAckText) || DEFAULT_INBOUND_ACK_TEXT,
    inboundParseMode: parseInboundParseMode(merged.inboundParseMode),
    inboundBlockedTypes: parseInboundTypeEntries(merged.inboundBlockedTypes ?? DEFAULT_INBOUND_BLOCKED_TYPES),
    inboundMinTextLength: parseBoundedInt(merged.inboundMinTextLength, 1, 1, 200),
    inboundMaxTextLength: parseBoundedInt(merged.inboundMaxTextLength, 4000, 50, 20000),
    inboundAllowTypelessText: parseBoolean(merged.inboundAllowTypelessText, true),
    inboundParseDebug: parseBoolean(merged.inboundParseDebug, false),
    webhookPath: normalizeWebhookPath(merged.webhookPath),
    webhookApiKey: normalizeString(merged.webhookApiKey) || undefined,
    allowFrom: parseAllowEntries(merged.allowFrom),
    groupAllowFrom: parseAllowEntries(merged.groupAllowFrom),
  };
}

function parseTarget(raw: string): ParsedTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.replace(/^(vocechat|vc):/i, "").trim();
  if (!withoutPrefix) return null;

  const match = withoutPrefix.match(/^(user|u|dm|private|group|g|room|channel):\s*(.+)$/i);
  if (match) {
    const rawKind = match[1].toLowerCase();
    const id = normalizeString(match[2]);
    if (!id) return null;
    const kind: TargetKind =
      rawKind === "group" || rawKind === "g" || rawKind === "room" || rawKind === "channel"
        ? "group"
        : "user";
    return { kind, id };
  }

  if (/^\d+$/.test(withoutPrefix)) return { kind: "user", id: withoutPrefix };
  return null;
}

function ensureTarget(params: { to?: string; defaultTo?: string; mode?: string }): ParsedTarget {
  const requested = normalizeString(params.to);
  const parsedRequested = requested ? parseTarget(requested) : null;
  if (parsedRequested) return parsedRequested;

  if (params.mode !== "explicit") {
    const fallback = normalizeString(params.defaultTo);
    const parsedFallback = fallback ? parseTarget(fallback) : null;
    if (parsedFallback) return parsedFallback;
  }

  throw new Error(
    '[vocechat] Invalid target. Use "user:<id>" or "group:<id>" (example: user:3).',
  );
}

function buildPathFromTemplate(template: string, targetId: string): string {
  const encodedId = encodeURIComponent(targetId);
  if (template.includes("{id}")) return template.replaceAll("{id}", encodedId);
  if (template.includes(":id")) return template.replaceAll(":id", encodedId);
  return `${template.replace(/\/+$/g, "")}/${encodedId}`;
}

function buildSendUrl(account: ResolvedAccount, target: ParsedTarget): string {
  const template = target.kind === "group" ? account.groupPathTemplate : account.privatePathTemplate;
  const rawPath = buildPathFromTemplate(template, target.id);
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (rawPath.startsWith("/")) return `${account.baseUrl}${rawPath}`;
  return `${account.baseUrl}/${rawPath}`;
}

function parseMessageId(rawBody: string): string {
  const body = rawBody.trim();
  if (!body) return `${Date.now()}`;

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const data = asRecord(parsed.data);
    const result = asRecord(parsed.result);
    const candidates = [
      parsed.messageId,
      parsed.message_id,
      parsed.msgId,
      parsed.msg_id,
      parsed.id,
      data.id,
      data.messageId,
      result.id,
      result.messageId,
    ];
    for (const value of candidates) {
      const normalized = parseId(value);
      if (normalized) return normalized;
    }
  } catch {
    // VoceChat may return plain text.
  }

  return body;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeVoceChatMarkdownStyle(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine;
    const trimmed = line.trim();

    // Unify bullets so app/web render consistently.
    if (/^[•·●]\s+/.test(trimmed)) {
      line = `- ${trimmed.replace(/^[•·●]\s+/, "")}`;
    }

    out.push(line);
  }

  let normalized = out.join("\n");
  // Avoid overly sparse output on mobile clients.
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return normalized.trim();
}

function formatModelTagForVoceChat(text: string): string {
  const normalized = normalizeVoceChatMarkdownStyle(text);
  const firstNewline = normalized.indexOf("\n");
  const firstLineRaw = (firstNewline >= 0 ? normalized.slice(0, firstNewline) : normalized).trim();
  if (!/^\[MODEL:\s*.+\]$/i.test(firstLineRaw)) return normalized;

  // Markdown-only badge style (works on both VoceChat web and app clients).
  const rest = firstNewline >= 0 ? normalized.slice(firstNewline + 1).trimStart() : "";
  const safeTag = firstLineRaw.replace(/`/g, "\\`");
  const badge = `> \`${safeTag}\``;
  if (!rest) return badge;
  return `${badge}\n\n${rest}`;
}

function buildPayloadText(text: string, mediaUrl?: string): string {
  const normalizedText = formatModelTagForVoceChat(text);
  const normalizedMedia = normalizeString(mediaUrl);
  if (normalizedText && normalizedMedia) return `${normalizedText}\n\n${normalizedMedia}`;
  if (normalizedMedia) return normalizedMedia;
  return normalizedText;
}

async function sendVoceChatMessage(
  ctx: ChannelOutboundContext,
  mediaUrl?: string,
): Promise<OutboundDeliveryResult> {
  const account = resolveVoceChatAccount(ctx.cfg, ctx.accountId);
  if (!account.enabled) throw new Error("[vocechat] Channel account is disabled.");
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (!account.apiKey) throw new Error("[vocechat] channels.vocechat.apiKey is required.");

  const target = ensureTarget({
    to: ctx.to,
    defaultTo: account.defaultTo,
    mode: "implicit",
  });
  const url = buildSendUrl(account, target);
  const text = buildPayloadText(ctx.text, mediaUrl);
  if (!text) throw new Error("[vocechat] Empty payload is not allowed.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    let rawBody = "";
    let response: Response | null = null;
    const contentTypes: string[] = ["text/markdown", "text/plain"];

    for (const contentType of contentTypes) {
      const current = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": account.apiKey,
          "content-type": contentType,
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        },
        body: text,
        signal: controller.signal,
      });
      const currentBody = await current.text();

      if (current.ok) {
        response = current;
        rawBody = currentBody;
        break;
      }

      if (current.status === 415 && contentType !== "text/plain") {
        continue;
      }

      const detail = currentBody.trim().slice(0, 500);
      throw new Error(
        `[vocechat] send failed: HTTP ${current.status}${detail ? `, body=${detail}` : ""}`,
      );
    }

    if (!response) {
      throw new Error("[vocechat] send failed: no usable content-type accepted by VoceChat.");
    }

    const messageId = parseMessageId(rawBody);
    rememberRecentMessage(recentOutboundMessageIds, makeMessageKey(account.accountId, messageId));

    return {
      channel: CHANNEL_ID,
      messageId,
      chatId: `${target.kind}:${target.id}`,
      timestamp: Date.now(),
      meta: {
        accountId: account.accountId,
        targetKind: target.kind,
        targetId: target.id,
        status: response.status,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendVoceChatReplyToMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  const account = resolveVoceChatAccount(params.cfg, params.accountId);
  if (!account.enabled) throw new Error("[vocechat] Channel account is disabled.");
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (!account.apiKey) throw new Error("[vocechat] channels.vocechat.apiKey is required.");

  const messageId = normalizeString(params.messageId);
  if (!messageId) throw new Error("[vocechat] reply target messageId is required.");

  const text = formatModelTagForVoceChat(params.text);
  if (!text) throw new Error("[vocechat] Empty payload is not allowed.");

  const url = `${account.baseUrl}/api/bot/reply/${encodeURIComponent(messageId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    let rawBody = "";
    let response: Response | null = null;
    const contentTypes: string[] = ["text/markdown", "text/plain"];

    for (const contentType of contentTypes) {
      const current = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": account.apiKey,
          "content-type": contentType,
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        },
        body: text,
        signal: controller.signal,
      });
      const currentBody = await current.text();

      if (current.ok) {
        response = current;
        rawBody = currentBody;
        break;
      }

      if (current.status === 415 && contentType !== "text/plain") {
        continue;
      }

      const detail = currentBody.trim().slice(0, 500);
      throw new Error(
        `[vocechat] reply failed: HTTP ${current.status}${detail ? `, body=${detail}` : ""}`
      );
    }

    if (!response) {
      throw new Error("[vocechat] reply failed: no usable content-type accepted by VoceChat.");
    }

    const outboundMessageId = parseMessageId(rawBody);
    rememberRecentMessage(recentOutboundMessageIds, makeMessageKey(account.accountId, outboundMessageId));
  } finally {
    clearTimeout(timeout);
  }
}

function parseInboundEvent(raw: unknown, account: ResolvedAccount): InboundEvent | null {
  const payload = asRecord(raw);
  const detail = asRecord(payload.detail);
  const target = asRecord(payload.target);
  const detailTarget = asRecord(detail.target);
  const sender = asRecord(payload.sender);
  const detailSender = asRecord(detail.sender);

  const visibleTypes = [
    detail.type,
    detail.message_type,
    detail.messageType,
    payload.type,
    payload.message_type,
    payload.messageType,
  ];
  const normalizedTypes = Array.from(
    new Set(visibleTypes.map((value) => normalizeInboundType(value)).filter(Boolean)),
  );
  const hasExplicitType = normalizedTypes.length > 0;
  const hasSupportedType = normalizedTypes.some((value) => isSupportedInboundTextType(value));
  const hasBlockedType = normalizedTypes.some((value) => account.inboundBlockedTypes.includes(value));

  if (hasBlockedType) return null;

  const textRaw = firstNonEmptyString([
    detail.content,
    detail.text,
    payload.content,
    payload.text,
    detail.preview,
    payload.preview,
  ]);
  const text = normalizeInboundText(textRaw);
  if (!text) return null;
  if (text.length < account.inboundMinTextLength) return null;
  if (text.length > account.inboundMaxTextLength) return null;

  if (account.inboundParseMode === "strict") {
    if (!hasExplicitType || !hasSupportedType) return null;
  } else if (account.inboundParseMode === "legacy") {
    if (hasExplicitType && !hasSupportedType) return null;
  } else {
    // balanced
    if (hasExplicitType && !hasSupportedType) return null;
    if (!hasExplicitType && !account.inboundAllowTypelessText) return null;
  }

  const fromUid = firstNonEmptyId([
    payload.from_uid,
    payload.fromUid,
    payload.sender_uid,
    payload.senderUid,
    payload.user_id,
    payload.userId,
    payload.uid,
    detail.from_uid,
    detail.fromUid,
    detail.sender_uid,
    detail.senderUid,
    detail.user_id,
    detail.userId,
    detail.uid,
    sender.uid,
    sender.user_id,
    sender.userId,
    sender.sender_uid,
    sender.senderUid,
    sender.id,
    detailSender.uid,
    detailSender.user_id,
    detailSender.userId,
    detailSender.sender_uid,
    detailSender.senderUid,
    detailSender.id,
  ]);
  if (!fromUid) return null;

  const groupId = firstNonEmptyId([
    target.gid,
    target.group_id,
    target.groupId,
    target.room_id,
    target.roomId,
    detailTarget.gid,
    detailTarget.group_id,
    detailTarget.groupId,
    detailTarget.room_id,
    detailTarget.roomId,
    payload.gid,
    payload.group_id,
    payload.groupId,
    payload.room_id,
    payload.roomId,
    detail.gid,
    detail.group_id,
    detail.groupId,
    detail.room_id,
    detail.roomId,
  ]);

  const chatType: "direct" | "group" = groupId ? "group" : "direct";
  const conversationId = groupId || fromUid;

  const messageId =
    firstNonEmptyId([
      payload.mid,
      payload.message_id,
      payload.messageId,
      payload.msg_id,
      payload.msgId,
      detail.mid,
      detail.message_id,
      detail.messageId,
      detail.msg_id,
      detail.msgId,
    ]) || `${Date.now()}`;

  const timestamp = parseTimestampMs(
    payload.created_at ??
      payload.createdAt ??
      payload.timestamp ??
      payload.ts ??
      detail.created_at ??
      detail.createdAt ??
      detail.timestamp ??
      detail.ts,
  );
  const replyTarget = chatType === "group" ? `group:${groupId}` : `user:${fromUid}`;

  return {
    messageId,
    fromUid,
    chatType,
    conversationId,
    groupId: groupId || undefined,
    text,
    timestamp,
    replyTarget,
  };
}


function isInboundAuthorized(account: ResolvedAccount, event: InboundEvent): boolean {
  if (event.chatType === "group") {
    if (account.groupAllowFrom.length === 0) return true;
    return account.groupAllowFrom.includes(event.fromUid);
  }

  if (account.allowFrom.length === 0) return true;
  return account.allowFrom.includes(event.fromUid);
}

function resolveAckReaction(cfg: OpenClawConfig, accountId: string): string {
  const channelCfg = getChannelConfig(cfg);
  const accountCfg = asRecord(asRecord(channelCfg.accounts)[normalizeAccountId(accountId)]);

  if (hasOwn(accountCfg, "ackReaction")) {
    return normalizeString(accountCfg.ackReaction);
  }

  const channelRecord = channelCfg as Record<string, unknown>;
  if (hasOwn(channelRecord, "ackReaction")) {
    return normalizeString(channelRecord.ackReaction);
  }

  const messagesCfg = asRecord((cfg as Record<string, unknown>).messages);
  return normalizeString(messagesCfg.ackReaction);
}

function resolveAckReactionScope(cfg: OpenClawConfig): "group-mentions" | "group-all" | "direct" | "all" {
  const messagesCfg = asRecord((cfg as Record<string, unknown>).messages);
  const raw = normalizeString(messagesCfg.ackReactionScope).toLowerCase();
  if (raw === "group-all" || raw === "direct" || raw === "all") return raw;
  return "group-mentions";
}

function shouldSendAckReaction(
  scope: "group-mentions" | "group-all" | "direct" | "all",
  event: InboundEvent,
): boolean {
  if (scope === "all") return true;
  if (scope === "direct") return event.chatType === "direct";
  if (scope === "group-all") return event.chatType === "group";
  // VoceChat webhook does not provide normalized mention metadata.
  // Fallback: treat group-mentions as group chats for immediate "I saw this" feedback.
  if (scope === "group-mentions") return event.chatType === "group";
  return false;
}

async function sendVoceChatReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  messageId: string;
  action: string;
}): Promise<void> {
  const account = resolveVoceChatAccount(params.cfg, params.accountId);
  if (!account.enabled || !account.baseUrl || !account.apiKey) return;

  const action = normalizeString(params.action);
  if (!action) return;

  const url = `${account.baseUrl}/api/bot/reply/${encodeURIComponent(params.messageId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": account.apiKey,
        "content-type": "text/plain",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: action,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500);
      throw new Error(`HTTP ${response.status}${detail ? `, body=${detail}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function writeJson(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const direct = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (Array.isArray(direct)) return normalizeString(direct[0]);
  return normalizeString(direct);
}

async function processInboundEvent(params: {
  accountId: string;
  event: InboundEvent;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<void> {
  const { accountId, event, logger } = params;
  const runtime = getVoceChatRuntime();
  const cfg = await runtime.config.loadConfig();
  const account = resolveVoceChatAccount(cfg, accountId);
  logger?.info?.(
    `[vocechat] inbound begin account=${account.accountId} mid=${event.messageId} from=${event.fromUid} chat=${event.chatType}`,
  );
  if (!account.enabled || !account.inboundEnabled) {
    logger?.info?.(
      `[vocechat] inbound ignored: account disabled account=${account.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled}`,
    );
    return;
  }

  const messageKey = makeMessageKey(account.accountId, event.messageId);
  if (hasRecentMessage(recentOutboundMessageIds, messageKey)) {
    logger?.info?.(`[vocechat] skip outbound echo mid=${event.messageId}`);
    return;
  }
  if (hasRecentMessage(recentInboundMessageIds, messageKey)) {
    logger?.info?.(`[vocechat] skip duplicated inbound mid=${event.messageId}`);
    return;
  }
  rememberRecentMessage(recentInboundMessageIds, messageKey);

  if (!isInboundAuthorized(account, event)) {
    logger?.warn?.(
      `[vocechat] drop unauthorized sender uid=${event.fromUid} account=${account.accountId} chatType=${event.chatType}`,
    );
    return;
  }

  const ackReaction = resolveAckReaction(cfg, account.accountId);
  const ackReactionScope = resolveAckReactionScope(cfg);
  if (ackReaction && shouldSendAckReaction(ackReactionScope, event)) {
    try {
      await sendVoceChatReaction({
        cfg,
        accountId: account.accountId,
        messageId: event.messageId,
        action: ackReaction,
      });
      logger?.info?.(
        `[vocechat] inbound ack reaction sent account=${account.accountId} mid=${event.messageId} action=${ackReaction}`,
      );
    } catch (err) {
      logger?.warn?.(
        `[vocechat] inbound ack reaction failed account=${account.accountId} mid=${event.messageId} action=${ackReaction} err=${String(err)}`,
      );
    }
  }

  if (account.inboundAckEnabled) {
    try {
      await sendVoceChatMessage(
        {
          cfg,
          to: event.replyTarget,
          text: account.inboundAckText,
          accountId: account.accountId,
        } as ChannelOutboundContext,
      );
    } catch (err) {
      logger?.warn?.(
        `[vocechat] inbound ack failed account=${account.accountId} mid=${event.messageId} err=${String(err)}`,
      );
    }
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: event.chatType === "group" ? "group" : "direct",
      id: event.conversationId,
    },
  });
  logger?.info?.(
    `[vocechat] inbound route agent=${route.agentId} sessionKey=${route.sessionKey} account=${route.accountId}`,
  );

  const storePath = runtime.channel.session.resolveStorePath(
    (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
    { agentId: route.agentId },
  );

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const conversationLabel =
    event.chatType === "group"
      ? `group:${event.groupId ?? event.conversationId}`
      : `user:${event.fromUid}`;

  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "VoceChat",
    from: conversationLabel,
    timestamp: event.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: event.text,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: event.text,
    RawBody: event.text,
    CommandBody: event.text,
    From: `vocechat:${event.fromUid}`,
    To: `vocechat:${event.replyTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: event.chatType,
    ConversationLabel: conversationLabel,
    GroupSubject: event.chatType === "group" ? `group:${event.groupId ?? event.conversationId}` : undefined,
    SenderId: event.fromUid,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: event.messageId,
    Timestamp: event.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: event.replyTarget,
    CommandAuthorized: true,
  });

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      logger?.error?.(`[vocechat] failed updating session: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    const combined = formatTextWithAttachmentLinks(payload.text, resolveOutboundMediaUrls(payload));
    if (!combined) return;

    if (event.chatType === "group") {
      try {
        await sendVoceChatReplyToMessage({
          cfg,
          accountId: account.accountId,
          messageId: event.messageId,
          text: combined,
        });
        return;
      } catch (err) {
        logger?.warn?.(
          `[vocechat] quote-reply failed account=${account.accountId} mid=${event.messageId} err=${String(err)}; fallback=group-send`,
        );
      }
    }

    await sendVoceChatMessage(
      {
        cfg,
        to: event.replyTarget,
        text: combined,
        accountId: account.accountId,
      } as ChannelOutboundContext,
    );
  });

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: deliverReply,
      onError: (err, info) => {
        logger?.error?.(`[vocechat] ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
  logger?.info?.(
    `[vocechat] inbound dispatch complete account=${account.accountId} mid=${event.messageId} replyTarget=${event.replyTarget}`,
  );
}

function createWebhookHandler(params: {
  accountId: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  const { accountId, logger } = params;

  return async (
    req: { method?: string; headers: Record<string, string | string[] | undefined> },
    res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void },
  ) => {
    const method = normalizeString(req.method).toUpperCase() || "UNKNOWN";
    const forwardedFor = readHeader(req.headers, "x-forwarded-for");
    logger?.info?.(
      `[vocechat] webhook hit account=${accountId} method=${method}${forwardedFor ? ` xff=${forwardedFor}` : ""}`,
    );

    if (method === "GET") {
      writeJson(res, 200, { ok: true, channel: CHANNEL_ID });
      return;
    }

    if (method !== "POST") {
      logger?.warn?.(
        `[vocechat] webhook reject: method_not_allowed account=${accountId} method=${method}`,
      );
      writeJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    const jsonResult = await readJsonBodyWithLimit(req as any, {
      maxBytes: DEFAULT_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
      emptyObjectOnEmpty: false,
    });

    if (!jsonResult.ok) {
      logger?.warn?.(
        `[vocechat] webhook reject: invalid_json account=${accountId} detail=${String(jsonResult.error)}`,
      );
      writeJson(res, 400, {
        ok: false,
        error: "invalid_json",
        detail: jsonResult.error,
      });
      return;
    }

    const runtime = getVoceChatRuntime();
    const cfg = await runtime.config.loadConfig();
    const account = resolveVoceChatAccount(cfg, accountId);

    if (!account.enabled || !account.inboundEnabled) {
      logger?.info?.(
        `[vocechat] webhook ignored: account disabled account=${account.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled}`,
      );
      writeJson(res, 200, { ok: true, ignored: "disabled" });
      return;
    }

    if (account.webhookApiKey) {
      const provided = readHeader(req.headers, "x-api-key");
      if (!provided || provided !== account.webhookApiKey) {
        logger?.warn?.(
          `[vocechat] webhook reject: forbidden account=${account.accountId} provided=${provided ? "yes" : "no"}`,
        );
        writeJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
    }

    const event = parseInboundEvent(jsonResult.value, account);
    writeJson(res, 200, { ok: true, accepted: Boolean(event) });

    if (!event) {
      const summary = summarizeInboundPayloadForAudit(jsonResult.value, account.accountId);
      logger?.warn?.(`[vocechat] webhook accepted but ignored: unsupported payload ${summary}`);
      if (account.inboundParseDebug) {
        logger?.info?.(
          `[vocechat] inbound parse debug account=${account.accountId} mode=${account.inboundParseMode} allowTypeless=${account.inboundAllowTypelessText} minLen=${account.inboundMinTextLength} maxLen=${account.inboundMaxTextLength} blockedTypes=${account.inboundBlockedTypes.join("|") || "-"}`,
        );
      }
      return;
    }
    logger?.info?.(
      `[vocechat] webhook parsed account=${account.accountId} mid=${event.messageId} from=${event.fromUid} chat=${event.chatType} len=${event.text.length}`,
    );

    void processInboundEvent({
      accountId,
      event,
      logger,
    }).catch((err) => {
      logger?.error?.(`[vocechat] inbound dispatch failed: ${String(err)}`);
    });
  };
}

const voceChatChannel: ChannelPlugin<ResolvedAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "VoceChat",
    selectionLabel: "VoceChat Bot API",
    docsPath: "/channels/vocechat",
    docsLabel: "vocechat",
    blurb: "Send and receive messages through VoceChat bot API + webhook.",
    aliases: ["vc"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.vocechat"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
        baseUrl: { type: "string" },
        apiKey: { type: "string" },
        privatePathTemplate: { type: "string" },
        groupPathTemplate: { type: "string" },
        ackReaction: { type: "string" },
        defaultTo: { type: "string" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
        inboundEnabled: { type: "boolean" },
        inboundAckEnabled: { type: "boolean" },
        inboundAckText: { type: "string" },
        inboundParseMode: { type: "string", enum: ["legacy", "balanced", "strict"] },
        inboundBlockedTypes: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        inboundMinTextLength: { type: "number", minimum: 1, maximum: 200 },
        inboundMaxTextLength: { type: "number", minimum: 50, maximum: 20000 },
        inboundAllowTypelessText: { type: "boolean" },
        inboundParseDebug: { type: "boolean" },
        webhookPath: { type: "string" },
        webhookApiKey: { type: "string" },
        allowFrom: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
          ],
        },
        groupAllowFrom: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
          ],
        },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              baseUrl: { type: "string" },
              apiKey: { type: "string" },
              privatePathTemplate: { type: "string" },
              groupPathTemplate: { type: "string" },
              ackReaction: { type: "string" },
              defaultTo: { type: "string" },
              timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
              inboundEnabled: { type: "boolean" },
              inboundAckEnabled: { type: "boolean" },
              inboundAckText: { type: "string" },
              inboundParseMode: { type: "string", enum: ["legacy", "balanced", "strict"] },
              inboundBlockedTypes: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
              },
              inboundMinTextLength: { type: "number", minimum: 1, maximum: 200 },
              inboundMaxTextLength: { type: "number", minimum: 50, maximum: 20000 },
              inboundAllowTypelessText: { type: "boolean" },
              inboundParseDebug: { type: "boolean" },
              webhookPath: { type: "string" },
              webhookApiKey: { type: "string" },
              allowFrom: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
                ],
              },
              groupAllowFrom: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
                ],
              },
            },
          },
        },
      },
    },
    uiHints: {
      apiKey: {
        label: "VoceChat API Key",
        sensitive: true,
      },
      webhookApiKey: {
        label: "Webhook API Key",
        sensitive: true,
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listVoceChatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveVoceChatAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isEnabled: (account) => account.enabled,
    disabledReason: (account) => (account.enabled ? "" : "vocechat channel is disabled"),
    isConfigured: (account) => Boolean(account.baseUrl && account.apiKey),
    unconfiguredReason: (account) => {
      if (!account.baseUrl) return "missing channels.vocechat.baseUrl";
      if (!account.apiKey) return "missing channels.vocechat.apiKey";
      return "not configured";
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.baseUrl && account.apiKey),
      connected: account.enabled && Boolean(account.baseUrl && account.apiKey),
      baseUrl: account.baseUrl || undefined,
      secretSource: account.apiKey ? "config" : "none",
      webhookPath: account.webhookPath,
      mode: account.inboundEnabled ? "webhook+outbound" : "outbound-only",
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveVoceChatAccount(cfg, accountId).allowFrom,
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) => resolveVoceChatAccount(cfg, accountId).defaultTo,
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ cfg, to, accountId, mode }) => {
      const defaultTo = cfg ? resolveVoceChatAccount(cfg, accountId).defaultTo : undefined;
      try {
        const parsed = ensureTarget({ to, defaultTo, mode });
        return { ok: true, to: `${parsed.kind}:${parsed.id}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: new Error(message) };
      }
    },
    sendText: async (ctx) => sendVoceChatMessage(ctx),
    sendMedia: async (ctx) => sendVoceChatMessage(ctx, ctx.mediaUrl),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const routeKey = `${ctx.accountId}:${account.webhookPath}`;
      ctx.log?.info(
        `[vocechat] start account=${ctx.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled} webhookPath=${account.webhookPath}`,
      );

      if (!account.enabled || !account.inboundEnabled) {
        ctx.log?.info(
          `[vocechat] skip webhook start for account=${ctx.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled}`,
        );
        return { stop: () => {} };
      }

      const previous = activeRouteUnregisters.get(routeKey);
      if (previous) {
        previous();
        activeRouteUnregisters.delete(routeKey);
      }

      const handler = createWebhookHandler({
        accountId: account.accountId,
        logger: {
          info: (message) => ctx.log?.info(message),
          warn: (message) => ctx.log?.warn(message),
          error: (message) => ctx.log?.error(message),
        },
      });

      const unregister = registerPluginHttpRoute({
        path: account.webhookPath,
        fallbackPath: DEFAULT_WEBHOOK_PATH,
        handler: handler as any,
        pluginId: CHANNEL_ID,
        accountId: account.accountId,
        log: (message) => ctx.log?.info(message),
      });
      activeRouteUnregisters.set(routeKey, unregister);
      ctx.log?.info(
        `[vocechat] webhook route registered account=${ctx.accountId} path=${account.webhookPath} fallback=${DEFAULT_WEBHOOK_PATH}`,
      );

      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        connected: true,
        mode: "webhook",
        webhookPath: account.webhookPath,
        lastStartAt: Date.now(),
      });

      await waitForAbort(ctx.abortSignal);
      const fn = activeRouteUnregisters.get(routeKey);
      if (fn) fn();
      activeRouteUnregisters.delete(routeKey);
      ctx.log?.info(`[vocechat] stop account=${ctx.accountId} webhookPath=${account.webhookPath}`);
      ctx.setStatus({
        accountId: ctx.accountId,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },
  },
};

const plugin = {
  id: CHANNEL_ID,
  name: "VoceChat Channel",
  description: "VoceChat inbound/outbound channel integration",
  register(api: OpenClawPluginApi) {
    setVoceChatRuntime(api.runtime);
    api.registerChannel({ plugin: voceChatChannel });
  },
};

export default plugin;
