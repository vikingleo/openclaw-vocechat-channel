# VoceChat group question and nickname reply policy - Intent

## TaskIntentDraft

- Requested outcome: Group messages should no longer require a native mention; questions, explicit nickname/alias matches, and native bot mentions should receive replies while ordinary statements stay ignored.
- Scope: Patch VoceChat group inbound reply trigger logic, add focused regression tests, sync installed extension, and restart gateway.
- Change kinds:
- behavior-change
- Risk hints:
- Question heuristics can over-trigger if too broad; ordinary statements must remain ignored.

## BaselineReadSetHint

- index.ts group inbound requireMention branch
- src/vocechat-mentions.ts native mention helper

## ImpactStatementDraft

- Compatibility boundary: Existing text alias and native mention trigger paths must continue to reply; direct chats must remain unaffected.
- Affected layers:
- channel
- Owners:
- index.ts
- src/vocechat-group-trigger.ts
- tests/vocechat-group-trigger.test.mjs
- Invariants:
- none
- Non-goals:
- Make every group message auto-reply.

These records are Method Pack drafts / hints, not authoritative runtime decisions.
