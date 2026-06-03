export type VoceChatReplyChatType = "direct" | "group";

export type VoceChatReplyOptionsInput = {
  chatType: VoceChatReplyChatType;
  onModelSelected?: unknown;
  runEventReplyOptions?: Record<string, unknown>;
};

export function buildVoceChatReplyOptions(input: VoceChatReplyOptionsInput): Record<string, unknown> {
  return {
    onModelSelected: input.onModelSelected,
    ...input.runEventReplyOptions,
    ...(input.chatType === "group" ? { sourceReplyDeliveryMode: "automatic" } : {}),
  };
}
