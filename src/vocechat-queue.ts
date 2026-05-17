export type VoceChatQueueTerminalReason = "finish" | "timeout" | "skip_current" | "account_stop";

export type VoceChatQueueStateItem = {
  queueItemId: string;
  messageId?: string;
  startedAt?: number;
  deadlineAt?: number;
  terminalReason?: VoceChatQueueTerminalReason;
  terminalAt?: number;
};

export type VoceChatExecutionQueueState<T extends VoceChatQueueStateItem> = {
  current: T | null;
  pending: T[];
};

const QUEUE_TIMEOUT_NOTICE_TEXT = "本次处理超过等待时间，已停止等待后续回复。请稍后重试。";

export function startNextQueueItem<T extends VoceChatQueueStateItem>(
  queue: VoceChatExecutionQueueState<T>,
  options: {
    nowMs: number;
    timeoutMs: number;
  },
): T | null {
  if (queue.current) return null;

  const item = queue.pending.shift();
  if (!item) return null;

  item.startedAt = options.nowMs;
  item.deadlineAt = options.timeoutMs > 0 ? options.nowMs + options.timeoutMs : undefined;
  item.terminalReason = undefined;
  item.terminalAt = undefined;
  queue.current = item;
  return item;
}

export function releaseCurrentQueueItem<T extends VoceChatQueueStateItem>(
  queue: VoceChatExecutionQueueState<T>,
  options: {
    queueItemId?: string;
    nowMs: number;
    reason: VoceChatQueueTerminalReason;
  },
): T | null {
  const item = queue.current;
  if (!item) return null;

  const expectedId = options.queueItemId;
  if (expectedId && item.queueItemId !== expectedId && item.messageId !== expectedId) return null;

  item.terminalReason = options.reason;
  item.terminalAt = options.nowMs;
  queue.current = null;
  return item;
}

export function canQueueItemDeliver(item: VoceChatQueueStateItem | null | undefined): boolean {
  return !item?.terminalReason;
}

export function buildQueueTerminalNoticeText(reason: VoceChatQueueTerminalReason): string {
  return reason === "timeout" ? QUEUE_TIMEOUT_NOTICE_TEXT : "";
}
