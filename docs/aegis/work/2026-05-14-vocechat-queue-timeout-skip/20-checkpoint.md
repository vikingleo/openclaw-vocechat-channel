# VoceChat queue timeout and skip - Checkpoint

- Task ID: 2026-05-14-vocechat-queue-timeout-skip
- Current todo: Confirm RED test, implement queue helper, integrate timeout and skip-current, update docs/config, verify and apply runtime.
- Active slice: Implement queue helper and index.ts integration.
- Blocked on: none
- Next step: Create src/vocechat-queue.ts and patch queue runner.

## Checkpoint Update

- Current todo: All implementation todos completed; final status reporting remains.
- Active slice: Completion candidate.
- Completed todos:
- Confirmed RED test before implementation.
- Added queue helper and tests.
- Integrated queue timeout, skip-current, account-stop release, and late reply guard.
- Updated manifest, runtime schema, config example, and README.
- Built, tested, refreshed registry, restarted gateway, and checked runtime queue status.
- Evidence refs:
- npm-test-green
- openclaw-runtime-check
- Blocked on: none
- Next step: Report concise outcome and residual risk.

## DriftCheckDraft

- Scope status: Stayed within VoceChat plugin queue owner, queue control API, docs/config/tests.
- Compatibility status: Webhook parsing and outbound VoceChat API shape unchanged; skip-current response is additive behavior for an existing endpoint.
- Retirement status: Old unavailable skip-current behavior replaced; interrupt-run-now degraded behavior retained until host exposes hard abort.
- New risk signals:
- Gateway health reported transient eventLoop degraded due CPU, but plugins loaded and queue endpoint responded.
- Advisory decision: continue
