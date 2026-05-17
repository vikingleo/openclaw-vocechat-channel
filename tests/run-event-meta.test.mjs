import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHiddenRunEventMarkdown,
  buildVoceChatRunEventMeta,
  mapVoceChatRunEventMessageType,
} from "../dist/src/run-event-meta.js";
import { createVoceChatDispatchRunEventBridge } from "../dist/src/dispatch-run-events.js";

function parseMeta(markdown) {
  const firstLine = markdown.split("\n", 1)[0];
  const match = firstLine.match(/^<!-- vocechat-meta:(.*) -->$/);
  assert.ok(match, "metadata comment should be the first line");
  return JSON.parse(match[1]);
}

test("buildHiddenRunEventMarkdown prefixes stable hidden metadata", () => {
  const markdown = buildHiddenRunEventMarkdown("已加入执行队列。", {
    messageType: "queue",
    phase: "queued",
    runId: "run-2",
    queue_key: "queue:user:7",
    queue_item_id: "run-2",
    queue_position: 1,
  });

  const meta = parseMeta(markdown);
  assert.equal(meta.schema, "vocechat-run-event/v1");
  assert.equal(meta.source, "openclaw-vocechat-channel");
  assert.equal(meta.messageType, "queue");
  assert.equal(meta.kind, "queue");
  assert.equal(meta.phase, "queued");
  assert.equal(meta.runId, "run-2");
  assert.equal(meta.queue_key, "queue:user:7");
  assert.equal(meta.queue_item_id, "run-2");
  assert.equal(meta.queue_position, 1);
  assert.match(markdown, /\n已加入执行队列。$/);
});

test("message type mapping provides kind and phase compatibility fields", () => {
  assert.deepEqual(mapVoceChatRunEventMessageType("process_summary"), {
    kind: "progress",
    phase: "summary",
  });
  assert.deepEqual(mapVoceChatRunEventMessageType("execution_record"), {
    kind: "execution",
    phase: "record",
  });
  assert.deepEqual(mapVoceChatRunEventMessageType("management"), {
    kind: "management",
    phase: "notice",
  });

  const meta = buildVoceChatRunEventMeta({
    messageType: "approval",
    approval_id: "approval-1",
  });
  assert.equal(meta.kind, "approval");
  assert.equal(meta.phase, "requested");
  assert.equal(meta.runId, "approval-1");
});

test("dispatch hook message types map to stable compatibility fields", () => {
  assert.deepEqual(mapVoceChatRunEventMessageType("tool_call"), {
    kind: "tool",
    phase: "tool-call",
  });
  assert.deepEqual(mapVoceChatRunEventMessageType("tool_result"), {
    kind: "tool",
    phase: "tool-result",
  });
  assert.deepEqual(mapVoceChatRunEventMessageType("command_output"), {
    kind: "execution",
    phase: "command-output",
  });
  assert.deepEqual(mapVoceChatRunEventMessageType("patch"), {
    kind: "artifact",
    phase: "patch",
  });
  assert.deepEqual(mapVoceChatRunEventMessageType("plan_update"), {
    kind: "progress",
    phase: "plan-update",
  });
});

test("dispatch bridge suppresses developer execution events for chat channels", async () => {
  const delivered = [];
  const bridge = createVoceChatDispatchRunEventBridge({
    runId: "run-1",
    queueKey: "queue:user:7",
    queueItemId: "run-1",
    deliver: async (text) => {
      delivered.push(text);
    },
  });

  assert.equal(bridge.replyOptions.suppressDefaultToolProgressMessages, true);
  bridge.replyOptions.onToolStart({ toolName: "exec_command", preview: "npm test" });
  bridge.replyOptions.onToolResult({ toolName: "exec_command", ok: true, output: "pass" });
  bridge.replyOptions.onCommandOutput({ command: "npm test", exitCode: 0, output: "pass" });
  bridge.replyOptions.onPatchSummary({ summary: "changed index.ts" });
  bridge.replyOptions.onPlanUpdate({ summary: "running tests" });
  bridge.replyOptions.onItemEvent({ type: "step", summary: "read file" });
  bridge.replyOptions.onPartialReply({ text: "partial assistant text" });
  bridge.replyOptions.onBlockReplyQueued({ type: "text", summary: "queued" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(delivered, []);
});

test("reasoning stream is not forwarded to chat", async () => {
  const delivered = [];
  const bridge = createVoceChatDispatchRunEventBridge({
    runId: "run-2",
    deliver: async (text) => {
      delivered.push(text);
    },
  });

  bridge.replyOptions.onReasoningStream({
    status: "delta",
    text: "RAW INTERNAL REASONING SHOULD NOT LEAK",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(delivered, []);
});
