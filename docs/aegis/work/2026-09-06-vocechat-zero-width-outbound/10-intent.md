# VoceChat 零宽空消息修复 - Intent

## TaskIntentDraft

- Requested outcome: 阻止纯零宽和不可见模型输出被作为空消息发送到 VoceChat
- Scope: 插件出站文本归一化、普通文本/引用回复/媒体附言/队列通知入口及回归测试
- Change kinds:
- bugfix
- Risk hints:
- 保留含可见文本的原始内容，避免破坏 emoji ZWJ 和变体选择符

## BaselineReadSetHint

- README.md 出站消息与运行事件说明

## ImpactStatementDraft

- Compatibility boundary: 不改变 webhook 鉴权、白名单、目标解析和媒体上传契约
- Affected layers:
- 出站文本 canonical owner、VoceChat API 调用、测试与文档
- Owners:
- index.ts + src/vocechat-text.ts
- Invariants:
- 纯不可见文本不调用 VoceChat 发送接口；含可见文本的消息仍可发送
- Non-goals:
- 不删除或改写所有消息中的零宽字符，不修复历史已发送消息

These records are Method Pack drafts / hints, not authoritative runtime decisions.
