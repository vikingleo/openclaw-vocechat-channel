# VoceChat Channel Plugin

一个用于 `OpenClaw` 的标准可移植 `VoceChat` 通道插件。

它负责把宿主与 `VoceChat Bot API + Webhook` 连接起来，并补充管理员可用的卡片式管理面板。

## 当前能力

- VoceChat 出站消息发送
- VoceChat 入站 webhook 接收
- VoceChat 入站图片解析、下载与本地落地
- VoceChat 入站图片规范化为 agent 友好的 JPEG 副本
- VoceChat 入站 OCR 文字兜底
- VoceChat 入站短窗口图文合并
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

### 入站图片链路

1. 插件会从 webhook 原始包中提取图片附件元信息，而不再只保留文本字段。
2. 图片资源会优先解析成真实下载 URL，并下载到 `~/.openclaw/workspace/media/inbound/vocechat/YYYY/MM/DD/<messageId>/`。
3. 插件会把原图进一步规范化成更稳定的 JPEG 副本，再把“用户文本 + agent 图片路径 + 原始文件信息”一起投递给 agent。
4. 插件会额外做一层 OCR，把可见文字提取结果写进给 agent 的正文里，但明确标注为辅助信息，不替代真实看图。
5. 在默认“稳定优先”模式下，只要 OCR 已成功，插件就不再把图片作为原生 `MediaPath` 注入，避免当前 OpenClaw/provider 的坏图报错直接打断整轮回复。
6. 下载失败时，仍会显式告诉 agent “用户发的是图片”，并附带资源 URL、失败原因与 `messageId`，避免退化成一串无意义路径字符串。

详细升级说明与新机器操作步骤见：

- [docs/vocechat-inbound-image-upgrade.md](docs/vocechat-inbound-image-upgrade.md)
- [docs/openclaw-provider-cleanup.md](docs/openclaw-provider-cleanup.md)
- [docs/vocechat-inbound-merge-design.md](docs/vocechat-inbound-merge-design.md)

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

## 一键安装与卸载

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
- 启用插件条目与 `vocechat-send` skill 条目
- 将 `vocechat-send` 安装到 `~/.openclaw/skills/vocechat-send`
- 可选自动重启 `openclaw gateway`

常用安装示例：

```bash
./scripts/install.sh \
  --base-url https://your-vocechat.example \
  --api-key YOUR_VOCECHAT_API_KEY \
  --default-to user:2 \
  --admin-sender-ids telegram:123456789
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
  --default-to user:2
```

4. 如需入站 webhook，再配置公网 HTTPS 和反向代理

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
- 入站 webhook（VoceChat -> OpenClaw）能把 OpenClaw 本地路由和鉴权一次配好
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
