import test from "node:test";
import assert from "node:assert/strict";

import { buildVoceChatReplyMediaLocalRoots } from "../dist/src/reply-media-context.js";

test("reply media roots include inbound media root and attachment directories", () => {
  const inboundMediaRootDir = "/home/vkleo/.openclaw/workspace/media/inbound/vocechat";
  const generatedMediaRootDir = "/home/vkleo/.openclaw/workspace/media";
  const messageDir = `${inboundMediaRootDir}/2026/07/01/mid-123`;

  const roots = buildVoceChatReplyMediaLocalRoots({
    inboundMediaRootDir,
    generatedMediaRootDir,
    attachments: [
      {
        localFile: `${messageDir}/normalized.jpg`,
        storedFile: `${messageDir}/original.jpg`,
        normalizedFile: `${messageDir}/normalized.jpg`,
      },
      {
        localFile: "relative/path.jpg",
        storedFile: "",
        normalizedFile: null,
      },
    ],
  });

  assert.deepEqual(roots, [inboundMediaRootDir, generatedMediaRootDir, messageDir]);
});

test("reply media roots ignore empty and relative roots", () => {
  const roots = buildVoceChatReplyMediaLocalRoots({
    inboundMediaRootDir: "relative/inbound",
    generatedMediaRootDir: "",
    attachments: [
      {
        localFile: "",
        storedFile: "./file.png",
        normalizedFile: undefined,
      },
    ],
  });

  assert.deepEqual(roots, []);
});
