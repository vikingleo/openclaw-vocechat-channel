# VoceChat group question and nickname reply policy - Reflection

## Repair Track

- Repaired object: VoceChat group inbound reply gate.
- Action: replaced the mention-only group gate with a trigger policy that accepts likely questions, explicit nickname/alias text matches, and native bot mentions.
- Runtime config action: opened VoceChat group sender authorization by setting `groupAllowFrom` to `[]`, `groupPolicy` to `open`, and `groups["*"].requireMention` to `false`.
- Impact: group members no longer need a native `@` for questions or nickname-addressed requests; ordinary group statements remain ignored by the content trigger.
- Verification: focused trigger tests passed, full `npm test` passed 17/17, installed extension runtime check matched the intended trigger matrix, runtime config inspection matched the desired policy, and gateway restarted with VoceChat webhook registered.

## Retirement Track

- Retired object: active-path dependency on `requireMention` and group sender allowlist as blockers for normal group members.
- Retained boundary: text alias and native mention detection remain as trigger types for compatibility; private chat sender allowlist is unchanged.
- Future trigger: tune or externalize question heuristics if live usage shows false positives.

## Residual Risk

- No live group message was sent during automated verification; runtime behavior was verified through installed helper behavior and gateway service logs.

Method Pack output does not grant completion authority.
