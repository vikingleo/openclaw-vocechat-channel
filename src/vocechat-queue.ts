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
