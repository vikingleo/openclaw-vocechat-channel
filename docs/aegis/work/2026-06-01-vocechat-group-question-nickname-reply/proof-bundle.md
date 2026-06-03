# Proof Bundle - 2026-06-01-vocechat-group-question-nickname-reply

## Method Pack Boundary

This proof bundle is an advisory Aegis Method Pack record. It does not determine evidence sufficiency, produce authoritative `GateDecision`, or grant `completion authority`.

## Task Intent

- Requested outcome: Group messages should no longer require a native mention; questions, explicit nickname/alias matches, and native bot mentions should receive replies while ordinary statements stay ignored.
- Scope: Patch VoceChat group inbound reply trigger logic, add focused regression tests, sync installed extension, and restart gateway.

## Impact

- Compatibility boundary: Existing text alias and native mention trigger paths must continue to reply; direct chats must remain unaffected.
- Non-goals:
- Make every group message auto-reply.

## Evidence Bundle Refs

- docs/aegis/work/2026-06-01-vocechat-group-question-nickname-reply/evidence-bundle-draft-gateway-restart-2026-06-01.json
- docs/aegis/work/2026-06-01-vocechat-group-question-nickname-reply/evidence-bundle-draft-installed-runtime-group-trigger-2026-06-01.json
- docs/aegis/work/2026-06-01-vocechat-group-question-nickname-reply/evidence-bundle-draft-npm-test-full-2026-06-01.json
- docs/aegis/work/2026-06-01-vocechat-group-question-nickname-reply/evidence-bundle-draft-npm-test-group-trigger-2026-06-01.json
- docs/aegis/work/2026-06-01-vocechat-group-question-nickname-reply/evidence-bundle-draft-runtime-config-open-group-2026-06-01.json

## Drift Check

- Scope status: Scope expanded within user request after discovering runtime groupAllowFrom whitelist would block non-admin group members before trigger evaluation.
- Compatibility status: Private allowFrom remains unchanged; group reply still requires question, nickname/alias, or native mention trigger after sender authorization is opened.
- Retirement status: Retire runtime group sender allowlist for this VoceChat channel; keep trigger-based content gate to prevent all-message auto-reply.
- Advisory decision: continue
