# VoceChat 入站图片升级说明

本文档用于把当前仓库中的“VoceChat 图片入站 -> 本地落地 -> agent 可识别”能力迁移到新机器。

## 变更目标

这次升级只聚焦入站媒体处理，不重做现有出站链路。

升级后，插件会：

- 从 VoceChat webhook 原始包里解析图片附件
- 把图片下载到本机 `OpenClaw workspace` 内
- 将本地绝对路径、文件名、MIME 一起传给 agent
- 在下载失败时，把失败原因明确告诉 agent，而不是只传一串路径文本

## 仓库内代码改动

本次升级的核心代码在 [index.ts](../index.ts)：

- 扩展 `InboundEvent`，新增 `attachments`、`imageUrls`、`localFiles`、`originalText`
- 解析 VoceChat 图片/附件结构，兼容存储路径 `YYYY/M/D/<uuid>`
- 自动转换为 `/api/resource/file?file_path=...` 下载地址
- 下载并落地到 `~/.openclaw/workspace/media/inbound/vocechat/...`
- 生成更适合 agent 理解的入站正文

## 新机器更新步骤

### 1. 拉取仓库最新代码

```bash
git pull --ff-only
```

### 2. 同步插件到宿主扩展目录

如果宿主实际从 `~/.openclaw/extensions/vocechat` 加载插件，执行：

```bash
sh ./scripts/sync-to-root-extension.sh
```

这个脚本会：

- 自动定位宿主插件安装目录
- 把仓库里的 `index.ts`、`src/**/*`、`package.json`、`tsconfig.json` 等同步过去
- 进入宿主扩展目录执行 `npm run build`

如果你的宿主不是默认路径，可以先指定：

```bash
OPENCLAW_VOCECHAT_INSTALL_PATH=/custom/path/vocechat sh ./scripts/sync-to-root-extension.sh
```

### 3. 校正宿主配置

这一步改的是宿主机器上的 `~/.openclaw/openclaw.json`，不是本仓库文件。

至少确认以下配置：

#### VoceChat 通道配置

```json
{
  "channels": {
    "vocechat": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:53000",
      "apiKey": "你的机器人 API Key",
      "webhookApiKey": "你的 webhook API Key",
      "inboundEnabled": true,
      "webhookPath": "/vocechat/webhook"
    }
  }
}
```

注意：

- `baseUrl` 必须是 `OpenClaw` 进程实际可访问的地址
- 如果 `VoceChat` 跑在 Docker 容器内，且映射到宿主 `53000 -> 3000`，这里应写宿主端口 `53000`
- 不要想当然写容器内 `3000`，除非 `OpenClaw` 与容器在同一网络命名空间且该地址真实可达

#### 图片模型配置

`image` 工具不会自动沿用普通对话模型。必须显式配置：

```json
{
  "agents": {
    "defaults": {
      "imageModel": {
        "primary": "rightcode/gpt-5.4"
      }
    }
  }
}
```

要求：

- 该模型必须是宿主上已注册、且声明支持 `image` 输入的模型
- 只配置你实际可用的视觉模型；不要随手填不存在的 provider/model

### 4. 校验配置

```bash
openclaw config validate
```

### 5. 重启网关

```bash
systemctl --user restart openclaw-gateway.service
systemctl --user is-active openclaw-gateway.service
```

### 6. 发送一条带图片的消息做验证

验证成功时，日志中应看到类似内容：

- `webhook parsed ... attachments=1`
- `inbound attachment stored ... path=...png`
- `inbound media ready ... localFiles=1`

可用下面命令查看：

```bash
rg -n "attachments=|inbound attachment stored|inbound media ready|image failed|does not represent a valid image" /tmp/openclaw/openclaw-$(date +%F).log
```

## 落地目录说明

图片默认保存在：

```text
~/.openclaw/workspace/media/inbound/vocechat/YYYY/MM/DD/<messageId>/
```

目录内通常包含：

- 图片文件本体
- `manifest.json`

这样做的原因是：

- `OpenClaw` 内置文件工具可直接访问 workspace 内路径
- agent、OCR、后续 skill 更容易直接消费本地绝对路径
- 避免临时 URL、鉴权 URL 失效

## 已有坏会话的处理

如果旧会话里已经发生过下面两类错误：

- `Unknown model: anthropic/default`
- `400 The image data you provided does not represent a valid image`

建议清理对应 session，避免旧错误上下文继续污染后续图片对话。

处理方式：

1. 在 `~/.openclaw/agents/main/sessions/sessions.json` 找到对应 `vocechat` 会话键
2. 备份后删除该索引项
3. 将对应 `sessionFile` 移到隔离目录
4. 重新发送图片消息，让系统建立新会话

## 安全与运维规则

当前实现已经包含以下约束：

- 图片大小上限 `20MB`
- 只允许常见图片 MIME
- 文件名净化，避免非法路径字符
- 按 `messageId + manifest` 做重复复用
- 审计日志记录解析数量、落地路径、下载失败原因

## 回归验证清单

新机器更新后，至少检查下面 6 项：

1. `openclaw config validate` 通过
2. `systemctl --user is-active openclaw-gateway.service` 为 `active`
3. webhook 收到图片时日志出现 `attachments=1`
4. 本地目录出现真实 PNG/JPG 文件，而不是只有文本路径
5. 日志中不再出现 `Unknown model: anthropic/default`
6. agent 能对图片内容返回正常中文说明

## 一句结论

这次升级真正补上的，是 “VoceChat 把图片发进来之后，OpenClaw agent 能拿到本地真实图片文件” 这一段。
