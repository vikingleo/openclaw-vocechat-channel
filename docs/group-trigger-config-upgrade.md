# 群聊触发器配置功能升级说明

## 升级概述

本次升级为 VoceChat 插件增加了灵活的群聊触发器配置功能，支持通过 JSON 配置文件或环境变量自定义群聊消息触发机器人回复的条件。

**重要**：本功能遵循两层门禁机制，以 OpenClaw 主程序原生配置为首要条件。

## 门禁优先级

### 两层门禁机制

```
┌─────────────────────────────────────────────────┐
│ 第一层：OpenClaw 主程序原生配置（首要门禁）    │
│   - requireMention（必须原生@）                 │
│   - groupPolicy（群组策略）                      │
│   - groupAllowFrom（发送者白名单）              │
│         ↓ 通过后                                │
│ 第二层：插件触发器配置（细化控制）             │
│   - nativeMention（原生@触发）                  │
│   - textMention（文本匹配触发）                 │
│   - questionAuto（问句自动触发）                │
│   - replyToBot（回复触发）                      │
└─────────────────────────────────────────────────┘
```

### 第一层门禁：OpenClaw 主程序配置

以下 OpenClaw 原生配置作为首要条件，必须先满足：

1. **`requireMention`**（最高优先级）
   - 如果主程序设置 `requireMention: true`，则**必须原生 @ 机器人**才能触发
   - 此时插件的所有其他触发器（文本匹配、问句等）都会被忽略
   - 只有主程序未设置或设置为 `false` 时，才进入插件的触发器评估

2. **`groupPolicy`**
   - 主程序的群组策略设置

3. **`groupAllowFrom`**
   - 主程序的群聊发送者白名单

**重要说明**：
- OpenClaw 主程序配置是**首要门禁**，插件必须遵循主程序的设置
- 插件触发器配置是**细化控制**，只有在主程序允许的前提下才生效
- 这种设计确保了以 OpenClaw 主程序为准的管理策略

### 第二层门禁：插件触发器配置

只有在通过第一层门禁后，才会评估插件的触发器配置。

## 新增功能

### 1. 四种可配置的触发方式

| 触发方式 | 配置键 | 默认值 | 说明 |
|---------|--------|--------|------|
| 原生 @ 机器人 | `nativeMention` | `true` | 用户通过 VoceChat 原生 @ 功能提及机器人 |
| 文本名称匹配 | `textMention` | `true` | 消息中包含机器人名称、昵称或自定义关键词 |
| 问句自动触发 | `questionAuto` | `true` | 自动识别疑问句（包含 `?`、`？`、`吗`、`呢` 等） |
| 回复机器人消息 | `replyToBot` | `false` | 用户回复/引用机器人的消息时触发（实验性） |

### 2. 自定义文本匹配模式

- **`mentionPatterns`**: 自定义匹配关键词列表
- **`mentionPatternsMode`**: 
  - `append`（默认）: 自定义模式追加到系统默认（agent name）之后
  - `replace`: 自定义模式完全替换系统默认，只使用配置的关键词

### 3. 按群组单独配置

支持为不同群聊配置不同的触发策略，使用 `groups` 配置节：

```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        "*": {  // 默认配置
          "triggers": { /* ... */ }
        },
        "12345": {  // 特定群聊配置
          "triggers": { /* ... */ }
        }
      }
    }
  }
}
```

### 4. 环境变量配置支持

支持通过 `.env` 文件配置，环境变量优先级高于 JSON 配置。

**环境变量格式**：

```bash
# 默认配置（所有群）
VOCECHAT_GROUP_DEFAULT_{配置项}=value

# 特定群组配置
VOCECHAT_GROUP_{群组ID}_{配置项}=value

# 全局简化配置
VOCECHAT_TRIGGER_{配置项}=value
```

## 配置优先级

```
环境变量（群组特定） > 环境变量（默认） > 环境变量（全局） > JSON 配置 > 代码默认值
```

## 代码变更

### 新增类型定义

```typescript
type VoceChatGroupTriggerConfig = {
  nativeMention?: boolean;
  textMention?: boolean;
  questionAuto?: boolean;
  replyToBot?: boolean;
  mentionPatterns?: string[];
  mentionPatternsMode?: "append" | "replace";
};

type ResolvedVoceChatGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  triggers: VoceChatGroupTriggerConfig;
};
```

### 新增函数

- **`parseGroupTriggerConfigFromEnv(groupId?)`**: 从环境变量解析触发器配置
- **`parseVoceChatGroupTriggers(value, groupId?)`**: 解析触发器配置（合并 JSON + 环境变量）
- 更新 **`parseVoceChatGroups(value)`**: 支持解析 `triggers` 配置节
- 更新 **`resolveVoceChatGroupConfig(account, groupId?)`**: 始终返回配置（不再返回 `undefined`）

### 修改的函数签名

`evaluateVoceChatGroupReplyTrigger()` 新增参数：

```typescript
export function evaluateVoceChatGroupReplyTrigger(params: {
  text: unknown;
  mentionRegexes?: readonly RegExp[];
  mentionIds?: readonly unknown[];
  botUid?: unknown;
  replyToMessageId?: string;           // 新增（预留）
  botMessageHistory?: Set<string>;     // 新增（预留）
  triggerConfig?: VoceChatGroupTriggerConfig;  // 新增
}): VoceChatGroupReplyTrigger;
```

新增触发原因：`"reply-to-bot"`

### 增强的日志输出

- `[vocechat] group trigger activated` - 触发器激活，包含 `reason`
- `[vocechat] skip group event: no reply trigger ... reason=...` - 跳过群聊事件，包含原因

## 配置示例

### 场景 1: 严格模式（只响应明确 @）

**JSON 配置**：
```json5
{
  "groups": {
    "*": {
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

**环境变量配置**：
```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=false
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
VOCECHAT_GROUP_DEFAULT_REPLY_TO_BOT=false
```

### 场景 2: 客服模式（多触发器 + 自定义关键词）

**JSON 配置**：
```json5
{
  "groups": {
    "12345": {
      "triggers": {
        "nativeMention": true,
        "textMention": true,
        "questionAuto": false,
        "replyToBot": true,
        "mentionPatterns": ["客服", "帮助", "咨询", "报修"],
        "mentionPatternsMode": "append"
      }
    }
  }
}
```

**环境变量配置**：
```bash
VOCECHAT_GROUP_12345_NATIVE_MENTION=true
VOCECHAT_GROUP_12345_TEXT_MENTION=true
VOCECHAT_GROUP_12345_QUESTION_AUTO=false
VOCECHAT_GROUP_12345_REPLY_TO_BOT=true
VOCECHAT_GROUP_12345_MENTION_PATTERNS=客服,帮助,咨询,报修
VOCECHAT_GROUP_12345_MENTION_PATTERNS_MODE=append
```

### 场景 3: 混合模式（不同群组不同策略）

**环境变量配置**：
```bash
# 默认：只响应 @
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=false
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false

# 客服群（12345）：全面响应
VOCECHAT_GROUP_12345_NATIVE_MENTION=true
VOCECHAT_GROUP_12345_TEXT_MENTION=true
VOCECHAT_GROUP_12345_QUESTION_AUTO=true
VOCECHAT_GROUP_12345_MENTION_PATTERNS=客服,帮助

# 技术群（67890）：只响应专业关键词
VOCECHAT_GROUP_67890_NATIVE_MENTION=true
VOCECHAT_GROUP_67890_TEXT_MENTION=true
VOCECHAT_GROUP_67890_QUESTION_AUTO=false
VOCECHAT_GROUP_67890_MENTION_PATTERNS=技术支持,故障,bug
VOCECHAT_GROUP_67890_MENTION_PATTERNS_MODE=replace
```

## 升级步骤

### 1. 更新代码

```bash
cd /path/to/openclaw-vocechat-channel
git pull  # 或从最新代码同步
npm run build
```

### 2. 重新安装插件

```bash
openclaw plugins install -l /path/to/openclaw-vocechat-channel
openclaw gateway restart
```

### 3. 配置触发器（可选）

**方式 1: 使用 JSON 配置**

编辑 `~/.openclaw/openclaw.json`，在 `channels.vocechat` 中添加 `groups` 配置节。

**方式 2: 使用环境变量**

```bash
cd /path/to/openclaw-vocechat-channel
cp .env.example .env
vim .env  # 编辑配置
```

然后重启 OpenClaw gateway：
```bash
openclaw gateway restart
```

### 4. 验证配置

发送测试消息到群聊，查看日志确认触发器工作：

```bash
journalctl --user -u openclaw-gateway.service -f | grep "group trigger"
```

预期日志：
- `group trigger activated ... reason=native-mention` - @ 触发成功
- `group trigger activated ... reason=text-mention` - 文本匹配触发成功
- `skip group event: no reply trigger ... reason=none` - 未触发

## 兼容性说明

### 向后兼容

- 如果未配置 `groups` 或 `triggers`，使用默认值（全部启用，除了 `replyToBot`）
- 现有配置不需要修改即可继续使用
- 新增的配置项都是可选的

### 默认行为变更

**无变更** - 默认行为与升级前完全一致：
- `nativeMention`: `true`（保持）
- `textMention`: `true`（保持）
- `questionAuto`: `true`（保持）
- `replyToBot`: `false`（新增，默认关闭）

## 调试与排障

### 查看触发器日志

```bash
journalctl --user -u openclaw-gateway.service -f | grep "group trigger"
```

### 常见问题

**问题 1: 配置了触发器但没有生效**

检查配置优先级，环境变量会覆盖 JSON 配置：

```bash
# 检查环境变量
env | grep VOCECHAT_

# 查看实际配置（从日志中）
journalctl --user -u openclaw-gateway.service -n 200 | grep "group trigger"
```

**问题 2: 自定义 mentionPatterns 不起作用**

检查 `mentionPatternsMode` 设置：
- `append`（默认）: 自定义模式追加到系统默认之后
- `replace`: 完全替换系统默认，只使用配置的模式

**问题 3: 群聊消息完全不触发**

检查以下配置：
1. `groups[groupId].enabled` 或 `groups["*"].enabled` 是否为 `false`
2. 是否所有触发器都被关闭（全部为 `false`）
3. `allowFrom` / `groupAllowFrom` 是否包含发送者 UID

## 文件清单

### 新增文件

- `.env.example` - 环境变量配置示例文件（带中文说明）
- `docs/group-trigger-config-upgrade.md` - 本升级说明文档

### 修改文件

- `index.ts` - 核心逻辑实现
- `src/vocechat-group-trigger.ts` - 触发器评估逻辑
- `README.md` - 更新使用说明
- `config/plugin-config.example.json5` - 更新配置示例

## 未来计划

### 短期（待验证 VoceChat webhook 支持）

- [ ] 实现 `replyToBot` 触发器的完整功能
- [ ] 维护机器人历史消息 ID 列表
- [ ] 解析 webhook 中的 `reply_to` 字段

### 中期

- [ ] 支持正则表达式匹配模式（高级用户）
- [ ] 支持时间窗口限制（例如工作时间内才响应问句）
- [ ] 支持按用户权限配置触发器（例如管理员 vs 普通用户）

### 长期

- [ ] Web UI 配置界面
- [ ] 触发器统计与分析
- [ ] 智能学习优化（基于历史触发效果调整）

## 技术细节

### 环境变量解析优先级实现

```typescript
return {
  nativeMention:
    envConfigSpecific?.nativeMention ??           // 1. 群组特定环境变量
    envConfigDefault?.nativeMention ??            // 2. 默认环境变量
    (globalNativeMention !== undefined ? ... ) ?? // 3. 全局环境变量
    jsonConfig.nativeMention ??                   // 4. JSON 配置
    true,                                         // 5. 代码默认值
  // ...
};
```

### 文本匹配模式合并逻辑

```typescript
const finalMentionRegexes = patternsMode === "replace" && customPatterns.length > 0
  ? customPatterns.map(pattern => buildRegex(pattern))  // replace: 只用自定义
  : [
      ...mentionRegexes,                                // append: 系统默认
      ...customPatterns.map(pattern => buildRegex(pattern)), // + 自定义
    ];
```

## 测试建议

### 单元测试场景

1. 环境变量解析优先级
2. JSON 配置解析
3. 触发器评估逻辑（每种触发方式）
4. 文本匹配模式合并（append vs replace）

### 集成测试场景

1. 默认配置下的群聊触发行为
2. 特定群组配置覆盖默认配置
3. 环境变量覆盖 JSON 配置
4. 多群组不同策略并存

### 手工测试步骤

1. 配置严格模式（只响应 @）
   - 发送普通文本 → 不触发
   - @ 机器人 → 触发
   - 发送疑问句 → 不触发

2. 配置主动模式（响应所有疑问）
   - 发送普通文本 → 不触发
   - 发送疑问句 → 触发
   - @ 机器人 → 触发

3. 配置自定义关键词
   - 发送包含关键词的消息 → 触发
   - 发送不包含关键词的消息 → 不触发

4. 测试多群组不同配置
   - 在不同群组发送相同消息 → 不同响应

## 贡献者

- 初始设计与实现：@vkleo
- 文档编写：AI Assistant (Claude)

## 相关文档

- [VoceChat Channel Plugin README](../README.md)
- [环境变量配置示例](.env.example)
- [JSON 配置示例](../config/plugin-config.example.json5)
