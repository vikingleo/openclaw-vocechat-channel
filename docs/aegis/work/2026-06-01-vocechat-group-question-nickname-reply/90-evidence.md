# VoceChat group question and nickname reply policy - Evidence


## EvidenceBundleDraft

- Artifact key: npm-test-group-trigger-2026-06-01
- Type: command
- Source: npm test -- --test-name-pattern VoceChatGroupTrigger
- Summary: Red turned green: helper test suite passed 5/5 group trigger checks, including question heuristics, nickname match, native mention, and ordinary statement rejection.
- Verifier: Codex run on 2026-06-01 in project root; exit code 0.

## EvidenceBundleDraft

- Artifact key: npm-test-full-2026-06-01
- Type: command
- Source: npm test
- Summary: Build succeeded and node --test passed 17/17 tests across run-event metadata, group trigger policy, native mentions, and queue behavior.
- Verifier: Codex run on 2026-06-01 in project root; exit code 0.

## EvidenceBundleDraft

- Artifact key: installed-runtime-group-trigger-2026-06-01
- Type: command
- Source: node import from /home/vkleo/.openclaw/extensions/vocechat/dist/src/vocechat-group-trigger.js
- Summary: Installed extension runtime check parsed real bot uid 2 and returned shouldReply true for question, nickname, and native-mention triggers while returning false for an ordinary statement.
- Verifier: node --input-type=module runtime check on 2026-06-01; exit code 0.

## EvidenceBundleDraft

- Artifact key: gateway-restart-2026-06-01
- Type: command
- Source: systemctl --user restart openclaw-gateway.service; journalctl --user -u openclaw-gateway.service
- Summary: Gateway restarted successfully, active/running with MainPID 3326343; journal shows VoceChat start, webhook route registered, queue control routes registered, and approval gateway connected.
- Verifier: systemctl and journalctl checks on 2026-06-01; exit code 0.

## EvidenceBundleDraft

- Artifact key: runtime-config-open-group-2026-06-01
- Type: command
- Source: /home/vkleo/.openclaw/openclaw.json and gateway reload logs
- Summary: Runtime VoceChat config now has groupAllowFrom [], groupPolicy open, and groups.*.requireMention false; journal shows config hot reload and post-restart VoceChat webhook registration.
- Verifier: node config inspection and journalctl checks on 2026-06-01; exit code 0.
