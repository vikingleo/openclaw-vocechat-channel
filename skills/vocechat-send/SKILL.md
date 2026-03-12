---
name: vocechat-send
description: Send text or attachments to a VoceChat user or group through the locally installed OpenClaw VoceChat plugin. Use when the user asks the agent to push a message, file, report, screenshot, or artifact into VoceChat, especially when local OpenClaw config or .env should provide the VoceChat baseUrl and apiKey automatically.
---

# VoceChat Send

Use the bundled send script instead of rebuilding Bot API calls.

## When To Use

- The user wants OpenClaw to send a text message to VoceChat.
- The user wants OpenClaw to send an attachment to a VoceChat user or group.
- A local file, generated artifact, export, or report should be delivered into VoceChat.
- The task should reuse local OpenClaw channel config, `.env` fallback, and the established upload flow.

## Preferred Command

Run the wrapper in this skill directory:

```bash
sh scripts/send.sh --to user:2 --text "已处理完成"
```

Send a file with optional text:

```bash
sh scripts/send.sh --to user:2 --text "附件见下" --file /absolute/path/report.pdf
```

Remote file URL also works:

```bash
sh scripts/send.sh --to user:2 --file https://example.com/report.pdf
```

## Behavior

- Reuses `channels.vocechat` in the local OpenClaw config.
- Falls back to local `.env` when `baseUrl` or `apiKey` are missing.
- Supports `user:<id>`, `group:<id>`, and plain numeric user IDs.
- For attachments, sends through `file/prepare -> file/upload -> send_to_user/send_to_group`.
- If you omit required parameters in an interactive terminal, the underlying script can prompt; for agent automation, prefer passing `--to` plus `--text` and/or `--file`.

## Notes

- The real sender lives at `../../../scripts/vocechat-send.sh` relative to this skill directory.
- If VoceChat delivery fails, report the exact HTTP or curl error back to the user.
