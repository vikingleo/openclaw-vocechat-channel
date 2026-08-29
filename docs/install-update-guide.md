# 安装与更新指南

本文档覆盖插件的完整生命周期：**首次安装**、**日常更新**、**安装方式差异**与**常见问题**。

相关脚本均位于仓库 `scripts/` 目录，使用前先赋予执行权限：

```bash
chmod +x ./scripts/install.sh ./scripts/uninstall.sh ./scripts/doctor.sh
```

---

## 1. 安装方式总览

| 安装方式 | 命令 | 插件文件位置 | 适用场景 |
|---------|------|-------------|---------|
| 复制安装（默认） | `./scripts/install.sh` | OpenClaw 托管目录 | 大多数用户，更新时脚本自动覆盖 |
| 链接安装 | `./scripts/install.sh --link` | 直接指向本仓库 | 开发者，改完代码即时生效 |

两种方式下，安装脚本都会：

- 写入/更新 `channels.vocechat` 本地配置（`~/.openclaw/openclaw.json`）
- 启用插件条目与 `vocechat-send` skill 条目
- 将 `vocechat-send` 安装到 `~/.openclaw/skills/vocechat-send`
- 自动补装插件 runtime 依赖 `undici`
- 默认重启 `openclaw gateway`

---

## 2. 首次安装（全新机器）

### 2.1 准备

- 已安装 OpenClaw 主程序（`openclaw` 命令可用）
- 已有一个 VoceChat 服务端（本机、Docker 或远程），并拿到 Bot API Key
  - 若还未初始化 VoceChat：先执行 `--install-server` 装服务端，初始化拿到 API Key 后再执行一次补全（见 2.5）
- 运行安装脚本的用户必须能读写 OpenClaw 配置文件（默认 `~/.openclaw/openclaw.json`）；例如该文件权限应至少允许文件属主写入，推荐使用 `600`

如果配置文件当前是只读的，例如权限为 `400`，先修复权限再运行安装器：

```bash
chmod 600 ~/.openclaw/openclaw.json
```

不要使用 `sudo ./scripts/install.sh` 代替权限修复；这可能让配置备份、插件目录或 OpenClaw 运行环境归属到错误用户。

### 2.2 克隆仓库

```bash
git clone https://github.com/vikingleo/openclaw-vocechat-channel.git
cd openclaw-vocechat-channel
chmod +x ./scripts/install.sh ./scripts/uninstall.sh ./scripts/doctor.sh
```

### 2.3 只安装插件（服务端已在别处）

```bash
./scripts/install.sh \
  --base-url https://your-vocechat.example \
  --api-key YOUR_VOCECHAT_API_KEY \
  --default-to user:2 \
  --admin-sender-ids telegram:123456789,vocechat:user:1 \
  --public-webhook-base https://openclaw.example.com
```

参数说明：

| 参数 | 必填 | 说明 |
|------|------|------|
| `--base-url` | 是 | VoceChat 服务地址 |
| `--api-key` | 是 | VoceChat Bot API Key |
| `--default-to` | 否 | 默认发送目标，如 `user:2` / `group:5` / 纯数字 |
| `--allow-from` | 否 | 私聊白名单（逗号分隔），填写 VoceChat 原始 UID，如 `1` |
| `--group-allow-from` | 否 | 群聊白名单（逗号分隔），填写 VoceChat 原始 UID，如 `1` |
| `--admin-sender-ids` | 否 | 插件管理员白名单（逗号分隔） |
| `--public-webhook-base` | 否 | OpenClaw 公网基础地址（用于 webhook 输出与审批网页链接） |
| `--webhook-api-key` | 否 | 可选反代/自定义回调鉴权密钥。VoceChat 原生 webhook 不会发送 `x-api-key`，直连时不要配置 |
| `--disable-approvals` | 否 | 关闭审批转发/网页审批配置 |
| `--disable-inbound` | 否 | 只配置出站，不启用 webhook 入站 |
| `--skill-scope` | 否 | `managed`（默认）或 `none`（不装 skill） |

### 2.4 首次安装时同时装本机 VoceChat 服务端

推荐使用本地二进制（`--server-bin`）而非官方 shell 源，避免旧版二进制与数据库迁移不兼容：

```bash
./scripts/install.sh \
  --install-server \
  --server-bin /path/to/vocechat-server.bin \
  --base-url http://127.0.0.1:3000
```

或从制品 URL 安装：

```bash
./scripts/install.sh \
  --install-server \
  --server-bin-url https://artifacts.example.com/vocechat/vocechat-server.bin \
  --server-bin-sha256 YOUR_SHA256 \
  --base-url http://127.0.0.1:3000
```

安全保护：

- 非交互模式下，若检测到本机已有 VoceChat 安装/数据目录，而你又没有显式提供二进制来源，脚本会拒绝继续（避免官方源旧版覆盖已迁移数据）
- 交互模式下会引导选择本地二进制，并对官方源做一次确认

### 2.5 分两步安装（先骨架，后补 Key）

首次安装服务端时往往还拿不到 Bot API Key。可以分两步：

```bash
# 第 1 步：装服务端 + 插件骨架（channels.vocechat.enabled 保持关闭）
./scripts/install.sh \
  --install-server \
  --server-bin /path/to/vocechat-server.bin \
  --base-url http://127.0.0.1:3000

# 第 2 步：在 VoceChat 里初始化并创建 Bot API Key 后，补全出站配置
./scripts/install.sh \
  --base-url http://127.0.0.1:3000 \
  --api-key YOUR_VOCECHAT_API_KEY \
  --default-to user:2
```

第 2 步无需重传第 1 步的服务端参数——脚本会复用 `openclaw.json` 里已有的配置。

### 2.6 验证安装

```bash
./scripts/doctor.sh
```

预期结果：`channels.vocechat` 配置存在、插件已安装、runtime 依赖就绪、skill 已注册。

再检查网关日志（服务名为 user 或 system 取决于安装方式）：

```bash
journalctl --user -u openclaw-gateway.service -n 120 --no-pager | rg 'vocechat|approval'
```

在 VoceChat 里发送 `/vocechatctl webhook` 确认 webhook 路由注册成功。

`--api-key` 和 `--webhook-api-key` 的用途不同：`--api-key` 是 VoceChat Bot API Key，用于 OpenClaw 向 VoceChat 发送消息；`--webhook-api-key` 是插件接收入站 webhook 时要求请求携带的 `x-api-key`。VoceChat 管理界面的原生 webhook 不能配置自定义 `x-api-key` 请求头，所以直连时不要设置 `--webhook-api-key`。

---

## 3. 更新已安装的插件

### 3.1 更新前须知

- **常规配置不会丢**：脚本会先读取 `openclaw.json` 里已有的 `baseUrl`/`apiKey`/`defaultTo`/`allowFrom`/`groupAllowFrom` 等字段作为默认值，不带参数重跑就会沿用旧值。`webhookApiKey` 例外，默认不继承旧值；只有显式传 `--webhook-api-key` 才会写入，否则会清理旧字段以兼容 VoceChat 原生 webhook。
- **旧版本自动备份**：更新前脚本会把当前插件目录整体备份为 `<插件目录>.bak-<时间戳>`，出问题可回退。
- **脚本自身会被刷新**：`install.sh` 属于仓库文件，覆盖更新时新版本脚本会随仓库一起复制到插件目录，无需手工携带。
- **增量 `.bak-*` 会累积**：每次更新产生一个备份目录，确认稳定后可清理。

### 3.2 标准更新流程（复制安装）

```bash
cd /path/to/openclaw-vocechat-channel
git pull --ff-only
./scripts/install.sh --yes
```

`--yes` 用于跳过交互确认；脚本会：

1. 通过 `openclaw plugins info vocechat` 定位已安装插件目录
2. 备份现有插件目录为 `.bak-<时间戳>`
3. 用仓库内容覆盖插件目录（保留 `.git` 与 `node_modules` 之外的全部文件）
4. 重新装 runtime 依赖、同步 skill、更新配置、重启 gateway

若本次更新涉及配置变更（如群聊触发器），更新后检查：

```bash
cat ~/.openclaw/openclaw.json | grep -A 20 '"vocechat"' | head -40
```

### 3.3 链接安装的更新流程

如果当初用 `--link` 安装，插件目录就是本仓库，`install.sh` 会检测到路径相同并**跳过文件覆盖**。此时更新方式：

```bash
cd /path/to/openclaw-vocechat-channel
git pull --ff-only
./scripts/install.sh --yes   # 仍可跑：用于刷新配置、skill 与 gateway
```

若插件实际从 `~/.openclaw/extensions/vocechat` 加载（非默认托管目录），用同步脚本：

```bash
sh ./scripts/sync-to-root-extension.sh
```

### 3.4 更新后的验证

```bash
./scripts/doctor.sh
# 常见问题修复：
# - "managed skill 目录不存在" → 安装时用了 --skill-scope none，或从未跑过 install.sh
# - "VoceChat systemd 服务未运行" → systemctl status vocechat.service
# - "channels.vocechat.apiKey 缺失" → 补 Key：./scripts/install.sh --api-key ...
```

---

## 4. 安装方式选择建议

| 场景 | 推荐方式 |
|------|---------|
| 生产服务器，跑稳定版 | 复制安装（默认），更新时 `git pull` + `install.sh --yes` |
| 开发机，频繁改插件代码 | 链接安装（`--link`），或使用 `sync-to-root-extension.sh` |
| 不想装 managed skill | `install.sh --skill-scope none` |
| 只想配出站、不接收消息 | `install.sh --disable-inbound` |
| 插件与 OpenClaw 不同机 | 复制安装 + `--public-webhook-base` 配公网回调用 |

---

## 5. 常见问题

**Q: 更新后插件启动失败，报 `Cannot find module undici`？**
A: 插件目录被人工改动过或依赖未装。运行 `install.sh --yes` 会自动重装 runtime 依赖。

**Q: 更新后配置丢了？**
A: 检查 `.bak-<时间戳>` 备份目录并恢复；确认是否是 `--link` 安装跳过了文件覆盖。

**Q: 更新是否需要先 `npm run build`？**
A: 不需要。插件加载入口是 `index.ts`，由 OpenClaw 在运行时加载；`dist/` 目录仅用于本地开发调试。

**Q: 更新时是否会把自定义文件覆盖掉？**
A: 会。更新会清空插件目录再复制仓库内容，插件目录内的手工文件会在备份目录中保留。插件配置一律放在 `~/.openclaw/openclaw.json` 或 `.env`，不要放在插件目录内。

**Q: 检测到旧版本 daemon 配置文件残留？**
A: 参见 [vocechat-inbound-image-upgrade.md](./vocechat-inbound-image-upgrade.md) 的迁移步骤。
