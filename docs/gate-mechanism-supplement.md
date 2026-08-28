# 门禁机制补充说明 - 变更摘要

## 重要变更

本次补充实现了**两层门禁机制**：先执行 VoceChat 插件基础配置，再执行触发器细化控制。

## 核心原则

**插件先做基础门禁，再做触发器判断**

- `channels.vocechat` 的 `requireMention`、`groupPolicy`、`groupAllowFrom` 等配置是**首要门禁**
- 触发器配置是**细化控制**，只在基础门禁允许的前提下生效
- `groupAllowFrom` 填写 VoceChat 原始 UID 字符串，例如 `"1"`，不要写成 `vocechat:user:1`

## 两层门禁架构

```
┌─────────────────────────────────────────────────┐
│ 第一层：VoceChat 插件基础配置（首要门禁）      │
│ ─────────────────────────────────────────────── │
│ • requireMention: 如果设置为 true，           │
│   必须原生 @ 机器人，插件其他触发器被忽略     │
│                                                 │
│ • groupPolicy: 群组策略                        │
│                                                 │
│ • groupAllowFrom: 发送者白名单                 │
│                                                 │
│         ↓ 通过后                                │
│                                                 │
│ 第二层：插件触发器配置（细化控制）             │
│ ─────────────────────────────────────────────── │
│ • nativeMention: 原生 @ 触发                   │
│ • textMention: 文本名称匹配触发                │
│ • questionAuto: 问句自动触发                   │
│ • replyToBot: 回复触发                         │
└─────────────────────────────────────────────────┘
```

## 代码变更

### 新增逻辑

在 `processInboundEvent` 函数中，**第一层门禁检查**（位于第 5287-5306 行）：

```typescript
// 第一层门禁：VoceChat 插件基础配置
const groupConfig = event.chatType === "group" 
  ? resolveVoceChatGroupConfig(account, event.groupId) 
  : undefined;

// 检查插件的 requireMention 设置（优先级最高）
const botUid = parseVoceChatBotUidFromApiKey(account.apiKey);
const hasNativeMention = mentionsVoceChatBotUid(event.mentionIds ?? [], botUid);

if (event.chatType === "group" && groupConfig?.requireMention === true && !hasNativeMention) {
  logger?.info?.(
    `[vocechat] skip group event: plugin requireMention not satisfied`
  );
  return;  // ← 直接拒绝，不进入插件触发器评估
}

// 第二层门禁：插件触发器配置（只有通过第一层后才会执行）
const groupReplyTrigger = event.chatType === "group"
  ? evaluateVoceChatGroupReplyTrigger({
      text: event.originalText || event.text,
      mentionRegexes: finalMentionRegexes,
      mentionIds: event.mentionIds,
      botUid: botUid,
      triggerConfig: groupConfig?.triggers,  // ← 插件触发器配置
    })
  : undefined;
```

### 新增导入

```typescript
import {
  extractVoceChatMentionIds,
  parseVoceChatBotUidFromApiKey,
  mentionsVoceChatBotUid,  // ← 新增导入
} from "./src/vocechat-mentions.js";
```

### 日志变更

**第一层门禁日志**：
```
[vocechat] skip group event: plugin requireMention not satisfied
```

**第二层门禁日志**：
```
[vocechat] skip group event: plugin trigger not satisfied ... reason=none
```

区分了基础门禁拒绝和触发器拒绝的情况。

## 配置示例

### 示例 1：严格模式（插件基础门禁强制要求 @）

```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        "12345": {
          "requireMention": true,  // ← 第一层门禁：插件基础门禁要求必须 @
          
          // 以下插件触发器配置会被忽略
          "triggers": {
            "nativeMention": true,
            "textMention": true,   // ✗ 不生效（被 requireMention 覆盖）
            "questionAuto": true   // ✗ 不生效（被 requireMention 覆盖）
          }
        }
      }
    }
  }
}
```

**行为**：
- 只有原生 @ 机器人才能触发
- 文本匹配、问句等插件触发器全部失效

### 示例 2：灵活模式（插件基础门禁不限制，触发器细化控制）

```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        "12345": {
          "requireMention": false,  // ← 第一层门禁：插件基础门禁不限制
          
          // 插件触发器配置生效
          "triggers": {
            "nativeMention": true,  // ✓ 生效
            "textMention": true,    // ✓ 生效
            "questionAuto": false,  // ✓ 生效（关闭问句触发）
            "replyToBot": true,     // ✓ 生效
            "mentionPatterns": ["客服", "帮助"]
          }
        }
      }
    }
  }
}
```

**行为**：
- @ 机器人 → 触发
- 包含"客服"或"帮助" → 触发
- 包含 agent name → 触发
- 疑问句 → 不触发（已关闭）

### 示例 3：混合模式（不同群组不同策略）

```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        // 默认：严格模式
        "*": {
          "requireMention": true  // 所有群默认要求 @
        },
        
        // 客服群：灵活模式
        "12345": {
          "requireMention": false,  // 客服群不限制
          "triggers": {
            "nativeMention": true,
            "textMention": true,
            "questionAuto": true,
            "mentionPatterns": ["客服", "帮助"]
          }
        }
      }
    }
  }
}
```

## 环境变量配置

环境变量同样遵循两层门禁机制：

```bash
# 第一层门禁：VoceChat 插件基础配置（通过 JSON 配置，不支持环境变量）
# channels.vocechat.groups[groupId].requireMention

# 第二层门禁：插件触发器配置（支持环境变量）
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=true
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
```

**注意**：`requireMention` 是 `channels.vocechat.groups` 下的插件基础配置，暂不支持通过环境变量设置。

## 文档更新

### 新增文档

- **`docs/group-trigger-gate-mechanism.md`** - 门禁机制详细说明
  - 两层门禁架构
  - 配置优先级
  - 实际场景示例
  - 调试指南
  - 常见问题

### 更新文档

- **`README.md`**
  - 添加"门禁优先级"章节
  - 说明第一层和第二层门禁的关系

- **`.env.example`**
  - 添加门禁机制图示
  - 说明 `requireMention` 的优先级

- **`config/plugin-config.example.json5`**
  - 添加门禁机制注释
  - 更新配置示例（包含 `requireMention`）

- **`docs/group-trigger-config-upgrade.md`**
  - 添加门禁优先级章节

## 测试场景

### 场景 1：插件基础门禁强制要求 @

**配置**：
```json5
{ "requireMention": true }
```

**测试**：
- [ ] @ 机器人 → 触发
- [ ] 包含 agent name → 不触发
- [ ] 发送疑问句 → 不触发
- [ ] 包含自定义关键词 → 不触发

**预期日志**：
```
[vocechat] skip group event: plugin requireMention not satisfied
```

### 场景 2：插件基础门禁不限制，触发器只响应 @

**配置**：
```json5
{
  "requireMention": false,
  "triggers": {
    "nativeMention": true,
    "textMention": false,
    "questionAuto": false
  }
}
```

**测试**：
- [ ] @ 机器人 → 触发
- [ ] 包含 agent name → 不触发
- [ ] 发送疑问句 → 不触发

**预期日志**：
```
[vocechat] skip group event: plugin trigger not satisfied reason=none
```

### 场景 3：插件基础门禁不限制，触发器多种方式

**配置**：
```json5
{
  "requireMention": false,
  "triggers": {
    "nativeMention": true,
    "textMention": true,
    "questionAuto": true
  }
}
```

**测试**：
- [ ] @ 机器人 → 触发（reason=native-mention）
- [ ] 包含 agent name → 触发（reason=text-mention）
- [ ] 发送疑问句 → 触发（reason=question）
- [ ] 普通文本 → 不触发

## 向后兼容性

✅ **完全向后兼容**

- 未配置 `requireMention` 时，默认为 `false`（不限制）
- 插件触发器的默认行为与之前完全一致
- 现有配置无需修改

## 技术亮点

1. **分层管理**：插件基础门禁 + 触发器细化控制
2. **优先级清晰**：基础门禁优先于触发器配置
3. **可观测性**：日志区分基础门禁拒绝和触发器拒绝
4. **向后兼容**：不影响现有部署

## 实施状态

- [x] 代码实现完成
- [x] 日志输出完善
- [x] 文档更新完成
- [x] 构建验证通过
- [ ] 实际环境测试
- [ ] 用户反馈收集

## 下一步

1. **部署测试**：在测试环境验证门禁机制
2. **场景验证**：测试所有配置场景
3. **文档完善**：根据测试结果补充说明
4. **用户反馈**：收集实际使用反馈

## 相关文档

- [门禁机制详细说明](./group-trigger-gate-mechanism.md)
- [升级说明](./group-trigger-config-upgrade.md)
- [快速总结](./group-trigger-quick-summary.md)
- [实施检查清单](./group-trigger-implementation-checklist.md)
