# VoceChat Channel Plugin

一个用于 `OpenClaw` 的 **标准可移植 VoceChat 通道插件**。

它负责把 `OpenClaw` 与 `VoceChat Bot API + Webhook` 连接起来，支持：

- VoceChat 出站消息发送
- VoceChat 入站 webhook 接收
- 私聊与群聊目标解析
- 媒体消息出站
- 入站消息确认回复
- 按账号维度进行多实例配置

## 插件定位

本插件是一个标准 `OpenClaw` 通道插件：

- 有标准插件入口 `index.ts`
- 有标准插件清单 `openclaw.plugin.json`
- 有标准包元数据 `package.json`
- 可作为目录直接安装、复制安装或链接安装

## 工作原理

### 出站流程

1. `OpenClaw` 需要向 VoceChat 发消息
2. 插件解析目标类型：用户或群组
3. 插件选择对应 API 路径模板
4. 插件调用 VoceChat Bot API 发送文本或媒体消息

### 入站流程

1. VoceChat webhook 调用插件注册的 HTTP 路由
2. 插件校验账号配置与 webhook 设置
3. 插件解析消息内容、消息类型、发送者、会话目标
4. 插件按允许列表与群组策略做筛选
5. 合法消息进入 `OpenClaw` 的消息处理链
6. 如果启用了入站确认，则自动回复一条确认消息

## 当前特性

- 支持 `vocechat` 通道注册
- 支持出站文本与媒体消息
- 支持私聊与群聊目标
- 支持入站 webhook
- 支持入站解析模式：`legacy` / `balanced` / `strict`
- 支持入站确认消息
- 支持发送者白名单与群组白名单
- 支持多账号 `accounts.*` 配置
- 支持默认目标 `defaultTo`
- 支持 webhook 鉴权键

## 安装方式

### 本地链接安装

```bash
openclaw plugins install -l /path/to/vocechat
openclaw gateway restart
```

### 本地复制安装

```bash
openclaw plugins install /path/to/vocechat
openclaw gateway restart
```

## 基本配置

把插件配置写到宿主配置中的 `channels.vocechat`：

```json5
{
  channels: {
    vocechat: {
      enabled: true,
      baseUrl: "https://your-vocechat.example",
      apiKey: "<VOCECHAT_API_KEY>",
      inboundEnabled: true,
      webhookPath: "/vocechat/webhook",
      defaultTo: "user:demo",
      allowFrom: ["10001"],
      groupAllowFrom: ["10001"]
    }
  }
}
```

完整示例见：`config/plugin-config.example.json5`

## 关键配置字段

- `enabled`
  - 是否启用通道
- `baseUrl`
  - VoceChat 服务地址
- `apiKey`
  - Bot API 凭据
- `privatePathTemplate`
  - 私聊发送路径模板
- `groupPathTemplate`
  - 群聊发送路径模板
- `defaultTo`
  - 默认发送目标
- `timeoutMs`
  - 请求超时
- `inboundEnabled`
  - 是否启用 webhook 入站
- `inboundAckEnabled`
  - 是否自动发送入站确认
- `inboundAckText`
  - 入站确认内容
- `inboundParseMode`
  - webhook 解析模式
- `inboundBlockedTypes`
  - 过滤的入站消息类型
- `webhookPath`
  - webhook 路由路径
- `webhookApiKey`
  - webhook 鉴权键
- `allowFrom`
  - 私聊允许发送者
- `groupAllowFrom`
  - 群聊允许发送者
- `accounts`
  - 多账号配置

## 多账号配置示例

```json5
{
  channels: {
    vocechat: {
      accounts: {
        default: {
          enabled: true,
          baseUrl: "https://vocechat-a.example",
          apiKey: "<API_KEY_A>",
          inboundEnabled: true
        },
        backup: {
          enabled: true,
          baseUrl: "https://vocechat-b.example",
          apiKey: "<API_KEY_B>",
          inboundEnabled: false
        }
      }
    }
  }
}
```

## 使用方式

安装并重启宿主后：

- 出站：通过 `OpenClaw` 常规消息发送链调用该通道
- 入站：让 VoceChat webhook 指向插件暴露的 webhook 路径

## 排障建议

### 插件已加载但不能发送

优先检查：

- `baseUrl` 是否正确
- `apiKey` 是否有效
- 目标格式是否正确，例如 `user:xxx` 或 `group:xxx`

### webhook 无法进入宿主

优先检查：

- `inboundEnabled` 是否开启
- `webhookPath` 是否与外部配置一致
- `webhookApiKey` 是否匹配
- 宿主 HTTP 路由是否已正常注册

### 群消息被静默丢弃

优先检查：

- `groupAllowFrom` 是否为空或配置不匹配
- 宿主群组策略是否允许该发送者

## 可移植性说明

这个目录现在已经具备标准插件包的最小完整结构：

- `index.ts`
- `openclaw.plugin.json`
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `config/plugin-config.example.json5`

因此可以直接作为一个目录插件进行搬运和安装。
