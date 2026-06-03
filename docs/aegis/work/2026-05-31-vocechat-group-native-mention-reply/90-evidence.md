# VoceChat group native mention reply fix - Evidence

## EvidenceBundleDraft

- Artifact key: npm-test-2026-05-31
- Type: command
- Source: npm test
- Summary: Build succeeded and node --test passed 12/12 tests, including parseVoceChatBotUidFromApiKey, extractVoceChatMentionIds, and mentionsVoceChatBotUid native mention regression tests.
- Verifier: Codex run on 2026-05-31 in project root; exit code 0.

## EvidenceBundleDraft

- Artifact key: runtime-installed-extension-2026-05-31
- Type: command
- Source: installed extension dist and gateway status
- Summary: Verified /home/vkleo/.openclaw/extensions/vocechat/dist/src/vocechat-mentions.js exists and openclaw-gateway.service is active after restart; journal shows VoceChat webhook route and approval gateway connected.
- Verifier: systemctl --user and journalctl checks on 2026-05-31; exit code 0.

## EvidenceBundleDraft

- Artifact key: installed-helper-native-mention-2026-05-31
- Type: command
- Source: node import from installed extension dist/src/vocechat-mentions.js
- Summary: Installed extension helper parsed bot uid 2 from a synthetic VoceChat apiKey and extracted mentionIds ['2'] from a native mention payload, producing nativeMentioned true.
- Verifier: node --input-type=module runtime check on 2026-05-31; exit code 0.
