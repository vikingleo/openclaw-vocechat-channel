const INVISIBLE_OR_WHITESPACE_ONLY = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*$/u;

export function normalizeVoceChatOutboundText(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && !INVISIBLE_OR_WHITESPACE_ONLY.test(normalized) ? normalized : "";
}
