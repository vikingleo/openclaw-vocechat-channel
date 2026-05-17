import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHiddenRunEventMarkdown,
  buildVoceChatRunEventMeta,
  mapVoceChatRunEventMessageType,
} from "../dist/src/run-event-meta.js";

function parseMeta(markdown) {
  const firstLine = markdown.split("\n", 1)[0];
  const match = firstLine.match(/^<!-- hermes-meta:(.*) -->$/);
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
