# VoceChat Channel Plugin

一个用于 `OpenClaw` 的标准可移植 `VoceChat` 通道插件。

它负责把宿主与 `VoceChat Bot API + Webhook` 连接起来，并补充管理员可用的卡片式管理面板。

## 当前能力

- VoceChat 出站消息发送
- VoceChat 入站 webhook 接收
- 私聊与群聊目标解析
- 多账号配置
- Telegram 卡片式管理面板
- 多视图运维摘要（概览 / 账号 / Webhook / 路由 / 权限）
- 非 Telegram 渠道的文本管理视图
- 管理命令与按钮的管理员权限控制
- 管理员白名单与默认目标的在线编辑

## 工作原理

### 通道收发

1. 宿主需要向 VoceChat 发消息时，插件解析目标类型并调用对应 Bot API。
2. VoceChat webhook 进入插件注册的 HTTP 路由后，插件完成鉴权、解析和过滤。
3. 合法入站消息进入宿主消息处理链；如已启用确认回复，则自动回一条确认消息。

### 卡片管理

1. 管理员在 Telegram 中发送 `/vocechatctl`。
2. 插件直接调用 Telegram Bot API 发送一张带按钮的管理卡片。
3. 后续点击按钮时，插件不再新发消息，而是原地编辑同一张卡片。
4. 为避免刷屏，按钮回调链路返回静默令牌，交由插件自身完成界面更新。
5. 非 Telegram 渠道执行同一命令时，自动退化为纯文本视图。

## 管理命令

- `/vocechatctl`
  - 打开概览面板
- `/vocechatctl accounts`
  - 查看账号列表
- `/vocechatctl account <账号ID>`
  - 查看指定账号详情
- `/vocechatctl webhook`
  - 查看 webhook 概览
- `/vocechatctl routing`
  - 查看默认路由、目标格式与路径模板状态
- `/vocechatctl access`
  - 查看管理员控制与白名单摘要
- `/vocechatctl admin list|add|remove|clear`
  - 查看或编辑管理员白名单
- `/vocechatctl set default-to <目标>`
  - 修改默认账号的默认目标
- `/vocechatctl set default-to <账号ID> <目标>`
  - 修改指定账号的默认目标

在 Telegram 中，面板命令第一次会新发一张管理卡片；之后的按钮操作会原地刷新。编辑类命令会直接写回宿主配置，并按通道配置自动热重载。路由、权限、账号详情卡片还提供主色复制命令按钮，可一键复制专用命令模板；权限卡片会直接展示当前管理员列表，并给每个管理员提供删除按钮；路由卡片和账号详情页会优先使用 `management.quickTargets` 作为真实常用目标预设，未配置时再自动从现有设置推断。

## 权限模型

管理入口分两层控制：

- 宿主命令鉴权
  - 只有已通过宿主授权的发送者才能触发命令
- 插件管理员白名单
  - `channels.vocechat.management.adminSenderIds` 可进一步限制管理员身份
  - 文本命令与卡片按钮共用同一套管理员校验

如果未配置 `management.adminSenderIds`，则默认继承宿主已授权发送者范围。

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
      groupAllowFrom: ["10001"],
      management: {
        adminSenderIds: ["telegram:123456789", "vocechat:user:1"]
      }
    }
  }
}
```

完整示例见：`config/plugin-config.example.json5`

## 附件发送脚本

仓库内提供了一个交互式脚本，可直接向指定 `VoceChat user` 发送附件：

```bash
chmod +x ./scripts/send-vocechat-attachment.sh
./scripts/send-vocechat-attachment.sh /path/to/file.pdf
```

也支持把远程文件 URL 当成附件参数：

```bash
./scripts/send-vocechat-attachment.sh https://example.com/report.pdf
```

脚本行为：

- 自动按 OpenClaw 规则读取配置文件：
  - `OPENCLAW_CONFIG_PATH`
  - `CLAWDBOT_CONFIG_PATH`
  - `OPENCLAW_STATE_DIR/openclaw.json`
  - `CLAWDBOT_STATE_DIR/openclaw.json`
  - 默认 `~/.openclaw/openclaw.json`
- 若配置中缺少 `channels.vocechat.baseUrl` 或 `apiKey`
  - 继续从本机 `.env` 兜底查找
- 若 `.env` 仍然缺失
  - 在终端交互输入
- 交互式选择账号、输入目标 `user id`、可选输入附言后再发送

`.env` 支持的常见变量名：

- `VOCECHAT_BASE_URL`
- `OPENCLAW_VOCECHAT_BASE_URL`
- `VOCECHAT_API_KEY`
- `OPENCLAW_VOCECHAT_API_KEY`
- `VOCECHAT_BOT_API_KEY`
- `OPENCLAW_VOCECHAT_BOT_API_KEY`

如果是多账号，也支持按账号名查找，例如账号 `backup`：

- `VOCECHAT_BACKUP_BASE_URL`
- `VOCECHAT_BACKUP_API_KEY`
- `OPENCLAW_VOCECHAT_BACKUP_BASE_URL`
- `OPENCLAW_VOCECHAT_BACKUP_API_KEY`

依赖：

- `node`
- `curl`
- `file`（可选，仅用于更准确识别附件 MIME）

## 关键配置字段

- `enabled`
  - 是否启用通道
- `baseUrl`
  - VoceChat 服务地址
- `apiKey`
  - Bot API 凭据
- `privatePathTemplate` / `groupPathTemplate`
  - 私聊和群聊发送路径模板
- `defaultTo`
  - 默认发送目标
- `inboundEnabled`
  - 是否启用 webhook 入站
- `inboundAckEnabled` / `inboundAckText`
  - 是否发送入站确认及确认内容
- `allowFrom` / `groupAllowFrom`
  - 私聊和群聊允许发送者
- `accounts`
  - 多账号配置
- `management.adminSenderIds`
  - 管理员发送者白名单
- `management.panelStateFile`
  - Telegram 面板状态存储文件

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

## 可移植性说明

这个目录已具备标准插件包结构：

- `index.ts`
- `src/`
- `openclaw.plugin.json`
- `package.json`
- `tsconfig.json`
- `README.md`
- `CHANGELOG.md`
- `config/plugin-config.example.json5`

因此可以直接作为目录插件进行搬运、链接安装或独立仓库维护。
