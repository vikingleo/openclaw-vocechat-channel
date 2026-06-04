export type VoceChatRunEventDispatchContext = {
  runId: string;
  chatType?: "direct" | "group";
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

function noopRunEventCallback(): void {
  // Chat channels receive only the final assistant reply through the normal dispatcher.
}

function buildNoopReplyOptions(): Record<string, unknown> {
  return {
    suppressDefaultToolProgressMessages: true,
    onToolStart: noopRunEventCallback,
    onToolResult: noopRunEventCallback,
    onCommandOutput: noopRunEventCallback,
    onPatchSummary: noopRunEventCallback,
    onPlanUpdate: noopRunEventCallback,
    onApprovalEvent: noopRunEventCallback,
    onItemEvent: noopRunEventCallback,
    onPartialReply: noopRunEventCallback,
    onReasoningStream: noopRunEventCallback,
    onBlockReplyQueued: noopRunEventCallback,
  };
}

export function createVoceChatDispatchRunEventBridge(
  _ctx: VoceChatRunEventDispatchContext,
): VoceChatDispatchRunEventBridge {
  return { replyOptions: buildNoopReplyOptions() };
}
