import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateVoceChatGroupReplyTrigger,
  isLikelyQuestionText,
} from "../dist/src/vocechat-group-trigger.js";

test("isLikelyQuestionText detects punctuation and Chinese question wording", () => {
  assert.equal(isLikelyQuestionText("这个怎么处理"), true);
  assert.equal(isLikelyQuestionText("status?"), true);
  assert.equal(isLikelyQuestionText("这里先记录一下进展"), false);
});

test("evaluateVoceChatGroupReplyTrigger replies to group questions without mention", () => {
  const trigger = evaluateVoceChatGroupReplyTrigger({
    text: "这个怎么处理",
    mentionRegexes: [],
    mentionIds: [],
    botUid: "2",
  });

  assert.deepEqual(trigger, { shouldReply: true, reason: "question" });
});

test("evaluateVoceChatGroupReplyTrigger replies to explicit bot nickname", () => {
  const trigger = evaluateVoceChatGroupReplyTrigger({
    text: "小爪 帮我整理一下",
    mentionRegexes: [/小爪/u],
    mentionIds: [],
    botUid: "2",
  });

  assert.deepEqual(trigger, { shouldReply: true, reason: "text-mention" });
});

test("evaluateVoceChatGroupReplyTrigger keeps native bot mention support", () => {
  const trigger = evaluateVoceChatGroupReplyTrigger({
    text: "看一下",
    mentionRegexes: [],
    mentionIds: ["2"],
    botUid: "2",
  });

  assert.deepEqual(trigger, { shouldReply: true, reason: "native-mention" });
});

test("evaluateVoceChatGroupReplyTrigger ignores ordinary group statements", () => {
  const trigger = evaluateVoceChatGroupReplyTrigger({
    text: "这里先记录一下进展",
    mentionRegexes: [/小爪/u],
    mentionIds: [],
    botUid: "2",
  });

  assert.deepEqual(trigger, { shouldReply: false, reason: "none" });
});
