# VoceChat 零宽空消息修复 - Reflection

## Goal

阻止模型产生的纯零宽不可见文本被发送到 VoceChat，避免客户端出现空消息。

## DeeperCause

否。历史轨迹证明模型输出为 3 条 `U+200B`；JavaScript `trim()` 不移除该字符，插件原有出站判断因此将其当作非空正文发送。

## Evidence

- `tests/vocechat-text.test.mjs` 覆盖 3 个 `U+200B`、空白和含可见文本场景。
- `npm test`：32 个测试全部通过。
- `systemctl --user restart openclaw-gateway.service` 后 gateway active，插件从仓库 `dist/index.js` 加载。
- Aegis workspace check 通过。

## Repair Track

- Canonical owner：`src/vocechat-text.ts` 的统一出站文本归一化 helper。
- Action：纯 Unicode 空白或 `Default_Ignorable_Code_Point` 文本归一化为空，并接入普通发送、引用回复、媒体 caption、队列/兜底通知和 dispatcher 出站边界。
- Impact：不发送纯不可见消息；含可见文本的内容保持原文，不删除内部 emoji ZWJ 或变体选择符。

## Retirement Track

- Old owner：各出站路径直接使用 `trim()` 或 `normalizeString()` 判断文本。
- Action：这些路径不再独立承担不可见文本判断，保留原有普通空字符串检查作为兼容边界。
- Future trigger：若 OpenClaw 或 VoceChat 改变文本语义，再增加对应协议级测试后调整 helper。

## Residual Risk

- 未向真实 VoceChat 客户端发送测试消息，避免产生测试污染；已验证活动 gateway 加载仓库构建产物。
- 历史已经发送的 3 条空消息不会被自动删除。

Method Pack output does not grant completion authority.
