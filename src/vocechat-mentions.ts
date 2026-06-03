function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeMentionIds(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const normalized = normalizeId(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseJsonObjectWithEmbeddedPrefix(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
  } catch {
    return {};
  }
}

export function parseVoceChatBotUidFromApiKey(apiKey: unknown): string {
  const raw = normalizeId(apiKey);
  if (!raw) return "";

  const directPayload = parseJsonObjectWithEmbeddedPrefix(raw);
  const directUid = normalizeId(directPayload.uid);
  if (directUid) return directUid;

  if (!/^[0-9a-f]+$/i.test(raw) || raw.length % 2 !== 0) return "";
  const decoded = Buffer.from(raw, "hex").toString("utf8");
  const decodedPayload = parseJsonObjectWithEmbeddedPrefix(decoded);
  return normalizeId(decodedPayload.uid);
}

export function extractVoceChatMentionIds(raw: unknown): string[] {
  const roots = [raw];
  const rootRecord = asRecord(raw);
  roots.push(rootRecord.payload, rootRecord.data, rootRecord.message);

  const result: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    for (const mentionId of normalizeMentionIds(value)) {
      if (seen.has(mentionId)) continue;
      seen.add(mentionId);
      result.push(mentionId);
    }
  };

  for (const root of roots) {
    const payload = asRecord(root);
    if (Object.keys(payload).length === 0) continue;
    const detail = asRecord(payload.detail);
    const payloadProperties = asRecord(payload.properties);
    const detailProperties = asRecord(detail.properties);

    add(payload.mentions);
    add(payloadProperties.mentions);
    add(detail.mentions);
    add(detailProperties.mentions);
  }

  return result;
}

export function mentionsVoceChatBotUid(mentionIds: readonly unknown[], botUid: unknown): boolean {
  const normalizedBotUid = normalizeId(botUid);
  if (!normalizedBotUid) return false;
  return normalizeMentionIds([...mentionIds]).includes(normalizedBotUid);
}
