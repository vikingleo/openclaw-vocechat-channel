import test from "node:test";
import assert from "node:assert/strict";

import { normalizeVoceChatOutboundText } from "../dist/src/vocechat-text.js";

test("zero-width-only outbound text is treated as empty", () => {
  assert.equal(normalizeVoceChatOutboundText("\u200B\u200B\u200B"), "");
  assert.equal(normalizeVoceChatOutboundText(" \n\u200B\t"), "");
});

test("visible outbound text remains unchanged when it contains zero-width characters", () => {
  assert.equal(normalizeVoceChatOutboundText("\u200B正常回复"), "\u200B正常回复");
  assert.equal(normalizeVoceChatOutboundText("正常\u200B回复"), "正常\u200B回复");
});

test("ordinary whitespace-only outbound text remains empty", () => {
  assert.equal(normalizeVoceChatOutboundText(" \n\t"), "");
});
