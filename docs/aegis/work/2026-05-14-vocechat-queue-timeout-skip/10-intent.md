# VoceChat queue timeout and skip - Intent

## TaskIntentDraft

- Requested outcome: Prevent one stuck VoceChat inbound queue item from blocking later messages.
- Scope: Plugin-side queue owner, queue control route, late reply guard, config/docs/tests.
- Change kinds:
- bugfix
- Risk hints:
- Host model calls may continue after plugin-side timeout; plugin must drop late delivery from terminal queue items.

## BaselineReadSetHint

- index.ts queue owner and processInboundEvent
- README queue control section

## ImpactStatementDraft

- Compatibility boundary: Do not change VoceChat webhook payload parsing or outbound API shape.
- Affected layers:
- VoceChat inbound execution queue
- Owners:
- index.ts queue owner plus src/vocechat-queue.ts helper
- Invariants:
- Only one current item runs per queue; terminal current items must not block pending items or deliver late replies.
- Non-goals:
- Hard-killing host OpenClaw model calls without host abort API.

These records are Method Pack drafts / hints, not authoritative runtime decisions.
