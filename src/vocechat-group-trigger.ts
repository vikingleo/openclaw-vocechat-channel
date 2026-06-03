import { mentionsVoceChatBotUid } from "./vocechat-mentions.js";

export type VoceChatGroupReplyTriggerReason = "none" | "question" | "text-mention" | "native-mention";

export type VoceChatGroupReplyTrigger = {
  shouldReply: boolean;
  reason: VoceChatGroupReplyTriggerReason;
};

const CHINESE_QUESTION_HINTS = [
  "请问",
  "问一下",
  "怎么",
  "怎样",
  "如何",
  "为什么",
  "为啥",
  "什么",
  "啥时候",
  "什么时候",
  "何时",
  "哪里",
  "哪儿",
  "哪个",
  "哪位",
  "哪种",
  "哪条",
  "哪台",
  "谁",
  "多少",
  "几点",
  "能否",
  "能不能",
  "可不可以",
  "是否",
  "是不是",
  "会不会",
  "有没有",
  "要不要",
  "需不需要",
  "该不该",
  "行不行",
];

const ENGLISH_QUESTION_PREFIX = /^\s*(who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|will|may|might)\b/i;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function matchesTextPatterns(text: string, patterns: readonly RegExp[]): boolean {
  if (!text || patterns.length === 0) return false;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

export function isLikelyQuestionText(text: unknown): boolean {
  const candidate = normalizeText(text);
  if (!candidate) return false;
  if (/[?？]/u.test(candidate)) return true;

  const compact = candidate.replace(/\s+/g, "");
  if (/[吗呢][。.!！]*$/u.test(compact)) return true;
  if (CHINESE_QUESTION_HINTS.some((hint) => compact.includes(hint))) return true;

  return ENGLISH_QUESTION_PREFIX.test(candidate);
}

export function evaluateVoceChatGroupReplyTrigger(params: {
  text: unknown;
  mentionRegexes?: readonly RegExp[];
  mentionIds?: readonly unknown[];
  botUid?: unknown;
}): VoceChatGroupReplyTrigger {
  const text = normalizeText(params.text);

  if (matchesTextPatterns(text, params.mentionRegexes ?? [])) {
    return { shouldReply: true, reason: "text-mention" };
  }

  if (mentionsVoceChatBotUid(params.mentionIds ?? [], params.botUid)) {
    return { shouldReply: true, reason: "native-mention" };
  }

  if (isLikelyQuestionText(text)) {
    return { shouldReply: true, reason: "question" };
  }

  return { shouldReply: false, reason: "none" };
}
