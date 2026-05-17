# openclaw-vocechat-channel Agent Progress

## Current State

- Migration state: `ai-agent/` seeded for Hermes project context.
- Repository path: /home/vkleo/.openclaw/workspace/development/openclaw-extensions/openclaw-vocechat-channel
- Branch at migration: master
- Had pre-existing uncommitted changes before seeding: yes

## Done

- 2026-05-08: Located repository from OpenClaw project routing table.
- 2026-05-08: Created `ai-agent/README.md` for stable project facts and workflow guardrails.
- 2026-05-08: Created `ai-agent/PROGRESS.md` for ongoing development state.
- 2026-05-13: Pulled `openclaw-vocechat-channel` with `git pull --ff-only`; repository was already up to date.
- 2026-05-13: Added plugin-side VoceChat inbound execution queue and `/queue/*` compatible control routes so desktop can read selected remote robot queues instead of falling back to local queue token state.
- 2026-05-13: Removed product-specific queue naming from the new queue control interface; route metadata now uses neutral VoceChat channel names and only `/queue/*` plus `/vocechat/queue/*` are registered.
- 2026-05-17: Added hidden VoceChat run-event metadata for process, queue, approval, management, and execution-record notices.

## Todo

- Replace generic command notes with verified install/dev/test/build commands after first successful run.
- Decide later whether legacy OpenClaw bootstrap files should be archived, ignored, or migrated; do not delete automatically.

## Decisions

- `ai-agent/README.md` is the canonical Hermes project context file.
- `ai-agent/PROGRESS.md` records ongoing task/migration state.
- Project `AGENTS.md` is not used as the new canonical Hermes project-agent directory.

## Verification

- `git status --short` was checked before seeding.
- 2026-05-13: `npm run build` passes after installing local npm dependencies with `npm install --package-lock=false`.
- 2026-05-13: `npm run build` passes after neutral queue naming changes.
- 2026-05-17: `npm test` passes, including build and run-event metadata tests.
- Pre-seeding status preview:

```text
M openclaw.plugin.json
?? .openclaw/
?? AGENTS.md
?? BOOTSTRAP.md
?? HEARTBEAT.md
?? IDENTITY.md
?? SOUL.md
?? TOOLS.md
?? USER.md
```

## Open Questions / Risks

- Some repositories already had unrelated OpenClaw-era untracked or modified files. Do not auto-commit/push this migration together with those changes without review.
