import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  formatTextWithAttachmentLinks,
  readJsonBodyWithLimit,
  registerPluginHttpRoute,
  resolveOutboundMediaUrls,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk";
import type {
  ChannelOutboundContext,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  OutboundDeliveryResult,
  PluginCommandContext,
  PluginRuntime,
  ReplyPayload,
} from "openclaw/plugin-sdk";

import { ControlPanelStore } from "./src/panel-store.js";
import { parseTelegramTarget, TelegramPanelDelivery, type TelegramInlineKeyboardButton } from "./src/telegram-panel-delivery.js";

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

type VoceChatManagementConfig = {
  adminSenderIds: string[];
  panelStateFile: string;
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

function resolveVoceChatManagement(cfg: OpenClawConfig): VoceChatManagementConfig {
  const section = getChannelConfig(cfg);
  const management = asRecord((section as Record<string, unknown>).management);
  const panelStateFile = normalizeString(management.panelStateFile) || path.join(os.homedir(), ".local", "state", "openclaw-vocechat-channel", "panels.json");
  return {
    adminSenderIds: parseAllowEntries(management.adminSenderIds),
    panelStateFile,
  };
}

function resolveHostConfigFilePath(): string {
  const explicitPath = normalizeString(process.env.OPENCLAW_CONFIG_PATH ?? process.env.CLAWDBOT_CONFIG_PATH);
  if (explicitPath) return expandHomePath(explicitPath);

  const explicitStateDir = normalizeString(process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR);
  const stateDir = explicitStateDir ? expandHomePath(explicitStateDir) : path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function loadHostConfigForEdit(): Promise<Record<string, unknown>> {
  const configPath = resolveHostConfigFilePath();
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code === "ENOENT") {
      throw new Error("未找到宿主配置文件，已取消写入。");
    }
    throw new Error(`读取宿主配置失败：${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("宿主配置不是标准 JSON，已取消写入。");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("宿主配置结构无效，已取消写入。");
  }

  return parsed as Record<string, unknown>;
}

function ensureMutableRecord(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = container[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  container[key] = created;
  return created;
}

async function updateVoceChatHostConfig(
  updater: (channelConfig: Record<string, unknown>) => string,
): Promise<string> {
  const root = await loadHostConfigForEdit();
  const channels = ensureMutableRecord(root, "channels");
  const channelConfig = ensureMutableRecord(channels, CHANNEL_ID);
  const summary = updater(channelConfig);
  await writeJsonFileAtomically(resolveHostConfigFilePath(), root);
  return summary;
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
        management: {
          type: "object",
          additionalProperties: false,
          properties: {
            adminSenderIds: {
              type: "array",
              items: { type: "string" },
            },
            panelStateFile: { type: "string" },
          },
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
      "management.adminSenderIds": {
        label: "管理员发送者 ID",
        advanced: true,
      },
      "management.panelStateFile": {
        label: "面板状态文件",
        advanced: true,
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

const VOCECHAT_CONTROL_COMMAND = "vocechatctl";
const SILENT_REPLY_TOKEN = "NO_REPLY";

type VoceChatPanelAction = "home" | "accounts" | "account-detail" | "webhook" | "routing" | "access";

type VoceChatParsedCommand = {
  panelId: string | null;
  action: VoceChatPanelAction;
  arg: string;
};

type VoceChatPanelResponse = {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
};

function registerVoceChatManagementCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: VOCECHAT_CONTROL_COMMAND,
    description: "VoceChat 通道管理面板（管理员）",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleVoceChatManagementCommand(ctx, api.config as OpenClawConfig),
  });
}

async function handleVoceChatManagementCommand(ctx: PluginCommandContext, cfg: OpenClawConfig): Promise<ReplyPayload> {
  const management = resolveVoceChatManagement(cfg);
  if (!isVoceChatAdminAuthorized(ctx, management)) {
    return {
      text: [
        "VoceChat 通道管理",
        "",
        "无权限：仅管理员可执行该命令。",
      ].join("\n"),
      isError: true,
    };
  }

  const editReply = await maybeHandleVoceChatEditCommand(ctx.args ?? "", cfg);
  if (editReply) return editReply;

  const parsed = parseVoceChatCommandArgs(ctx.args ?? "");
  if (ctx.channel === "telegram") {
    return await handleVoceChatTelegramPanel(ctx, cfg, management, parsed);
  }
  return await handleVoceChatGenericCommand(cfg, parsed);
}

async function handleVoceChatTelegramPanel(
  ctx: PluginCommandContext,
  cfg: OpenClawConfig,
  management: VoceChatManagementConfig,
  parsed: VoceChatParsedCommand,
): Promise<ReplyPayload> {
  const telegramRuntime = resolveVoceChatTelegramRuntime(cfg);
  if (!telegramRuntime) {
    return {
      text: [
        "VoceChat 通道管理",
        "",
        "缺少 Telegram 机器人配置，无法打开卡片面板。",
      ].join("\n"),
      isError: true,
    };
  }

  const target = parseTelegramTarget(ctx.to ?? ctx.from, ctx.messageThreadId);
  if (!target && !parsed.panelId) {
    return {
      text: [
        "VoceChat 通道管理",
        "",
        "当前会话未解析出 Telegram 目标，无法打开卡片面板。",
      ].join("\n"),
      isError: true,
    };
  }

  const store = new ControlPanelStore(management.panelStateFile);
  const delivery = new TelegramPanelDelivery(telegramRuntime);

  if (parsed.panelId) {
    const panel = store.get(parsed.panelId);
    if (!panel) {
      return {
        text: [
          "VoceChat 通道管理",
          "",
          `卡片已过期，请重新发送 /${VOCECHAT_CONTROL_COMMAND} 打开。`,
        ].join("\n"),
        isError: true,
      };
    }

    const response = renderVoceChatPanel(cfg, parsed.action, parsed.arg, parsed.panelId);
    await delivery.editMessage(
      { chatId: panel.chatId, threadId: panel.threadId },
      panel.messageId,
      { text: response.text, replyMarkup: { inline_keyboard: response.buttons } },
    );
    store.update(parsed.panelId, (current) => current);
    return { text: SILENT_REPLY_TOKEN };
  }

  const panel = store.create({
    chatId: target?.chatId ?? "",
    threadId: target?.threadId ?? null,
    ownerSenderId: normalizeIdentity(ctx.senderId ?? ctx.from),
  });
  const response = renderVoceChatPanel(cfg, parsed.action, parsed.arg, panel.panelId);
  const sent = await delivery.sendMessage(
    { chatId: panel.chatId, threadId: panel.threadId },
    { text: response.text, replyMarkup: { inline_keyboard: response.buttons } },
  );
  store.update(panel.panelId, (current) => ({ ...current, messageId: sent.messageId }));
  return {};
}

async function handleVoceChatGenericCommand(cfg: OpenClawConfig, parsed: VoceChatParsedCommand): Promise<ReplyPayload> {
  return {
    text: renderVoceChatPanel(cfg, parsed.action, parsed.arg, "plain").text,
  };
}

function renderVoceChatPanel(
  cfg: OpenClawConfig,
  action: VoceChatPanelAction,
  arg: string,
  panelId: string,
): VoceChatPanelResponse {
  switch (action) {
    case "accounts":
      return renderVoceChatAccountsPanel(cfg, panelId);
    case "account-detail":
      return renderVoceChatAccountDetailPanel(cfg, panelId, arg);
    case "webhook":
      return renderVoceChatWebhookPanel(cfg, panelId);
    case "routing":
      return renderVoceChatRoutingPanel(cfg, panelId);
    case "access":
      return renderVoceChatAccessPanel(cfg, panelId);
    case "home":
    default:
      return renderVoceChatOverviewPanel(cfg, panelId);
  }
}

function renderVoceChatOverviewPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const section = getChannelConfig(cfg);
  const management = resolveVoceChatManagement(cfg);
  const accountIds = listVoceChatAccountIds(cfg);
  const accounts = accountIds.map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const configuredCount = accounts.filter((account) => Boolean(account.baseUrl && account.apiKey)).length;
  const inboundCount = accounts.filter((account) => account.enabled && account.inboundEnabled).length;
  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  const groupPolicy = normalizeString((section as Record<string, unknown>).groupPolicy);

  const lines = [
    "VoceChat 通道管理",
    "",
    `账号总数：${accounts.length}`,
    `启用账号：${enabledCount}`,
    `已配置账号：${configuredCount}`,
    `启用入站：${inboundCount}`,
    `默认账号：${defaultAccount.accountId}`,
    `默认目标：${defaultAccount.defaultTo ?? "<未设置>"}`,
    `群消息策略：${formatVoceChatGroupPolicy(groupPolicy)}`,
    `管理员控制：${formatVoceChatAdminMode(management.adminSenderIds)}`,
  ];

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatRoutingButtons(panelId),
  };
}

function renderVoceChatAccountsPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const accounts = listVoceChatAccountIds(cfg).map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const lines = ["VoceChat 账号列表", ""];

  if (accounts.length === 0) {
    lines.push("当前未配置任何账号。", "", "请先在配置中补充账号信息。");
  } else {
    for (const account of accounts) {
      const defaultMark = account.accountId === DEFAULT_ACCOUNT_ID ? " [默认]" : "";
      lines.push(
        `${account.enabled ? "✅" : "⛔"} ${account.accountId}${defaultMark} · ${account.inboundEnabled ? "入站开" : "入站关"} · ${account.baseUrl ? "已配置" : "未配置"}`,
      );
    }
    lines.push("", "点击下方按钮查看账号详情。", "可用“返回概览”返回主页。");
  }

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatAccountButtons(panelId, accounts),
  };
}

function renderVoceChatAccountDetailPanel(cfg: OpenClawConfig, panelId: string, accountIdRaw: string): VoceChatPanelResponse {
  const accountId = normalizeAccountId(accountIdRaw || DEFAULT_ACCOUNT_ID);
  const account = resolveVoceChatAccount(cfg, accountId);
  const lines = [
    `账号详情：${account.accountId}`,
    "",
    `启用状态：${account.enabled ? "已启用" : "未启用"}`,
    `配置状态：${account.baseUrl && account.apiKey ? "完整" : "不完整"}`,
    `名称：${account.name ?? "<未设置>"}`,
    `基础地址：${account.baseUrl || "<未设置>"}`,
    `默认目标：${account.defaultTo ?? "<未设置>"}`,
    `超时时间：${account.timeoutMs} ms`,
    `Webhook 路径：${account.webhookPath}`,
    `Webhook 鉴权：${account.webhookApiKey ? "已设置" : "未设置"}`,
    `入站模式：${account.inboundEnabled ? "webhook+outbound" : "outbound-only"}`,
    `确认回复：${account.inboundAckEnabled ? "开启" : "关闭"}`,
    `解析模式：${account.inboundParseMode}`,
    `允许无类型文本：${account.inboundAllowTypelessText ? "是" : "否"}`,
    `解析调试：${account.inboundParseDebug ? "开启" : "关闭"}`,
    `阻断类型：${formatVoceChatCountPreview(account.inboundBlockedTypes)}`,
    `私聊白名单：${formatVoceChatCountPreview(account.allowFrom)}`,
    `群聊白名单：${formatVoceChatCountPreview(account.groupAllowFrom)}`,
    `私聊路径模板：${formatVoceChatTemplateState(account.privatePathTemplate, DEFAULT_PRIVATE_PATH_TEMPLATE)}`,
    `群聊路径模板：${formatVoceChatTemplateState(account.groupPathTemplate, DEFAULT_GROUP_PATH_TEMPLATE)}`,
  ];

  return {
    text: lines.join("\n"),
    buttons: [
      [
        buildVoceChatCopyButton("复制改目标命令", `/${VOCECHAT_CONTROL_COMMAND} set default-to ${account.accountId} user:2`),
      ],
      [
        { text: "返回概览", callback_data: buildVoceChatPanelCallback(panelId, "h") },
        { text: "账号列表", callback_data: buildVoceChatPanelCallback(panelId, "l") },
      ],
      [
        { text: "Webhook", callback_data: buildVoceChatPanelCallback(panelId, "w") },
        { text: "权限", callback_data: buildVoceChatPanelCallback(panelId, "x") },
      ],
      [
        { text: "路由", callback_data: buildVoceChatPanelCallback(panelId, "r") },
      ],
    ],
  };
}

function renderVoceChatWebhookPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const accountIds = listVoceChatAccountIds(cfg);
  const accounts = accountIds.map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const webhookEnabledCount = accounts.filter((account) => account.enabled && account.inboundEnabled).length;
  const authEnabledCount = accounts.filter((account) => Boolean(account.webhookApiKey)).length;
  const lines = [
    "VoceChat Webhook 总览",
    "",
    `Webhook 启用账号：${webhookEnabledCount}`,
    `鉴权开启账号：${authEnabledCount}`,
  ];

  if (accounts.length === 0) {
    lines.push("", "当前未配置任何账号。", "请先在配置中补充账号信息。");
  } else {
    lines.push("");
    for (const account of accounts) {
      lines.push(
        `${account.enabled && account.inboundEnabled ? "✅" : "⛔"} ${account.accountId} · ${account.webhookPath} · ${account.webhookApiKey ? "鉴权开" : "鉴权关"} · ${account.inboundAckEnabled ? "确认开" : "确认关"}`,
      );
    }
    lines.push("", `默认回退路径：${DEFAULT_WEBHOOK_PATH}`);
  }

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatAccessButtons(panelId),
  };
}

function renderVoceChatRoutingPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const accounts = listVoceChatAccountIds(cfg).map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  const lines = [
    "VoceChat 路由摘要",
    "",
    `账号模式：${accounts.length > 1 ? "多账号" : "单账号"}`,
    `默认账号：${defaultAccount.accountId}`,
    `默认目标：${defaultAccount.defaultTo ?? "<未设置>"}`,
    `私聊路径模板：${formatVoceChatTemplateState(defaultAccount.privatePathTemplate, DEFAULT_PRIVATE_PATH_TEMPLATE)}`,
    `群聊路径模板：${formatVoceChatTemplateState(defaultAccount.groupPathTemplate, DEFAULT_GROUP_PATH_TEMPLATE)}`,
    `目标格式：user:<ID> / group:<ID>`,
    `回复能力：支持按消息回复`,
    "",
    "下方按钮可直接复制命令模板。",
    `修改默认目标：/${VOCECHAT_CONTROL_COMMAND} set default-to user:2`,
    `指定账号目标：/${VOCECHAT_CONTROL_COMMAND} set default-to <账号ID> user:2`,
  ];

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatMainButtons(panelId),
  };
}

function renderVoceChatAccessPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const section = getChannelConfig(cfg);
  const management = resolveVoceChatManagement(cfg);
  const accounts = listVoceChatAccountIds(cfg).map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  const groupPolicy = normalizeString((section as Record<string, unknown>).groupPolicy);
  const allowFromTotal = accounts.reduce((sum, account) => sum + account.allowFrom.length, 0);
  const groupAllowFromTotal = accounts.reduce((sum, account) => sum + account.groupAllowFrom.length, 0);
  const lines = [
    "VoceChat 访问控制",
    "",
    `管理员模式：${management.adminSenderIds.length > 0 ? "插件白名单" : "继承宿主授权"}`,
    `管理员数量：${management.adminSenderIds.length}`,
    `管理员示例：${formatVoceChatMaskedEntries(management.adminSenderIds)}`,
    `群消息策略：${formatVoceChatGroupPolicy(groupPolicy)}`,
    `私聊白名单总量：${allowFromTotal}`,
    `群聊白名单总量：${groupAllowFromTotal}`,
    `默认账号私聊白名单：${formatVoceChatCountPreview(defaultAccount.allowFrom)}`,
    `默认账号群聊白名单：${formatVoceChatCountPreview(defaultAccount.groupAllowFrom)}`,
    "",
    "下方按钮可直接复制命令模板。",
    `查看管理员：/${VOCECHAT_CONTROL_COMMAND} admin list`,
    `添加管理员：/${VOCECHAT_CONTROL_COMMAND} admin add telegram:123456789`,
    `移除管理员：/${VOCECHAT_CONTROL_COMMAND} admin remove telegram:123456789`,
  ];

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatMainButtons(panelId),
  };
}

function buildVoceChatMainButtons(panelId: string): TelegramInlineKeyboardButton[][] {
  return [
    [
      { text: "概览", callback_data: buildVoceChatPanelCallback(panelId, "h") },
      { text: "账号", callback_data: buildVoceChatPanelCallback(panelId, "l") },
    ],
    [
      { text: "Webhook", callback_data: buildVoceChatPanelCallback(panelId, "w") },
      { text: "路由", callback_data: buildVoceChatPanelCallback(panelId, "r") },
    ],
    [
      { text: "权限", callback_data: buildVoceChatPanelCallback(panelId, "x") },
    ],
  ];
}

function buildVoceChatRoutingButtons(panelId: string): TelegramInlineKeyboardButton[][] {
  return [
    [
      buildVoceChatCopyButton("复制默认目标", `/${VOCECHAT_CONTROL_COMMAND} set default-to user:2`),
    ],
    [
      buildVoceChatCopyButton("复制指定账号目标", `/${VOCECHAT_CONTROL_COMMAND} set default-to default user:2`),
    ],
    ...buildVoceChatMainButtons(panelId),
  ];
}

function buildVoceChatAccessButtons(panelId: string): TelegramInlineKeyboardButton[][] {
  return [
    [
      buildVoceChatCopyButton("复制查看管理员", `/${VOCECHAT_CONTROL_COMMAND} admin list`),
    ],
    [
      buildVoceChatCopyButton("复制添加管理员", `/${VOCECHAT_CONTROL_COMMAND} admin add telegram:123456789`),
    ],
    [
      buildVoceChatCopyButton("复制移除管理员", `/${VOCECHAT_CONTROL_COMMAND} admin remove telegram:123456789`),
    ],
    ...buildVoceChatMainButtons(panelId),
  ];
}

function buildVoceChatCopyButton(text: string, command: string): TelegramInlineKeyboardButton {
  return {
    text,
    copy_text: { text: command },
  };
}

function buildVoceChatAccountButtons(panelId: string, accounts: ResolvedAccount[]): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [];
  let row: TelegramInlineKeyboardButton[] = [];

  for (const account of accounts) {
    row.push({
      text: `${account.enabled ? "✅" : "⛔"}${account.accountId}`,
      callback_data: buildVoceChatPanelCallback(panelId, "a", account.accountId),
    });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length > 0) rows.push(row);
  rows.push([{ text: "返回概览", callback_data: buildVoceChatPanelCallback(panelId, "h") }]);
  return rows;
}

function buildVoceChatPanelCallback(panelId: string, action: "h" | "l" | "a" | "w" | "r" | "x", arg?: string): string {
  return arg
    ? `/${VOCECHAT_CONTROL_COMMAND} p ${panelId} ${action} ${arg}`
    : `/${VOCECHAT_CONTROL_COMMAND} p ${panelId} ${action}`;
}

function parseVoceChatCommandArgs(rawArgs: string): VoceChatParsedCommand {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === "p" && tokens[1]) {
    return {
      panelId: tokens[1],
      action: decodeVoceChatPanelAction(tokens[2]),
      arg: tokens.slice(3).join(" "),
    };
  }
  return {
    panelId: null,
    action: decodeVoceChatPanelAction(tokens[0]),
    arg: tokens.slice(1).join(" "),
  };
}

function decodeVoceChatPanelAction(raw: string | undefined): VoceChatPanelAction {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "l":
    case "list":
    case "accounts":
      return "accounts";
    case "a":
    case "account":
    case "detail":
      return "account-detail";
    case "w":
    case "webhook":
      return "webhook";
    case "r":
    case "routing":
    case "route":
      return "routing";
    case "x":
    case "access":
    case "auth":
      return "access";
    case "h":
    case "home":
    case "menu":
    case "status":
    default:
      return "home";
  }
}

function formatVoceChatGroupPolicy(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "open":
      return "开放";
    case "allowlist":
      return "白名单";
    case "denylist":
      return "黑名单";
    case "":
      return "未设置";
    default:
      return value;
  }
}

function formatVoceChatAdminMode(adminSenderIds: string[]): string {
  return adminSenderIds.length > 0 ? `插件白名单（${adminSenderIds.length}）` : "继承宿主授权";
}

function formatVoceChatTemplateState(current: string, defaultTemplate: string): string {
  return current === defaultTemplate ? "默认" : "已自定义";
}

function formatVoceChatCountPreview(entries: string[]): string {
  if (entries.length === 0) return "0";
  return `${entries.length}（${formatVoceChatMaskedEntries(entries)}）`;
}

function formatVoceChatMaskedEntries(entries: string[], max = 3): string {
  if (entries.length === 0) return "未设置";
  const preview = entries.slice(0, max).map(maskVoceChatEntry).join("、");
  return entries.length > max ? `${preview} 等 ${entries.length} 项` : preview;
}

function maskVoceChatEntry(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "<空>";
  const parts = trimmed.split(":");
  if (parts.length >= 2) {
    return `${parts[0]}:${maskVoceChatSegment(parts.slice(1).join(":"))}`;
  }
  return maskVoceChatSegment(trimmed);
}

function maskVoceChatSegment(value: string): string {
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-1)}`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

async function maybeHandleVoceChatEditCommand(rawArgs: string, cfg: OpenClawConfig): Promise<ReplyPayload | null> {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0] === "p" && tokens[1]) return null;

  switch (tokens[0].toLowerCase()) {
    case "admin":
    case "admins":
      return await handleVoceChatAdminEditCommand(tokens.slice(1), cfg);
    case "set":
      return await handleVoceChatSetCommand(tokens.slice(1), cfg);
    case "default-to":
    case "target":
      return await handleVoceChatDefaultTargetCommand(tokens.slice(1), cfg);
    default:
      return null;
  }
}

async function handleVoceChatAdminEditCommand(args: string[], cfg: OpenClawConfig): Promise<ReplyPayload> {
  const management = resolveVoceChatManagement(cfg);
  const action = (args[0] ?? "list").trim().toLowerCase();

  if (action === "list") {
    return {
      text: [
        "VoceChat 管理员设置",
        "",
        `当前管理员数量：${management.adminSenderIds.length}`,
        `管理员列表：${management.adminSenderIds.length > 0 ? management.adminSenderIds.join("、") : "未设置（继承宿主授权）"}`,
        "",
        `添加：/${VOCECHAT_CONTROL_COMMAND} admin add telegram:123456789`,
        `移除：/${VOCECHAT_CONTROL_COMMAND} admin remove telegram:123456789`,
        `清空：/${VOCECHAT_CONTROL_COMMAND} admin clear`,
      ].join("\n"),
    };
  }

  if (action === "add") {
    const senderId = normalizeIdentity(args.slice(1).join(" "));
    if (!senderId) {
      return { text: `用法：/${VOCECHAT_CONTROL_COMMAND} admin add <发送者ID>`, isError: true };
    }
    const summary = await updateVoceChatHostConfig((channelConfig) => {
      const managementSection = ensureMutableRecord(channelConfig, "management");
      const current = parseAllowEntries(managementSection.adminSenderIds);
      const merged = Array.from(new Set([...current.map(normalizeIdentity), senderId])).filter(Boolean);
      managementSection.adminSenderIds = merged;
      return `已添加管理员：${senderId}`;
    });
    return buildVoceChatMutationReply(summary);
  }

  if (action === "remove") {
    const senderId = normalizeIdentity(args.slice(1).join(" "));
    if (!senderId) {
      return { text: `用法：/${VOCECHAT_CONTROL_COMMAND} admin remove <发送者ID>`, isError: true };
    }
    const summary = await updateVoceChatHostConfig((channelConfig) => {
      const managementSection = ensureMutableRecord(channelConfig, "management");
      const current = parseAllowEntries(managementSection.adminSenderIds).map(normalizeIdentity).filter(Boolean);
      managementSection.adminSenderIds = current.filter((entry) => entry !== senderId);
      return `已移除管理员：${senderId}`;
    });
    return buildVoceChatMutationReply(summary);
  }

  if (action === "clear") {
    const summary = await updateVoceChatHostConfig((channelConfig) => {
      const managementSection = ensureMutableRecord(channelConfig, "management");
      managementSection.adminSenderIds = [];
      return "已清空管理员白名单，将回退为宿主授权控制。";
    });
    return buildVoceChatMutationReply(summary);
  }

  return {
    text: [
      "VoceChat 管理员设置",
      "",
      `不支持的动作：${action}`,
      `可用：/${VOCECHAT_CONTROL_COMMAND} admin list|add|remove|clear`,
    ].join("\n"),
    isError: true,
  };
}

async function handleVoceChatSetCommand(args: string[], cfg: OpenClawConfig): Promise<ReplyPayload | null> {
  const field = (args[0] ?? "").trim().toLowerCase();
  switch (field) {
    case "default-to":
    case "default":
    case "target":
      return await handleVoceChatDefaultTargetCommand(args.slice(1), cfg);
    default:
      return {
        text: [
          "VoceChat 配置编辑",
          "",
          `不支持的字段：${field || "<空>"}`,
          `可用：/${VOCECHAT_CONTROL_COMMAND} set default-to <目标>`,
          `或：/${VOCECHAT_CONTROL_COMMAND} set default-to <账号ID> <目标>`,
        ].join("\n"),
        isError: true,
      };
  }
}

async function handleVoceChatDefaultTargetCommand(args: string[], cfg: OpenClawConfig): Promise<ReplyPayload> {
  const currentDefault = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  if (args.length === 0) {
    return {
      text: [
        "VoceChat 默认目标设置",
        "",
        `当前默认账号：${currentDefault.accountId}`,
        `当前默认目标：${currentDefault.defaultTo ?? "<未设置>"}`,
        "",
        `设置默认账号目标：/${VOCECHAT_CONTROL_COMMAND} set default-to user:2`,
        `设置指定账号目标：/${VOCECHAT_CONTROL_COMMAND} set default-to backup user:5`,
      ].join("\n"),
    };
  }

  const single = parseTarget(args[0]);
  let accountId = DEFAULT_ACCOUNT_ID;
  let targetRaw = "";

  if (args.length === 1 && single) {
    targetRaw = `${single.kind}:${single.id}`;
  } else if (args.length >= 2) {
    accountId = normalizeAccountId(args[0]);
    const parsedTarget = parseTarget(args.slice(1).join(" "));
    if (!parsedTarget) {
      return {
        text: [
          "VoceChat 默认目标设置",
          "",
          "目标格式无效。",
          "示例：user:2 或 group:12345",
        ].join("\n"),
        isError: true,
      };
    }
    targetRaw = `${parsedTarget.kind}:${parsedTarget.id}`;
  } else {
    return {
      text: [
        "VoceChat 默认目标设置",
        "",
        "目标格式无效。",
        "示例：user:2 或 group:12345",
      ].join("\n"),
      isError: true,
    };
  }

  const summary = await updateVoceChatHostConfig((channelConfig) => {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      const accounts = asRecord(channelConfig.accounts);
      const defaultAccountSection = asRecord(accounts[DEFAULT_ACCOUNT_ID]);
      if (Object.keys(defaultAccountSection).length > 0) {
        const mutableAccounts = ensureMutableRecord(channelConfig, "accounts");
        const mutableDefault = ensureMutableRecord(mutableAccounts, DEFAULT_ACCOUNT_ID);
        mutableDefault.defaultTo = targetRaw;
      } else {
        channelConfig.defaultTo = targetRaw;
      }
      return `已更新默认账号目标：${targetRaw}`;
    }

    const accounts = ensureMutableRecord(channelConfig, "accounts");
    const accountSection = ensureMutableRecord(accounts, accountId);
    accountSection.defaultTo = targetRaw;
    return `已更新账号 ${accountId} 的默认目标：${targetRaw}`;
  });

  return buildVoceChatMutationReply(summary);
}

function buildVoceChatMutationReply(summary: string): ReplyPayload {
  return {
    text: [
      "VoceChat 配置已更新",
      "",
      summary,
      "宿主将按通道配置自动热重载。",
      `可重新发送 /${VOCECHAT_CONTROL_COMMAND} 查看最新状态。`,
    ].join("\n"),
  };
}

function isVoceChatAdminAuthorized(ctx: PluginCommandContext, management: VoceChatManagementConfig): boolean {
  if (!ctx.isAuthorizedSender) return false;
  const admins = management.adminSenderIds.map(normalizeIdentity).filter(Boolean);
  if (admins.length === 0) return true;
  const candidates = new Set<string>();
  for (const value of [ctx.senderId, ctx.from]) {
    const normalized = normalizeIdentity(value);
    if (!normalized) continue;
    candidates.add(normalized);
    if (!normalized.includes(":")) {
      candidates.add(normalizeIdentity(`${ctx.channel}:${normalized}`));
    }
  }
  return [...candidates].some((candidate) => admins.includes(candidate));
}

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function resolveVoceChatTelegramRuntime(cfg: OpenClawConfig): { botToken: string; apiBaseUrl?: string; proxyUrl?: string | null } | null {
  const telegram = asRecord(cfg.channels?.telegram);
  const botToken = normalizeString(telegram.botToken);
  if (!botToken) return null;
  return {
    botToken,
    apiBaseUrl: normalizeString(telegram.apiBaseUrl) || undefined,
    proxyUrl: normalizeString(telegram.proxy) || undefined,
  };
}

const plugin = {
  id: CHANNEL_ID,
  name: "VoceChat Channel",
  description: "VoceChat inbound/outbound channel integration",
  register(api: OpenClawPluginApi) {
    setVoceChatRuntime(api.runtime);
    api.registerChannel({ plugin: voceChatChannel });
    registerVoceChatManagementCommand(api);
  },
};

export default plugin;
