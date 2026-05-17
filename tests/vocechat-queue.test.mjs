import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQueueTerminalNoticeText,
  canQueueItemDeliver,
  releaseCurrentQueueItem,
  startNextQueueItem,
} from "../dist/src/vocechat-queue.js";

function item(id) {
  return {
    queueKey: "queue:direct:1",
    queueItemId: id,
    messageId: id,
    previewText: `message ${id}`,
  };
}

test("startNextQueueItem starts one pending item and records its deadline", () => {
  const queue = { current: null, pending: [item("1"), item("2")] };

  const started = startNextQueueItem(queue, { nowMs: 1000, timeoutMs: 5000 });

  assert.equal(started?.queueItemId, "1");
  assert.equal(queue.current?.queueItemId, "1");
  assert.equal(queue.current?.startedAt, 1000);
  assert.equal(queue.current?.deadlineAt, 6000);
  assert.equal(queue.pending.map((entry) => entry.queueItemId).join(","), "2");
});

test("releaseCurrentQueueItem clears the current item and prevents late delivery", () => {
  const current = item("1");
  const queue = { current, pending: [item("2")] };

  const released = releaseCurrentQueueItem(queue, {
    queueItemId: "1",
    nowMs: 3000,
    reason: "skip_current",
  });

  assert.equal(released, current);
  assert.equal(queue.current, null);
  assert.equal(current.terminalReason, "skip_current");
  assert.equal(current.terminalAt, 3000);
  assert.equal(canQueueItemDeliver(current), false);
  assert.equal(queue.pending.length, 1);
});

test("releaseCurrentQueueItem refuses to release a different current item", () => {
  const current = item("1");
  const queue = { current, pending: [item("2")] };

  const released = releaseCurrentQueueItem(queue, {
    queueItemId: "2",
    nowMs: 3000,
    reason: "skip_current",
  });

  assert.equal(released, null);
  assert.equal(queue.current, current);
  assert.equal(canQueueItemDeliver(current), true);
});

test("timeout terminal reason has a user-visible notice", () => {
  const notice = buildQueueTerminalNoticeText("timeout");

  assert.match(notice, /超时|超过|停止等待/);
  assert.equal(buildQueueTerminalNoticeText("finish"), "");
  assert.equal(buildQueueTerminalNoticeText("skip_current"), "");
  assert.equal(buildQueueTerminalNoticeText("account_stop"), "");
});
