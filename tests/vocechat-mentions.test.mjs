import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVoceChatMentionIds,
  mentionsVoceChatBotUid,
  parseVoceChatBotUidFromApiKey,
} from "../dist/src/vocechat-mentions.js";

function fakeApiKeyWithPayload(payload) {
  return Buffer.concat([
    Buffer.from([0x12, 0xe9, 0xb8, 0x7e]),
    Buffer.from(JSON.stringify(payload), "utf8"),
  ]).toString("hex");
}

test("parseVoceChatBotUidFromApiKey reads uid from VoceChat hex key payload", () => {
  const apiKey = fakeApiKeyWithPayload({ uid: 2, nonce: "abc" });

  assert.equal(parseVoceChatBotUidFromApiKey(apiKey), "2");
});

test("extractVoceChatMentionIds reads native mentions from message detail properties", () => {
  const payload = {
    mid: 4044,
    from_uid: 1,
    target: { gid: 3 },
    detail: {
      type: "normal",
      content_type: "text/plain",
      content: " @2 status?",
      properties: {
        cid: "3ef0f067-ea04-4ebf-9859-36492dde8306",
        mentions: [2, "2", 7, "", null],
      },
    },
  };

  assert.deepEqual(extractVoceChatMentionIds(payload), ["2", "7"]);
});

test("mentionsVoceChatBotUid accepts native mention of the configured bot uid", () => {
  assert.equal(mentionsVoceChatBotUid(["2", "7"], "2"), true);
  assert.equal(mentionsVoceChatBotUid(["7"], "2"), false);
});
