# VoceChat queue timeout and skip - Evidence

No evidence has been recorded yet.

## EvidenceBundleDraft

- Artifact key: npm-test-green
- Type: command
- Source: npm test
- Summary: Build succeeded and node:test queue helper tests passed: 3 tests, 0 failures.
- Verifier: Codex 2026-05-14

## EvidenceBundleDraft

- Artifact key: openclaw-runtime-check
- Type: command
- Source: openclaw health --json && curl -fsS http://127.0.0.1:18789/queue/status
- Summary: Gateway restarted with vocechat loaded and connected; queue status endpoint returned ok with empty queues.
- Verifier: Codex 2026-05-14
