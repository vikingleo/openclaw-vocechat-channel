export type VoceChatRunEventMessageType =
  | "process_summary"
  | "execution_record"
  | "queue"
  | "approval"
  | "management"
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
export const VOCECHAT_RUN_EVENT_COMMENT_PREFIX = "hermes-meta";

let nextSequence = 1;

export function mapVoceChatRunEventMessageType(
  messageType: VoceChatRunEventMessageType,
): { kind: string; phase: string } {
  switch (messageType) {
    case "queue":
      return { kind: "queue", phase: "queued" };
    case "approval":
      return { kind: "approval", phase: "requested" };
    case "management":
      return { kind: "management", phase: "notice" };
    case "execution_record":
      return { kind: "execution", phase: "record" };
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
