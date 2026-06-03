import test from "node:test";
import assert from "node:assert/strict";

import { buildVoceChatReplyOptions } from "../dist/src/reply-options.js";

test("group chat reply options force automatic source reply delivery", () => {
  const options = buildVoceChatReplyOptions({
    chatType: "group",
    onModelSelected: "model-hook",
    runEventReplyOptions: {
      suppressDefaultToolProgressMessages: true,
    },
  });

  assert.equal(options.sourceReplyDeliveryMode, "automatic");
  assert.equal(options.onModelSelected, "model-hook");
  assert.equal(options.suppressDefaultToolProgressMessages, true);
});

test("direct chat reply options do not override source reply delivery mode", () => {
  const options = buildVoceChatReplyOptions({
    chatType: "direct",
    onModelSelected: "model-hook",
    runEventReplyOptions: {
      suppressDefaultToolProgressMessages: true,
    },
  });

  assert.equal(options.sourceReplyDeliveryMode, undefined);
  assert.equal(options.onModelSelected, "model-hook");
  assert.equal(options.suppressDefaultToolProgressMessages, true);
});

test("group chat automatic delivery is not overridden by run event options", () => {
  const options = buildVoceChatReplyOptions({
    chatType: "group",
    runEventReplyOptions: {
      sourceReplyDeliveryMode: "message_tool_only",
    },
  });

  assert.equal(options.sourceReplyDeliveryMode, "automatic");
});
