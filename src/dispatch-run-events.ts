import {
  buildHiddenRunEventMarkdown,
  type VoceChatRunEventMessageType,
} from "./run-event-meta.js";

export type VoceChatRunEventDispatchContext = {
  runId: string;
  queueKey?: string;
  queueItemId?: string;
  logger?: {
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  deliver: (text: string) => Promise<void>;
};

export type VoceChatDispatchRunEventBridge = {
  replyOptions: Record<string, unknown>;
};

type RunEventSpec = {
  messageType: VoceChatRunEventMessageType;
  title: string;
  phase?: string;
  emphasis?: "subtle" | "accent" | "emphasis";
  body?: string;
  meta?: Record<string, unknown>;
};

const MAX_SUMMARY_LENGTH = 900;
const MAX_FIELD_LENGTH = 220;
const MAX_COMMAND_OUTPUT_LENGTH = 1600;
const REASONING_NOTICE_COOLDOWN_MS = 15_000;

export function createVoceChatDispatchRunEventBridge(
  ctx: VoceChatRunEventDispatchContext,
): VoceChatDispatchRunEventBridge {
  let sequence = 0;
  let lastReasoningNoticeAt = 0;
  const seen = new Set<string>();

  const emit = (spec: RunEventSpec) => {
    const body = normalizeText(spec.body) || spec.title;
    if (!body) return;
    const dedupeKey = [
      spec.messageType,
      spec.phase || "",
      body,
      normalizeText(spec.meta?.tool_name),
      normalizeText(spec.meta?.command),
    ].join("\u0000");
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    if (seen.size > 240) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }

    sequence += 1;
    const markdown = buildHiddenRunEventMarkdown(body, {
      messageType: spec.messageType,
      phase: spec.phase,
      emphasis: spec.emphasis,
      runId: ctx.runId,
      sequence,
      queue_key: ctx.queueKey,
      queue_item_id: ctx.queueItemId,
      ...spec.meta,
    });

    void ctx.deliver(markdown).catch((error) => {
      ctx.logger?.warn?.(
        `[vocechat] run-event delivery failed type=${spec.messageType} run=${ctx.runId} err=${String(error)}`,
      );
    });
  };

  return {
    replyOptions: {
      suppressDefaultToolProgressMessages: true,
      onToolStart: (...args: unknown[]) => {
        const event = firstRecord(args);
        const toolName = pickString(event, ["toolName", "tool_name", "name", "tool", "functionName", "function_name"])
          || normalizeText(args[0]);
        const preview = pickString(event, ["preview", "inputPreview", "argsPreview", "description", "title"]);
        emit({
          messageType: "tool_call",
          title: "开始调用工具",
          phase: "tool-call",
          emphasis: "accent",
          body: joinLines([
            `工具：${toolName || "unknown"}`,
            preview ? `输入：${clip(preview, MAX_FIELD_LENGTH)}` : "",
          ]),
          meta: {
            tool_name: toolName || undefined,
          },
        });
      },
      onToolResult: (...args: unknown[]) => {
        const event = firstRecord(args);
        const toolName = pickString(event, ["toolName", "tool_name", "name", "tool", "functionName", "function_name"]);
        const ok = pickBoolean(event, ["ok", "success", "succeeded"]);
        const summary = summarizeEvent(event, args, ["result", "output", "summary", "preview", "text", "content"], MAX_SUMMARY_LENGTH);
        emit({
          messageType: ok === false ? "error" : "tool_result",
          title: ok === false ? "工具执行失败" : "工具执行完成",
          phase: ok === false ? "tool-error" : "tool-result",
          emphasis: ok === false ? "accent" : "subtle",
          body: joinLines([
            toolName ? `工具：${toolName}` : "",
            summary || (ok === false ? "工具执行失败。" : "工具执行完成。"),
          ]),
          meta: {
            tool_name: toolName || undefined,
            ok: typeof ok === "boolean" ? ok : undefined,
          },
        });
      },
      onCommandOutput: (...args: unknown[]) => {
        const event = firstRecord(args);
        const command = pickString(event, ["command", "cmd", "shellCommand", "shell_command"]);
        const exitCode = pickNumber(event, ["exitCode", "exit_code", "code", "status"]);
        const output = summarizeEvent(event, args, ["output", "stdout", "stderr", "summary", "text", "content"], MAX_COMMAND_OUTPUT_LENGTH);
        emit({
          messageType: typeof exitCode === "number" && exitCode !== 0 ? "error" : "command_output",
          title: "命令输出",
          phase: "command-output",
          emphasis: typeof exitCode === "number" && exitCode !== 0 ? "accent" : "subtle",
          body: joinLines([
            command ? `$ ${clip(command, MAX_FIELD_LENGTH)}` : "命令输出",
            typeof exitCode === "number" ? `退出码：${exitCode}` : "",
            output,
          ]),
          meta: {
            command: command || undefined,
            exit_code: exitCode,
          },
        });
      },
      onPatchSummary: (...args: unknown[]) => {
        const event = firstRecord(args);
        const summary = summarizeEvent(event, args, ["summary", "text", "content", "preview"], MAX_SUMMARY_LENGTH);
        emit({
          messageType: "patch",
          title: "补丁摘要",
          phase: "patch",
          emphasis: "emphasis",
          body: summary || "已生成补丁摘要。",
          meta: {
            files_changed: pickNumber(event, ["filesChanged", "files_changed"]),
          },
        });
      },
      onPlanUpdate: (...args: unknown[]) => {
        const event = firstRecord(args);
        const summary = summarizePlanEvent(event, args);
        emit({
          messageType: "plan_update",
          title: "计划更新",
          phase: "plan-update",
          emphasis: "subtle",
          body: summary || "计划已更新。",
        });
      },
      onApprovalEvent: (...args: unknown[]) => {
        const event = firstRecord(args);
        const approvalId = pickString(event, ["approvalId", "approval_id", "id"]);
        const decision = pickString(event, ["decision", "status", "state"]);
        const summary = summarizeEvent(event, args, ["summary", "message", "text", "reason"], MAX_SUMMARY_LENGTH);
        emit({
          messageType: "approval_event",
          title: "审批事件",
          phase: normalizeToken(decision) || "approval-event",
          emphasis: "accent",
          body: joinLines([
            decision ? `状态：${decision}` : "审批事件",
            summary,
          ]),
          meta: {
            approval_id: approvalId || undefined,
            decision: decision || undefined,
          },
        });
      },
      onItemEvent: (...args: unknown[]) => {
        const event = firstRecord(args);
        const type = pickString(event, ["type", "eventType", "event_type", "kind"]);
        const summary = summarizeEvent(event, args, ["summary", "message", "text", "content", "preview"], MAX_SUMMARY_LENGTH);
        emit({
          messageType: "item_event",
          title: "执行事件",
          phase: normalizeToken(type) || "item-event",
          emphasis: "subtle",
          body: summary || (type ? `事件：${type}` : "执行事件已更新。"),
          meta: {
            item_event_type: type || undefined,
          },
        });
      },
      onPartialReply: (...args: unknown[]) => {
        const event = firstRecord(args);
        const text = summarizeEvent(event, args, ["summary", "preview", "text", "content"], MAX_FIELD_LENGTH);
        emit({
          messageType: "partial_reply",
          title: "回复生成中",
          phase: "partial-reply",
          emphasis: "subtle",
          body: text ? `回复片段：${text}` : "回复生成中。",
        });
      },
      onReasoningStream: (...args: unknown[]) => {
        const now = Date.now();
        if (now - lastReasoningNoticeAt < REASONING_NOTICE_COOLDOWN_MS) return;
        lastReasoningNoticeAt = now;
        const event = firstRecord(args);
        const status = pickString(event, ["status", "phase", "type"]) || "updated";
        emit({
          messageType: "reasoning",
          title: "推理过程更新",
          phase: "reasoning",
          emphasis: "subtle",
          body: `推理过程更新：${status}`,
          meta: {
            reasoning_status: status,
          },
        });
      },
      onBlockReplyQueued: (...args: unknown[]) => {
        const event = firstRecord(args);
        const blockType = pickString(event, ["type", "kind", "blockType", "block_type"]);
        const summary = summarizeEvent(event, args, ["summary", "preview", "text", "content"], MAX_FIELD_LENGTH);
        emit({
          messageType: "block_queued",
          title: "回复块已入队",
          phase: "block-queued",
          emphasis: "subtle",
          body: joinLines([
            blockType ? `类型：${blockType}` : "回复块已入队。",
            summary,
          ]),
          meta: {
            block_type: blockType || undefined,
          },
        });
      },
    },
  };
}

function firstRecord(values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return {};
}

function summarizePlanEvent(event: Record<string, unknown>, args: unknown[]): string {
  const direct = summarizeEvent(event, args, ["summary", "message", "text", "content"], MAX_SUMMARY_LENGTH);
  if (direct) return direct;
  const items = event.items || event.plan || event.steps;
  if (!Array.isArray(items)) return "";
  return items
    .slice(0, 8)
    .map((item) => {
      if (!isRecord(item)) return clip(item, MAX_FIELD_LENGTH);
      const status = pickString(item, ["status", "state"]);
      const text = pickString(item, ["step", "text", "title", "description", "content"]);
      return [status ? `[${status}]` : "", text].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeEvent(
  event: Record<string, unknown>,
  args: unknown[],
  keys: string[],
  limit: number,
): string {
  const fromKey = pickString(event, keys);
  if (fromKey) return clip(fromKey, limit);
  for (const arg of args) {
    if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") {
      const text = normalizeText(arg);
      if (text) return clip(text, limit);
    }
  }
  return "";
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const normalized = normalizeText(value);
      if (normalized) return normalized;
    }
  }
  return "";
}

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function joinLines(lines: string[]): string {
  return lines.map((line) => normalizeText(line)).filter(Boolean).join("\n");
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function clip(value: unknown, limit: number): string {
  const text = normalizeText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
