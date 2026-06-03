# Proof Bundle - 2026-05-31-vocechat-group-native-mention-reply

## Method Pack Boundary

This proof bundle is an advisory Aegis Method Pack record. It does not determine evidence sufficiency, produce authoritative `GateDecision`, or grant `completion authority`.

## Task Intent

- Requested outcome: Group messages that mention the VoceChat bot through native mention metadata should be accepted as mentioned and replied to.
- Scope: Patch VoceChat channel mention detection and add focused regression tests.

## Impact

- Compatibility boundary: Existing text alias mention patterns must continue to work.
- Non-goals:
- Change requireMention policy or make all group messages auto-reply.

## Evidence Bundle Refs

- docs/aegis/work/2026-05-31-vocechat-group-native-mention-reply/evidence-bundle-draft-installed-helper-native-mention-2026-05-31.json
- docs/aegis/work/2026-05-31-vocechat-group-native-mention-reply/evidence-bundle-draft-npm-test-2026-05-31.json
- docs/aegis/work/2026-05-31-vocechat-group-native-mention-reply/evidence-bundle-draft-runtime-installed-extension-2026-05-31.json

## Drift Check

- Scope status: Inside requested VoceChat group reply scope: only native mention detection, inbound event mentionIds propagation, tests, and Aegis record changed.
- Compatibility status: Existing text alias mention path remains active; native mention metadata is accepted as an additional signal only when requireMention applies.
- Retirement status: Old text-only detection remains as compatibility path; no fallback retired yet because alias mentions still support non-native text triggers.
- Advisory decision: continue
