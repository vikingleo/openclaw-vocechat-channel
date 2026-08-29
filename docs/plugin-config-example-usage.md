# `config/plugin-config.example.json5` 使用说明

## 文件用途

`config/plugin-config.example.json5` 是 VoceChat 通道插件的**完整配置示例**文件，包含所有可配置项的中文注释和实际场景示例。

它的作用：
- **参考模板**：为用户提供完整的配置结构参考
- **快速上手**：可以直接复制需要的配置片段
- **场景演示**：包含多种实际使用场景的完整配置

## 如何查看

### 方法 1：直接查看文件

```bash
# 在仓库目录中
cat config/plugin-config.example.json5

# 或使用编辑器
vim config/plugin-config.example.json5
```

### 方法 2：在 README 中查看

README 的"基本配置"和"群聊触发器配置"章节包含了该文件的子集示例。

## 如何使用

### 场景 1：从零开始配置（新用户）

1. **查看现有配置**：
   ```bash
   cat ~/.openclaw/openclaw.json
   ```

2. **参考示例文件**：
   ```bash
   cat config/plugin-config.example.json5
   ```

3. **复制需要的配置片段**到 `~/.openclaw/openclaw.json`：
   ```bash
   openclaw config edit
   ```
   或：
   ```bash
   vim ~/.openclaw/openclaw.json
   ```

4. **保存并重启**：
   ```bash
   openclaw gateway restart
   ```

5. **验证**：
   ```bash
   journalctl --user -u openclaw-gateway.service -f | grep "vocechat"
   ```

### 场景 2：添加群聊触发器配置（已有配置）

1. **查看示例文件中的 `groups` 配置节**：
   ```bash
   cat config/plugin-config.example.json5
   ```

2. **在 `~/.openclaw/openclaw.json` 的 `channels.vocechat` 中添加 `groups`**：
   ```json5
   {
     channels: {
       vocechat: {
         // ... 现有配置
         
         groups: {
           "*": {
             requireMention: false,
             triggers: {
               nativeMention: true,
               textMention: true,
               questionAuto: false,
               replyToBot: false
             }
           }
         }
       }
     }
   }
   ```

3. **重启**：
   ```bash
   openclaw gateway restart
   ```

### 场景 3：使用环境变量代替 JSON 配置

如果更喜欢环境变量配置方式：

1. **复制示例文件**：
   ```bash
   cp .env.example .env
   ```

2. **编辑配置**：
   ```bash
   vim .env
   ```

3. **重启**：
   ```bash
   openclaw gateway restart
   ```

## 文件内容概览

```
channels.vocechat
├── enabled                     # 是否启用通道
├── baseUrl                     # VoceChat 服务地址
├── apiKey                      # Bot API 凭据
├── privatePathTemplate         # 私聊发送路径模板
├── groupPathTemplate           # 群聊发送路径模板
├── defaultTo                   # 默认发送目标
├── timeoutMs                   # 请求超时时间
├── inboundEnabled              # 是否启用 webhook 入站
├── inboundAckEnabled           # 是否发送入站确认
├── inboundAckText              # 入站确认内容
├── inboundParseMode            # 入站解析模式
├── webhookPath                 # webhook 路径
├── webhookApiKey               # 可选反代/自定义回调鉴权；原生 VoceChat webhook 直连时不要配置
├── allowFrom                   # 私聊允许发送者，填写 VoceChat 原始 UID，如 "1"
├── groupAllowFrom              # 群聊允许发送者，填写 VoceChat 原始 UID，如 "1"
├── groups                      # ← 群聊触发器配置（新增）
│   ├── "*"                     # 默认配置
│   ├── "12345"                 # 客服群示例
│   ├── "67890"                 # 严格模式群示例
│   └── "999"                   # 灵活模式群示例
├── queueControl                # 队列控制
├── management                  # 管理面板
└── approvals                   # 审批转发
```

## 关键配置项说明

### 群聊触发器（`groups`）

该文件包含三种实际场景的完整示例：

| 示例 | 群 ID | 场景 | 说明 |
|------|-------|------|------|
| 默认配置 | `"*"` | 通用配置 | 适用于所有未单独配置的群 |
| 客服群 | `"12345"` | 客服场景 | 多触发器 + 自定义关键词 |
| 严格模式群 | `"67890"` | 严格模式 | `requireMention: true`，只响应 @ |
| 灵活模式群 | `"999"` | 专业场景 | `replace` 模式，只响应专业关键词 |

### 门禁机制

文件开头的注释说明了**两层门禁机制**：

```
第一层：VoceChat 插件基础配置（首要条件）
  - requireMention: 如果设置为 true，必须原生 @ 机器人才能触发
  - enabled: 群组是否启用

第二层：插件触发器配置（细化控制）
  - nativeMention: 原生 @ 触发
  - textMention: 文本名称匹配触发
  - questionAuto: 问句自动触发
  - replyToBot: 回复机器人消息触发
```

## 与其他文件的关系

| 文件 | 用途 | 关系 |
|------|------|------|
| `.env.example` | 环境变量配置示例 | 互补：提供环境变量方式 |
| `config/plugin-config.example.json5` | JSON 配置示例 | 本文件：提供 JSON 方式 |
| `README.md` | 使用说明 | 引用：README 中多次引用本文件 |

两者提供两种配置方式，用户可以根据偏好选择：
- **环境变量** → 使用 `.env.example`
- **JSON 配置** → 使用 `plugin-config.example.json5`

## Webhook 鉴权说明

- `apiKey` 是 VoceChat Bot API Key，用于 OpenClaw 调 VoceChat Bot API 发消息。
- `webhookApiKey` 是本插件接收 webhook 时校验 `x-api-key` 的可选密钥，不是 VoceChat Bot API Key。
- VoceChat 原生 webhook 不能配置自定义 `x-api-key` 请求头，直连 `http://<openclaw-host>:18789/vocechat/webhook` 时应删除 `webhookApiKey`。
- 只有你在前面加了反向代理或自定义转发器，并确认它会向 OpenClaw 转发 `x-api-key`，才需要配置 `webhookApiKey`。

## 审批公网地址说明

- `approvals.publicBaseUrl` 只填公网基础地址，例如 `https://openclaw.example.com`。
- `approvals.routePath` 才填审批路由，例如 `/vocechat/approval`。
- 不要把 `/vocechat/approval` 写进 `publicBaseUrl`，否则会得到 `/vocechat/approval/vocechat/approval` 这类重复路径。

## 常见问题

### Q1: 是否需要完整复制整个文件？

**不需要**。该文件是参考模板，只需要复制你需要的配置片段。
最小配置只需要 `enabled`、`baseUrl`、`apiKey`。

### Q2: 可以直接复制到 `~/.openclaw/openclaw.json` 吗？

**可以，但建议只复制 `channels.vocechat` 部分**。完整的 `openclaw.json` 可能还包括 `agents`、`messages` 等其他配置节。

### Q3: 修改配置后如何生效？

```bash
# 重启 gateway
openclaw gateway restart

# 或查看配置是否自动热重载
journalctl --user -u openclaw-gateway.service -f | grep "config"
```

### Q4: 如何验证配置生效？

```bash
# 查看日志确认配置加载
journalctl --user -u openclaw-gateway.service -n 100 | grep -i "vocechat"

# 发送测试消息到群聊
# 观察群聊消息是否触发机器人回复
```

## 总结

`config/plugin-config.example.json5` 是重要的参考文件，提供了：
- ✅ 完整的配置结构
- ✅ 每个配置项的中文注释
- ✅ 多种实际场景的示例
- ✅ 门禁机制的详细说明

**使用建议**：
1. 新用户：先查看该文件了解完整配置
2. 已有用户：参考该文件中的 `groups` 配置节添加触发器
3. 偏好环境变量：使用 `.env.example` 替代
