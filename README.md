# VoceChat Channel Plugin

一个用于 `OpenClaw` 的标准可移植 `VoceChat` 通道插件。

它负责把宿主与 `VoceChat Bot API + Webhook` 连接起来，并补充管理员可用的卡片式管理面板。

## 文档索引

插件的完整文档分为「使用指南」与「设计说明」两类，按需查阅：

### 安装与使用

| 文档 | 说明 |
|------|------|
| [docs/install-update-guide.md](docs/install-update-guide.md) | **安装与更新指南**：首次安装、已安装插件升级、安装方式选择、常见问题 |
| [config/plugin-config.example.json5](config/plugin-config.example.json5) | 完整配置示例（含中文注释），配置参考第一入口 |
| [.env.example](.env.example) | 环境变量配置示例（含中文说明），按群组与全局两级配置 |
| [docs/plugin-config-example-usage.md](docs/plugin-config-example-usage.md) | 示例配置文件的使用说明：查看、复制片段、三种使用场景 |
| [docs/group-trigger-quick-summary.md](docs/group-trigger-quick-summary.md) | 群聊触发器快速总结：四种触发方式、配置优先级、快速开始 |
| [docs/group-trigger-config-upgrade.md](docs/group-trigger-config-upgrade.md) | 群聊触发器升级指南：完整升级步骤、配置示例、兼容性说明 |
| [docs/group-trigger-gate-mechanism.md](docs/group-trigger-gate-mechanism.md) | 两层门禁机制详解：插件基础门禁与触发器的协作流程 |
| [docs/gate-mechanism-supplement.md](docs/gate-mechanism-supplement.md) | 门禁机制补充说明：代码改动、配置场景示例、测试要点 |
| [docs/group-trigger-implementation-checklist.md](docs/group-trigger-implementation-checklist.md) | 实施检查清单：更新代码、构建、配置、验证的全流程清单 |

### 历史升级与设计

| 文档 | 说明 |
|------|------|
| [docs/vocechat-inbound-image-upgrade.md](docs/vocechat-inbound-image-upgrade.md) | 入站图片能力迁移：新机器升级步骤、宿主配置校正 |
| [docs/vocechat-inbound-merge-design.md](docs/vocechat-inbound-merge-design.md) | 入站图文合并设计说明：待实施升级的思路与问题定义 |
| [docs/openclaw-provider-cleanup.md](docs/openclaw-provider-cleanup.md) | OpenClaw Provider 清理说明：移除废弃 provider 及残留痕迹 |

## 当前能力

- VoceChat 出站消息发送
- VoceChat 入站 webhook 接收
- VoceChat 入站图片解析、下载与本地落地
- VoceChat 入站图片规范化为 agent 友好的 JPEG 副本
- VoceChat 入站 OCR 文字兜底
- VoceChat 入站短窗口图文合并
- VoceChat 入站执行队列与远端队列控制接口
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
3. 合法入站消息先进入插件侧执行队列，再串行进入宿主消息处理链；如已启用确认回复，则自动回一条确认消息。

### 入站图片链路

1. 插件会从 webhook 原始包中提取图片附件元信息，而不再只保留文本字段。
2. 图片资源会优先解析成真实下载 URL，并下载到 `~/.openclaw/workspace/media/inbound/vocechat/YYYY/MM/DD/<messageId>/`。
3. 插件会把原图进一步规范化成更稳定的 JPEG 副本，再把“用户文本 + agent 图片路径 + 原始文件信息”一起投递给 agent。
4. 插件会额外做一层 OCR，把可见文字提取结果写进给 agent 的正文里，但明确标注为辅助信息，不替代真实看图。
5. 在默认“稳定优先”模式下，只要 OCR 已成功，插件就不再把图片作为原生 `MediaPath` 注入，避免当前 OpenClaw/provider 的坏图报错直接打断整轮回复。
6. 下载失败时，仍会显式告诉 agent “用户发的是图片”，并附带资源 URL、失败原因与 `messageId`，避免退化成一串无意义路径字符串。

详细升级说明、新机器操作步骤与安装/更新完整指南见 [文档索引](#文档索引)。

### 队列控制接口

插件会注册 `GET /queue/status`、`POST /queue/cancel`、`POST /queue/promote-head`、`POST /queue/interrupt-run-now`、`POST /queue/skip-current`，并同时兼容 `/vocechat/queue/*` 前缀。

桌面端选中远端 VoceChat 机器人时，可以直接读取该机器人所在服务暴露的队列状态，不需要回退到本机旧队列 token 文件。当前插件能取消待执行项、提升到队首；`interrupt-run-now` 在宿主运行时暂无硬中断 hook 时会降级为“提升到队首”。`skip-current` 会从插件侧释放当前项并继续处理后续队列；宿主里已经开始的旧模型调用可能仍会继续，但该队列项的迟到回复会被丢弃。

队列当前项默认 10 分钟超时，超时后插件会标记当前项为 `timeout`、释放当前项并继续下一条。可用 `channels.vocechat.queueControl.itemTimeoutMs` 或环境变量 `VOCECHAT_QUEUE_ITEM_TIMEOUT_MS` 调整，范围为 10000 到 3600000 毫秒。

如需鉴权，可配置 `channels.vocechat.queueControl.token` 或环境变量 `VOCECHAT_QUEUE_CONTROL_TOKEN`；客户端请求可使用 `X-Queue-Control-Token`、`X-VoceChat-Queue-Token`、`Authorization: Bearer ...` 或查询参数 `token`。

### 运行事件元数据

插件发出的过程类通知会在 Markdown 正文前加入一行隐藏元数据，便于 VoceChat 客户端识别队列、审批、管理和执行过程运行事件：

```markdown
<!-- vocechat-meta:{"schema":"vocechat-run-event/v1","source":"openclaw-vocechat-channel","messageType":"queue","kind":"queue","phase":"queued","runId":"...","sequence":1,"queue_key":"...","queue_item_id":"..."} -->
已加入执行队列，当前排在第 1 位。
```

当前覆盖：入站接收确认、队列排队通知、空回复/失败兜底执行记录、审批请求/结果通知和非 Telegram 管理命令文本。聊天软件渠道不承载 OpenClaw 开发态输出流；工具开始、工具结果、命令输出、patch 摘要、计划更新、item 事件、partial reply、reasoning 状态和 block queued 等 dispatch 回调会被静默处理，最终模型回复仍通过普通回复消息发送。

### 卡片管理

1. 管理员在 Telegram 中发送 `/vocechatctl`。
2. 插件直接调用 Telegram Bot API 发送一张带按钮的管理卡片。
3. 后续点击按钮时，插件不再新发消息，而是原地编辑同一张卡片。
4. 为避免刷屏，按钮回调链路返回静默令牌，交由插件自身完成界面更新。
5. 非 Telegram 渠道执行同一命令时，自动退化为纯文本视图。

## 管理命令

- `/cmd [keyword]`
  - 返回 OpenClaw 自定义命令目录；支持按关键字或别名过滤
- `/transit_health [check|repair] [target]`
  - 管理员执行共享 `transit` 交付目录的检查或修复
- `/vocechatctl`
  - 打开概览面板
- `/writerflow`
  - 返回 `main` 监督 `writer` 处理小说章节的流程说明、发令模板与状态追问模板
- `/writerstatus`
  - 返回 `writer` 小说监督任务的状态追问模板与常见状态释义
- `/writerreview`
  - 返回要求 `main` 写具体返工意见的模板，避免空泛编审意见
- `/writerapprove`
  - 返回要求 `main` 在通过编审后执行 approve 并归档正式目录的模板
- `/writertask`
  - 返回要求 `main` 为某一章先创建监督 task 并回报 task id/路径的模板
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

`/cmd` 会优先由 VoceChat 插件原生命令处理，直接读取 OpenClaw 工作区中的命令目录脚本；不需要依赖 `main` 先接住后再转述。`/transit_health` 也由插件原生命令处理，直接执行宿主机 `transit_health.sh`。`/commands` 与 `/help` 保持交给系统内建命令，避免保留名冲突。

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

### 查看示例

**方式 1：查看完整示例文件**

仓库内提供了可直接参考的完整示例：

```bash
cat config/plugin-config.example.json5
```

**方式 2：从示例文件开始配置**

```bash
# 查看 ~/.openclaw/openclaw.json 现有配置
cat ~/.openclaw/openclaw.json

# 编辑配置，参考 config/plugin-config.example.json5 中的结构
openclaw config edit
```

### 最小配置示例

```json5
{
  channels: {
    vocechat: {
      enabled: true,
      baseUrl: "https://your-vocechat.example",
      apiKey: "<VOCECHAT_BOT_API_KEY>",
      inboundEnabled: true,
      webhookPath: "/vocechat/webhook",
      defaultTo: "user:demo",
      allowFrom: ["1"],
      groupAllowFrom: [],
      queueControl: {
        enabled: true,
        token: "<OPTIONAL_QUEUE_CONTROL_TOKEN>",
        itemTimeoutMs: 600000
      },
      management: {
        adminSenderIds: ["telegram:123456789", "vocechat:user:1"]
      }
    }
  }
}
```

注意：

- `apiKey` 是 VoceChat Bot API Key，用于 OpenClaw 调 VoceChat Bot API 发送消息，必须配置。
- `webhookApiKey` 不是 VoceChat 后台创建的 Bot API Key。VoceChat 原生 webhook 不会发送 `x-api-key`，直连时不要配置；只有经过反向代理或自定义回调转发器且会注入 `x-api-key` 时，才需要配置。
- `allowFrom` / `groupAllowFrom` 是本插件的发送者白名单，值是 VoceChat 原始 UID 字符串，例如 `"1"`；不要写成 `vocechat:user:1`。空数组表示不限制。

### 示例文件说明

`config/plugin-config.example.json5` 是完整的配置示例，包含：

- 所有通道配置项（`enabled`、`baseUrl`、`apiKey` 等）
- 群聊触发器配置（含门禁机制说明）
- 三种实际场景的完整示例（客服群、严格模式群、灵活模式群）
- 队列控制、管理面板、审批转发等其他配置
- 每个配置项的中文注释

直接复制需要的配置片段到你的 `~/.openclaw/openclaw.json` 即可。

## 一键安装与卸载

本仓库提供三个运维脚本：`install.sh`（安装/更新）、`uninstall.sh`（卸载）、`doctor.sh`（体检）。

- **首次安装**：按本文下方「从 Clone 到安装完成」或 [docs/install-update-guide.md](docs/install-update-guide.md) 完整指南执行
- **已安装更新**：见下方「更新已安装的插件」
- **完整安装/更新流程与所有参数**：[docs/install-update-guide.md](docs/install-update-guide.md)

### 更新已安装的插件

已安装插件的更新直接复用安装脚本，脚本会自动备份旧版本、覆盖插件文件并复用现有配置：

```bash
cd /path/to/openclaw-vocechat-channel
git pull --ff-only
./scripts/install.sh --yes
```

行为说明：

- **常规配置不丢**：脚本读取 `openclaw.json` 现有 `baseUrl`/`apiKey`/`defaultTo`/`allowFrom`/`groupAllowFrom` 等字段作为默认值，不带参数重跑即沿用旧值；`webhookApiKey` 例外，默认不继承旧值，只有显式传 `--webhook-api-key` 才写入，否则会清理旧字段以兼容 VoceChat 原生 webhook
- **旧版本自动备份**：覆盖前把插件目录整体备份为 `<插件目录>.bak-<时间戳>`，出问题可恢复
- **脚本自身会随更新刷新**：`install.sh` 属于仓库文件，覆盖更新时新版本自动复制到插件目录，无需手工携带
- **`--link` 安装例外**：插件目录即仓库本身时，脚本检测到路径相同会跳过文件覆盖，更新改为在仓库 `git pull` 后重跑脚本（仅刷新配置、skill 与 gateway）；若插件实际从 `~/.openclaw/extensions/vocechat` 加载，使用 `sh ./scripts/sync-to-root-extension.sh`
- **备份目录累积**：每次更新产生一个 `.bak-*`，确认稳定后可清理

更新后仍建议跑一次 `./scripts/doctor.sh` 验证。

### 从 Clone 到安装完成（首次安装）

如果你是从一台空白机器开始，建议先走一遍最小闭环：

#### 1. 克隆仓库

```bash
git clone https://github.com/vikingleo/openclaw-vocechat-channel.git
cd openclaw-vocechat-channel
chmod +x ./scripts/install.sh ./scripts/uninstall.sh ./scripts/doctor.sh
```

#### 2. 执行安装脚本

只安装插件，并直接把机器人连通与审批页面入口一起配好：

```bash
./scripts/install.sh \
  --base-url https://your-vocechat.example \
  --api-key YOUR_VOCECHAT_API_KEY \
  --default-to user:2 \
  --admin-sender-ids telegram:123456789,vocechat:user:1 \
  --public-webhook-base https://openclaw.example.com
```

如果 `VoceChat` 和 `OpenClaw` 就跑在同一台宿主机，或 `VoceChat` 跑在 Docker 容器里而 `OpenClaw` 跑在宿主机：

- `channels.vocechat.baseUrl` 优先写内部地址，例如：
  - `http://127.0.0.1:53000`
- `VoceChat Bot webhook` 也优先写内部回调地址，例如：
  - `http://172.17.0.1:18789/vocechat/webhook`
  - 或 `http://127.0.0.1:18789/vocechat/webhook`
- 不建议把 Bot webhook 配成 `https://server.example.com/vocechat/webhook` 这种公网域名回环地址

原因：

- 机器内部回调不需要经过公网 DNS、NAT 回环或 1Panel/OpenResty
- 故障点更少，也更容易排查
- 真正需要保留公网的，通常只有“给人点击”的网页入口，例如审批页 `approvals.publicBaseUrl`

如果你还想在同一轮里把本机 `vocechat-server` 也装好：

```bash
./scripts/install.sh \
  --install-server \
  --server-bin /path/to/vocechat-server.bin \
  --base-url http://127.0.0.1:3000
```

#### 3. 检查安装结果

先跑体检脚本：

```bash
./scripts/doctor.sh
```

再看最近网关日志：

```bash
journalctl --user -u openclaw-gateway.service -n 120 --no-pager | rg 'vocechat|approval'
```

如果你已经把 webhook 指向 OpenClaw，还可以在 VoceChat 里直接发送：

```text
/vocechatctl webhook
```

你应该至少能确认这几件事：

- `channels.vocechat` 已写入宿主配置
- `channels.vocechat.approvals` 已按参数生成
- 日志里出现 `approval route registered` 或 `approval forwarder enabled`
- `doctor.sh` 不再提示插件未安装或配置缺失

走完这一步，就算完整完成了“clone -> 安装 -> 验证”。

当前仓库现在提供专业化安装/卸载脚本：

```bash
chmod +x ./scripts/install.sh ./scripts/uninstall.sh ./scripts/doctor.sh
./scripts/install.sh
```

卸载：

```bash
./scripts/uninstall.sh
```

安装脚本会处理：

- 可选安装或升级本机 `vocechat-server`
- 可选写入 `systemd` 服务单元并自动启动
- 调用 `openclaw plugins install` 安装插件
- 自动补装插件 runtime 依赖，避免 `Cannot find module undici`
- 写入或更新 `channels.vocechat` 本地配置
- 自动补齐 `channels.vocechat.approvals`，让聊天内审批转发与网页审批链接可直接生效
- 启用插件条目与 `vocechat-send` skill 条目
- 将 `vocechat-send` 安装到 `~/.openclaw/skills/vocechat-send`
- 可选自动重启 `openclaw gateway`

常用安装示例：

```bash
./scripts/install.sh \
  --base-url https://your-vocechat.example \
  --api-key YOUR_VOCECHAT_API_KEY \
  --default-to user:2 \
  --admin-sender-ids telegram:123456789 \
  --public-webhook-base https://openclaw.example.com
```

同时安装本机 VoceChat 服务端，并从制品 URL 升级到你自己的二进制：

```bash
./scripts/install.sh \
  --install-server \
  --server-bin-url https://artifacts.example.com/vocechat/vocechat-server.bin \
  --server-bin-sha256 YOUR_SHA256 \
  --base-url http://127.0.0.1:3000
```

如果你已经有本地二进制文件：

```bash
./scripts/install.sh \
  --install-server \
  --server-bin /root/.openclaw/media/vocechat-server.bin \
  --base-url http://127.0.0.1:3000
```

如果未提供 `--server-bin` 或 `--server-bin-url`：

- 交互模式下，安装脚本会主动询问：
  - 使用官方 `sh.voce.chat`
  - 还是使用本地已下载的 `vocechat-server.bin`
- 如果检测到当前机器已有 VoceChat 安装或数据目录，默认会引导你选择本地二进制，并对官方源额外做一次风险确认
- 非交互模式下，若检测到已有安装/数据而你又没显式提供二进制来源，脚本会直接拒绝继续，避免把旧版官方二进制覆盖到已迁移的数据上

只有在“全新空目录”场景下，未指定制品来源时才建议回退到官方 `sh.voce.chat` 的 zip 包。

如果要使用 link 模式安装当前仓库：

```bash
./scripts/install.sh --link
```

### 推荐流程

如果你是在一台全新机器上首次部署，建议按这个顺序做：

1. 先安装 VoceChat 服务端和插件骨架

```bash
./scripts/install.sh \
  --install-server \
  --server-bin-url https://artifacts.example.com/vocechat/vocechat-server.bin \
  --server-bin-sha256 YOUR_SHA256 \
  --base-url http://127.0.0.1:3000
```

2. 登录 VoceChat 完成初始化，创建或查看 Bot API Key

3. 再次执行安装脚本，把 `apiKey` 补齐并启用出站通路

```bash
./scripts/install.sh \
  --base-url http://127.0.0.1:3000 \
  --api-key YOUR_VOCECHAT_API_KEY \
  --default-to user:2 \
  --admin-sender-ids telegram:123456789,vocechat:user:1 \
  --public-webhook-base https://openclaw.example.com
```

4. 如需入站 webhook，再配置公网 HTTPS 和反向代理

如果你希望安装完成后就直接具备“VoceChat 机器人连通 + 聊天内网页审批”这类和本机同等级的效果，至少补这几项：

```bash
./scripts/install.sh \
  --base-url https://your-vocechat.example \
  --api-key YOUR_VOCECHAT_API_KEY \
  --default-to user:2 \
  --admin-sender-ids telegram:123456789,vocechat:user:1 \
  --public-webhook-base https://openclaw.example.com
```

说明：

- `--public-webhook-base` 现在默认同时用于：
  - 安装完成后的 webhook URL 输出
  - `channels.vocechat.approvals.publicBaseUrl`
- 如果你的 `VoceChat` webhook 实际走的是容器到宿主机内部地址，例如 `http://172.17.0.1:18789/vocechat/webhook`，这完全正常；`--public-webhook-base` 仍然只需要用于“对外展示的 URL”和审批网页公网入口
- 如需把审批网页挂到另一个公网地址，可额外传：
  - `--approval-public-base https://approval.example.com`
  - `--approval-route-path /vocechat/approval`
- 若明确不想启用审批转发，可传：
  - `--disable-approvals`

健康检查：

```bash
./scripts/doctor.sh
```

如果你是在当前仓库里直接改插件代码，并且宿主实际加载的是 `~/.openclaw/extensions/vocechat`，可以用下面这个同步脚本把仓库代码覆盖到宿主扩展目录后立即构建：

```bash
sh ./scripts/sync-to-root-extension.sh
```

卸载插件并移除 VoceChat 服务单元：

```bash
./scripts/uninstall.sh --uninstall-server
```

如果还要连数据目录一起删：

```bash
./scripts/uninstall.sh --uninstall-server --remove-server-data
```

### 常见安装场景

只安装插件，不安装本机 VoceChat 服务端：

```bash
./scripts/install.sh \
  --base-url https://your-vocechat.example \
  --api-key YOUR_VOCECHAT_API_KEY
```

安装本机 VoceChat，并使用本地二进制：

```bash
./scripts/install.sh \
  --install-server \
  --server-bin /absolute/path/vocechat-server.bin \
  --base-url http://127.0.0.1:3000
```

安装本机 VoceChat，但暂时不写 systemd：

```bash
./scripts/install.sh \
  --install-server \
  --server-bin-url https://artifacts.example.com/vocechat/vocechat-server.bin \
  --server-service-scope none \
  --base-url http://127.0.0.1:3000
```

安装插件，但不写 managed skill：

```bash
./scripts/install.sh \
  --base-url https://your-vocechat.example \
  --api-key YOUR_VOCECHAT_API_KEY \
  --skill-scope none
```

### 是否能一键完全打通

结论分两部分：

- 对 OpenClaw 本地侧
  - 可以基本一键完成：VoceChat 二进制安装、systemd 托管、插件安装、宿主配置、skill 安装、`undici` 依赖处理、gateway 重启都能脚本化
- 对 VoceChat webhook 外部回调链路
  - 不能仅靠本地脚本 100% 保证完全打通
  - 原因是还依赖：
    - OpenClaw 所在机器是否有可公网访问的 HTTPS 地址或反向代理
    - VoceChat 服务端是否已把 webhook 指向该公开地址

也就是说：

- 纯出站（OpenClaw -> VoceChat 发消息/附件）可以一键配完
- 入站 webhook（VoceChat -> OpenClaw）会写入 OpenClaw 本地路由；默认不写 `webhookApiKey`，因为 VoceChat 原生 webhook 不会携带 `x-api-key`
- 审批转发与网页审批链接，也能随安装脚本一起写入 `channels.vocechat.approvals`
- 但公网入口和 VoceChat 端 webhook 指向，仍然属于外部部署步骤

还有一个现实限制：

- 首次全新安装 VoceChat 服务端时，`Bot API Key` 往往要在 VoceChat 初始化完成后才能拿到
- 因此 `install.sh` 在拿不到 `apiKey` 时，会先完成服务端 + 插件骨架安装，并把 `channels.vocechat.enabled` 保持为关闭
- 拿到 `apiKey` 后，重新执行一次 `./scripts/install.sh --api-key ...` 即可补全出站配置

### 关于二进制分发

支持把 Docker 导出的 `vocechat-server.bin` 接到 `install.sh` 流程里，但不建议把该二进制直接提交到公开 GitHub 仓库：

- 公开仓库存放二进制不利于版本治理和校验
- 还会引入分发、许可和后续维护风险

更稳妥的方式是：

- 放到你自己的制品仓库、私有 Release 或对象存储
- 用 `--server-bin-url` + `--server-bin-sha256` 安装

## Doctor 使用说明

`doctor.sh` 用来快速判断当前机器到底差在哪一层：

```bash
./scripts/doctor.sh
```

输出约定：

- `OK`
  - 该检查项已通过
- `WARN`
  - 不一定阻塞，但通常意味着功能不完整，或还没做完对应部署
- `FAIL`
  - 明确阻塞，需要先修复

典型检查项包括：

- `channels.vocechat.baseUrl` / `apiKey`
- 插件是否已安装
- 插件 runtime 依赖 `undici` 是否存在
- `vocechat-send` skill 是否已注册
- 本机 `vocechat-server` 二进制是否存在
- `systemd` 服务是否存在、已启用、运行中

常见结果解释：

- `managed skill 目录不存在`
  - 说明你还没跑过 `install.sh`，或安装时用了 `--skill-scope none`
- `VoceChat 服务端二进制不存在`
  - 说明当前机器没有走 `--install-server`，或者服务端安装目录不是默认路径
- `VoceChat systemd 服务未运行`
  - 说明 unit 已写但服务没起来，通常需要 `systemctl status vocechat.service` 进一步看日志
- `channels.vocechat.apiKey 缺失`
  - 说明插件骨架已经装了，但 Bot API Key 还没补齐，出站发送会不可用
- `VoceChat webhookApiKey 已配置`
  - 只有反向代理或自定义回调会注入 `x-api-key` 时才需要；直连 VoceChat 原生 webhook 时应删除该字段

如果你的服务名或安装目录不是默认值，可以显式传参：

```bash
./scripts/doctor.sh \
  --server-install-dir /opt/vocechat \
  --server-service-name vocechat
```

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

常见示例：

```bash
./scripts/send-vocechat-attachment.sh /path/to/report.pdf
sh ./scripts/vocechat-send.sh --to user:2 --text "处理完成"
sh ./scripts/vocechat-send.sh --to group:5 --text "日报见附件" --file /path/to/report.pdf
sh ./scripts/vocechat-send.sh --to user:2 --file https://example.com/report.pdf
```

## OpenClaw Agent Skill

插件现在内置了一个可给 OpenClaw agent 使用的 skill：

- `skills/vocechat-send`

它的用途是让 agent 直接向 VoceChat 发送文本或附件，而不是临时手写 `curl`。

skill 的底层调用脚本是：

```bash
sh scripts/vocechat-send.sh --to user:2 --text "已处理完成"
sh scripts/vocechat-send.sh --to user:2 --text "附件见下" --file /path/to/report.pdf
```

安装脚本默认会把这个 skill 同步到：

```bash
~/.openclaw/skills/vocechat-send
```

这样 OpenClaw agent 可以把它当作 managed skill 直接发现和使用。

## 卸载说明

只卸载插件与 skill，保留服务端：

```bash
./scripts/uninstall.sh
```

卸载插件并停掉 VoceChat `systemd` 服务，但保留目录和数据：

```bash
./scripts/uninstall.sh --uninstall-server --keep-server-files
```

完全移除插件、服务单元和数据目录：

```bash
./scripts/uninstall.sh --uninstall-server --remove-server-data
```

如果你只想停用插件，但保留原有 `channels.vocechat` 配置：

```bash
./scripts/uninstall.sh --keep-channel-config
```

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
- `webhookPath`
  - OpenClaw 接收 VoceChat webhook 的本地路径，默认 `/vocechat/webhook`
- `webhookApiKey`
  - 可选反向代理/自定义回调鉴权；VoceChat 原生 webhook 不会发送 `x-api-key`，直连时应留空
- `inboundAckEnabled` / `inboundAckText`
  - 是否发送入站确认及确认内容
- `allowFrom` / `groupAllowFrom`
  - 本插件的私聊和群聊发送者白名单，填写 VoceChat 原始 UID 字符串，例如 `"1"`
- `queueControl.itemTimeoutMs`
  - 入站执行队列当前项超时时间，默认 600000 ms
- `accounts`
  - 多账号配置
- `management.adminSenderIds`
  - 管理员发送者白名单
- `management.panelStateFile`
  - Telegram 面板状态存储文件
- `groups`
  - 群聊配置（支持按群组单独配置触发器）

## 群聊触发器配置

插件支持灵活配置群聊消息触发机器人回复的条件，提供四种触发方式。

### 门禁优先级

**重要**：群聊回复遵循两层门禁机制：

```
第一层：VoceChat 插件基础配置（首要门禁）
  ↓ 通过后
第二层：插件触发器配置（细化控制）
```

#### 第一层门禁：VoceChat 插件基础配置

以下 `channels.vocechat` 插件配置作为首要条件，必须先满足：

1. **`requireMention`**（最高优先级）
   - 如果插件设置 `requireMention: true`，则**必须原生 @ 机器人**才能触发
   - 此时插件的所有其他触发器（文本匹配、问句等）都会被忽略
   - 只有插件未设置或设置为 `false` 时，才进入触发器评估

2. **`groupPolicy`**
   - 插件的群组策略设置

3. **`groupAllowFrom`**
   - 插件的群聊发送者白名单，填写 VoceChat 原始 UID 字符串，例如 `"1"`

**配置位置**：
```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        "12345": {
          "enabled": true,
          "requireMention": false,  // ← VoceChat 插件基础配置（第一层门禁）
          "triggers": {             // ← 插件触发器配置（第二层门禁）
            "nativeMention": true,
            "textMention": true,
            // ...
          }
        }
      }
    }
  }
}
```

#### 第二层门禁：插件触发器配置

只有在通过第一层门禁后，才会评估插件的触发器配置：

### 触发方式

1. **原生 @ 机器人**（`nativeMention`）
   - 用户在群聊中通过 VoceChat 原生 @ 功能提及机器人
   - 默认：`true`

2. **文本名称匹配**（`textMention`）
   - 消息中包含机器人名称、昵称或自定义关键词
   - 支持配置 `mentionPatterns` 自定义匹配模式
   - 默认：`true`

3. **问句自动触发**（`questionAuto`）
   - 自动识别疑问句（包含 `?`、`？`、`吗`、`呢` 等）
   - 默认：`true`

4. **回复机器人消息**（`replyToBot`）
   - 用户回复/引用机器人的消息时触发（实验性功能）
   - 需要 VoceChat webhook 支持 `reply_to` 字段
   - 默认：`false`

### JSON 配置示例

**配置位置**：`~/.openclaw/openclaw.json`

**使用方式**：

```bash
# 方式 1：从示例文件复制配置片段
# 查看完整示例
cat config/plugin-config.example.json5

# 复制需要的配置到 ~/.openclaw/openclaw.json
vim ~/.openclaw/openclaw.json

# 方式 2：使用 openclaw CLI 编辑（推荐）
openclaw config edit
```

**配置示例**：

```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        // 默认配置（适用于所有未单独配置的群）
        "*": {
          "triggers": {
            "nativeMention": true,      // 启用 @ 触发
            "textMention": true,        // 启用文本匹配
            "questionAuto": false,      // 关闭问句自动触发
            "replyToBot": false,        // 关闭回复触发
            "mentionPatterns": ["小助手", "AI", "机器人"],  // 自定义匹配词
            "mentionPatternsMode": "append"  // append: 追加到系统默认 | replace: 替换系统默认
          }
        },
        
        // 特定群聊配置（群 ID: 12345）
        "12345": {
          "triggers": {
            "nativeMention": true,
            "textMention": false,
            "questionAuto": false,
            "replyToBot": true,
            "mentionPatterns": ["客服", "帮助"],
            "mentionPatternsMode": "replace"
          }
        }
      }
    }
  }
}
```

**完整配置示例**：参考 `config/plugin-config.example.json5`，包含：
- 门禁机制详细说明
- 三种实际场景的完整配置
- 所有配置项的中文注释

### 环境变量配置

插件支持通过 `.env` 文件配置群聊触发器，环境变量优先级高于 JSON 配置。

**配置文件**：
```bash
# 复制示例文件
cp .env.example .env

# 编辑配置
vim .env
```

**默认配置（适用于所有群）**：
```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=true
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
VOCECHAT_GROUP_DEFAULT_REPLY_TO_BOT=false
VOCECHAT_GROUP_DEFAULT_MENTION_PATTERNS=小助手,AI,机器人
VOCECHAT_GROUP_DEFAULT_MENTION_PATTERNS_MODE=append
```

**特定群组配置**：
```bash
# 群组 12345 的配置
VOCECHAT_GROUP_12345_NATIVE_MENTION=true
VOCECHAT_GROUP_12345_TEXT_MENTION=false
VOCECHAT_GROUP_12345_QUESTION_AUTO=false
VOCECHAT_GROUP_12345_MENTION_PATTERNS=客服,帮助
```

**全局简化配置**：
```bash
# 适用于所有群组的全局配置
VOCECHAT_TRIGGER_NATIVE_MENTION=true
VOCECHAT_TRIGGER_TEXT_MENTION=true
VOCECHAT_TRIGGER_QUESTION_AUTO=false
VOCECHAT_MENTION_PATTERNS=小助手,AI
```

### 配置优先级

```
环境变量（群组特定） > 环境变量（默认） > 环境变量（全局） > JSON 配置 > 代码默认值
```

具体规则：
1. `VOCECHAT_GROUP_{群组ID}_*` 优先级最高
2. 如果没有，使用 `VOCECHAT_GROUP_DEFAULT_*`
3. 如果还没有，使用 `VOCECHAT_TRIGGER_*` 或 `VOCECHAT_MENTION_PATTERNS`
4. 如果还没有，使用 JSON 配置中的 `groups[群组ID]` 或 `groups["*"]`
5. 最后使用代码默认值

### 常见场景配置

**场景 1：严格模式（只响应明确 @）**
```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=false
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
VOCECHAT_GROUP_DEFAULT_REPLY_TO_BOT=false
```

**场景 2：主动模式（响应所有疑问）**
```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=true
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=true
VOCECHAT_GROUP_DEFAULT_REPLY_TO_BOT=true
```

**场景 3：客服模式（多种触发 + 自定义关键词）**
```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=true
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
VOCECHAT_GROUP_DEFAULT_REPLY_TO_BOT=true
VOCECHAT_GROUP_DEFAULT_MENTION_PATTERNS=客服,帮助,咨询,报修
VOCECHAT_GROUP_DEFAULT_MENTION_PATTERNS_MODE=append
```

**场景 4：混合模式（不同群组不同策略）**
```bash
# 默认：只响应 @
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=false

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

### 调试触发器

如需调试触发器行为，可以查看日志：

```bash
journalctl --user -u openclaw-gateway.service -f | grep "group trigger"
```

关键日志标识：
- `group trigger activated` - 触发器激活
- `skip group event: no reply trigger` - 未触发（包含原因）
- `reason=native-mention` - 触发原因为原生 @
- `reason=text-mention` - 触发原因为文本匹配
- `reason=question` - 触发原因为疑问句
- `reason=reply-to-bot` - 触发原因为回复机器人消息

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
