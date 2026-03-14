# VoceChat 入站图文合并设计说明

本文档记录一个待实施升级：当 VoceChat 前端把“输入文字 + 粘贴图片”拆成两条独立消息发送时，插件在入站侧做短时间窗口合并，再只向 OpenClaw agent 发起一次请求。

写这份文档的目的很直接：

- 避免中途断线后实现思路丢失
- 明确这次要改的是“入站调度”，不是“回复阶段拼接”
- 让后续新机器或其他 agent 可以直接按本文档继续开发

## 1. 问题定义

当前 VoceChat 的前后端实现决定了：

- 文本消息是单独发送、单独存储、单独广播
- 图片附件也是单独发送、单独存储、单独广播
- 不存在一条原生“文本 + 附件数组”的复合消息

这会导致一个直接结果：

1. 用户先输入文字
2. 用户再粘贴图片并发送
3. 插件收到 2 次 webhook
4. 当前插件会把这 2 次 webhook 分别独立交给 agent

因此 agent 常见表现是：

- 先对前一条纯文本做出回答
- 随后又单独处理图片
- 因为两次请求没有在同一轮入站中关联，最终回复显得“答非所问”或上下文错位

## 2. 当前插件为什么会这样

当前代码路径是“每条 webhook 事件独立立即派发”：

- `parseInboundEvent(raw, account)` 解析一条 webhook
- `createWebhookHandler()` 里解析完成后，立刻调用 `processInboundEvent()`
- `processInboundEvent()` 再立刻构造 `agentBody` 并调用 `dispatchReplyWithBufferedBlockDispatcher()`

现有 `buildInboundAgentBody()` 只会把“同一个 `InboundEvent` 内的文本 + 附件”整理成给 agent 的正文。

它做不到跨两条独立 webhook 合并，所以：

- 一条纯文本 webhook 仍会立刻触发一次 agent
- 紧随其后的图片 webhook 只能作为第二次独立请求进入系统

## 3. 为什么不能在回复阶段再合并

这个方向不对，原因有 3 个：

1. 太晚了

第一条文本消息一旦已经触发 agent 推理，就已经开始生成回复了。回复阶段再试图“把第二条图片并回去”，无法撤销第一次错误推理。

2. 语义已经分叉

第一条文本消息进入 agent 时，没有携带图片文件，模型只能按纯文本理解，结果天然容易偏离用户真实意图。

3. 会带来双回复风险

如果等到回复阶段才发现还有后续图片消息，需要处理“是否取消第一次回复”“是否保留第二次回复”“是否补发整合说明”等复杂分支，成本高且不稳定。

一句话：正确位置必须是入站 webhook 刚进入插件时。

## 4. 设计目标

这次升级的目标不是把 VoceChat 改造成原生图文消息，而是在插件层补一个“短时间窗口合并器”。

目标行为如下：

1. 同一用户在同一会话里短时间连续发送“文本 + 图片”
2. 插件先暂存第一条消息，不立即交给 agent
3. 在等待窗口内收到第二条相关消息后，合并为一个 synthetic inbound event
4. 最终只向 agent 派发一次
5. agent 拿到的是：
   - 用户文字
   - 本地图片路径
   - 原始文件名 / MIME / 失败兜底

## 5. 方案总览

核心思路：在 `createWebhookHandler()` 与 `processInboundEvent()` 之间增加“入站聚合层”。

建议新增内存态 pending map：

```text
pendingInboundMerges: Map<string, PendingInboundMerge>
```

其中 key 建议由下面字段组成：

```text
accountId + chatType + conversationId + fromUid
```

这样可以保证只合并：

- 同一个账号
- 同一种聊天类型
- 同一个私聊或群聊会话
- 同一个发送者

不会误把不同人的消息拼到一起。

## 6. 合并窗口

建议默认增加两个配置项：

```json
{
  "channels": {
    "vocechat": {
      "inboundMergeEnabled": true,
      "inboundMergeWindowMs": 1200,
      "inboundMergeMaxMessages": 3
    }
  }
}
```

推荐默认值：

- `inboundMergeEnabled: true`
- `inboundMergeWindowMs: 1200`
- `inboundMergeMaxMessages: 3`

含义：

- 首条消息进入后最多等 `1200ms`
- 在窗口内最多合并 3 条消息
- 超过数量或超时后立刻派发

这个窗口足够覆盖前端“先文本、后附件”的常见连续发送，又不会让普通纯文本聊天延迟过久。

## 7. 待新增的数据结构

建议新增：

```ts
type PendingInboundMerge = {
  key: string;
  accountId: string;
  createdAt: number;
  flushAt: number;
  timer?: NodeJS.Timeout;
  events: InboundEvent[];
};
```

如果需要更细日志，也可以增加：

- `mergedMessageIds: string[]`
- `chatType`
- `conversationId`
- `fromUid`

## 8. 合并规则

### 合并前提

只有同时满足下列条件才合并：

1. `inboundMergeEnabled === true`
2. key 相同
3. 后续消息在 `inboundMergeWindowMs` 时间窗口内到达
4. 当前 pending 条目未 flush
5. 消息数未超过 `inboundMergeMaxMessages`

### 推荐优先合并的组合

- 文本 -> 图片
- 图片 -> 文本
- 文本 -> 图片 -> 图片

### 不建议合并的情况

- 不同 `fromUid`
- 不同 `conversationId`
- 间隔时间过长
- 后续消息明显是另一轮对话
- webhook 已经识别为重复消息

## 9. synthetic event 的生成方式

多个 `InboundEvent` 合并后，需要生成一个新的 synthetic event，再交给现有 `processInboundEvent()`。

建议规则：

- `messageId`：使用首条消息 id，另加一个 merged 标记，或内部生成 `merged:<first>:<last>`
- `timestamp`：取首条消息时间，必要时附加最后一条时间到审计日志
- `replyTarget`：沿用同一会话已有值
- `chatType` / `conversationId` / `groupId` / `fromUid`：必须一致，直接沿用
- `text`：把所有非空文本按顺序拼接
- `originalText`：同样按顺序拼接
- `attachments`：拼接所有事件的附件数组
- `imageUrls` / `localFiles`：在 `hydrateInboundAttachments()` 后再统一生成

推荐文本拼接形式：

```text
第一条文本

第二条补充文本
```

不要硬编码“用户又补充说”，避免把系统解释词混入用户原文。

## 10. 与图片落地链路的关系

当前图片链路已经支持：

- 解析附件
- 下载到本地
- 生成 `localFiles`
- 传给 agent

因此这次升级不需要重做图片下载逻辑。

正确做法是：

1. 先把多个 `InboundEvent` 合并成一个 synthetic event
2. 再调用现有 `hydrateInboundAttachments()`
3. 再走现有 `buildInboundAgentBody()`
4. 再派发给 agent

也就是说：

- 复用已有图片处理链路
- 只新增入站聚合层

## 11. 调度位置建议

建议在 webhook handler 内这样调整：

1. `parseInboundEvent()` 成功后
2. 不再直接 `processInboundEvent()`
3. 改为 `enqueueInboundMergeOrDispatch()`
4. 由该函数决定：
   - 立即派发
   - 还是放入 pending map 等待合并

### 推荐新增函数

- `buildInboundMergeKey(accountId, event)`
- `shouldHoldInboundEventForMerge(account, event)`
- `enqueueInboundMerge(accountId, event, logger)`
- `flushInboundMerge(key, reason, logger)`
- `mergeInboundEvents(events)`

## 12. 是否所有消息都要延迟

不建议所有消息都无差别延迟。

更稳的策略是：

- 纯文本消息：如果开启合并功能，先短暂等待窗口
- 纯图片消息：同样进入窗口，等待用户是否紧跟补一条说明文字
- 明显不适合等待的管理命令或系统型消息：直接放行

如果后续想更激进优化，可以做成：

- 普通文本：延迟 `1200ms`
- 带附件消息：延迟 `1500ms`

第一版不需要这么复杂，统一窗口即可。

## 13. 日志要求

必须补充审计日志，否则后续排障会很难。

建议新增日志：

- `inbound merge queued account=... key=... mid=... holdMs=...`
- `inbound merge appended account=... key=... mid=... pendingCount=...`
- `inbound merge flushed account=... key=... reason=timeout|max_messages|manual count=... mids=...`
- `inbound merge produced account=... key=... textLen=... attachmentCount=...`

这样能回答下面问题：

- 某条消息有没有进入合并窗口
- 为什么被 flush
- 最终拼成了几条
- 合并后到底有没有附件

## 14. 对回复行为的影响

这次变更的直接效果是：

- agent 回复次数减少
- 图文场景不再先答前面的文本

但有一个现实限制需要写清楚：

- VoceChat 群聊原生只能 quote 某一条原消息

所以合并后回复时，最多只能：

- quote 最后一条原消息
- 或直接在群里普通发一条回复

无法同时“引用两条原消息”。

这不影响 agent 理解输入，只影响 VoceChat UI 上的引用展示方式。

## 15. 风险与边界

### 风险 1：普通文本回复会慢一点

因为进入了短窗口等待，纯文本消息理论上会增加 `~1.2s` 延迟。

这是一个有意接受的权衡。

### 风险 2：误把两条独立文本拼成一条

如果用户在 1 秒内连续发两条完全不同的问题，可能被合并。

缓解方式：

- 限制窗口较短
- 限制同一发送者、同一会话
- 仅合并最多 3 条

### 风险 3：进程重启后 pending 丢失

pending map 是内存态的。网关重启时，未 flush 的临时消息会丢。

这是可接受的，因为窗口只有 1 秒级，不值得为此做持久化。

## 16. 验证用例

开发完成后至少验证下面 6 组场景：

1. 文本后紧跟 1 张图片
   - 预期：只触发 1 次 agent

2. 先发图片后补文字
   - 预期：只触发 1 次 agent

3. 文本后连续 2 张图片
   - 预期：1 次 agent，`attachments=2`

4. 两条间隔超过窗口的消息
   - 预期：仍然拆成 2 次 agent

5. 群聊里两个不同用户几乎同时发消息
   - 预期：不会互相串线

6. 管理命令或非普通对话消息
   - 预期：不应错误进入普通图文合并流程

## 17. 实施顺序

建议按下面顺序开发：

1. 扩展配置解析与 `configSchema`
2. 新增 pending merge 数据结构和工具函数
3. 在 webhook handler 中接入 `enqueue / flush` 流程
4. 实现 `mergeInboundEvents()`
5. 让合并后的 synthetic event 复用现有图片落地与 agent 派发链路
6. 补日志
7. 手工验证上述 6 组场景
8. 更新 README 与升级文档

## 18. 一句结论

这次要补的不是“把两条回复再拼回去”，而是“在入站 webhook 刚进入插件时，把同一轮文本和图片先合成一次请求，再只交给 agent 一次”。
