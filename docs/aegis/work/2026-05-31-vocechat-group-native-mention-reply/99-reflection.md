# VoceChat group native mention reply fix - Reflection

## Repair Track

- Repaired object: VoceChat channel group mention gate.
- Root cause: group `requireMention` handling only matched text aliases and ignored VoceChat native mention metadata in `detail.properties.mentions`.
- Canonical owner: `index.ts` inbound event parsing/merging and group mention decision, with native mention parsing isolated in `src/vocechat-mentions.ts`.
- Action: carry native mention ids through inbound events and accept a native mention when it matches the bot uid parsed from the VoceChat apiKey.
- Compatibility boundary: existing text alias mention patterns remain active.
- Verification: `npm test` passed 12/12; installed extension helper returns `nativeMentioned: true`; gateway service is active and VoceChat webhook route is registered after restart.

## Retirement Track

- Retained object: text alias mention detection.
- Reason retained: supports existing non-native alias triggers and configured mention aliases.
- Future trigger: retire only if group mention policy is migrated entirely to VoceChat native mention metadata with an explicit compatibility migration.

## Residual Risk

- No fresh live group chat message was sent during final verification; the final runtime check covered installed helper behavior, service status, and webhook registration.

Method Pack output does not grant completion authority.
