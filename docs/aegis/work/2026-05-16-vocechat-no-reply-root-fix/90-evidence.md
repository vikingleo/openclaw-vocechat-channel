# VoceChat no-reply root fix - Evidence

## Baseline

- `npm test` in the VoceChat extension passed before new tests were added: 3 tests passing.
- Minimal OpenAI SDK probe before patch failed with:
  - `Could not parse message into JSON:`
  - `From chunk: [ 'event: response.output_item.added' ]`
  - `Unexpected end of JSON input`

## Red Tests

- Added `timeout terminal reason has a user-visible notice` to `tests/vocechat-queue.test.mjs`.
- First run failed because `../dist/src/vocechat-queue.js` did not export `buildQueueTerminalNoticeText`.

## Fix Evidence

- `npm test` in the VoceChat extension passed after implementation: 4 tests passing.
- OpenAI SDK probe after patch returned:
  - `{"ok":true,"events":[{"type":"response.completed"}]}`
- Startup patch idempotence check returned `already patched` for all bundled OpenAI SDK streaming files.
- `systemctl --user status openclaw-gateway.service --no-pager` showed gateway active and `patch-openai-sdk-empty-sse-data.sh` ExecStartPre exited successfully.
- `curl -fsS http://127.0.0.1:18789/health` returned `{"ok":true,"status":"live"}`.
- `openclaw config validate` returned `Config valid: ~/.openclaw/openclaw.json`.
- Gateway model smoke:
  - command: `openclaw infer model run --gateway --model vkleo/gpt-5.5 --prompt '只回复 OK' --json`
  - result: `ok: true`, output text `OK`.
- Post-restart log scan since `2026-05-16 02:45:30` found no `Could not parse`, `Unexpected end`, `response.output_item`, `queue timed out`, `drop late`, `error`, or `fail` matches.
- VoceChat queue status returned `queues: []`.
