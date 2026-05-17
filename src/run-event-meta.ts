export type VoceChatRunEventMessageType =
  | "process_summary"
  | "execution_record"
  | "tool_call"
  | "tool_result"
  | "command_output"
  | "patch"
  | "plan_update"
  | "approval_event"
  | "item_event"
  | "partial_reply"
  | "reasoning"
  | "block_queued"
  | "queue"
  | "approval"
  | "management"
  | "error"
  | "final";

export type VoceChatRunEventMeta = {
  messageType: VoceChatRunEventMessageType;
  kind?: string;
  phase?: string;
  runId?: string;
  sequence?: number;
  queue_key?: string;
  queue_item_id?: string;
  queue_position?: number;
  approval_id?: string;
  action?: string;
  emphasis?: "subtle" | "accent" | "emphasis" | string;
  [key: string]: unknown;
};

export const VOCECHAT_RUN_EVENT_SCHEMA = "vocechat-run-event/v1";
export const VOCECHAT_RUN_EVENT_SOURCE = "openclaw-vocechat-channel";
export const VOCECHAT_RUN_EVENT_COMMENT_PREFIX = "vocechat-meta";

let nextSequence = 1;

export function mapVoceChatRunEventMessageType(
  messageType: VoceChatRunEventMessageType,
): { kind: string; phase: string } {
  switch (messageType) {
    case "queue":
      return { kind: "queue", phase: "queued" };
    case "approval":
      return { kind: "approval", phase: "requested" };
    case "approval_event":
      return { kind: "approval", phase: "event" };
    case "management":
      return { kind: "management", phase: "notice" };
    case "tool_call":
      return { kind: "tool", phase: "tool-call" };
    case "tool_result":
      return { kind: "tool", phase: "tool-result" };
    case "command_output":
      return { kind: "execution", phase: "command-output" };
    case "patch":
      return { kind: "artifact", phase: "patch" };
    case "plan_update":
      return { kind: "progress", phase: "plan-update" };
    case "item_event":
      return { kind: "progress", phase: "item-event" };
    case "partial_reply":
      return { kind: "progress", phase: "partial-reply" };
    case "reasoning":
      return { kind: "progress", phase: "reasoning" };
    case "block_queued":
      return { kind: "progress", phase: "block-queued" };
    case "execution_record":
      return { kind: "execution", phase: "record" };
    case "error":
      return { kind: "error", phase: "error" };
    case "final":
      return { kind: "final", phase: "final" };
    case "process_summary":
    default:
      return { kind: "progress", phase: "summary" };
  }
}

export function buildVoceChatRunEventMeta(meta: VoceChatRunEventMeta): Record<string, unknown> {
  const mapped = mapVoceChatRunEventMessageType(meta.messageType);
  const runId = normalizeMetaValue(meta.runId)
    || normalizeMetaValue(meta.queue_item_id)
    || normalizeMetaValue(meta.approval_id);
  const payload: Record<string, unknown> = {
    schema: VOCECHAT_RUN_EVENT_SCHEMA,
    source: VOCECHAT_RUN_EVENT_SOURCE,
    messageType: meta.messageType,
    kind: normalizeMetaValue(meta.kind) || mapped.kind,
    phase: normalizeMetaValue(meta.phase) || mapped.phase,
    runId: runId || undefined,
    sequence: typeof meta.sequence === "number" ? meta.sequence : nextSequence++,
  };

  for (const [key, value] of Object.entries(meta)) {
    if (["messageType", "kind", "phase", "runId", "sequence"].includes(key)) continue;
    if (isEmptyMetaValue(value)) continue;
    payload[key] = value;
  }

  return Object.fromEntries(Object.entries(payload).filter(([, value]) => !isEmptyMetaValue(value)));
}

export function buildHiddenRunEventMarkdown(body: string, meta: VoceChatRunEventMeta): string {
  const payload = buildVoceChatRunEventMeta(meta);
  const metaJson = JSON.stringify(payload);
  const text = String(body ?? "").trim();
  return `<!-- ${VOCECHAT_RUN_EVENT_COMMENT_PREFIX}:${metaJson} -->\n${text}`.trim();
}

function normalizeMetaValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isEmptyMetaValue(value: unknown): boolean {
  return value === undefined
    || value === null
    || value === ""
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
}
