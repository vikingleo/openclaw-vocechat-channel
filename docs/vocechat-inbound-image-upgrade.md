# VoceChat 入站图片升级说明

本文档用于把当前仓库中的“VoceChat 图片入站 -> 本地落地 -> 规范化 -> OCR 兜底 -> agent 可识别”能力迁移到新机器。

## 变更目标

这次升级只聚焦入站媒体处理，不重做现有出站链路。

升级后，插件会：

- 从 VoceChat webhook 原始包里解析图片附件
- 把图片下载到本机 `OpenClaw workspace` 内
- 把原图再规范化成更稳定的 JPEG 副本交给 agent
- 在插件侧补一层 OCR，把可见文字提取结果一起传给 agent
- 将本地绝对路径、文件名、MIME、OCR 文本一起传给 agent
- 在下载失败时，把失败原因明确告诉 agent，而不是只传一串路径文本

## 仓库内代码改动

本次升级的核心代码在 [index.ts](../index.ts)：

- 扩展 `InboundEvent`，新增 `attachments`、`imageUrls`、`localFiles`、`originalText`
- 解析 VoceChat 图片/附件结构，兼容存储路径 `YYYY/M/D/<uuid>`
- 自动转换为 `/api/resource/file?file_path=...` 下载地址
- 下载并落地到 `~/.openclaw/workspace/media/inbound/vocechat/...`
- 额外生成 agent 友好的 JPEG 副本
- 支持本地/远程 OCR 语言包路径
- 生成“图片本体 + OCR 文本 + 失败兜底”三合一的入站正文

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

#### 可选：开启入站短窗口图文合并

如果你的 VoceChat 前端会把“文字 + 图片”拆成两条消息，建议显式开启：

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

作用：

- 同一用户在同一会话中短时间连续发出的文本和图片，会先在插件侧合并
- 最终只向 agent 触发 1 次请求，而不是先答文本、再单独处理图片

详细设计见：

- [docs/vocechat-inbound-merge-design.md](./vocechat-inbound-merge-design.md)

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

#### 推荐：显式开启规范化和 OCR

最稳妥的做法是把插件配置成“双轨”：

- 原生图片继续交给 OpenClaw 视觉链路
- OCR 文本作为稳定兜底一起给 agent

建议配置：

```json
{
  "channels": {
    "vocechat": {
      "inboundImageNormalizationEnabled": true,
      "inboundImageNormalizationMaxEdge": 2048,
      "inboundImageNormalizationQuality": 90,
      "inboundNativeVisionEnabled": false,
      "inboundOcrEnabled": true,
      "inboundOcrLangs": "chi_sim+eng",
      "inboundOcrTimeoutMs": 120000,
      "inboundOcrMaxTextLength": 3000
    }
  }
}
```

含义：

- 规范化会把图片转成更稳定的 JPEG 副本，尽量降低 provider 报“坏图”的概率
- `inboundNativeVisionEnabled: false` 表示默认走“稳定优先”模式：只要 OCR 成功，就不再把图片作为原生 `MediaPath` 注入宿主，避免当前 provider 直接以坏图报错
- OCR 会把图片中的可见文字追加到给 agent 的正文里
- 以后如果宿主原生视觉链修好，再把 `inboundNativeVisionEnabled` 改成 `true`，即可恢复“原生视觉 + OCR”双轨

#### 强烈推荐：使用本地 OCR 语言包目录

`tesseract.js` 默认远程拉语言包，但首次下载速度和稳定性都不理想。新机器上建议直接准备本地目录，再显式配置 `inboundOcrLangPath`。

推荐目录：

```text
~/.openclaw/workspace/cache/vocechat-ocr-lang
```

准备方式：

```bash
mkdir -p ~/.openclaw/workspace/cache/vocechat-ocr-lang
curl -L https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz -o ~/.openclaw/workspace/cache/vocechat-ocr-lang/eng.traineddata.gz
gzip -dc ~/.openclaw/workspace/cache/vocechat-ocr-lang/eng.traineddata.gz > ~/.openclaw/workspace/cache/vocechat-ocr-lang/eng.traineddata
curl -L https://tessdata.projectnaptha.com/4.0.0/chi_sim.traineddata.gz -o ~/.openclaw/workspace/cache/vocechat-ocr-lang/chi_sim.traineddata.gz
gzip -dc ~/.openclaw/workspace/cache/vocechat-ocr-lang/chi_sim.traineddata.gz > ~/.openclaw/workspace/cache/vocechat-ocr-lang/chi_sim.traineddata
```

然后把配置补成：

```json
{
  "channels": {
    "vocechat": {
      "inboundOcrLangPath": "/home/<你的用户名>/.openclaw/workspace/cache/vocechat-ocr-lang"
    }
  }
}
```

这样 OCR 就不会在第一张图到来时临时联网拉包。

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
- `inbound attachment normalized ... path=...jpg`
- `inbound attachment ocr ok ...`
- `inbound media ready ... localFiles=1`

可用下面命令查看：

```bash
rg -n "attachments=|inbound attachment stored|inbound attachment normalized|inbound attachment ocr|inbound media ready|image failed|does not represent a valid image" /tmp/openclaw/openclaw-$(date +%F).log
```

## 落地目录说明

图片默认保存在：

```text
~/.openclaw/workspace/media/inbound/vocechat/YYYY/MM/DD/<messageId>/
```

目录内通常包含：

- 图片原始落地文件
- 给 agent 用的 JPEG 副本
- `manifest.json`

这样做的原因是：

- `OpenClaw` 内置文件工具可直接访问 workspace 内路径
- agent、OCR、后续 skill 更容易直接消费本地绝对路径
- 避免临时 URL、鉴权 URL 失效
- 即使上游视觉 provider 偶发失败，OCR 兜底也还在

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
- OCR 文本按长度截断，避免塞爆上下文
- 审计日志记录解析数量、落地路径、下载失败原因

## 回归验证清单

新机器更新后，至少检查下面 6 项：

1. `openclaw config validate` 通过
2. `systemctl --user is-active openclaw-gateway.service` 为 `active`
3. webhook 收到图片时日志出现 `attachments=1`
4. 本地目录出现真实原图和规范化 JPEG，而不是只有文本路径
5. 日志出现 `inbound attachment normalized` 和 `inbound attachment ocr ok` 或明确的 OCR 失败原因
6. 即使视觉 provider 失败，agent 也能基于 OCR 文本给出不离题的中文说明

## 一句结论

这次升级真正补上的，是 “VoceChat 把图片发进来之后，OpenClaw agent 不但能拿到本地真实图片文件，还有一条稳定的 OCR 文字兜底” 这一段。
