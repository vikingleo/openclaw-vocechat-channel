# VoceChat group native mention reply fix - Intent

## TaskIntentDraft

- Requested outcome: Group messages that mention the VoceChat bot through native mention metadata should be accepted as mentioned and replied to.
- Scope: Patch VoceChat channel mention detection and add focused regression tests.
- Change kinds:
- bugfix
- Risk hints:
- none

## BaselineReadSetHint

- none

## ImpactStatementDraft

- Compatibility boundary: Existing text alias mention patterns must continue to work.
- Affected layers:
- channel
- Owners:
- index.ts
- Invariants:
- none
- Non-goals:
- Change requireMention policy or make all group messages auto-reply.

These records are Method Pack drafts / hints, not authoritative runtime decisions.
