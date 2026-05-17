# VoceChat no-reply root fix - Intent

## TaskIntentDraft

- Requested outcome: Stop VoceChat inbound turns from going silent when OpenAI Responses streaming fails or queue items time out.
- Scope: VoceChat queue timeout visibility and OpenClaw SSE parser runtime diagnosis.
- Change kinds:
- bugfix
- Risk hints:
- none

## BaselineReadSetHint

- `src/vocechat-queue.ts` owns queue terminal state helpers.
- `index.ts` owns VoceChat inbound execution timeout scheduling and fallback notice delivery.
- OpenClaw bundled OpenAI SDK stream reader owns final SSE JSON parse behavior.

## ImpactStatementDraft

- Compatibility boundary: inbound queue timeout must stop late model replies from delivering, but timeout itself must be user-visible; SDK SSE empty `data` frames must be ignored before JSON parsing.
- Affected layers:
- VoceChat inbound execution queue
- OpenClaw provider stream parsing
- Owners:
- `src/vocechat-queue.ts`
- `index.ts`
- `/home/vkleo/.openclaw/workspace/memory/openclaw-patches/patch-openai-sdk-empty-sse-data.sh`
- Invariants:
- Late replies after timeout remain blocked.
- Queue timeout releases the current item and starts the next queue item.
- Empty SSE data frames are skipped; non-empty frames still parse as JSON.
- Non-goals:
- Do not change VoceChat webhook routing.
- Do not disable queue timeout.
- Do not change model/provider selection.

These records are Method Pack drafts / hints, not authoritative runtime decisions.
