# VoceChat 群聊触发器门禁机制说明

## 概述

VoceChat 插件的群聊触发器采用**两层门禁机制**，确保以 OpenClaw 主程序为准的管理策略得到遵守。

## 两层门禁架构

```
用户消息（群聊）
    ↓
┌───────────────────────────────────────────────┐
│ 第一层门禁：OpenClaw 主程序原生配置         │
│ （首要条件，必须先通过）                      │
├───────────────────────────────────────────────┤
│ 1. requireMention（最高优先级）              │
│    - true: 必须原生 @ 机器人                 │
│    - false 或未设置: 继续下一步              │
│                                               │
│ 2. groupPolicy                                │
│    - 群组策略检查                             │
│                                               │
│ 3. groupAllowFrom                             │
│    - 发送者白名单检查                         │
└───────────────────────────────────────────────┘
    ↓ 通过
┌───────────────────────────────────────────────┐
│ 第二层门禁：插件触发器配置                   │
│ （细化控制，在主程序允许的前提下）           │
├───────────────────────────────────────────────┤
│ 1. nativeMention: 原生 @ 机器人              │
│ 2. textMention: 文本名称匹配                 │
│ 3. questionAuto: 问句自动识别                │
│ 4. replyToBot: 回复机器人消息                │
└───────────────────────────────────────────────┘
    ↓ 触发
   机器人回复
```

## 第一层门禁详解

### 1. requireMention（最高优先级）

**作用**：强制要求必须原生 @ 机器人才能触发回复

**配置位置**：
```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        "12345": {
          "requireMention": true  // ← OpenClaw 主程序原生配置
        }
      }
    }
  }
}
```

**行为**：
- `requireMention: true`
  - **必须**通过 VoceChat 原生 @ 功能提及机器人
  - 插件的所有其他触发器（文本匹配、问句等）都会被**忽略**
  - 即使插件配置了 `textMention: true` 或 `questionAuto: true`，也不会生效

- `requireMention: false` 或未设置
  - 不强制要求 @
  - 继续评估插件触发器配置

**示例 1：严格模式**
```json5
{
  "groups": {
    "12345": {
      "requireMention": true,  // ← 主程序要求必须 @
      "triggers": {
        "nativeMention": true,
        "textMention": true,   // ✗ 不生效（被 requireMention 覆盖）
        "questionAuto": true   // ✗ 不生效（被 requireMention 覆盖）
      }
    }
  }
}
```

**日志输出**：
```
[vocechat] skip group event: OpenClaw requireMention not satisfied account=... group=12345 mid=...
```

### 2. groupPolicy

主程序的群组策略设置，控制群聊的总体行为。

### 3. groupAllowFrom

主程序的群聊发送者白名单，只有在白名单中的用户才能触发机器人。

## 第二层门禁详解

### 前置条件

只有在满足以下条件时，才会评估插件触发器：

1. **第一层门禁已通过**
2. **主程序未强制要求 @**（`requireMention != true`）

### 触发器评估顺序

插件按以下顺序评估触发器（任一满足即触发）：

1. **文本名称匹配**（`textMention`）
   - 优先级最高
   - 消息中包含机器人名称、agent name 或自定义关键词

2. **原生 @ 机器人**（`nativeMention`）
   - 通过 VoceChat 原生 @ 功能提及

3. **回复机器人消息**（`replyToBot`）
   - 用户回复/引用机器人的消息（实验性功能）

4. **问句自动识别**（`questionAuto`）
   - 优先级最低
   - 自动识别疑问句

### 示例配置

**示例 1：灵活模式（主程序不限制，插件细化控制）**
```json5
{
  "groups": {
    "12345": {
      "requireMention": false,  // ← 主程序不强制要求 @
      "triggers": {
        "nativeMention": true,  // ✓ 生效
        "textMention": true,    // ✓ 生效
        "questionAuto": false,  // ✓ 生效（关闭问句触发）
        "replyToBot": true      // ✓ 生效
      }
    }
  }
}
```

**示例 2：客服模式（主程序允许，插件启用多触发器）**
```json5
{
  "groups": {
    "12345": {
      "requireMention": false,
      "triggers": {
        "nativeMention": true,
        "textMention": true,
        "questionAuto": false,
        "mentionPatterns": ["客服", "帮助", "咨询"]
      }
    }
  }
}
```

## 配置优先级总结

```
OpenClaw 主程序 requireMention > 插件所有触发器
```

**关键点**：
- 主程序的 `requireMention` 是**最高优先级**
- 插件触发器只在主程序允许的前提下生效
- 这种设计确保了管理策略的一致性

## 实际场景

### 场景 1：公司内部群（严格模式）

**需求**：避免机器人干扰正常讨论，只在明确 @ 时才响应

**配置**：
```json5
{
  "groups": {
    "company-internal": {
      "requireMention": true  // ← 主程序强制要求 @
      // 插件触发器配置不需要，因为会被 requireMention 覆盖
    }
  }
}
```

**效果**：
- 普通消息 → 不触发
- 疑问句 → 不触发
- 包含关键词 → 不触发
- @ 机器人 → ✓ 触发

### 场景 2：客服群（灵活模式）

**需求**：多种方式触发，方便用户求助

**配置**：
```json5
{
  "groups": {
    "customer-service": {
      "requireMention": false,  // ← 主程序不限制
      "triggers": {
        "nativeMention": true,
        "textMention": true,
        "questionAuto": false,
        "mentionPatterns": ["客服", "帮助", "咨询"]
      }
    }
  }
}
```

**效果**：
- @ 机器人 → ✓ 触发
- 包含"客服" → ✓ 触发
- 包含 agent name → ✓ 触发
- 疑问句 → 不触发（已关闭）

### 场景 3：技术讨论群（混合模式）

**需求**：响应专业关键词，但不干扰普通讨论

**配置**：
```json5
{
  "groups": {
    "tech-discussion": {
      "requireMention": false,
      "triggers": {
        "nativeMention": true,
        "textMention": true,
        "questionAuto": false,
        "mentionPatterns": ["技术支持", "故障", "bug"],
        "mentionPatternsMode": "replace"  // 只响应专业关键词
      }
    }
  }
}
```

**效果**：
- @ 机器人 → ✓ 触发
- 包含"技术支持" → ✓ 触发
- 包含"故障" → ✓ 触发
- 包含 agent name → 不触发（已被 replace 模式替换）
- 疑问句 → 不触发

## 调试指南

### 查看门禁日志

```bash
journalctl --user -u openclaw-gateway.service -f | grep "vocechat"
```

### 关键日志标识

**第一层门禁**：
```
[vocechat] skip group event: OpenClaw requireMention not satisfied
```
→ 主程序要求必须 @，但消息未 @

**第二层门禁**：
```
[vocechat] skip group event: plugin trigger not satisfied ... reason=none
```
→ 主程序已允许，但插件触发器未满足

```
[vocechat] group trigger activated ... reason=native-mention
[vocechat] group trigger activated ... reason=text-mention
[vocechat] group trigger activated ... reason=question
```
→ 触发器已激活，包含具体原因

## 常见问题

### Q1: 设置了 `textMention: true` 但不生效？

**检查**：
1. 是否设置了 `requireMention: true`？
   - 如果是，`textMention` 会被忽略
2. 检查日志中的跳过原因

### Q2: 如何实现"只响应 @"？

**方案 1（推荐）**：使用主程序配置
```json5
{
  "groups": {
    "*": {
      "requireMention": true
    }
  }
}
```

**方案 2**：使用插件配置
```json5
{
  "groups": {
    "*": {
      "requireMention": false,
      "triggers": {
        "nativeMention": true,
        "textMention": false,
        "questionAuto": false,
        "replyToBot": false
      }
    }
  }
}
```

**区别**：
- 方案 1：主程序级别控制，更严格
- 方案 2：插件级别控制，更灵活

### Q3: 如何在不同群使用不同策略？

```json5
{
  "groups": {
    // 默认：严格模式
    "*": {
      "requireMention": true
    },
    
    // 客服群：灵活模式
    "12345": {
      "requireMention": false,
      "triggers": {
        "nativeMention": true,
        "textMention": true,
        "questionAuto": true
      }
    }
  }
}
```

## 最佳实践

1. **明确管理策略**
   - 先确定主程序级别的管理策略（`requireMention`）
   - 再配置插件级别的细化控制（`triggers`）

2. **保持一致性**
   - 同类型群组使用相同的配置
   - 通过通配符 `"*"` 设置默认策略

3. **日志驱动调试**
   - 遇到问题先查看日志
   - 根据日志中的原因定位问题

4. **渐进式配置**
   - 先在一个测试群验证配置
   - 确认无误后再推广到其他群组

## 技术实现

### 代码逻辑

```typescript
// 第一层门禁：OpenClaw 主程序配置
if (requireMention === true && !hasNativeMention) {
  // 主程序要求必须 @，但消息未 @
  logger.info('skip: OpenClaw requireMention not satisfied');
  return;
}

// 第二层门禁：插件触发器配置
const trigger = evaluateVoceChatGroupReplyTrigger({
  text,
  mentionRegexes,
  mentionIds,
  botUid,
  triggerConfig
});

if (!trigger.shouldReply) {
  logger.info('skip: plugin trigger not satisfied');
  return;
}

// 触发成功
logger.info(`triggered: reason=${trigger.reason}`);
```

### 触发器评估顺序

```typescript
function evaluateVoceChatGroupReplyTrigger(params) {
  // 1. 文本匹配（优先级最高）
  if (config.textMention && matchesTextPatterns(...)) {
    return { shouldReply: true, reason: "text-mention" };
  }
  
  // 2. 原生 @
  if (config.nativeMention && mentionsVoceChatBotUid(...)) {
    return { shouldReply: true, reason: "native-mention" };
  }
  
  // 3. 回复触发
  if (config.replyToBot && replyToMessageId && ...) {
    return { shouldReply: true, reason: "reply-to-bot" };
  }
  
  // 4. 问句识别（优先级最低）
  if (config.questionAuto && isLikelyQuestionText(...)) {
    return { shouldReply: true, reason: "question" };
  }
  
  return { shouldReply: false, reason: "none" };
}
```

## 总结

VoceChat 群聊触发器的两层门禁机制确保了：

1. **管理策略优先**：OpenClaw 主程序配置是首要条件
2. **灵活细化控制**：插件触发器提供更细粒度的配置
3. **清晰的优先级**：主程序 > 插件，避免配置冲突
4. **可观测性**：详细的日志输出便于调试

这种设计既保证了以 OpenClaw 主程序为准的管理策略，又提供了灵活的触发器配置能力。
