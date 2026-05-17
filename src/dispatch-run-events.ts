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

function noopRunEventCallback(): void {
  // Chat channels receive final assistant replies through the normal reply dispatcher.
}

export function createVoceChatDispatchRunEventBridge(
  _ctx: VoceChatRunEventDispatchContext,
): VoceChatDispatchRunEventBridge {
  return {
    replyOptions: {
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
    },
  };
}
