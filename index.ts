import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createWorker, OEM, PSM } from "tesseract.js";

import {
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  formatTextWithAttachmentLinks,
  loadOutboundMediaFromUrl,
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
const DEFAULT_INBOUND_MERGE_WINDOW_MS = 1200;
const DEFAULT_INBOUND_MERGE_MAX_MESSAGES = 3;
const DEFAULT_INBOUND_IMAGE_NORMALIZATION_ENABLED = true;
const DEFAULT_INBOUND_IMAGE_NORMALIZATION_MAX_EDGE = 2048;
const DEFAULT_INBOUND_IMAGE_NORMALIZATION_QUALITY = 90;
const DEFAULT_INBOUND_NATIVE_VISION_ENABLED = false;
const DEFAULT_INBOUND_OCR_ENABLED = true;
const DEFAULT_INBOUND_OCR_LANGS = "chi_sim+eng";
const DEFAULT_INBOUND_OCR_LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";
const DEFAULT_INBOUND_OCR_TIMEOUT_MS = 120000;
const DEFAULT_INBOUND_OCR_MAX_TEXT_LENGTH = 3000;
const RECENT_MESSAGE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MAX_INBOUND_IMAGE_ATTACHMENTS = 8;
const INBOUND_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);
const ALLOWED_INBOUND_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
]);
const IMAGE_TYPE_KEYWORDS = new Set(["image", "img", "photo", "picture", "pic", "snapshot"]);

type InboundParseMode = "legacy" | "balanced" | "strict";

type VoceChatGroupConfig = {
  enabled?: boolean;
  allow?: boolean;
  requireMention?: boolean;
};

type ResolvedVoceChatGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
};

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
  inboundMergeEnabled?: boolean;
  inboundMergeWindowMs?: number;
  inboundMergeMaxMessages?: number;
  inboundImageNormalizationEnabled?: boolean;
  inboundImageNormalizationMaxEdge?: number;
  inboundImageNormalizationQuality?: number;
  inboundNativeVisionEnabled?: boolean;
  inboundOcrEnabled?: boolean;
  inboundOcrLangs?: string;
  inboundOcrTimeoutMs?: number;
  inboundOcrMaxTextLength?: number;
  inboundOcrLangPath?: string;
  webhookPath?: string;
  webhookApiKey?: string;
  groupPolicy?: string;
  groups?: unknown;
  allowFrom?: unknown;
  groupAllowFrom?: unknown;
};

type VoceChatApprovalConfig = {
  enabled?: boolean;
  stateFile?: string;
  publicBaseUrl?: string;
  routePath?: string;
  notifyAdminSenderIds?: unknown;
  fanoutToAdmins?: boolean;
  fanoutToSession?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

type VoceChatChannelConfig = VoceChatAccountConfig & {
  accounts?: Record<string, VoceChatAccountConfig>;
  approvals?: VoceChatApprovalConfig;
};

type VoceChatQuickTargets = {
  users: string[];
  groups: string[];
};

type VoceChatManagementConfig = {
  adminSenderIds: string[];
  panelStateFile: string;
  quickTargets: VoceChatQuickTargets;
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
  inboundMergeEnabled: boolean;
  inboundMergeWindowMs: number;
  inboundMergeMaxMessages: number;
  inboundImageNormalizationEnabled: boolean;
  inboundImageNormalizationMaxEdge: number;
  inboundImageNormalizationQuality: number;
  inboundNativeVisionEnabled: boolean;
  inboundOcrEnabled: boolean;
  inboundOcrLangs: string[];
  inboundOcrTimeoutMs: number;
  inboundOcrMaxTextLength: number;
  inboundOcrLangPath?: string;
  webhookPath: string;
  webhookApiKey?: string;
  groups: Record<string, ResolvedVoceChatGroupConfig>;
  allowFrom: string[];
  groupAllowFrom: string[];
};

type TargetKind = "user" | "group";
type ParsedTarget = {
  kind: TargetKind;
  id: string;
};

type VoceChatApprovalRecipient = {
  accountId: string;
  target: string;
  source: "session" | "admin";
};

type VoceChatApprovalStatus = "pending" | "resolved" | "expired";

type ApprovalRequestSummary = {
  command?: string | null;
  cwd?: string | null;
  host?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
};

type VoceChatApprovalRequestedEvent = {
  id: string;
  request: ApprovalRequestSummary;
  createdAtMs: number;
  expiresAtMs: number;
};

type VoceChatApprovalResolvedEvent = {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
  resolvedBy?: string | null;
  ts: number;
  request?: ApprovalRequestSummary;
};

type StoredVoceChatApprovalRecord = {
  approvalId: string;
  status: VoceChatApprovalStatus;
  recipients: VoceChatApprovalRecipient[];
  createdAtMs: number;
  expiresAtMs: number;
  sentAtMs: number;
  request: ApprovalRequestSummary;
  actionTokens?: Partial<Record<"allow-once" | "allow-always" | "deny", string>>;
  decision?: "allow-once" | "allow-always" | "deny";
  resolvedBy?: string | null;
  resolvedAtMs?: number;
  expiredAtMs?: number;
};

type VoceChatHttpResponse = {
  status: number;
  ok: boolean;
  body: string;
};

type InboundAttachment = {
  kind: "image";
  messageId: string;
  source: string;
  attachmentId?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  storedFile?: string;
  normalizedFile?: string;
  localFile?: string;
  normalizationError?: string;
  ocrEngine?: string;
  ocrLangs?: string;
  ocrConfidence?: number;
  ocrText?: string;
  ocrTruncated?: boolean;
  ocrError?: string;
  downloadError?: string;
};

type InboundEvent = {
  messageId: string;
  fromUid: string;
  chatType: "direct" | "group";
  conversationId: string;
  groupId?: string;
  text: string;
  originalText: string;
  timestamp: number;
  replyTarget: string;
  sourceMessageIds: string[];
  attachments: InboundAttachment[];
  imageUrls: string[];
  localFiles: string[];
};

type PendingInboundMerge = {
  key: string;
  accountId: string;
  createdAt: number;
  flushAt: number;
  events: InboundEvent[];
  timer?: ReturnType<typeof setTimeout>;
};

let runtimeRef: PluginRuntime | null = null;
const activeRouteUnregisters = new Map<string, () => void>();
const recentOutboundMessageIds = new Map<string, number>();
const recentInboundMessageIds = new Map<string, number>();
const pendingInboundMerges = new Map<string, PendingInboundMerge>();

class VoceChatApprovalStore {
  private readonly filePath: string;

  private readonly approvals = new Map<string, StoredVoceChatApprovalRecord>();

  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(approvalId: string): Promise<StoredVoceChatApprovalRecord | undefined> {
    await this.ensureLoaded();
    return this.approvals.get(approvalId);
  }

  async upsert(record: StoredVoceChatApprovalRecord): Promise<void> {
    await this.ensureLoaded();
    this.approvals.set(record.approvalId, record);
    await this.persist();
  }

  async update(
    approvalId: string,
    updater: (current: StoredVoceChatApprovalRecord) => StoredVoceChatApprovalRecord,
  ): Promise<StoredVoceChatApprovalRecord | undefined> {
    await this.ensureLoaded();
    const current = this.approvals.get(approvalId);
    if (!current) return undefined;
    const next = updater(current);
    this.approvals.set(approvalId, next);
    await this.persist();
    return next;
  }

  async listExpiredPending(nowMs: number): Promise<StoredVoceChatApprovalRecord[]> {
    await this.ensureLoaded();
    return [...this.approvals.values()].filter((record) => record.status === "pending" && record.expiresAtMs <= nowMs);
  }

  async findByActionToken(
    token: string,
  ): Promise<{ record: StoredVoceChatApprovalRecord; decision: "allow-once" | "allow-always" | "deny" } | undefined> {
    await this.ensureLoaded();
    for (const record of this.approvals.values()) {
      const tokens = record.actionTokens;
      if (!tokens) continue;
      if (tokens["allow-once"] === token) return { record, decision: "allow-once" };
      if (tokens["allow-always"] === token) return { record, decision: "allow-always" };
      if (tokens["deny"] === token) return { record, decision: "deny" };
    }
    return undefined;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const approvals = asRecord(parsed?.approvals);
      for (const record of Object.values(approvals)) {
        const approval = asStoredVoceChatApprovalRecord(record);
        if (approval) this.approvals.set(approval.approvalId, approval);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomically(this.filePath, {
      version: 1,
      approvals: Object.fromEntries(this.approvals.entries()),
    });
  }
}

class VoceChatApprovalForwarderService {
  private readonly cfg: OpenClawConfig;

  private readonly logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug?(message: string): void;
  };

  private readonly version: string;

  private readonly store: VoceChatApprovalStore;

  private socket: WebSocket | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private reconnectAttempt = 0;

  private shouldStop = false;

  private connectRequestId: string | null = null;

  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  private approvalRouteUnregister: (() => void) | null = null;

  constructor(params: {
    cfg: OpenClawConfig;
    logger: { info(message: string): void; warn(message: string): void; error(message: string): void; debug?(message: string): void };
    version: string;
  }) {
    this.cfg = params.cfg;
    this.logger = params.logger;
    this.version = params.version;
    this.store = new VoceChatApprovalStore(resolveVoceChatApprovalStateFile(this.cfg));
  }

  start(): void {
    const approvalCfg = resolveVoceChatApprovalSettings(this.cfg);
    if (!approvalCfg.enabled) {
      this.logger.info("[vocechat] approval forwarder disabled");
      return;
    }
    this.logger.info(`[vocechat] approval forwarder enabled stateFile=${approvalCfg.stateFile}`);
    this.registerApprovalRoute(approvalCfg);
    this.shouldStop = false;
    this.connect();
    this.expiryTimer = setInterval(() => {
      void this.processExpired();
    }, 15_000);
    this.expiryTimer.unref?.();
  }

  stop(): void {
    this.shouldStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.approvalRouteUnregister) {
      this.approvalRouteUnregister();
      this.approvalRouteUnregister = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    const runtime = resolveVoceChatApprovalGatewayRuntime(this.cfg);
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      this.logger.error("[vocechat] approval forwarder unavailable: runtime WebSocket is missing");
      return;
    }

    const socket = new WebSocketCtor(runtime.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.connectRequestId = randomUUID();
      this.sendFrame({
        type: "req",
        id: this.connectRequestId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          role: "operator",
          scopes: ["operator.approvals"],
          client: {
            id: "gateway-client",
            displayName: "VoceChat Approval Forwarder",
            version: this.version,
            platform: `${os.platform()}-${os.release()}`,
            mode: "backend",
            instanceId: os.hostname(),
          },
          auth: {
            ...(runtime.token ? { token: runtime.token } : {}),
            ...(runtime.password ? { password: runtime.password } : {}),
          },
        },
      });
    });

    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(event.data);
    });

    socket.addEventListener("close", (event) => {
      this.logger.warn(`[vocechat] approval gateway disconnected: ${event.reason || `close code ${event.code}`}`);
      this.socket = null;
      if (!this.shouldStop) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.logger.warn("[vocechat] approval gateway socket error");
    });
  }

  private async handleSocketMessage(data: unknown): Promise<void> {
    try {
      const text = await readWebSocketPayloadText(data);
      if (!text) return;
      const frame = JSON.parse(text) as Record<string, unknown>;
      const type = normalizeString(frame.type);
      if (type === "res") {
        if (normalizeString(frame.id) === this.connectRequestId) {
          if (frame.ok === false) {
            throw new Error(normalizeString(asRecord(frame.error).message) || "approval gateway connect failed");
          }
          this.logger.info("[vocechat] approval gateway connected");
        }
        return;
      }
      if (type !== "event") return;
      const eventName = normalizeString(frame.event);
      if (eventName === "exec.approval.requested") {
        await this.handleRequested(frame.payload as VoceChatApprovalRequestedEvent);
        return;
      }
      if (eventName === "exec.approval.resolved") {
        await this.handleResolved(frame.payload as VoceChatApprovalResolvedEvent);
      }
    } catch (error) {
      this.logger.error(`[vocechat] approval message handling failed: ${String(error)}`);
    }
  }

  private async handleRequested(event: VoceChatApprovalRequestedEvent): Promise<void> {
    const approvalId = normalizeString(event?.id);
    if (!approvalId) return;

    const existing = await this.store.get(approvalId);
    if (existing?.status === "pending") {
      this.logger.info(`[vocechat] skip duplicate approval ${approvalId}`);
      return;
    }

    const recipients = resolveVoceChatApprovalRecipients(this.cfg, event);
    if (recipients.length === 0) {
      this.logger.debug?.(`[vocechat] approval ${approvalId} has no vocechat recipients`);
      return;
    }

    const approvalCfg = resolveVoceChatApprovalSettings(this.cfg);
    const actionTokens = approvalCfg.publicBaseUrl ? createApprovalActionTokens() : undefined;
    const text = renderVoceChatRequestedApproval(
      event,
      actionTokens
        ? {
            publicBaseUrl: approvalCfg.publicBaseUrl,
            routePath: approvalCfg.routePath,
            actionTokens,
          }
        : undefined,
    );
    const successfulRecipients: VoceChatApprovalRecipient[] = [];
    for (const recipient of recipients) {
      try {
        await sendVoceChatMessage({
          cfg: this.cfg,
          accountId: recipient.accountId,
          to: recipient.target,
          text,
        } as ChannelOutboundContext);
        successfulRecipients.push(recipient);
      } catch (error) {
        this.logger.warn(
          `[vocechat] approval notify failed id=${approvalId} account=${recipient.accountId} target=${recipient.target} err=${String(error)}`,
        );
      }
    }

    if (successfulRecipients.length === 0) return;
    await this.store.upsert({
      approvalId,
      status: "pending",
      recipients: successfulRecipients,
      createdAtMs: Number(event.createdAtMs) || Date.now(),
      expiresAtMs: Number(event.expiresAtMs) || Date.now() + 180_000,
      sentAtMs: Date.now(),
      request: sanitizeApprovalRequest(event.request),
      actionTokens,
    });
    this.logger.info(`[vocechat] approval ${approvalId} forwarded to ${successfulRecipients.length} vocechat recipients`);
  }

  private async handleResolved(event: VoceChatApprovalResolvedEvent): Promise<void> {
    const approvalId = normalizeString(event?.id);
    if (!approvalId) return;
    const record = await this.store.get(approvalId);
    if (!record) return;

    const text = renderVoceChatResolvedApproval(record, event);
    for (const recipient of record.recipients) {
      try {
        await sendVoceChatMessage({
          cfg: this.cfg,
          accountId: recipient.accountId,
          to: recipient.target,
          text,
        } as ChannelOutboundContext);
      } catch (error) {
        this.logger.warn(
          `[vocechat] approval resolved notify failed id=${approvalId} account=${recipient.accountId} target=${recipient.target} err=${String(error)}`,
        );
      }
    }

    await this.store.update(approvalId, (current) => ({
      ...current,
      status: "resolved",
      decision: event.decision,
      resolvedBy: event.resolvedBy ?? null,
      resolvedAtMs: Number(event.ts) || Date.now(),
    }));
  }

  private async processExpired(): Promise<void> {
    const expired = await this.store.listExpiredPending(Date.now());
    for (const record of expired) {
      const text = renderVoceChatExpiredApproval(record);
      for (const recipient of record.recipients) {
        try {
          await sendVoceChatMessage({
            cfg: this.cfg,
            accountId: recipient.accountId,
            to: recipient.target,
            text,
          } as ChannelOutboundContext);
        } catch (error) {
          this.logger.warn(
            `[vocechat] approval expired notify failed id=${record.approvalId} account=${recipient.accountId} target=${recipient.target} err=${String(error)}`,
          );
        }
      }
      await this.store.update(record.approvalId, (current) => ({
        ...current,
        status: "expired",
        expiredAtMs: Date.now(),
      }));
    }
  }

  private scheduleReconnect(): void {
    const runtime = resolveVoceChatApprovalGatewayRuntime(this.cfg);
    const delayMs = Math.min(runtime.reconnectMaxMs, Math.round(runtime.reconnectBaseMs * 2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("approval gateway socket not connected");
    }
    this.socket.send(JSON.stringify(frame));
  }

  private registerApprovalRoute(approvalCfg: {
    routePath: string;
    publicBaseUrl: string;
  }): void {
    if (this.approvalRouteUnregister) {
      this.approvalRouteUnregister();
      this.approvalRouteUnregister = null;
    }
    const routePath = normalizeRoutePath(approvalCfg.routePath, "/vocechat/approval");
    const handler = this.createApprovalRouteHandler();
    this.approvalRouteUnregister = registerPluginHttpRoute({
      path: routePath,
      handler: handler as any,
      pluginId: CHANNEL_ID,
      accountId: DEFAULT_ACCOUNT_ID,
      replaceExisting: true,
      log: (message) => this.logger.info(message),
    });
    this.logger.info(
      `[vocechat] approval route registered path=${routePath}${approvalCfg.publicBaseUrl ? ` publicBaseUrl=${approvalCfg.publicBaseUrl}` : ""}`,
    );
  }

  private createApprovalRouteHandler() {
    return async (
      req: { method?: string; url?: string },
      res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void },
    ) => {
      const method = normalizeString(req.method).toUpperCase() || "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      let token = normalizeString(requestUrl.searchParams.get("token"));

      if (method !== "GET" && method !== "POST") {
        writeHtml(
          res,
          405,
          renderVoceChatApprovalResultPage({
            title: "方法不支持",
            heading: "请求方法不支持",
            tone: "error",
            detail: `当前仅支持 GET 和 POST，收到：${method}`,
          }),
        );
        return;
      }

      if (method === "POST") {
        try {
          const body = await readRequestTextWithLimit(req as any, 8 * 1024);
          const form = new URLSearchParams(body);
          token = normalizeString(form.get("token")) || token;
        } catch (error) {
          writeHtml(
            res,
            400,
            renderVoceChatApprovalResultPage({
              title: "请求无效",
              heading: "审批提交失败",
              tone: "error",
              detail: `无法读取提交内容：${String(error)}`,
            }),
          );
          return;
        }
      }

      if (!token) {
        writeHtml(
          res,
          400,
          renderVoceChatApprovalResultPage({
            title: "缺少参数",
            heading: "缺少审批令牌",
            tone: "error",
            detail: "请从 VoceChat 审批消息重新点击对应链接。",
          }),
        );
        return;
      }

      const runtime = getVoceChatRuntime();
      const cfg = await runtime.config.loadConfig();
      const store = new VoceChatApprovalStore(resolveVoceChatApprovalStateFile(cfg));
      const matched = await store.findByActionToken(token);
      if (!matched) {
        writeHtml(
          res,
          404,
          renderVoceChatApprovalResultPage({
            title: "审批不存在",
            heading: "审批链接无效或已失效",
            tone: "error",
            detail: "对应审批记录未找到。请返回 VoceChat 查看最新审批消息。",
          }),
        );
        return;
      }

      const { record, decision } = matched;
      const expired = record.status === "expired" || record.expiresAtMs <= Date.now();
      if (expired && record.status === "pending") {
        await store.update(record.approvalId, (current) => ({
          ...current,
          status: "expired",
          expiredAtMs: Date.now(),
        }));
      }

      if (record.status === "resolved") {
        writeHtml(res, 200, renderVoceChatApprovalResolvedPage(record, decision));
        return;
      }
      if (expired) {
        writeHtml(res, 410, renderVoceChatApprovalExpiredPage(record, decision));
        return;
      }
      if (method === "GET") {
        if (decision === "allow-always") {
          writeHtml(res, 200, renderVoceChatApprovalConfirmPage(record, decision, token));
          return;
        }
        writeHtml(res, 200, renderVoceChatApprovalAutoSubmitPage(record, decision, token));
        return;
      }

      try {
        await submitVoceChatApprovalDecision({
          cfg,
          approvalId: record.approvalId,
          decision,
          version: this.version,
        });
        await store.update(record.approvalId, (current) => ({
          ...current,
          status: "resolved",
          decision,
          resolvedBy: "vocechat-link",
          resolvedAtMs: Date.now(),
        }));
        writeHtml(res, 200, renderVoceChatApprovalSuccessPage(record, decision));
      } catch (error) {
        this.logger.error(`[vocechat] approval resolve via web failed id=${record.approvalId} err=${String(error)}`);
        writeHtml(
          res,
          502,
          renderVoceChatApprovalResultPage({
            title: "提交失败",
            heading: "审批提交失败",
            tone: "error",
            detail: String(error),
            record,
            decision,
          }),
        );
      }
    };
  }
}

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
  const attachmentKeys = Object.keys({ ...payload, ...detail }).filter((key) =>
    /(attachment|file|media|image|photo|picture|pic)/i.test(key),
  );

  return [
    `account=${clipAuditSegment(accountId)}`,
    `types=${clipAuditSegment(uniqueTypes.join("|"))}`,
    `hasTextField=${hasTextField ? "yes" : "no"}`,
    `attachmentKeys=${clipAuditSegment(attachmentKeys.join("|"))}`,
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

function parseInboundOcrLanguages(value: unknown): string[] {
  const raw = normalizeString(value);
  const parts = (raw || DEFAULT_INBOUND_OCR_LANGS)
    .split(/[+,]/)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
  return Array.from(new Set(parts.length > 0 ? parts : ["eng"]));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[] {
  const root = asRecord(cfg as Record<string, unknown>);
  const messages = asRecord(root.messages);
  const groupChat = asRecord(messages.groupChat);
  const patterns = parseAllowEntries(groupChat.mentionPatterns);

  const normalizedAgentId = normalizeString(agentId);
  if (normalizedAgentId) {
    patterns.push(normalizedAgentId);
    const agentsSection = asRecord(root.agents);
    const agentList = Array.isArray(agentsSection.list) ? agentsSection.list : [];
    const agentRecord = agentList.find((entry) => normalizeString(asRecord(entry).id) === normalizedAgentId);
    if (agentRecord) {
      const agent = asRecord(agentRecord);
      patterns.push(normalizeString(agent.name));
      const identity = asRecord(agent.identity);
      patterns.push(normalizeString(identity.name));
    }
  }

  return Array.from(new Set(patterns.map((pattern) => normalizeString(pattern)).filter(Boolean))).map((pattern) => {
    const escaped = escapeRegExp(pattern);
    if (/^[A-Za-z0-9_.:-]+$/.test(pattern)) {
      return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
    }
    return new RegExp(escaped, "u");
  });
}

function matchesMentionPatterns(text: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const candidate = typeof text === "string" ? text : "";
  return patterns.some((pattern) => pattern.test(candidate));
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

function normalizeOcrText(text: string): string {
  return text
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeMimeType(value: unknown): string {
  return normalizeString(value).toLowerCase().split(";")[0]?.trim() || "";
}

function parseOptionalSize(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.trunc(numeric);
}

function isAllowedInboundImageMimeType(value: unknown): boolean {
  const normalized = normalizeMimeType(value);
  if (!normalized) return false;
  return ALLOWED_INBOUND_IMAGE_MIME_TYPES.has(normalized);
}

function inferMimeTypeFromExtension(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      return undefined;
  }
}

function inferExtensionFromMimeType(mimeType: string): string {
  switch (normalizeMimeType(mimeType)) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tif";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    default:
      return "";
  }
}

function sanitizePathSegment(input: string, fallback: string, maxLength = 120): string {
  const raw = input.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ");
  const normalized = raw.replace(/\.+$/g, "").trim();
  if (!normalized || normalized === "." || normalized === "..") return fallback;
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength);
}

function sanitizeFileName(input: string, fallback = "attachment"): string {
  return sanitizePathSegment(path.basename(input), fallback);
}

function isImageExtension(ext: string): boolean {
  return INBOUND_IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

function extractExtensionFromPathLike(value: string): string {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  try {
    const parsed = normalized.includes("://") ? new URL(normalized) : new URL(normalized, "https://vocechat.local");
    return path.extname(parsed.pathname || "");
  } catch {
    return path.extname(normalized.split("?")[0] || "");
  }
}

function isLikelyVoceChatStoredFilePath(value: unknown): boolean {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  if (normalized.includes("?") || normalized.includes("#")) return false;
  if (normalized.startsWith("/")) return false;
  return /^\d{4}\/\d{1,2}\/\d{1,2}\/[A-Za-z0-9][A-Za-z0-9-]{15,}$/.test(normalized);
}

function isLikelyImageReference(value: unknown): boolean {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  const ext = extractExtensionFromPathLike(normalized);
  if (isImageExtension(ext)) return true;
  return /\/image(s)?\//i.test(normalized);
}

function isImageTypeKeyword(value: unknown): boolean {
  const normalized = normalizeInboundType(value);
  if (!normalized) return false;
  if (IMAGE_TYPE_KEYWORDS.has(normalized)) return true;
  return normalized.startsWith("image") || normalized.startsWith("photo") || normalized.startsWith("picture");
}

function resolveInboundMediaUrl(account: ResolvedAccount, rawUrl: string): string {
  const normalized = normalizeString(rawUrl);
  if (!normalized) return "";
  if (isLikelyVoceChatStoredFilePath(normalized)) {
    if (!account.baseUrl) return normalized;
    return `${account.baseUrl}/api/resource/file?file_path=${encodeURIComponent(normalized)}`;
  }
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (normalized.startsWith("//")) {
    try {
      return new URL(account.baseUrl).protocol + normalized;
    } catch {
      return `https:${normalized}`;
    }
  }
  if (!account.baseUrl) return normalized;
  if (normalized.startsWith("/")) return `${account.baseUrl}${normalized}`;
  return `${account.baseUrl}/${normalized.replace(/^\.?\//, "")}`;
}

function extractImageReferencesFromText(raw: string): string[] {
  const normalized = normalizeString(raw);
  if (!normalized) return [];

  const matches = new Set<string>();
  const markdownImage = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const htmlImage = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const bareRef = /(?:https?:\/\/|\/)[^\s<>()]+/g;

  for (const match of normalized.matchAll(markdownImage)) {
    const candidate = normalizeString(match[1]);
    if (candidate && isLikelyImageReference(candidate)) matches.add(candidate);
  }
  for (const match of normalized.matchAll(htmlImage)) {
    const candidate = normalizeString(match[1]);
    if (candidate && isLikelyImageReference(candidate)) matches.add(candidate);
  }
  for (const match of normalized.matchAll(bareRef)) {
    const candidate = normalizeString(match[0]);
    if (candidate && isLikelyImageReference(candidate)) matches.add(candidate);
  }

  return [...matches];
}

function stripImageReferencesFromText(raw: string): string {
  if (!raw) return "";
  return normalizeInboundText(
    raw
      .replace(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, " ")
      .replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, " ")
      .replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\/[A-Za-z0-9][A-Za-z0-9-]{15,}\b/g, " ")
      .replace(/(?:https?:\/\/|\/)[^\s<>()]+/g, (segment) => (isLikelyImageReference(segment) ? " " : segment)),
  );
}

function dedupeInboundAttachments(attachments: InboundAttachment[]): InboundAttachment[] {
  const seen = new Set<string>();
  const deduped: InboundAttachment[] = [];

  for (const attachment of attachments) {
    const key = [
      attachment.attachmentId || "-",
      attachment.url || "-",
      attachment.fileName || "-",
      attachment.mimeType || "-",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(attachment);
    if (deduped.length >= MAX_INBOUND_IMAGE_ATTACHMENTS) break;
  }

  return deduped;
}

function collectInboundAttachmentCandidates(
  value: unknown,
  source: string,
  results: Array<{ source: string; value: unknown }>,
  depth = 0,
): void {
  if (value === undefined || value === null || depth > 3) return;

  if (Array.isArray(value)) {
    for (const entry of value) collectInboundAttachmentCandidates(entry, source, results, depth + 1);
    return;
  }

  if (typeof value === "string") {
    const refs = extractImageReferencesFromText(value);
    if (refs.length === 0 && !isLikelyImageReference(value)) return;
    if (refs.length === 0) {
      results.push({ source, value });
      return;
    }
    for (const ref of refs) results.push({ source: `${source}.text`, value: ref });
    return;
  }

  if (typeof value !== "object") return;

  results.push({ source, value });
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (!/(attachment|file|media|image|photo|picture|pic|preview|url|path)/i.test(key)) continue;
    collectInboundAttachmentCandidates(entry, `${source}.${key}`, results, depth + 1);
  }
}

function parseInboundAttachmentCandidate(params: {
  value: unknown;
  source: string;
  messageId: string;
  account: ResolvedAccount;
}): InboundAttachment[] {
  const { value, source, messageId, account } = params;

  if (typeof value === "string") {
    const refs = extractImageReferencesFromText(value);
    const candidates = refs.length > 0 ? refs : [value];
    return candidates
      .map((candidate) => resolveInboundMediaUrl(account, candidate))
      .filter((candidate) => isLikelyImageReference(candidate))
      .map((candidate) => ({
        kind: "image" as const,
        messageId,
        source,
        url: candidate,
      }));
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) return [];
  const properties = asRecord(record.properties);

  const nestedCandidates: InboundAttachment[] = [];
  for (const key of ["attachment", "attachments", "file", "files", "image", "images", "media", "medias"]) {
    if (!hasOwn(record, key)) continue;
    const nested: Array<{ source: string; value: unknown }> = [];
    collectInboundAttachmentCandidates(record[key], `${source}.${key}`, nested, 1);
    for (const candidate of nested) {
      nestedCandidates.push(
        ...parseInboundAttachmentCandidate({
          value: candidate.value,
          source: candidate.source,
          messageId,
          account,
        }),
      );
    }
  }
  if (nestedCandidates.length > 0) return nestedCandidates;

  const mimeType = normalizeMimeType(
    firstNonEmptyString([
      record.mime,
      record.mime_type,
      record.mimeType,
      record.content_type,
      record.contentType,
      record.file_type,
      record.fileType,
      properties.mime,
      properties.mime_type,
      properties.mimeType,
      properties.content_type,
      properties.contentType,
      properties.file_type,
      properties.fileType,
    ]),
  );
  const fileName = firstNonEmptyString([
    record.file_name,
    record.fileName,
    record.filename,
    record.name,
    record.title,
    properties.file_name,
    properties.fileName,
    properties.filename,
    properties.name,
    properties.title,
  ]);
  const rawUrl = firstNonEmptyString([
    record.url,
    record.src,
    record.href,
    record.path,
    record.file_path,
    record.filePath,
    record.download_url,
    record.downloadUrl,
    record.image_url,
    record.imageUrl,
    record.preview_url,
    record.previewUrl,
    record.content,
    properties.url,
    properties.src,
    properties.href,
    properties.path,
    properties.file_path,
    properties.filePath,
    properties.download_url,
    properties.downloadUrl,
    properties.image_url,
    properties.imageUrl,
    properties.preview_url,
    properties.previewUrl,
  ]);
  const url = rawUrl ? resolveInboundMediaUrl(account, rawUrl) : "";
  const attachmentId = firstNonEmptyId([
    record.attachment_id,
    record.attachmentId,
    record.file_id,
    record.fileId,
    record.image_id,
    record.imageId,
    record.id,
    properties.attachment_id,
    properties.attachmentId,
    properties.file_id,
    properties.fileId,
    properties.image_id,
    properties.imageId,
    properties.id,
  ]);
  if (!url && !attachmentId) return [];
  const sizeBytes =
    parseOptionalSize(record.size) ??
    parseOptionalSize(record.file_size) ??
    parseOptionalSize(record.fileSize) ??
    parseOptionalSize(record.bytes) ??
    parseOptionalSize(properties.size) ??
    parseOptionalSize(properties.file_size) ??
    parseOptionalSize(properties.fileSize) ??
    parseOptionalSize(properties.bytes);
  const looksLikeImage =
    isAllowedInboundImageMimeType(mimeType) ||
    isImageTypeKeyword(record.type) ||
    isImageTypeKeyword(record.message_type) ||
    isImageTypeKeyword(record.kind) ||
    isImageTypeKeyword(record.content_type) ||
    isImageTypeKeyword(properties.type) ||
    isImageTypeKeyword(properties.message_type) ||
    isImageTypeKeyword(properties.kind) ||
    isImageTypeKeyword(properties.content_type) ||
    isLikelyImageReference(url) ||
    isLikelyImageReference(fileName);

  if (!looksLikeImage) return [];

  return [
    {
      kind: "image",
      messageId,
      source,
      attachmentId: attachmentId || undefined,
      url: url || undefined,
      fileName: fileName || undefined,
      mimeType: mimeType || undefined,
      sizeBytes,
    },
  ];
}

function extractInboundAttachments(raw: unknown, messageId: string, account: ResolvedAccount): InboundAttachment[] {
  const payload = asRecord(raw);
  const detail = asRecord(payload.detail);
  const candidates: Array<{ source: string; value: unknown }> = [];

  const roots: Array<{ label: string; value: unknown }> = [
    { label: "payload", value: payload },
    { label: "detail", value: detail },
    { label: "payload", value: payload.attachments },
    { label: "payload", value: payload.attachment },
    { label: "payload", value: payload.files },
    { label: "payload", value: payload.file },
    { label: "payload", value: payload.media },
    { label: "payload", value: payload.medias },
    { label: "payload", value: payload.images },
    { label: "payload", value: payload.image },
    { label: "payload", value: payload.imageUrls },
    { label: "payload", value: payload.image_urls },
    { label: "payload", value: payload.properties },
    { label: "payload", value: payload.content },
    { label: "payload", value: payload.preview },
    { label: "detail", value: detail.attachments },
    { label: "detail", value: detail.attachment },
    { label: "detail", value: detail.files },
    { label: "detail", value: detail.file },
    { label: "detail", value: detail.media },
    { label: "detail", value: detail.medias },
    { label: "detail", value: detail.images },
    { label: "detail", value: detail.image },
    { label: "detail", value: detail.imageUrls },
    { label: "detail", value: detail.image_urls },
    { label: "detail", value: detail.properties },
    { label: "detail", value: detail.content },
    { label: "detail", value: detail.preview },
  ];

  for (const root of roots) {
    collectInboundAttachmentCandidates(root.value, root.label, candidates);
  }

  const parsed = candidates.flatMap((candidate) =>
    parseInboundAttachmentCandidate({
      value: candidate.value,
      source: candidate.source,
      messageId,
      account,
    }),
  );
  return dedupeInboundAttachments(parsed);
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
    inboundMergeEnabled: parseBoolean(merged.inboundMergeEnabled, true),
    inboundMergeWindowMs: parseBoundedInt(merged.inboundMergeWindowMs, DEFAULT_INBOUND_MERGE_WINDOW_MS, 0, 10000),
    inboundMergeMaxMessages: parseBoundedInt(merged.inboundMergeMaxMessages, DEFAULT_INBOUND_MERGE_MAX_MESSAGES, 1, 10),
    inboundImageNormalizationEnabled: parseBoolean(
      merged.inboundImageNormalizationEnabled,
      DEFAULT_INBOUND_IMAGE_NORMALIZATION_ENABLED,
    ),
    inboundImageNormalizationMaxEdge: parseBoundedInt(
      merged.inboundImageNormalizationMaxEdge,
      DEFAULT_INBOUND_IMAGE_NORMALIZATION_MAX_EDGE,
      512,
      4096,
    ),
    inboundImageNormalizationQuality: parseBoundedInt(
      merged.inboundImageNormalizationQuality,
      DEFAULT_INBOUND_IMAGE_NORMALIZATION_QUALITY,
      60,
      100,
    ),
    inboundNativeVisionEnabled: parseBoolean(
      merged.inboundNativeVisionEnabled,
      DEFAULT_INBOUND_NATIVE_VISION_ENABLED,
    ),
    inboundOcrEnabled: parseBoolean(merged.inboundOcrEnabled, DEFAULT_INBOUND_OCR_ENABLED),
    inboundOcrLangs: parseInboundOcrLanguages(merged.inboundOcrLangs),
    inboundOcrTimeoutMs: parseBoundedInt(
      merged.inboundOcrTimeoutMs,
      DEFAULT_INBOUND_OCR_TIMEOUT_MS,
      5000,
      120000,
    ),
    inboundOcrMaxTextLength: parseBoundedInt(
      merged.inboundOcrMaxTextLength,
      DEFAULT_INBOUND_OCR_MAX_TEXT_LENGTH,
      200,
      10000,
    ),
    inboundOcrLangPath: normalizeString(merged.inboundOcrLangPath) || DEFAULT_INBOUND_OCR_LANG_PATH,
    webhookPath: normalizeWebhookPath(merged.webhookPath),
    webhookApiKey: normalizeString(merged.webhookApiKey) || undefined,
    groups: parseVoceChatGroups(merged.groups),
    allowFrom: parseAllowEntries(merged.allowFrom),
    groupAllowFrom: parseAllowEntries(merged.groupAllowFrom),
  };
}

function parseVoceChatGroups(value: unknown): Record<string, ResolvedVoceChatGroupConfig> {
  const groups = asRecord(value);
  const result: Record<string, ResolvedVoceChatGroupConfig> = {};
  for (const [groupId, raw] of Object.entries(groups)) {
    const record = asRecord(raw);
    const next: ResolvedVoceChatGroupConfig = {};
    if (hasOwn(record, "enabled")) next.enabled = parseBoolean(record.enabled, true);
    else if (hasOwn(record, "allow")) next.enabled = parseBoolean(record.allow, true);
    if (hasOwn(record, "requireMention")) next.requireMention = parseBoolean(record.requireMention, true);
    result[String(groupId)] = next;
  }
  return result;
}

function resolveVoceChatGroupConfig(
  account: ResolvedAccount,
  groupId?: string,
): ResolvedVoceChatGroupConfig | undefined {
  const normalizedGroupId = normalizeString(groupId);
  if (normalizedGroupId && hasOwn(account.groups, normalizedGroupId)) {
    return account.groups[normalizedGroupId];
  }
  return account.groups["*"];
}

function resolveVoceChatManagement(cfg: OpenClawConfig): VoceChatManagementConfig {
  const section = getChannelConfig(cfg);
  const management = asRecord((section as Record<string, unknown>).management);
  const panelStateFile = normalizeString(management.panelStateFile) || path.join(os.homedir(), ".local", "state", "openclaw-vocechat-channel", "panels.json");
  const adminSenderIds = parseAllowEntries(management.adminSenderIds);
  return {
    adminSenderIds,
    panelStateFile,
    quickTargets: resolveVoceChatQuickTargets(cfg, management, adminSenderIds),
  };
}

function resolveVoceChatApprovalStateFile(cfg: OpenClawConfig): string {
  const section = getChannelConfig(cfg);
  const approvalSection = asRecord((section as Record<string, unknown>).approvals);
  const configured = normalizeString(approvalSection.stateFile);
  if (configured) return configured;
  const management = resolveVoceChatManagement(cfg);
  return path.join(path.dirname(management.panelStateFile), "approval-state.json");
}

function resolveVoceChatApprovalSettings(cfg: OpenClawConfig): {
  enabled: boolean;
  stateFile: string;
  publicBaseUrl: string;
  routePath: string;
  notifyAdminTargets: string[];
  fanoutToAdmins: boolean;
  fanoutToSession: boolean;
} {
  const section = getChannelConfig(cfg);
  const approvalSection = asRecord((section as Record<string, unknown>).approvals);
  const management = resolveVoceChatManagement(cfg);
  const adminSenderIds = parseAllowEntries(
    approvalSection.notifyAdminSenderIds ?? management.adminSenderIds,
  );

  return {
    enabled: parseBoolean(approvalSection.enabled, true),
    stateFile: resolveVoceChatApprovalStateFile(cfg),
    publicBaseUrl: normalizeString(approvalSection.publicBaseUrl) || "",
    routePath: normalizeRoutePath(approvalSection.routePath, "/vocechat/approval"),
    notifyAdminTargets: adminSenderIds
      .map(parseVoceChatApprovalTargetFromSenderId)
      .filter((entry): entry is string => Boolean(entry)),
    fanoutToAdmins: parseBoolean(approvalSection.fanoutToAdmins, true),
    fanoutToSession: parseBoolean(approvalSection.fanoutToSession, true),
  };
}

function resolveVoceChatApprovalGatewayRuntime(cfg: OpenClawConfig): {
  url: string;
  token: string | null;
  password: string | null;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
} {
  const section = getChannelConfig(cfg);
  const approvalSection = asRecord((section as Record<string, unknown>).approvals);
  const gateway = asRecord(cfg.gateway);
  const auth = asRecord(gateway.auth);
  const remote = asRecord(gateway.remote);
  const gatewayPort = typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : Number(gateway.port) || 18789;
  const rawUrl =
    normalizeString(approvalSection.gatewayUrl)
    || normalizeString(remote.url)
    || `ws://127.0.0.1:${gatewayPort}`;

  return {
    url: normalizeGatewayWsUrl(rawUrl),
    token:
      normalizeString(approvalSection.gatewayToken)
      || normalizeString(auth.token)
      || normalizeString(remote.token)
      || null,
    password:
      normalizeString(approvalSection.gatewayPassword)
      || normalizeString(auth.password)
      || normalizeString(remote.password)
      || null,
    reconnectBaseMs: parseBoundedInt(approvalSection.reconnectBaseMs, 1000, 250, 60000),
    reconnectMaxMs: parseBoundedInt(approvalSection.reconnectMaxMs, 15000, 1000, 300000),
  };
}

function normalizeGatewayWsUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.toString();
}

function normalizeRoutePath(value: unknown, fallback: string): string {
  const raw = normalizeString(value);
  if (!raw) return fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function parseVoceChatApprovalTargetFromSenderId(raw: string): string | null {
  const normalized = normalizeIdentity(raw);
  if (!normalized.startsWith("vocechat:")) return null;
  return parseVoceChatApprovalTarget(normalized.slice("vocechat:".length));
}

function parseVoceChatApprovalTarget(raw: string): string | null {
  const parsed = parseTarget(raw);
  if (!parsed) return null;
  return `${parsed.kind}:${parsed.id}`;
}

function resolveVoceChatApprovalRecipients(
  cfg: OpenClawConfig,
  event: VoceChatApprovalRequestedEvent,
): VoceChatApprovalRecipient[] {
  const approvalCfg = resolveVoceChatApprovalSettings(cfg);
  const dedup = new Map<string, VoceChatApprovalRecipient>();

  const addRecipient = (recipient: VoceChatApprovalRecipient | null) => {
    if (!recipient) return;
    dedup.set(`${recipient.accountId}:${recipient.target}`, recipient);
  };

  if (approvalCfg.fanoutToSession) {
    const sessionChannel = normalizeString(event.request?.turnSourceChannel).toLowerCase();
    if (sessionChannel === "vocechat") {
      const target = parseVoceChatApprovalTarget(
        normalizeString(event.request?.turnSourceTo).replace(/^vocechat:/i, ""),
      );
      if (target) {
        addRecipient({
          accountId: normalizeAccountId(event.request?.turnSourceAccountId),
          target,
          source: "session",
        });
      }
    }
  }

  if (approvalCfg.fanoutToAdmins) {
    for (const target of approvalCfg.notifyAdminTargets) {
      addRecipient({
        accountId: DEFAULT_ACCOUNT_ID,
        target,
        source: "admin",
      });
    }
  }

  return [...dedup.values()];
}

function sanitizeApprovalRequest(raw: ApprovalRequestSummary | undefined | null): ApprovalRequestSummary {
  const request = asRecord(raw);
  return {
    command: normalizeString(request.command) || null,
    cwd: normalizeString(request.cwd) || null,
    host: normalizeString(request.host) || null,
    agentId: normalizeString(request.agentId) || null,
    sessionKey: normalizeString(request.sessionKey) || null,
    turnSourceChannel: normalizeString(request.turnSourceChannel) || null,
    turnSourceTo: normalizeString(request.turnSourceTo) || null,
    turnSourceAccountId: normalizeString(request.turnSourceAccountId) || null,
  };
}

function asStoredVoceChatApprovalRecord(raw: unknown): StoredVoceChatApprovalRecord | null {
  const record = asRecord(raw);
  const approvalId = normalizeString(record.approvalId);
  if (!approvalId) return null;
  const recipientRows = Array.isArray(record.recipients) ? record.recipients : [];
  const recipients = recipientRows
    .map((entry) => {
      const item = asRecord(entry);
      const accountId = normalizeAccountId(normalizeString(item.accountId));
      const target = parseVoceChatApprovalTarget(normalizeString(item.target));
      const source = normalizeString(item.source) === "session" ? "session" : "admin";
      if (!target) return null;
      return { accountId, target, source } as VoceChatApprovalRecipient;
    })
    .filter((entry): entry is VoceChatApprovalRecipient => Boolean(entry));
  if (recipients.length === 0) return null;

  const statusRaw = normalizeString(record.status);
  const status: VoceChatApprovalStatus =
    statusRaw === "resolved" || statusRaw === "expired" ? statusRaw : "pending";

  return {
    approvalId,
    status,
    recipients,
    createdAtMs: Number(record.createdAtMs) || Date.now(),
    expiresAtMs: Number(record.expiresAtMs) || Date.now() + 180_000,
    sentAtMs: Number(record.sentAtMs) || Date.now(),
    request: sanitizeApprovalRequest(record.request as ApprovalRequestSummary | undefined),
    actionTokens: normalizeApprovalActionTokens(record.actionTokens),
    decision: normalizeApprovalDecision(record.decision),
    resolvedBy: normalizeString(record.resolvedBy) || null,
    resolvedAtMs: Number(record.resolvedAtMs) || undefined,
    expiredAtMs: Number(record.expiredAtMs) || undefined,
  };
}

function normalizeApprovalDecision(value: unknown): "allow-once" | "allow-always" | "deny" | undefined {
  const normalized = normalizeString(value);
  if (normalized === "allow-once" || normalized === "allow-always" || normalized === "deny") {
    return normalized;
  }
  return undefined;
}

function normalizeApprovalActionTokens(
  value: unknown,
): Partial<Record<"allow-once" | "allow-always" | "deny", string>> | undefined {
  const record = asRecord(value);
  const allowOnce = normalizeString(record["allow-once"]);
  const allowAlways = normalizeString(record["allow-always"]);
  const deny = normalizeString(record["deny"]);
  if (!allowOnce && !allowAlways && !deny) return undefined;
  return {
    ...(allowOnce ? { "allow-once": allowOnce } : {}),
    ...(allowAlways ? { "allow-always": allowAlways } : {}),
    ...(deny ? { deny } : {}),
  };
}

function createApprovalActionTokens(): Record<"allow-once" | "allow-always" | "deny", string> {
  return {
    "allow-once": randomUUID(),
    "allow-always": randomUUID(),
    "deny": randomUUID(),
  };
}

function renderVoceChatRequestedApproval(
  event: VoceChatApprovalRequestedEvent,
  approvalUi?: {
    publicBaseUrl: string;
    routePath: string;
    actionTokens?: Partial<Record<"allow-once" | "allow-always" | "deny", string>>;
  },
): string {
  const request = sanitizeApprovalRequest(event.request);
  const approvalId = normalizeString(event.id);
  const sourceChannel = request.turnSourceChannel || "unknown";
  const sourceTo = request.turnSourceTo || "<未知>";
  const expiresAt = event.expiresAtMs ? new Date(event.expiresAtMs).toLocaleString("zh-CN", { hour12: false }) : "未知";
  const command = request.command || "<缺失>";
  const linkLines = buildVoceChatApprovalLinkLines(approvalUi);
  return [
    "执行审批请求",
    "",
    `审批 ID：\`${approvalId}\``,
    `来源渠道：${sourceChannel}`,
    `来源会话：${sourceTo}`,
    `Agent：${request.agentId || "<未知>"}`,
    `主机：${request.host || "<未知>"}`,
    `工作目录：${request.cwd || "<未知>"}`,
    `过期时间：${expiresAt}`,
    "",
    "命令预览：",
    "```text",
    command,
    "```",
    "",
    ...(linkLines.length > 0
      ? [
          "点击下面的审批链接即可打开确认页：",
          ...linkLines,
          "",
        ]
      : []),
    "如果链接打不开，再发送以下命令审批：",
    `- \`/approve ${approvalId} allow-once\``,
    `- \`/approve ${approvalId} allow-always\``,
    `- \`/approve ${approvalId} deny\``,
  ].join("\n");
}

function renderVoceChatResolvedApproval(
  record: StoredVoceChatApprovalRecord,
  event: VoceChatApprovalResolvedEvent,
): string {
  const decision = normalizeApprovalDecision(event.decision) || record.decision || "deny";
  const labels: Record<string, string> = {
    "allow-once": "已允许（一次）",
    "allow-always": "已允许（始终）",
    "deny": "已拒绝",
  };
  return [
    "执行审批结果",
    "",
    `审批 ID：\`${record.approvalId}\``,
    `结果：${labels[decision] ?? decision}`,
    `处理人：${normalizeString(event.resolvedBy) || "<未知>"}`,
    `命令：\`${record.request.command || "<缺失>"}\``,
  ].join("\n");
}

function renderVoceChatExpiredApproval(record: StoredVoceChatApprovalRecord): string {
  return [
    "执行审批结果",
    "",
    `审批 ID：\`${record.approvalId}\``,
    "结果：审批已过期",
    `命令：\`${record.request.command || "<缺失>"}\``,
  ].join("\n");
}

function formatVoceChatApprovalDecisionLabel(decision: "allow-once" | "allow-always" | "deny"): string {
  if (decision === "allow-once") return "允许一次";
  if (decision === "allow-always") return "始终允许";
  return "拒绝";
}

function formatVoceChatApprovalDecisionResultLabel(decision: "allow-once" | "allow-always" | "deny"): string {
  if (decision === "allow-once") return "已允许（一次）";
  if (decision === "allow-always") return "已允许（始终）";
  return "已拒绝";
}

function formatVoceChatApprovalPageTime(value?: number): string {
  if (!value || !Number.isFinite(value)) return "<未知>";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function renderVoceChatApprovalConfirmPage(
  record: StoredVoceChatApprovalRecord,
  decision: "allow-once" | "allow-always" | "deny",
  token: string,
): string {
  return renderVoceChatApprovalResultPage({
    title: `${formatVoceChatApprovalDecisionLabel(decision)}审批`,
    heading: "确认执行审批",
    tone: decision === "deny" ? "warning" : "info",
    detail: `将对审批 ${record.approvalId} 执行“${formatVoceChatApprovalDecisionLabel(decision)}”。`,
    record,
    decision,
    formHtml: [
      `<form method="post">`,
      `<input type="hidden" name="token" value="${escapeHtml(token)}" />`,
      `<button type="submit">${escapeHtml(`确认${formatVoceChatApprovalDecisionLabel(decision)}`)}</button>`,
      `</form>`,
      `<p class="hint">打开页面不会自动审批，只有点击确认按钮才会提交。</p>`,
    ].join(""),
  });
}

function renderVoceChatApprovalAutoSubmitPage(
  record: StoredVoceChatApprovalRecord,
  decision: "allow-once" | "allow-always" | "deny",
  token: string,
): string {
  return renderVoceChatApprovalResultPage({
    title: `${formatVoceChatApprovalDecisionLabel(decision)}审批`,
    heading: "正在提交审批",
    tone: decision === "deny" ? "warning" : "info",
    detail: `正在执行“${formatVoceChatApprovalDecisionLabel(decision)}”，页面会自动跳转到审批结果。`,
    record,
    decision,
    formHtml: [
      `<form id="approval-submit-form" method="post">`,
      `<input type="hidden" name="token" value="${escapeHtml(token)}" />`,
      `<button type="submit">${escapeHtml(`继续${formatVoceChatApprovalDecisionLabel(decision)}`)}</button>`,
      `</form>`,
      `<p class="hint">如果没有自动跳转，再手动点一次按钮。</p>`,
      `<script>window.addEventListener('load',function(){document.getElementById('approval-submit-form')?.submit();},{once:true});</script>`,
    ].join(""),
  });
}

function renderVoceChatApprovalSuccessPage(
  record: StoredVoceChatApprovalRecord,
  decision: "allow-once" | "allow-always" | "deny",
): string {
  return renderVoceChatApprovalResultPage({
    title: "审批已提交",
    heading: "审批已提交",
    tone: "success",
    detail: `已提交“${formatVoceChatApprovalDecisionLabel(decision)}”，VoceChat 会收到审批结果通知。`,
    record,
    decision,
  });
}

function renderVoceChatApprovalResolvedPage(
  record: StoredVoceChatApprovalRecord,
  fallbackDecision: "allow-once" | "allow-always" | "deny",
): string {
  const decision = record.decision || fallbackDecision;
  const detailParts = [`审批已处理为“${formatVoceChatApprovalDecisionResultLabel(decision)}”。`];
  if (record.resolvedBy) detailParts.push(`处理人：${record.resolvedBy}`);
  if (record.resolvedAtMs) detailParts.push(`处理时间：${formatVoceChatApprovalPageTime(record.resolvedAtMs)}`);
  return renderVoceChatApprovalResultPage({
    title: "审批已处理",
    heading: "审批已处理",
    tone: "success",
    detail: detailParts.join(" "),
    record,
    decision,
  });
}

function renderVoceChatApprovalExpiredPage(
  record: StoredVoceChatApprovalRecord,
  decision: "allow-once" | "allow-always" | "deny",
): string {
  return renderVoceChatApprovalResultPage({
    title: "审批已过期",
    heading: "审批已过期",
    tone: "warning",
    detail: `该审批已于 ${formatVoceChatApprovalPageTime(record.expiresAtMs)} 过期，无法再执行“${formatVoceChatApprovalDecisionLabel(decision)}”。`,
    record,
    decision,
  });
}

function renderVoceChatApprovalResultPage(params: {
  title: string;
  heading: string;
  tone: "info" | "success" | "warning" | "error";
  detail: string;
  record?: StoredVoceChatApprovalRecord;
  decision?: "allow-once" | "allow-always" | "deny";
  formHtml?: string;
}): string {
  const toneClass = params.tone;
  const record = params.record;
  const command = record?.request.command || "<缺失>";
  const sourceChannel = record?.request.turnSourceChannel || "unknown";
  const sourceTo = record?.request.turnSourceTo || "<未知>";
  const decisionLabel = params.decision ? formatVoceChatApprovalDecisionLabel(params.decision) : "";
  const metaHtml = record
    ? [
        `<dl class="meta">`,
        `<div><dt>审批 ID</dt><dd>${escapeHtml(record.approvalId)}</dd></div>`,
        `<div><dt>当前动作</dt><dd>${escapeHtml(decisionLabel || "<未指定>")}</dd></div>`,
        `<div><dt>来源渠道</dt><dd>${escapeHtml(sourceChannel)}</dd></div>`,
        `<div><dt>来源会话</dt><dd>${escapeHtml(sourceTo)}</dd></div>`,
        `<div><dt>Agent</dt><dd>${escapeHtml(record.request.agentId || "<未知>")}</dd></div>`,
        `<div><dt>主机</dt><dd>${escapeHtml(record.request.host || "<未知>")}</dd></div>`,
        `<div><dt>工作目录</dt><dd>${escapeHtml(record.request.cwd || "<未知>")}</dd></div>`,
        `<div><dt>过期时间</dt><dd>${escapeHtml(formatVoceChatApprovalPageTime(record.expiresAtMs))}</dd></div>`,
        `</dl>`,
        `<div class="command">`,
        `<div class="label">命令预览</div>`,
        `<pre>${escapeHtml(command)}</pre>`,
        `</div>`,
      ].join("")
    : "";

  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(params.title)}</title>`,
    "<style>",
    "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f7fb;color:#172033;}",
    ".wrap{max-width:760px;margin:0 auto;padding:32px 16px 48px;}",
    ".card{background:#fff;border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(20,32,64,.08);border:1px solid rgba(20,32,64,.08);}",
    ".pill{display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.02em;}",
    ".pill.info{background:#e8f1ff;color:#175cd3;}",
    ".pill.success{background:#e7f8ee;color:#067647;}",
    ".pill.warning{background:#fff4e5;color:#b54708;}",
    ".pill.error{background:#fee4e2;color:#b42318;}",
    "h1{margin:14px 0 10px;font-size:28px;line-height:1.2;}",
    "p{margin:0 0 14px;line-height:1.6;}",
    ".meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 18px;margin:22px 0 20px;}",
    ".meta div{padding:12px 14px;border-radius:12px;background:#f8fafc;}",
    ".meta dt{font-size:12px;color:#667085;margin-bottom:6px;}",
    ".meta dd{margin:0;font-size:14px;word-break:break-word;}",
    ".label{font-size:12px;color:#667085;margin-bottom:8px;}",
    ".command{margin-top:18px;}",
    "pre{margin:0;padding:14px;border-radius:12px;background:#101828;color:#f8fafc;overflow:auto;white-space:pre-wrap;word-break:break-word;}",
    "form{margin-top:22px;}",
    "button{appearance:none;border:0;border-radius:12px;padding:14px 18px;font-size:16px;font-weight:700;background:#175cd3;color:#fff;cursor:pointer;box-shadow:0 10px 24px rgba(23,92,211,.22);}",
    "button:hover{filter:brightness(.98);}",
    ".hint{margin-top:12px;font-size:13px;color:#667085;}",
    "</style>",
    "</head>",
    "<body>",
    '<main class="wrap"><section class="card">',
    `<span class="pill ${toneClass}">${escapeHtml(params.heading)}</span>`,
    `<h1>${escapeHtml(params.heading)}</h1>`,
    `<p>${escapeHtml(params.detail)}</p>`,
    metaHtml,
    params.formHtml || "",
    "</section></main>",
    "</body>",
    "</html>",
  ].join("");
}

function buildVoceChatApprovalLinkLines(approvalUi?: {
  publicBaseUrl: string;
  routePath: string;
  actionTokens?: Partial<Record<"allow-once" | "allow-always" | "deny", string>>;
}): string[] {
  const publicBaseUrl = normalizeString(approvalUi?.publicBaseUrl);
  const routePath = normalizeString(approvalUi?.routePath);
  const actionTokens = approvalUi?.actionTokens;
  if (!publicBaseUrl || !routePath || !actionTokens) return [];

  const allowOnce = actionTokens["allow-once"] ? buildVoceChatApprovalLink(publicBaseUrl, routePath, actionTokens["allow-once"]) : "";
  const allowAlways = actionTokens["allow-always"] ? buildVoceChatApprovalLink(publicBaseUrl, routePath, actionTokens["allow-always"]) : "";
  const deny = actionTokens["deny"] ? buildVoceChatApprovalLink(publicBaseUrl, routePath, actionTokens["deny"]) : "";
  const links = [
    allowOnce ? `[允许一次](${allowOnce})` : "",
    allowAlways ? `[始终允许](${allowAlways})` : "",
    deny ? `[拒绝](${deny})` : "",
  ].filter(Boolean);
  return links.length > 0 ? [`- ${links.join(" | ")}`] : [];
}

function buildVoceChatApprovalLink(publicBaseUrl: string, routePath: string, token: string): string {
  const base = publicBaseUrl.replace(/\/+$/g, "");
  const pathPart = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${base}${pathPart}?token=${encodeURIComponent(token)}`;
}

async function submitVoceChatApprovalDecision(params: {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
  version: string;
}): Promise<void> {
  const runtime = resolveVoceChatApprovalGatewayRuntime(params.cfg);
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("runtime WebSocket is missing");
  }

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocketCtor(runtime.url);
    const connectRequestId = randomUUID();
    const resolveRequestId = randomUUID();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      } catch {}
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error("approval gateway request timed out")));
    }, 10_000);
    timeout.unref?.();

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "req",
          id: connectRequestId,
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            role: "operator",
            scopes: ["operator.approvals"],
            client: {
              id: "gateway-client",
              displayName: "VoceChat Approval Web",
              version: params.version,
              platform: `${os.platform()}-${os.release()}`,
              mode: "backend",
              instanceId: os.hostname(),
            },
            auth: {
              ...(runtime.token ? { token: runtime.token } : {}),
              ...(runtime.password ? { password: runtime.password } : {}),
            },
          },
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      void (async () => {
        try {
          const text = await readWebSocketPayloadText(event.data);
          if (!text) return;
          const frame = JSON.parse(text) as Record<string, unknown>;
          if (normalizeString(frame.type) !== "res") return;
          const frameId = normalizeString(frame.id);
          if (frameId === connectRequestId) {
            if (frame.ok === false) {
              finish(() => reject(new Error(normalizeString(asRecord(frame.error).message) || "approval gateway connect failed")));
              return;
            }
            socket.send(
              JSON.stringify({
                type: "req",
                id: resolveRequestId,
                method: "exec.approval.resolve",
                params: {
                  id: params.approvalId,
                  decision: params.decision,
                },
              }),
            );
            return;
          }
          if (frameId === resolveRequestId) {
            if (frame.ok === false) {
              finish(() => reject(new Error(normalizeString(asRecord(frame.error).message) || "approval resolve failed")));
              return;
            }
            finish(() => resolve());
          }
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      })();
    });

    socket.addEventListener("error", () => {
      finish(() => reject(new Error("approval gateway socket error")));
    });

    socket.addEventListener("close", (event) => {
      if (settled) return;
      finish(() => reject(new Error(event.reason || `approval gateway disconnected (code ${event.code})`)));
    });
  });
}

async function readWebSocketPayloadText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data instanceof Blob) return await data.text();
  return String(data ?? "");
}

function resolveVoceChatQuickTargets(
  cfg: OpenClawConfig,
  managementSection: Record<string, unknown>,
  adminSenderIds: string[],
): VoceChatQuickTargets {
  const quickTargets = asRecord(managementSection.quickTargets);
  const configuredUsers = normalizeVoceChatTargetEntries(parseAllowEntries(quickTargets.users), "user");
  const configuredGroups = normalizeVoceChatTargetEntries(parseAllowEntries(quickTargets.groups), "group");
  if (configuredUsers.length > 0 || configuredGroups.length > 0) {
    return { users: configuredUsers, groups: configuredGroups };
  }

  const inferredUsers = new Set<string>();
  const inferredGroups = new Set<string>();

  const addTarget = (raw: string | undefined) => {
    const parsed = parseTarget(raw ?? "");
    if (!parsed) return;
    const normalized = `${parsed.kind}:${parsed.id}`;
    if (parsed.kind === "user") inferredUsers.add(normalized);
    if (parsed.kind === "group") inferredGroups.add(normalized);
  };

  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  addTarget(defaultAccount.defaultTo);

  for (const accountId of listVoceChatAccountIds(cfg)) {
    addTarget(resolveVoceChatAccount(cfg, accountId).defaultTo);
  }

  for (const senderId of adminSenderIds) {
    const match = senderId.match(/^vocechat:user:(.+)$/i);
    if (match?.[1]) inferredUsers.add(`user:${match[1]}`);
  }

  return {
    users: [...inferredUsers],
    groups: [...inferredGroups],
  };
}

function normalizeVoceChatTargetEntries(entries: string[], kind: TargetKind): string[] {
  const normalized = new Set<string>();
  for (const entry of entries) {
    const parsed = parseTarget(entry);
    if (!parsed || parsed.kind !== kind) continue;
    normalized.add(`${parsed.kind}:${parsed.id}`);
  }
  return [...normalized];
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

function resolveOpenClawStateDir(): string {
  const explicitStateDir = normalizeString(process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR);
  return explicitStateDir ? expandHomePath(explicitStateDir) : path.join(os.homedir(), ".openclaw");
}

function resolveInboundMediaRootDir(): string {
  // Keep inbound media inside the OpenClaw workspace so built-in file tools can read it.
  return path.join(resolveOpenClawStateDir(), "workspace", "media", "inbound", "vocechat");
}

function resolveInboundOcrCacheDir(): string {
  return path.join(resolveOpenClawStateDir(), "workspace", "cache", "vocechat-ocr");
}

function formatInboundDatePath(timestamp: number): string[] {
  const date = new Date(timestamp || Date.now());
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day];
}

function buildInboundMediaMessageDir(event: InboundEvent): string {
  return path.join(
    resolveInboundMediaRootDir(),
    ...formatInboundDatePath(event.timestamp),
    sanitizePathSegment(event.messageId, "message"),
  );
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => Promise<void> | void,
): Promise<T> {
  if (timeoutMs <= 0) return await operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        void Promise.resolve(onTimeout?.()).finally(() => {
          reject(new Error(`timeout after ${timeoutMs} ms`));
        });
      }, timeoutMs);
      operation.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readWebStreamWithLimit(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel("too_large");
      throw new Error(`attachment exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function requestBinaryViaFetch(params: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<{ status: number; ok: boolean; body: Buffer; contentType: string; contentLength?: number }> {
  const response = await fetch(params.url, {
    method: "GET",
    headers: params.headers,
    signal: params.signal,
  });
  const contentType = normalizeMimeType(response.headers.get("content-type"));
  const contentLength = parseOptionalSize(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > params.maxBytes) {
    throw new Error(`attachment exceeds ${params.maxBytes} bytes`);
  }
  const body = await readWebStreamWithLimit(response.body, params.maxBytes);
  return {
    status: response.status,
    ok: response.ok,
    body,
    contentType,
    contentLength,
  };
}

async function requestBinaryViaLoopback(params: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<{ status: number; ok: boolean; body: Buffer; contentType: string; contentLength?: number }> {
  const parsed = new URL(params.url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = Number(parsed.port || (isHttps ? 443 : 80));

  return await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      params.signal.removeEventListener("abort", handleAbort);
      callback();
    };

    const handleAbort = () => {
      const abortError = createAbortError();
      request.destroy(abortError);
      finish(() => reject(abortError));
    };

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          ...params.headers,
          host: parsed.host,
        },
        servername: isHttps ? parsed.hostname : undefined,
        rejectUnauthorized: isHttps ? true : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const contentType = normalizeMimeType(response.headers["content-type"]);
        const contentLength = parseOptionalSize(response.headers["content-length"]);
        if (contentLength !== undefined && contentLength > params.maxBytes) {
          request.destroy(new Error(`attachment exceeds ${params.maxBytes} bytes`));
          return;
        }

        response.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > params.maxBytes) {
            request.destroy(new Error(`attachment exceeds ${params.maxBytes} bytes`));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
              body,
              contentType,
              contentLength,
            }),
          );
        });
      },
    );

    request.on("error", (error) => {
      finish(() => reject(error));
    });

    if (params.signal.aborted) {
      handleAbort();
      return;
    }

    params.signal.addEventListener("abort", handleAbort, { once: true });
    request.end();
  });
}

async function requestInboundBinaryResource(params: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<{ status: number; ok: boolean; body: Buffer; contentType: string; contentLength?: number }> {
  if (canUseLoopbackFallback(params.url)) {
    try {
      return await requestBinaryViaLoopback(params);
    } catch (loopbackError) {
      const loopbackDetail = loopbackError instanceof Error ? loopbackError.message : String(loopbackError);
      try {
        return await requestBinaryViaFetch(params);
      } catch (fetchError) {
        const fetchDetail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        throw new Error(
          `[vocechat] attachment request failed via loopback (${loopbackDetail}); configured host fallback failed (${fetchDetail})`,
        );
      }
    }
  }

  try {
    return await requestBinaryViaFetch(params);
  } catch (originalError) {
    if (!canUseLoopbackFallback(params.url)) throw originalError;

    try {
      return await requestBinaryViaLoopback(params);
    } catch (fallbackError) {
      const primaryDetail = originalError instanceof Error ? originalError.message : String(originalError);
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `[vocechat] attachment request failed via configured host (${primaryDetail}); loopback fallback failed (${fallbackDetail})`,
      );
    }
  }
}

function inferInboundAttachmentFileName(attachment: InboundAttachment, contentType?: string): string {
  const fallbackExt =
    extractExtensionFromPathLike(attachment.fileName || "") ||
    extractExtensionFromPathLike(attachment.url || "") ||
    inferExtensionFromMimeType(contentType || attachment.mimeType || "") ||
    ".bin";
  const baseName = sanitizeFileName(attachment.fileName || path.basename(attachment.url || "") || "attachment");
  const parsed = path.parse(baseName);
  const ext = isImageExtension(parsed.ext || fallbackExt) ? parsed.ext || fallbackExt : fallbackExt;
  const name = sanitizePathSegment(parsed.name || "attachment", "attachment");
  return `${name}${ext}`;
}

function buildInboundAttachmentSignature(attachments: InboundAttachment[]): string {
  return attachments
    .map((attachment) =>
      [
        attachment.kind || "-",
        attachment.messageId || "-",
        attachment.source || "-",
        attachment.attachmentId || "-",
        attachment.url || "-",
        attachment.fileName || "-",
      ].join("|"),
    )
    .join("||");
}

async function persistInboundAttachmentManifest(event: InboundEvent, attachments: InboundAttachment[]): Promise<void> {
  const messageDir = buildInboundMediaMessageDir(event);
  const manifestPath = path.join(messageDir, "manifest.json");
  await fs.mkdir(messageDir, { recursive: true });
  await writeJsonFileAtomically(manifestPath, {
    messageId: event.messageId,
    signature: buildInboundAttachmentSignature(event.attachments),
    attachments,
  });
}

async function normalizeInboundAttachmentForAgent(params: {
  event: InboundEvent;
  attachment: InboundAttachment;
  index: number;
  account: ResolvedAccount;
}): Promise<InboundAttachment> {
  const { event, attachment, index, account } = params;
  const currentLocalFile = normalizeString(attachment.localFile);
  const storedFile = normalizeString(attachment.storedFile) || currentLocalFile;
  if (!storedFile) return attachment;

  const existingNormalizedFile = normalizeString(attachment.normalizedFile);
  if (existingNormalizedFile && (await fileExists(existingNormalizedFile))) {
    return {
      ...attachment,
      storedFile: storedFile || undefined,
      normalizedFile: existingNormalizedFile,
      localFile: existingNormalizedFile,
      mimeType: "image/jpeg",
      normalizationError: undefined,
    };
  }

  const messageDir = buildInboundMediaMessageDir(event);
  const targetPath = path.join(messageDir, `${String(index + 1).padStart(2, "0")}-agent.jpg`);
  const image = sharp(storedFile, { failOn: "none" }).rotate();
  const metadata = await image.metadata();
  const pipeline = image.resize({
    width: account.inboundImageNormalizationMaxEdge,
    height: account.inboundImageNormalizationMaxEdge,
    fit: "inside",
    withoutEnlargement: true,
  });

  if (metadata.hasAlpha) {
    pipeline.flatten({ background: "#ffffff" });
  }

  await pipeline.jpeg({
    quality: account.inboundImageNormalizationQuality,
    mozjpeg: true,
    chromaSubsampling: "4:4:4",
  }).toFile(targetPath);

  return {
    ...attachment,
    storedFile: storedFile || undefined,
    normalizedFile: targetPath,
    localFile: targetPath,
    mimeType: "image/jpeg",
    normalizationError: undefined,
  };
}

async function runInboundAttachmentOcr(params: {
  attachment: InboundAttachment;
  account: ResolvedAccount;
}): Promise<Pick<InboundAttachment, "ocrEngine" | "ocrLangs" | "ocrConfidence" | "ocrText" | "ocrTruncated">> {
  const { attachment, account } = params;
  const sourcePath = normalizeString(attachment.localFile) || normalizeString(attachment.storedFile);
  if (!sourcePath) throw new Error("missing_local_file");

  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  const langs = account.inboundOcrLangs;
  const langLabel = langs.join("+");

  try {
    const operation = (async () => {
      await fs.mkdir(resolveInboundOcrCacheDir(), { recursive: true });
      worker = await createWorker(
        langs.length === 1 ? langs[0] : langs,
        OEM.LSTM_ONLY,
        {
          cachePath: resolveInboundOcrCacheDir(),
          langPath: account.inboundOcrLangPath,
          gzip: true,
        },
      );
      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: PSM.AUTO,
        user_defined_dpi: "300",
      });
      const input = await sharp(sourcePath, { failOn: "none" })
        .rotate()
        .resize({
          width: Math.max(account.inboundImageNormalizationMaxEdge, 2200),
          height: Math.max(account.inboundImageNormalizationMaxEdge, 2200),
          fit: "inside",
          withoutEnlargement: false,
        })
        .greyscale()
        .normalize()
        .png()
        .toBuffer();
      const result = await worker.recognize(input, { rotateAuto: true }, { blocks: true });
      const text = normalizeOcrText(result.data.text || "");
      const truncated = text.length > account.inboundOcrMaxTextLength;
      return {
        ocrEngine: "tesseract.js",
        ocrLangs: langLabel,
        ocrConfidence: Number.isFinite(result.data.confidence) ? Math.round(result.data.confidence) : undefined,
        ocrText: truncated ? text.slice(0, account.inboundOcrMaxTextLength) : text,
        ocrTruncated: truncated || undefined,
      };
    })();

    return await withTimeout(operation, account.inboundOcrTimeoutMs, async () => {
      await worker?.terminate().catch(() => {});
    });
  } finally {
    await worker?.terminate().catch(() => {});
  }
}

async function enhanceInboundAttachmentsForAgent(params: {
  event: InboundEvent;
  account: ResolvedAccount;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<InboundEvent> {
  const { event, account, logger } = params;
  if (event.attachments.length === 0) return event;

  const nextAttachments: InboundAttachment[] = [];
  let changed = false;

  for (let index = 0; index < event.attachments.length; index += 1) {
    let attachment = { ...event.attachments[index] };
    const localFile = normalizeString(attachment.localFile);

    if (localFile && account.inboundImageNormalizationEnabled) {
      try {
        const normalized = await normalizeInboundAttachmentForAgent({
          event,
          attachment,
          index,
          account,
        });
        changed ||= normalized.localFile !== attachment.localFile || normalized.normalizedFile !== attachment.normalizedFile;
        attachment = normalized;
        if (attachment.normalizedFile) {
          logger?.info?.(
            `[vocechat] inbound attachment normalized account=${account.accountId} mid=${event.messageId} index=${index} path=${attachment.normalizedFile}`,
          );
        }
      } catch (error) {
        const normalizationError = error instanceof Error ? error.message : String(error);
        attachment = {
          ...attachment,
          storedFile: normalizeString(attachment.storedFile) || localFile || undefined,
          normalizationError,
        };
        changed = true;
        logger?.warn?.(
          `[vocechat] inbound attachment normalize failed account=${account.accountId} mid=${event.messageId} index=${index} path=${clipAuditSegment(localFile)} err=${clipAuditSegment(normalizationError, 200)}`,
        );
      }
    }

    const ocrText = normalizeOcrText(attachment.ocrText || "");
    const hasOcrAttempt = Boolean(normalizeString(attachment.ocrEngine) || normalizeString(attachment.ocrError));
    if (
      account.inboundOcrEnabled &&
      normalizeString(attachment.localFile) &&
      !hasOcrAttempt
    ) {
      try {
        const ocr = await runInboundAttachmentOcr({ attachment, account });
        attachment = {
          ...attachment,
          ...ocr,
          ocrError: undefined,
        };
        changed = true;
        logger?.info?.(
          `[vocechat] inbound attachment ocr ok account=${account.accountId} mid=${event.messageId} index=${index} confidence=${ocr.ocrConfidence ?? "-"} chars=${ocr.ocrText?.length ?? 0}`,
        );
      } catch (error) {
        const ocrError = error instanceof Error ? error.message : String(error);
        attachment = {
          ...attachment,
          ocrError,
        };
        changed = true;
        logger?.warn?.(
          `[vocechat] inbound attachment ocr failed account=${account.accountId} mid=${event.messageId} index=${index} path=${clipAuditSegment(attachment.localFile)} err=${clipAuditSegment(ocrError, 200)}`,
        );
      }
    } else if (ocrText && ocrText !== attachment.ocrText) {
      attachment = {
        ...attachment,
        ocrText,
      };
      changed = true;
    }

    nextAttachments.push(attachment);
  }

  const nextEvent = {
    ...event,
    attachments: nextAttachments,
    imageUrls: nextAttachments.map((attachment) => attachment.url).filter(Boolean) as string[],
    localFiles: nextAttachments.map((attachment) => attachment.localFile).filter(Boolean) as string[],
  };

  if (changed) {
    await persistInboundAttachmentManifest(nextEvent, nextAttachments);
  }

  return nextEvent;
}

async function hydrateInboundAttachments(params: {
  event: InboundEvent;
  account: ResolvedAccount;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<InboundEvent> {
  const { event, account, logger } = params;
  if (event.attachments.length === 0) return event;

  const messageDir = buildInboundMediaMessageDir(event);
  const manifestPath = path.join(messageDir, "manifest.json");
  const attachmentSignature = buildInboundAttachmentSignature(event.attachments);

  try {
    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifest = asRecord(JSON.parse(manifestRaw));
    const manifestSignature = normalizeString(manifest.signature);
    const manifestFiles = Array.isArray(manifest.attachments) ? manifest.attachments : [];
    if (manifestSignature === attachmentSignature && manifestFiles.length === event.attachments.length) {
      const reusedAttachments: InboundAttachment[] = [];
      let allFilesExist = true;
      for (let index = 0; index < manifestFiles.length; index += 1) {
        const saved = asRecord(manifestFiles[index]);
        const localFile = normalizeString(saved.localFile);
        if (!localFile || !(await fileExists(localFile))) {
          allFilesExist = false;
          break;
        }
        reusedAttachments.push({
          ...event.attachments[index],
          localFile,
          storedFile: normalizeString(saved.storedFile) || undefined,
          normalizedFile: normalizeString(saved.normalizedFile) || undefined,
          mimeType: normalizeMimeType(saved.mimeType) || event.attachments[index]?.mimeType,
          fileName: normalizeString(saved.fileName) || event.attachments[index]?.fileName,
          sizeBytes: parseOptionalSize(saved.sizeBytes) ?? event.attachments[index]?.sizeBytes,
          normalizationError: normalizeString(saved.normalizationError) || undefined,
          ocrEngine: normalizeString(saved.ocrEngine) || undefined,
          ocrLangs: normalizeString(saved.ocrLangs) || undefined,
          ocrConfidence: parseOptionalSize(saved.ocrConfidence),
          ocrText: normalizeString(saved.ocrText) || undefined,
          ocrTruncated: saved.ocrTruncated === true ? true : undefined,
          ocrError: normalizeString(saved.ocrError) || undefined,
        });
      }
      if (allFilesExist) {
        logger?.info?.(
          `[vocechat] inbound attachments reused account=${account.accountId} mid=${event.messageId} count=${reusedAttachments.length} dir=${messageDir}`,
        );
        return {
          ...event,
          attachments: reusedAttachments,
          imageUrls: reusedAttachments.map((attachment) => attachment.url).filter(Boolean) as string[],
          localFiles: reusedAttachments.map((attachment) => attachment.localFile).filter(Boolean) as string[],
        };
      }
    }
  } catch {
    // Ignore missing or invalid manifest and re-download.
  }

  await fs.mkdir(messageDir, { recursive: true });
  const hydratedAttachments: InboundAttachment[] = [];
  const manifestAttachments: Array<Record<string, unknown>> = [];

  for (let index = 0; index < event.attachments.length; index += 1) {
    const attachment = event.attachments[index];
    const url = normalizeString(attachment.url);
    if (!url) {
      const downloadError = "missing_attachment_url";
      hydratedAttachments.push({ ...attachment, downloadError });
      logger?.warn?.(
        `[vocechat] inbound attachment skipped account=${account.accountId} mid=${event.messageId} index=${index} reason=${downloadError}`,
      );
      manifestAttachments.push({
        ...attachment,
        downloadError,
      });
      continue;
    }

    if (attachment.sizeBytes !== undefined && attachment.sizeBytes > DEFAULT_INBOUND_MEDIA_MAX_BYTES) {
      const downloadError = `attachment exceeds ${DEFAULT_INBOUND_MEDIA_MAX_BYTES} bytes`;
      hydratedAttachments.push({ ...attachment, downloadError });
      logger?.warn?.(
        `[vocechat] inbound attachment rejected account=${account.accountId} mid=${event.messageId} index=${index} reason=${clipAuditSegment(downloadError)}`,
      );
      manifestAttachments.push({
        ...attachment,
        downloadError,
      });
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
    try {
      const response = await requestInboundBinaryResource({
        url,
        headers: {
          "x-api-key": account.apiKey,
          accept: "image/*, application/octet-stream;q=0.8, */*;q=0.5",
        },
        signal: controller.signal,
        maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const resolvedMimeType = normalizeMimeType(response.contentType || attachment.mimeType);
      const resolvedFileName = inferInboundAttachmentFileName(attachment, resolvedMimeType);
      const resolvedExtension = extractExtensionFromPathLike(resolvedFileName) || inferExtensionFromMimeType(resolvedMimeType);
      const inferredMimeType = resolvedMimeType || inferMimeTypeFromExtension(resolvedExtension) || "";
      if (!isAllowedInboundImageMimeType(inferredMimeType) && !isImageExtension(resolvedExtension)) {
        throw new Error(`unsupported_mime:${resolvedMimeType || "unknown"}`);
      }

      const targetPath = path.join(messageDir, `${String(index + 1).padStart(2, "0")}-${randomUUID()}${resolvedExtension || ".bin"}`);
      await fs.writeFile(targetPath, response.body);

      const hydratedAttachment: InboundAttachment = {
        ...attachment,
        fileName: resolvedFileName,
        mimeType: inferredMimeType || attachment.mimeType,
        sizeBytes: response.body.length,
        storedFile: targetPath,
        localFile: targetPath,
        downloadError: undefined,
      };
      hydratedAttachments.push(hydratedAttachment);
      manifestAttachments.push({
        ...hydratedAttachment,
      });
      logger?.info?.(
        `[vocechat] inbound attachment stored account=${account.accountId} mid=${event.messageId} index=${index} path=${targetPath} size=${response.body.length} mime=${clipAuditSegment(hydratedAttachment.mimeType || "-")}`,
      );
    } catch (error) {
      const downloadError = error instanceof Error ? error.message : String(error);
      hydratedAttachments.push({ ...attachment, downloadError });
      manifestAttachments.push({
        ...attachment,
        downloadError,
      });
      logger?.warn?.(
        `[vocechat] inbound attachment download failed account=${account.accountId} mid=${event.messageId} index=${index} url=${clipAuditSegment(url)} err=${clipAuditSegment(downloadError, 200)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  await writeJsonFileAtomically(manifestPath, {
    messageId: event.messageId,
    signature: attachmentSignature,
    attachments: manifestAttachments,
  });

  return {
    ...event,
    attachments: hydratedAttachments,
    imageUrls: hydratedAttachments.map((attachment) => attachment.url).filter(Boolean) as string[],
    localFiles: hydratedAttachments.map((attachment) => attachment.localFile).filter(Boolean) as string[],
  };
}

function buildInboundAgentBody(event: InboundEvent): string {
  const text = normalizeInboundText(event.text);
  if (event.attachments.length === 0) return text;

  const localAttachments = event.attachments.filter((attachment) => attachment.localFile);
  const failedAttachments = event.attachments.filter((attachment) => !attachment.localFile);
  const lines: string[] = [];

  if (localAttachments.length > 0) {
    lines.push(
      localAttachments.length === 1 ? "用户发送了一张图片。" : `用户发送了 ${localAttachments.length} 张图片。`,
    );
    lines.push("已同时提供原生图片文件与 OCR 提取文本。若你能直接读取图片，请以图片视觉内容为准；OCR 仅作兜底，可能遗漏版式、颜色、图表关系和非文字元素。");
  } else {
    lines.push(
      failedAttachments.length === 1 ? "用户发送了一张图片，但插件未能落地文件。" : `用户发送了 ${failedAttachments.length} 张图片，但插件未能落地文件。`,
    );
  }

  if (text) lines.push(`用户问题：${text}`);

  for (let index = 0; index < localAttachments.length; index += 1) {
    const attachment = localAttachments[index];
    lines.push(localAttachments.length > 1 ? `图片 ${index + 1}：` : "图片：");
    lines.push(`本地文件：${attachment.localFile}`);
    if (attachment.storedFile && attachment.storedFile !== attachment.localFile) {
      lines.push(`原始落地文件：${attachment.storedFile}`);
    }
    if (attachment.fileName) lines.push(`原始文件名：${attachment.fileName}`);
    if (attachment.mimeType) lines.push(`MIME：${attachment.mimeType}`);
    if (attachment.ocrText) {
      const ocrMeta = [
        attachment.ocrEngine || "ocr",
        attachment.ocrLangs || undefined,
        attachment.ocrConfidence !== undefined ? `置信度 ${attachment.ocrConfidence}` : undefined,
        attachment.ocrTruncated ? "已截断" : undefined,
      ]
        .filter(Boolean)
        .join(" / ");
      lines.push(`OCR 提取${ocrMeta ? `（${ocrMeta}）` : ""}：`);
      lines.push(attachment.ocrText);
    } else if (attachment.ocrError) {
      lines.push(`OCR 状态：${attachment.ocrError}`);
    }
  }

  for (const attachment of failedAttachments) {
    lines.push("图片下载失败。");
    if (attachment.url) lines.push(`资源 URL：${attachment.url}`);
    lines.push(`messageId：${attachment.messageId}`);
    lines.push(`失败原因：${attachment.downloadError || "unknown_error"}`);
  }

  lines.push("请结合用户问题回复；能看图时优先依据图片本身，不能看图时再参考 OCR 文本。");
  return lines.join("\n");
}

function buildInboundMergeKey(accountId: string, event: InboundEvent): string {
  return [accountId, event.chatType, event.conversationId, event.fromUid].join(":");
}

function mergeInboundTextSegments(values: string[]): string {
  return values
    .map((value) => normalizeInboundText(value))
    .filter(Boolean)
    .join("\n\n");
}

function mergeInboundStringArrays(values: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of values) {
    for (const entry of group) {
      const normalized = normalizeString(entry);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
}

function mergeInboundEvents(events: InboundEvent[]): InboundEvent {
  const ordered = [...events].sort((left, right) => left.timestamp - right.timestamp);
  const last = ordered[ordered.length - 1];
  return {
    ...last,
    text: mergeInboundTextSegments(ordered.map((event) => event.text)),
    originalText: mergeInboundTextSegments(ordered.map((event) => event.originalText)),
    timestamp: last.timestamp,
    sourceMessageIds: mergeInboundStringArrays(ordered.map((event) => event.sourceMessageIds)),
    attachments: ordered.flatMap((event) => event.attachments),
    imageUrls: [],
    localFiles: [],
  };
}

function shouldHoldInboundEventForMerge(account: ResolvedAccount, event: InboundEvent): boolean {
  if (!account.inboundMergeEnabled) return false;
  if (account.inboundMergeWindowMs <= 0) return false;
  if (account.inboundMergeMaxMessages <= 1) return false;

  const normalizedText = normalizeInboundText(event.originalText || event.text);
  if (!normalizedText && event.attachments.length === 0) return false;
  if (normalizedText.startsWith("/")) return false;
  return true;
}

function acceptInboundEventForProcessing(params: {
  account: ResolvedAccount;
  event: InboundEvent;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): boolean {
  const { account, event, logger } = params;
  logger?.info?.(
    `[vocechat] inbound begin account=${account.accountId} mid=${event.messageId} from=${event.fromUid} chat=${event.chatType} attachments=${event.attachments.length}`,
  );

  if (!account.enabled || !account.inboundEnabled) {
    logger?.info?.(
      `[vocechat] inbound ignored: account disabled account=${account.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled}`,
    );
    return false;
  }

  const messageKey = makeMessageKey(account.accountId, event.messageId);
  if (hasRecentMessage(recentOutboundMessageIds, messageKey)) {
    logger?.info?.(`[vocechat] skip outbound echo mid=${event.messageId}`);
    return false;
  }

  if (hasRecentMessage(recentInboundMessageIds, messageKey)) {
    logger?.info?.(`[vocechat] skip duplicated inbound mid=${event.messageId}`);
    return false;
  }

  if (!isInboundAuthorized(account, event)) {
    logger?.warn?.(
      `[vocechat] drop unauthorized sender uid=${event.fromUid} account=${account.accountId} chatType=${event.chatType}`,
    );
    return false;
  }

  rememberRecentMessage(recentInboundMessageIds, messageKey);
  return true;
}

function clearPendingInboundMerge(pending: PendingInboundMerge): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
}

function clearPendingInboundMergesForAccount(
  accountId: string,
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  },
): void {
  for (const [key, pending] of pendingInboundMerges.entries()) {
    if (pending.accountId !== accountId) continue;
    clearPendingInboundMerge(pending);
    pendingInboundMerges.delete(key);
    logger?.info?.(
      `[vocechat] inbound merge dropped account=${accountId} key=${key} reason=account_stop pendingCount=${pending.events.length}`,
    );
  }
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeString(hostname).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function createAbortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function canUseLoopbackFallback(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

async function requestVoceChatApi(params: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string | Buffer;
  signal: AbortSignal;
}): Promise<VoceChatHttpResponse> {
  if (canUseLoopbackFallback(params.url)) {
    try {
      return await requestVoceChatApiViaLoopback(params);
    } catch (loopbackError) {
      const loopbackDetail = loopbackError instanceof Error ? loopbackError.message : String(loopbackError);
      try {
        return await requestVoceChatApiViaFetch(params);
      } catch (fetchError) {
        const fetchDetail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        throw new Error(
          `[vocechat] request failed via loopback (${loopbackDetail}); configured host fallback failed (${fetchDetail})`,
        );
      }
    }
  }

  try {
    return await requestVoceChatApiViaFetch(params);
  } catch (originalError) {
    if (!canUseLoopbackFallback(params.url)) throw originalError;

    try {
      return await requestVoceChatApiViaLoopback(params);
    } catch (fallbackError) {
      const primaryDetail = originalError instanceof Error ? originalError.message : String(originalError);
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `[vocechat] request failed via configured host (${primaryDetail}); loopback fallback failed (${fallbackDetail})`,
      );
    }
  }
}

async function requestVoceChatApiViaFetch(params: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string | Buffer;
  signal: AbortSignal;
}): Promise<VoceChatHttpResponse> {
  const response = await fetch(params.url, {
    method: params.method,
    headers: params.headers,
    body: params.body as BodyInit,
    signal: params.signal,
  });

  const body = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

async function requestVoceChatApiViaLoopback(params: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string | Buffer;
  signal: AbortSignal;
}): Promise<VoceChatHttpResponse> {
  const parsed = new URL(params.url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = Number(parsed.port || (isHttps ? 443 : 80));

  return await new Promise<VoceChatHttpResponse>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      params.signal.removeEventListener("abort", handleAbort);
      callback();
    };

    const handleAbort = () => {
      const abortError = createAbortError();
      request.destroy(abortError);
      finish(() => reject(abortError));
    };

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: "127.0.0.1",
        port,
        method: params.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          ...params.headers,
          host: parsed.host,
        },
        servername: isHttps ? parsed.hostname : undefined,
        rejectUnauthorized: isHttps ? true : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
              body,
            }),
          );
        });
      },
    );

    request.on("error", (error) => {
      finish(() => reject(error));
    });

    if (params.signal.aborted) {
      handleAbort();
      return;
    }

    params.signal.addEventListener("abort", handleAbort, { once: true });
    request.end(params.body);
  });
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeMediaCaption(text: string, mediaUrl?: string): string {
  const normalizedText = formatModelTagForVoceChat(text).trim();
  if (!normalizedText) return "";

  const normalizedMedia = normalizeString(mediaUrl);
  if (!normalizedMedia) return normalizedText;

  const lines = normalizedText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== normalizedMedia && trimmed !== `Attachment: ${normalizedMedia}` && trimmed !== `附件: ${normalizedMedia}`;
    });

  return lines.join("\n").trim();
}

function inferVoceChatPayloadContentType(mediaContentType?: string): "vocechat/file" | "vocechat/audio" {
  const normalized = normalizeString(mediaContentType).toLowerCase();
  return normalized.startsWith("audio/") ? "vocechat/audio" : "vocechat/file";
}

function buildMultipartUploadBody(params: {
  fileId: string;
  fileName: string;
  contentType?: string;
  buffer: Buffer;
}): { contentType: string; body: Buffer } {
  const boundary = `----openclaw-vocechat-${randomUUID()}`;
  const contentType = normalizeString(params.contentType) || "application/octet-stream";
  const safeFileName = path.basename(params.fileName || "attachment.bin");
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file_id"\r\n\r\n` +
        `${params.fileId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chunk_data"; filename="${safeFileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      "utf8",
    ),
    params.buffer,
    Buffer.from(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chunk_is_last"\r\n\r\n` +
        `true\r\n` +
        `--${boundary}--\r\n`,
      "utf8",
    ),
  ]);

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
  };
}

async function prepareVoceChatFileUpload(params: {
  account: ResolvedAccount;
  fileName: string;
  contentType?: string;
  signal: AbortSignal;
}): Promise<string> {
  const response = await requestVoceChatApi({
    url: `${params.account.baseUrl}/api/bot/file/prepare`,
    method: "POST",
    headers: {
      "x-api-key": params.account.apiKey,
      "content-type": "application/json; charset=utf-8",
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    body: JSON.stringify({
      content_type: normalizeString(params.contentType) || "application/octet-stream",
      filename: params.fileName,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const detail = response.body.trim().slice(0, 500);
    throw new Error(
      `[vocechat] file prepare failed: HTTP ${response.status}${detail ? `, body=${detail}` : ""}`,
    );
  }

  const direct = normalizeString(response.body.replace(/^"+|"+$/g, ""));
  if (direct) return direct;

  const parsed = parseJsonObject(response.body);
  const fileId = normalizeString(parsed?.file_id ?? parsed?.fileId ?? parsed?.id);
  if (!fileId) throw new Error("[vocechat] file prepare failed: missing file id.");
  return fileId;
}

async function uploadVoceChatFile(params: {
  account: ResolvedAccount;
  fileId: string;
  fileName: string;
  contentType?: string;
  buffer: Buffer;
  signal: AbortSignal;
}): Promise<string> {
  const multipart = buildMultipartUploadBody({
    fileId: params.fileId,
    fileName: params.fileName,
    contentType: params.contentType,
    buffer: params.buffer,
  });

  const response = await requestVoceChatApi({
    url: `${params.account.baseUrl}/api/bot/file/upload`,
    method: "POST",
    headers: {
      "x-api-key": params.account.apiKey,
      "content-type": multipart.contentType,
      "content-length": String(multipart.body.byteLength),
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    body: multipart.body,
    signal: params.signal,
  });

  if (!response.ok) {
    const detail = response.body.trim().slice(0, 500);
    throw new Error(
      `[vocechat] file upload failed: HTTP ${response.status}${detail ? `, body=${detail}` : ""}`,
    );
  }

  const parsed = parseJsonObject(response.body);
  const uploadPath = normalizeString(parsed?.path);
  if (!uploadPath) throw new Error("[vocechat] file upload failed: missing uploaded path.");
  return uploadPath;
}

async function sendVoceChatMedia(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> {
  const mediaUrl = normalizeString(ctx.mediaUrl);
  if (!mediaUrl) throw new Error("[vocechat] mediaUrl is required for media delivery.");

  const account = resolveVoceChatAccount(ctx.cfg, ctx.accountId);
  if (!account.enabled) throw new Error("[vocechat] Channel account is disabled.");
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (!account.apiKey) throw new Error("[vocechat] channels.vocechat.apiKey is required.");

  const target = ensureTarget({
    to: ctx.to,
    defaultTo: account.defaultTo,
    mode: "implicit",
  });

  const caption = normalizeMediaCaption(ctx.text, mediaUrl);
  const media = await loadOutboundMediaFromUrl(mediaUrl, {
    mediaLocalRoots: Array.isArray(ctx.mediaLocalRoots) ? ctx.mediaLocalRoots : undefined,
  });

  const fileName = normalizeString(media.fileName) || path.basename(mediaUrl) || "attachment.bin";
  const payloadContentType = inferVoceChatPayloadContentType(media.contentType);
  const url = buildSendUrl(account, target);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    const fileId = await prepareVoceChatFileUpload({
      account,
      fileName,
      contentType: media.contentType,
      signal: controller.signal,
    });
    const uploadPath = await uploadVoceChatFile({
      account,
      fileId,
      fileName,
      contentType: media.contentType,
      buffer: media.buffer,
      signal: controller.signal,
    });
    const response = await requestVoceChatApi({
      url,
      method: "POST",
      headers: {
        "x-api-key": account.apiKey,
        "content-type": payloadContentType,
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({ path: uploadPath }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = response.body.trim().slice(0, 500);
      throw new Error(
        `[vocechat] media send failed: HTTP ${response.status}${detail ? `, body=${detail}` : ""}`,
      );
    }

    const messageId = parseMessageId(response.body);
    rememberRecentMessage(recentOutboundMessageIds, makeMessageKey(account.accountId, messageId));

    let captionMessageId: string | undefined;
    let captionDeliveryError: string | undefined;
    if (caption) {
      // Caption is best-effort after media delivery so recovery retries cannot re-send text before media validation/upload succeeds.
      try {
        const captionDelivery = await sendVoceChatMessage({ ...ctx, text: caption });
        captionMessageId = captionDelivery.messageId;
      } catch (error) {
        captionDeliveryError = error instanceof Error ? error.message : String(error);
        ctx.log?.warn(
          `[vocechat] media delivered but caption follow-up failed for ${target.kind}:${target.id}: ${captionDeliveryError}`,
        );
      }
    }

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
        mediaUrl,
        uploadPath,
        captionMessageId,
        captionDeliveryError,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
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

function escapeHtml(raw: unknown): string {
  return String(raw ?? "")
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
    let response: VoceChatHttpResponse | null = null;
    const contentTypes: string[] = ["text/markdown", "text/plain"];

    for (const contentType of contentTypes) {
      const current = await requestVoceChatApi({
        url,
        method: "POST",
        headers: {
          "x-api-key": account.apiKey,
          "content-type": contentType,
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        },
        body: text,
        signal: controller.signal,
      });
      const currentBody = current.body;

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
    let response: VoceChatHttpResponse | null = null;
    const contentTypes: string[] = ["text/markdown", "text/plain"];

    for (const contentType of contentTypes) {
      const current = await requestVoceChatApi({
        url,
        method: "POST",
        headers: {
          "x-api-key": account.apiKey,
          "content-type": contentType,
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        },
        body: text,
        signal: controller.signal,
      });
      const currentBody = current.body;

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
  const hasSupportedTextType = normalizedTypes.some((value) => isSupportedInboundTextType(value));
  const hasBlockedType = normalizedTypes.some((value) => account.inboundBlockedTypes.includes(value));

  if (hasBlockedType) return null;

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

  const attachments = extractInboundAttachments(raw, messageId, account);
  const imageUrls = attachments.map((attachment) => attachment.url).filter(Boolean) as string[];

  const originalText = firstNonEmptyString([
    detail.content,
    detail.text,
    payload.content,
    payload.text,
    detail.preview,
    payload.preview,
  ]);
  const normalizedOriginalText = normalizeInboundText(originalText);
  const text = attachments.length > 0 ? stripImageReferencesFromText(normalizedOriginalText) : normalizedOriginalText;

  if (!text && attachments.length === 0) return null;
  if (text.length > account.inboundMaxTextLength) return null;
  if (attachments.length === 0 && text.length < account.inboundMinTextLength) return null;

  if (account.inboundParseMode === "strict") {
    if (!hasExplicitType || (!hasSupportedTextType && attachments.length === 0)) return null;
  } else if (account.inboundParseMode === "legacy") {
    if (hasExplicitType && !hasSupportedTextType && attachments.length === 0) return null;
  } else {
    // balanced
    if (hasExplicitType && !hasSupportedTextType && attachments.length === 0) return null;
    if (!hasExplicitType && !account.inboundAllowTypelessText && attachments.length === 0) return null;
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
    originalText: normalizedOriginalText,
    timestamp,
    replyTarget,
    sourceMessageIds: [messageId],
    attachments,
    imageUrls,
    localFiles: [],
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
  wasMentioned: boolean,
): boolean {
  if (scope === "all") return true;
  if (scope === "direct") return event.chatType === "direct";
  if (scope === "group-all") return event.chatType === "group";
  if (scope === "group-mentions") return event.chatType === "group" && wasMentioned;
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
    const response = await requestVoceChatApi({
      url,
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
      const detail = response.body.trim().slice(0, 500);
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

function writeHtml(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

async function readRequestTextWithLimit(
  req: AsyncIterable<unknown>,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const direct = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (Array.isArray(direct)) return normalizeString(direct[0]);
  return normalizeString(direct);
}

async function processInboundEvent(params: {
  accountId: string;
  event: InboundEvent;
  skipAcceptanceCheck?: boolean;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<void> {
  const { accountId, logger, skipAcceptanceCheck } = params;
  const runtime = getVoceChatRuntime();
  const cfg = await runtime.config.loadConfig();
  const account = resolveVoceChatAccount(cfg, accountId);
  let event = params.event;
  if (!skipAcceptanceCheck && !acceptInboundEventForProcessing({ account, event, logger })) return;

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: event.chatType === "group" ? "group" : "direct",
      id: event.conversationId,
    },
  });
  const groupConfig = event.chatType === "group" ? resolveVoceChatGroupConfig(account, event.groupId) : undefined;
  if (event.chatType === "group" && groupConfig?.enabled === false) {
    logger?.info?.(
      `[vocechat] skip group event: group disabled account=${account.accountId} group=${event.groupId ?? event.conversationId} mid=${event.messageId}`,
    );
    return;
  }
  const requireMention = event.chatType === "group" ? groupConfig?.requireMention !== false : false;
  const mentionRegexes = requireMention ? buildMentionRegexes(cfg, route.agentId) : [];
  const canDetectMention = !requireMention || mentionRegexes.length > 0;
  const wasMentioned = event.chatType !== "group" || !requireMention
    ? true
    : matchesMentionPatterns(event.originalText || event.text, mentionRegexes);
  if (event.chatType === "group" && requireMention && !canDetectMention) {
    logger?.warn?.(
      `[vocechat] skip group event: no mention patterns available account=${account.accountId} group=${event.groupId ?? event.conversationId} agent=${route.agentId}`,
    );
    return;
  }
  if (event.chatType === "group" && requireMention && !wasMentioned) {
    logger?.info?.(
      `[vocechat] skip group event: no mention account=${account.accountId} group=${event.groupId ?? event.conversationId} mid=${event.messageId}`,
    );
    return;
  }

  const ackReaction = resolveAckReaction(cfg, account.accountId);
  const ackReactionScope = resolveAckReactionScope(cfg);
  if (ackReaction && shouldSendAckReaction(ackReactionScope, event, wasMentioned)) {
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

  event = await hydrateInboundAttachments({
    event,
    account,
    logger,
  });
  event = await enhanceInboundAttachmentsForAgent({
    event,
    account,
    logger,
  });
  logger?.info?.(
    `[vocechat] inbound media ready account=${account.accountId} mid=${event.messageId} localFiles=${event.localFiles.length} attachmentCount=${event.attachments.length}`,
  );
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
  const agentBody = buildInboundAgentBody(event);
  const rawMediaPaths = event.attachments.map((attachment) => normalizeString(attachment.localFile)).filter(Boolean);
  const rawMediaUrls = event.attachments.map((attachment) => normalizeString(attachment.url)).filter(Boolean);
  const rawMediaTypes = event.attachments.map((attachment) => normalizeMimeType(attachment.mimeType)).filter(Boolean);
  const ocrTexts = event.attachments.map((attachment) => normalizeString(attachment.ocrText)).filter(Boolean);
  const attachNativeVisionMedia = account.inboundNativeVisionEnabled || ocrTexts.length === 0;
  const mediaPaths = attachNativeVisionMedia ? rawMediaPaths : [];
  const mediaUrls = attachNativeVisionMedia ? rawMediaUrls : [];
  const mediaTypes = attachNativeVisionMedia ? rawMediaTypes : [];
  logger?.info?.(
    `[vocechat] inbound agent media mode account=${account.accountId} mid=${event.messageId} nativeVision=${attachNativeVisionMedia ? "enabled" : "ocr_only"} ocrCount=${ocrTexts.length} mediaCount=${rawMediaPaths.length}`,
  );

  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "VoceChat",
    from: conversationLabel,
    timestamp: event.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: agentBody,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: agentBody,
    RawBody: agentBody,
    CommandBody: agentBody,
    From: `vocechat:${event.fromUid}`,
    To: `vocechat:${event.replyTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: event.chatType,
    ConversationLabel: conversationLabel,
    GroupSubject: event.chatType === "group" ? `group:${event.groupId ?? event.conversationId}` : undefined,
    WasMentioned: event.chatType === "group" ? wasMentioned : undefined,
    SenderId: event.fromUid,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: event.messageId,
    SourceMessageIds: event.sourceMessageIds,
    sourceMessageIds: event.sourceMessageIds,
    Timestamp: event.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: event.replyTarget,
    CommandAuthorized: true,
    OriginalText: event.originalText,
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaUrl: mediaUrls[0],
    MediaUrls: mediaUrls,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes,
    LocalFiles: event.localFiles,
    localFiles: event.localFiles,
    Attachments: event.attachments,
    attachments: event.attachments,
    ImageUrls: event.imageUrls,
    imageUrls: event.imageUrls,
    Media: event.attachments,
    media: event.attachments,
    OcrText: ocrTexts[0],
    OcrTexts: ocrTexts,
    ImageOcrTexts: ocrTexts,
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
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const text = normalizeString(payload.text);

    if (mediaUrls.length > 0) {
      for (let index = 0; index < mediaUrls.length; index += 1) {
        const mediaUrl = mediaUrls[index];
        const caption = index === 0 ? text : "";
        await sendVoceChatMedia(
          {
            cfg,
            to: event.replyTarget,
            text: caption,
            mediaUrl,
            accountId: account.accountId,
          } as ChannelOutboundContext,
        );
      }
      return;
    }

    const combined = formatTextWithAttachmentLinks(text, []);
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

async function flushInboundMerge(params: {
  key: string;
  reason: "timeout" | "max_messages";
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<void> {
  const pending = pendingInboundMerges.get(params.key);
  if (!pending) return;

  pendingInboundMerges.delete(params.key);
  clearPendingInboundMerge(pending);

  const event = pending.events.length === 1 ? pending.events[0] : mergeInboundEvents(pending.events);
  const mids = event.sourceMessageIds.join(",");
  params.logger?.info?.(
    `[vocechat] inbound merge flushed account=${pending.accountId} key=${params.key} reason=${params.reason} count=${pending.events.length} mids=${clipAuditSegment(mids, 240)}`,
  );
  params.logger?.info?.(
    `[vocechat] inbound merge produced account=${pending.accountId} key=${params.key} textLen=${event.text.length} attachmentCount=${event.attachments.length}`,
  );

  await processInboundEvent({
    accountId: pending.accountId,
    event,
    skipAcceptanceCheck: true,
    logger: params.logger,
  });
}

function enqueueInboundMergeOrDispatch(params: {
  account: ResolvedAccount;
  event: InboundEvent;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): void {
  const { account, event, logger } = params;
  if (!shouldHoldInboundEventForMerge(account, event)) {
    void processInboundEvent({
      accountId: account.accountId,
      event,
      skipAcceptanceCheck: true,
      logger,
    }).catch((err) => {
      logger?.error?.(`[vocechat] inbound dispatch failed: ${String(err)}`);
    });
    return;
  }

  const key = buildInboundMergeKey(account.accountId, event);
  const existing = pendingInboundMerges.get(key);
  if (existing) {
    existing.events.push(event);
    logger?.info?.(
      `[vocechat] inbound merge appended account=${account.accountId} key=${key} mid=${event.messageId} pendingCount=${existing.events.length}`,
    );
    if (existing.events.length >= account.inboundMergeMaxMessages) {
      void flushInboundMerge({ key, reason: "max_messages", logger }).catch((err) => {
        logger?.error?.(`[vocechat] inbound merge flush failed key=${key} err=${String(err)}`);
      });
    }
    return;
  }

  const pending: PendingInboundMerge = {
    key,
    accountId: account.accountId,
    createdAt: nowMs(),
    flushAt: nowMs() + account.inboundMergeWindowMs,
    events: [event],
  };
  pending.timer = setTimeout(() => {
    void flushInboundMerge({ key, reason: "timeout", logger }).catch((err) => {
      logger?.error?.(`[vocechat] inbound merge flush failed key=${key} err=${String(err)}`);
    });
  }, account.inboundMergeWindowMs);
  pending.timer.unref?.();
  pendingInboundMerges.set(key, pending);
  logger?.info?.(
    `[vocechat] inbound merge queued account=${account.accountId} key=${key} mid=${event.messageId} holdMs=${account.inboundMergeWindowMs}`,
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
      `[vocechat] webhook parsed account=${account.accountId} mid=${event.messageId} from=${event.fromUid} chat=${event.chatType} len=${event.text.length} attachments=${event.attachments.length}`,
    );
    if (!acceptInboundEventForProcessing({ account, event, logger })) return;
    enqueueInboundMergeOrDispatch({
      account,
      event,
      logger,
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
        inboundMergeEnabled: { type: "boolean" },
        inboundMergeWindowMs: { type: "number", minimum: 0, maximum: 10000 },
        inboundMergeMaxMessages: { type: "number", minimum: 1, maximum: 10 },
        inboundImageNormalizationEnabled: { type: "boolean" },
        inboundImageNormalizationMaxEdge: { type: "number", minimum: 512, maximum: 4096 },
        inboundImageNormalizationQuality: { type: "number", minimum: 60, maximum: 100 },
        inboundNativeVisionEnabled: { type: "boolean" },
        inboundOcrEnabled: { type: "boolean" },
        inboundOcrLangs: { type: "string" },
        inboundOcrTimeoutMs: { type: "number", minimum: 5000, maximum: 120000 },
        inboundOcrMaxTextLength: { type: "number", minimum: 200, maximum: 10000 },
        inboundOcrLangPath: { type: "string" },
        webhookPath: { type: "string" },
        webhookApiKey: { type: "string" },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        groups: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              allow: { type: "boolean" },
              requireMention: { type: "boolean" },
            },
          },
        },
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
              inboundMergeEnabled: { type: "boolean" },
              inboundMergeWindowMs: { type: "number", minimum: 0, maximum: 10000 },
              inboundMergeMaxMessages: { type: "number", minimum: 1, maximum: 10 },
              inboundImageNormalizationEnabled: { type: "boolean" },
              inboundImageNormalizationMaxEdge: { type: "number", minimum: 512, maximum: 4096 },
              inboundImageNormalizationQuality: { type: "number", minimum: 60, maximum: 100 },
              inboundNativeVisionEnabled: { type: "boolean" },
              inboundOcrEnabled: { type: "boolean" },
              inboundOcrLangs: { type: "string" },
              inboundOcrTimeoutMs: { type: "number", minimum: 5000, maximum: 120000 },
              inboundOcrMaxTextLength: { type: "number", minimum: 200, maximum: 10000 },
              inboundOcrLangPath: { type: "string" },
              webhookPath: { type: "string" },
              webhookApiKey: { type: "string" },
              groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
              groups: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    enabled: { type: "boolean" },
                    allow: { type: "boolean" },
                    requireMention: { type: "boolean" },
                  },
                },
              },
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
      inboundImageNormalizationEnabled: {
        label: "入站图片规范化",
        advanced: true,
      },
      inboundOcrEnabled: {
        label: "入站 OCR 兜底",
        advanced: true,
      },
      inboundNativeVisionEnabled: {
        label: "强制原生视觉",
        advanced: true,
      },
      inboundOcrLangs: {
        label: "入站 OCR 语言",
        advanced: true,
      },
      inboundOcrLangPath: {
        label: "入站 OCR 语言包地址",
        advanced: true,
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
    sendMedia: async (ctx) => sendVoceChatMedia(ctx),
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
      clearPendingInboundMergesForAccount(ctx.accountId, {
        info: (message) => ctx.log?.info(message),
        warn: (message) => ctx.log?.warn(message),
        error: (message) => ctx.log?.error(message),
      });

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
      clearPendingInboundMergesForAccount(ctx.accountId, {
        info: (message) => ctx.log?.info(message),
        warn: (message) => ctx.log?.warn(message),
        error: (message) => ctx.log?.error(message),
      });
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
const COMMAND_CATALOG_COMMAND = "cmd";
const TRANSIT_HEALTH_COMMAND = "transit_health";
const WRITER_FLOW_COMMAND = "writerflow";
const WRITER_STATUS_COMMAND = "writerstatus";
const WRITER_REVIEW_COMMAND = "writerreview";
const WRITER_APPROVE_COMMAND = "writerapprove";
const WRITER_TASK_COMMAND = "writertask";
const SILENT_REPLY_TOKEN = "NO_REPLY";

type VoceChatPanelAction = "home" | "accounts" | "account-detail" | "webhook" | "routing" | "access" | "admin-remove-confirm" | "admin-remove" | "set-default-target";

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

function registerCommandCatalogCommands(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: COMMAND_CATALOG_COMMAND,
    description: "返回 OpenClaw 自定义命令目录，支持关键字过滤",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleCommandCatalogCommand(ctx),
  });
}

function registerTransitHealthCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: TRANSIT_HEALTH_COMMAND,
    description: "检查或修复共享 transit 交付目录的可写性（管理员）",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleTransitHealthCommand(ctx, api.config as OpenClawConfig),
  });
}

function registerWriterFlowCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: WRITER_FLOW_COMMAND,
    description: "返回 main 监督 writer 小说章节的调度说明",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => ({
      text: renderWriterFlowGuide(),
    }),
  });
}

function registerWriterStatusCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: WRITER_STATUS_COMMAND,
    description: "返回 writer 小说监督任务的状态追问模板",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => ({
      text: renderWriterStatusGuide(),
    }),
  });
}

function registerWriterReviewCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: WRITER_REVIEW_COMMAND,
    description: "返回 writer 小说章节的返工意见模板",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => ({
      text: renderWriterReviewGuide(),
    }),
  });
}

function registerWriterApproveCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: WRITER_APPROVE_COMMAND,
    description: "返回 writer 小说章节通过编审后的归档模板",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => ({
      text: renderWriterApproveGuide(),
    }),
  });
}

function registerWriterTaskCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: WRITER_TASK_COMMAND,
    description: "返回要求 main 创建 writer 小说监督任务的模板",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => ({
      text: renderWriterTaskGuide(),
    }),
  });
}

async function handleCommandCatalogCommand(ctx: PluginCommandContext): Promise<ReplyPayload> {
  try {
    return {
      text: await renderCustomCommandCatalog(ctx.args ?? ""),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      text: [
        "自定义命令目录",
        "",
        "读取失败。",
        detail,
        "",
        `脚本：${resolveCustomCommandCatalogScriptPath()}`,
        `文档：${resolveCustomCommandCatalogMarkdownPath()}`,
      ].join("\n"),
      isError: true,
    };
  }
}

async function handleTransitHealthCommand(ctx: PluginCommandContext, cfg: OpenClawConfig): Promise<ReplyPayload> {
  const management = resolveVoceChatManagement(cfg);
  if (!isVoceChatAdminAuthorized(ctx, management)) {
    return {
      text: [
        "Transit 健康检查",
        "",
        "无权限：仅管理员可执行该命令。",
      ].join("\n"),
      isError: true,
    };
  }

  const { mode, target } = parseTransitHealthArgs(ctx.args ?? "");
  const scriptPath = path.join(resolveOpenClawStateDir(), "workspace", "memory", "ops", "transit_health.sh");
  try {
    await fs.access(scriptPath);
    const args = [scriptPath, mode];
    if (target) args.push(target);
    const rendered = await execFileText("sh", args);
    return {
      text: rendered.trim(),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      text: [
        "Transit 健康检查",
        "",
        "执行失败。",
        detail,
        "",
        `脚本：${scriptPath}`,
      ].join("\n"),
      isError: true,
    };
  }
}

function parseTransitHealthArgs(rawArgs: string): { mode: "check" | "repair"; target: string } {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const first = (tokens[0] ?? "").toLowerCase();
  if (first === "repair") {
    return { mode: "repair", target: tokens.slice(1).join(" ") };
  }
  if (first === "check" || first === "") {
    return { mode: "check", target: tokens.slice(first ? 1 : 0).join(" ") };
  }
  return { mode: "check", target: tokens.join(" ") };
}

async function renderCustomCommandCatalog(rawArgs: string): Promise<string> {
  const queryTokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const scriptPath = resolveCustomCommandCatalogScriptPath();
  try {
    await fs.access(scriptPath);
    const rendered = await execFileText("python3", [scriptPath, ...queryTokens]);
    if (rendered.trim()) return rendered.trim();
  } catch (error) {
    if (queryTokens.length > 0) throw error;
  }

  const markdownPath = resolveCustomCommandCatalogMarkdownPath();
  const markdown = await fs.readFile(markdownPath, "utf8");
  return markdown.trim();
}

function resolveCustomCommandCatalogScriptPath(): string {
  return path.join(resolveOpenClawStateDir(), "workspace", "memory", "ops", "custom_commands_catalog.py");
}

function resolveCustomCommandCatalogMarkdownPath(): string {
  return path.join(resolveOpenClawStateDir(), "workspace", "COMMANDS.md");
}

async function execFileText(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFileCallback(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(detail));
        return;
      }
      resolve(stdout);
    });
  });
}

function renderWriterFlowGuide(): string {
  return [
    "Writer 小说调度说明",
    "",
    "监督闭环：create-task -> writer 交 transit -> main 编审 -> request-rework/approve -> main 归档正式目录",
    "",
    "发给 main 的总开关：",
    "```text",
    "从现在开始，你对 writer 的小说章节任务一律走监督工作流，不要只口头派单。",
    "",
    "硬性要求：",
    "1. 先 create-task",
    "2. writer 首稿和返工稿都只能交到 transit/writer/_workflow/...",
    "3. 你必须先编审",
    "4. 不通过就 request-rework，并写具体问题和修改要求",
    "5. 通过后才 approve，并由你落正式章节目录",
    "6. 所有进度汇报必须以 task.json 为准，不要拿“编审中”这种空话糊弄我",
    "```",
    "",
    "指定某章开始执行：",
    "```text",
    "现在开始处理第12章，按监督工作流执行。先把 task id、当前状态、交稿路径发我，再进行编审。",
    "```",
    "",
    "追状态：",
    "```text",
    "报第12章 workflow 状态：task id、status、latest_delivery、latest_review、formal_target。",
    "```",
    "",
    "防止装懂：",
    "```text",
    "如果 task.json 没显示到对应状态，就不要说“已返工”“编审中”“已完成”。只按真实状态回报。",
    "```",
    "",
    "要求退回返工：",
    "```text",
    "如果第12章有问题，不要自己脑补通过。直接写 review 文件，明确列出必改项、修改方向和不要改动项，然后让 writer 按同一 task 返工提审。",
    "```",
    "",
    "要求通过归档：",
    "```text",
    "如果第12章通过编审，就执行 approve，把批准稿落到正式章节目录，并把最终 formal path 回报给我。",
    "```",
  ].join("\n");
}

function renderWriterStatusGuide(): string {
  return [
    "Writer 状态追问模板",
    "",
    "标准追法：",
    "```text",
    "报第12章 workflow 状态：task id、status、latest_delivery、latest_review、formal_target。",
    "```",
    "",
    "如果你已经知道 task id：",
    "```text",
    "报 tailend-v1-ch012 的 workflow 状态：status、round、latest_delivery、latest_review、formal_target。",
    "```",
    "",
    "要求它别装懂：",
    "```text",
    "如果 task.json 没显示到对应状态，就不要说“已返工”“编审中”“已完成”。只按真实状态回报。",
    "```",
    "",
    "要求它顺带报审稿结论：",
    "```text",
    "除了 workflow 状态，再补一句你当前结论：待审、已退回返工、还是已通过归档。",
    "```",
    "",
    "通用状态含义：",
    "- `assigned`：已建任务，writer 还没交稿",
    "- `awaiting_review`：writer 已交稿，等 main 编审",
    "- `rework_requested`：main 已退回，等 writer 返工",
    "- `merged`：main 已通过并落正式章节目录",
  ].join("\n");
}

function renderWriterReviewGuide(): string {
  return [
    "Writer 返工意见模板",
    "",
    "要求 main 真下 review：",
    "```text",
    "如果这一章有问题，不要只说“再润一下”。直接按 workflow 写 review 文件，至少包含：",
    "1. 本轮结论",
    "2. 必改问题",
    "3. 修改要求",
    "4. 不要改动",
    "5. 返工目标",
    "然后让 writer 按同一 task 返工提审。",
    "```",
    "",
    "短版发令：",
    "```text",
    "这章如果不通过，就 request-rework，并把问题写具体：哪里冲突、哪里抢戏、哪里逻辑不顺、要怎么改、哪些不能动。",
    "```",
    "",
    "防止空话：",
    "```text",
    "不准用“再润一下”“节奏不太行”“感觉有点怪”这种空意见，必须给出可执行修改要求。",
    "```",
    "",
    "返工意见结构范例：",
    "```text",
    "# 第12章返工意见",
    "",
    "## 本轮结论",
    "第12章当前版本不通过，需返工后再提审。",
    "",
    "## 必改问题",
    "1. ...",
    "2. ...",
    "",
    "## 修改要求",
    "1. ...",
    "2. ...",
    "",
    "## 不要改动",
    "1. ...",
    "",
    "## 返工目标",
    "这章最终要落在……，不要提前吃掉后章职责。",
    "```",
  ].join("\n");
}

function renderWriterApproveGuide(): string {
  return [
    "Writer 通过归档模板",
    "",
    "要求 main 正式归档：",
    "```text",
    "如果这一章通过编审，就执行 approve，把批准稿落到正式章节目录，并把 task id、status、formal_target、source_file 回报给我。",
    "```",
    "",
    "短版发令：",
    "```text",
    "第12章如已通过，就不要停在“审核通过”这句空话。直接 approve，落正式目录，并把最终 formal path 发我。",
    "```",
    "",
    "要求它回报落盘结果：",
    "```text",
    "报第12章最终归档结果：task id、status、latest_delivery、formal_target。",
    "```",
    "",
    "防止假通过：",
    "```text",
    "只有 task.json 状态变成 merged，且 formal_target 已落盘，才能说“已通过归档”。否则不要报完成。",
    "```",
    "",
    "常用通过口径：",
    "```text",
    "返工项已修复，本章通过编审并归档正式目录。",
    "```",
  ].join("\n");
}

function renderWriterTaskGuide(): string {
  return [
    "Writer 建任务模板",
    "",
    "要求 main 先建 workflow task：",
    "```text",
    "现在先不要让 writer 直接开写。先为第12章创建 workflow task，然后把 task id、task.json 路径、formal_target、当前 status 发我。",
    "```",
    "",
    "短版发令：",
    "```text",
    "先 create-task，再派 writer。不要跳过 task 创建这一步。",
    "```",
    "",
    "要求它连正式目标一起报：",
    "```text",
    "给第12章建 task 后，回报：task id、task.json、deliveries_dir、reviews_dir、formal_target。",
    "```",
    "",
    "如果是接管 transit 里的现成稿：",
    "```text",
    "把第12章现有 transit 稿纳入监督流程：先建 task，再把现稿登记成 awaiting_review，然后把 task id 和 latest_delivery 发我。",
    "```",
    "",
    "防止跳步：",
    "```text",
    "没有 task id 之前，不要说已经开始编审，也不要让 writer 直接写正式章节目录。",
    "```",
  ].join("\n");
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

    let effectiveCfg = cfg;
    let effectiveAction = parsed.action;
    let effectiveArg = parsed.arg;
    let notice = "";

    if (parsed.action === "admin-remove") {
      const senderId = normalizeIdentity(parsed.arg);
      if (senderId) {
        const summary = await updateVoceChatAdminRemoval(senderId);
        effectiveCfg = await loadHostConfigForEdit() as OpenClawConfig;
        effectiveAction = "access";
        effectiveArg = "";
        notice = summary;
      }
    } else if (parsed.action === "set-default-target") {
      const mutation = parseVoceChatTargetMutationArg(parsed.arg);
      if (mutation) {
        const summary = await updateVoceChatDefaultTarget(mutation.accountId, mutation.targetRaw);
        effectiveCfg = await loadHostConfigForEdit() as OpenClawConfig;
        effectiveAction = mutation.returnAction;
        effectiveArg = mutation.returnArg ?? "";
        notice = summary;
      }
    }

    const response = renderVoceChatPanel(effectiveCfg, effectiveAction, effectiveArg, parsed.panelId);
    const responseText = notice ? `${notice}\n\n${response.text}` : response.text;
    await delivery.editMessage(
      { chatId: panel.chatId, threadId: panel.threadId },
      panel.messageId,
      { text: responseText, replyMarkup: { inline_keyboard: response.buttons } },
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
    case "admin-remove-confirm":
      return renderVoceChatAdminRemoveConfirmPanel(cfg, panelId, arg);
    case "admin-remove":
      return renderVoceChatAccessPanel(cfg, panelId);
    case "set-default-target":
      return renderVoceChatRoutingPanel(cfg, panelId);
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
    buttons: buildVoceChatMainButtons(panelId),
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
    `入站合并：${account.inboundMergeEnabled ? "开启" : "关闭"}`,
    `合并窗口：${account.inboundMergeWindowMs} ms / 最多 ${account.inboundMergeMaxMessages} 条`,
    `图片规范化：${account.inboundImageNormalizationEnabled ? "开启" : "关闭"} / ${account.inboundImageNormalizationMaxEdge}px / JPEG ${account.inboundImageNormalizationQuality}`,
    `原生视觉注入：${account.inboundNativeVisionEnabled ? "始终开启" : "OCR 成功时自动关闭"}`,
    `OCR 兜底：${account.inboundOcrEnabled ? "开启" : "关闭"} / ${account.inboundOcrLangs.join("+")} / ${account.inboundOcrTimeoutMs} ms / 最多 ${account.inboundOcrMaxTextLength} 字`,
    `OCR 语言包：${account.inboundOcrLangPath ?? "<默认 CDN 缓存>"}`,
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
    buttons: buildVoceChatAccountDetailButtons(panelId, account, cfg),
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
    buttons: buildVoceChatMainButtons(panelId),
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
    buttons: buildVoceChatRoutingButtons(cfg, panelId),
  };
}


function renderVoceChatAdminRemoveConfirmPanel(cfg: OpenClawConfig, panelId: string, senderIdRaw: string): VoceChatPanelResponse {
  const senderId = normalizeIdentity(senderIdRaw);
  const management = resolveVoceChatManagement(cfg);
  const exists = management.adminSenderIds.map(normalizeIdentity).includes(senderId);
  const lines = [
    "确认删除管理员",
    "",
    `管理员：${senderId || "<空>"}`,
    `当前存在：${exists ? "是" : "否"}`,
    "",
    exists ? "请确认是否删除该管理员。" : "该管理员已不存在，可返回权限面板刷新查看。",
  ];

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (exists) {
    buttons.push([
      { text: "确认删除", style: "danger", callback_data: buildVoceChatPanelCallback(panelId, "z", senderId) },
    ]);
  }
  buttons.push([
    { text: "取消返回", callback_data: buildVoceChatPanelCallback(panelId, "x") },
  ]);

  return {
    text: lines.join("\n"),
    buttons,
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
    `管理员列表：${management.adminSenderIds.length > 0 ? management.adminSenderIds.join("、") : "未设置"}`,
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
    buttons: buildVoceChatAccessButtons(panelId, management.adminSenderIds),
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

function buildVoceChatRoutingButtons(cfg: OpenClawConfig, panelId: string): TelegramInlineKeyboardButton[][] {
  const currentTarget = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID).defaultTo ?? "";
  const management = resolveVoceChatManagement(cfg);
  return [
    ...buildVoceChatQuickTargetRows(panelId, DEFAULT_ACCOUNT_ID, management.quickTargets, currentTarget, "routing"),
    [
      buildVoceChatCopyButton("复制默认目标", `/${VOCECHAT_CONTROL_COMMAND} set default-to user:2`),
    ],
    [
      buildVoceChatCopyButton("复制指定账号目标", `/${VOCECHAT_CONTROL_COMMAND} set default-to default user:2`),
    ],
    ...buildVoceChatMainButtons(panelId),
  ];
}

function buildVoceChatAccountDetailButtons(panelId: string, account: ResolvedAccount, cfg: OpenClawConfig): TelegramInlineKeyboardButton[][] {
  const currentTarget = account.defaultTo ?? "";
  const management = resolveVoceChatManagement(cfg);
  return [
    ...buildVoceChatQuickTargetRows(panelId, account.accountId, management.quickTargets, currentTarget, "account-detail", account.accountId),
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
  ];
}

function buildVoceChatAccessButtons(panelId: string, adminSenderIds: string[]): TelegramInlineKeyboardButton[][] {
  const adminRows = adminSenderIds.map((senderId) => [{
    text: `删除 ${senderId}`,
    callback_data: buildVoceChatPanelCallback(panelId, "y", senderId),
  }]);

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
    ...adminRows,
    ...buildVoceChatMainButtons(panelId),
  ];
}

function buildVoceChatQuickTargetRows(
  panelId: string,
  accountId: string,
  quickTargets: VoceChatQuickTargets,
  currentTarget: string,
  returnAction: "routing" | "account-detail",
  returnArg = "",
): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [];
  if (quickTargets.users.length > 0) {
    rows.push(buildVoceChatQuickTargetRow(panelId, accountId, quickTargets.users, currentTarget, returnAction, returnArg));
  }
  if (quickTargets.groups.length > 0) {
    rows.push(buildVoceChatQuickTargetRow(panelId, accountId, quickTargets.groups, currentTarget, returnAction, returnArg));
  }
  return rows;
}

function buildVoceChatQuickTargetRow(
  panelId: string,
  accountId: string,
  targets: string[],
  currentTarget: string,
  returnAction: "routing" | "account-detail",
  returnArg = "",
): TelegramInlineKeyboardButton[] {
  return targets.map((targetRaw) =>
    buildVoceChatQuickTargetButton(panelId, accountId, targetRaw, currentTarget, returnAction, returnArg),
  );
}

function buildVoceChatQuickTargetButton(
  panelId: string,
  accountId: string,
  targetRaw: string,
  currentTarget: string,
  returnAction: "routing" | "account-detail",
  returnArg = "",
): TelegramInlineKeyboardButton {
  const isCurrent = currentTarget === targetRaw;
  return {
    text: `${isCurrent ? "✅ " : "设为 "}${targetRaw}`,
    style: isCurrent ? "primary" : "success",
    callback_data: buildVoceChatPanelCallback(
      panelId,
      "t",
      buildVoceChatTargetMutationArg(accountId, targetRaw, returnAction, returnArg),
    ),
  };
}

function buildVoceChatTargetMutationArg(accountId: string, targetRaw: string, returnAction: "routing" | "account-detail", returnArg = ""): string {
  return [accountId, targetRaw, returnAction, returnArg].join("|");
}

function parseVoceChatTargetMutationArg(raw: string): { accountId: string; targetRaw: string; returnAction: VoceChatPanelAction; returnArg: string } | null {
  const [accountIdRaw = DEFAULT_ACCOUNT_ID, targetRaw = "", returnActionRaw = "routing", returnArg = ""] = raw.split("|");
  if (!parseTarget(targetRaw)) return null;
  const returnAction = decodeVoceChatPanelAction(returnActionRaw);
  return {
    accountId: normalizeAccountId(accountIdRaw || DEFAULT_ACCOUNT_ID),
    targetRaw,
    returnAction,
    returnArg,
  };
}

function buildVoceChatCopyButton(text: string, command: string): TelegramInlineKeyboardButton {
  return {
    text,
    style: "primary",
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

function buildVoceChatPanelCallback(panelId: string, action: "h" | "l" | "a" | "w" | "r" | "x" | "y" | "z" | "t", arg?: string): string {
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
    case "y":
    case "admin-remove-confirm":
      return "admin-remove-confirm";
    case "z":
    case "admin-remove":
      return "admin-remove";
    case "t":
    case "set-default-target":
      return "set-default-target";
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
    const summary = await updateVoceChatAdminRemoval(senderId);
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

async function updateVoceChatAdminRemoval(senderId: string): Promise<string> {
  return await updateVoceChatHostConfig((channelConfig) => {
    const managementSection = ensureMutableRecord(channelConfig, "management");
    const current = parseAllowEntries(managementSection.adminSenderIds).map(normalizeIdentity).filter(Boolean);
    managementSection.adminSenderIds = current.filter((entry) => entry !== senderId);
    return `已移除管理员：${senderId}`;
  });
}

async function updateVoceChatDefaultTarget(accountId: string, targetRaw: string): Promise<string> {
  return await updateVoceChatHostConfig((channelConfig) => {
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

  const summary = await updateVoceChatDefaultTarget(accountId, targetRaw);

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

let approvalForwarderService: VoceChatApprovalForwarderService | null = null;

const plugin = {
  id: CHANNEL_ID,
  name: "VoceChat Channel",
  description: "VoceChat inbound/outbound channel integration",
  register(api: OpenClawPluginApi) {
    setVoceChatRuntime(api.runtime);
    api.registerChannel({ plugin: voceChatChannel });
    registerVoceChatManagementCommand(api);
    registerCommandCatalogCommands(api);
    registerTransitHealthCommand(api);
    registerWriterFlowCommand(api);
    registerWriterStatusCommand(api);
    registerWriterReviewCommand(api);
    registerWriterApproveCommand(api);
    registerWriterTaskCommand(api);
    api.registerService?.({
      id: "vocechat-approval-forwarder",
      start: async () => {
        if (approvalForwarderService) return;
        approvalForwarderService = new VoceChatApprovalForwarderService({
          cfg: api.config as OpenClawConfig,
          logger: {
            info: (message: string) => api.logger.info(message),
            warn: (message: string) => api.logger.warn(message),
            error: (message: string) => api.logger.error(message),
            debug: (message: string) => api.logger.debug?.(message),
          },
          version: api.version ?? "0.4.9",
        });
        approvalForwarderService.start();
      },
      stop: async () => {
        approvalForwarderService?.stop();
        approvalForwarderService = null;
      },
    });
  },
};

export default plugin;
