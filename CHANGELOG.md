# Changelog

## Unreleased

- README 补充“从 clone 到安装完成”的最小闭环，覆盖 clone、install、doctor 与日志验证
- 安装脚本新增审批一键配置，支持把 `channels.vocechat.approvals` 与出站/入站配置一并写好
- `--public-webhook-base` 默认同时用于 webhook 输出和网页审批公网地址
- 新增 `--approval-public-base`、`--approval-route-path`、`--disable-approvals` 安装参数
- 新增 VoceChat 原生命令 `/cmd`，可直接返回 OpenClaw 自定义命令目录并支持关键字过滤
- 停止在插件侧注册保留名 `/commands` 与 `/help`，避免与系统内建命令冲突
- 新增 VoceChat 原生命令 `/transit_health`，管理员可直接检查或修复共享 transit 交付目录
- 新增 `/writerflow` 聊天命令，返回 `main` 监督 `writer` 处理小说章节的流程说明、发令模板与状态追问模板
- 新增 `/writerstatus` 聊天命令，返回 `writer` 小说监督任务的状态追问模板与常见状态释义
- 新增 `/writerreview` 聊天命令，返回要求 `main` 写具体返工意见的模板，避免空泛编审意见
- 新增 `/writerapprove` 聊天命令，返回要求 `main` 在通过编审后执行 approve 并归档正式目录的模板
- 新增 `/writertask` 聊天命令，返回要求 `main` 为章节先创建监督 task 并回报 task id/路径的模板

## 0.4.9 - 2026-03-14

- 新增 VoceChat 入站图片解析，支持从 webhook 原始包提取图片附件元信息
- 新增图片资源下载与本地落地，默认保存到 `~/.openclaw/workspace/media/inbound/vocechat/...`
- 入站投递给 agent 时附带本地绝对路径、原始文件名、MIME 与失败兜底信息
- 复用 `manifest.json` 避免同一消息重复下载附件
- 新增 `scripts/sync-to-root-extension.sh`，便于将仓库代码同步到宿主扩展目录并立即构建
- 补充中文升级文档，说明新机器如何更新宿主配置与图片模型配置

## 0.4.8 - 2026-03-08

- 新增 `management.quickTargets` 配置，支持真实快捷目标预设
- 路由卡片与账号详情页优先使用快捷目标预设，未配置时自动推断

## 0.4.7 - 2026-03-08

- 路由卡片补充 `group:` 常用目标快捷按钮
- 账号详情页新增当前账号专属快捷目标设置按钮
- 当前目标快捷按钮使用高亮样式显示

## 0.4.6 - 2026-03-08

- 路由卡片新增常用默认目标快捷设置按钮
- 管理员删除改为二次确认后执行

## 0.4.5 - 2026-03-08

- 权限卡片新增按管理员逐个删除按钮
- 删除管理员后当前卡片原地刷新

## 0.4.4 - 2026-03-08

- 修正概览卡片误挂路由复制按钮的问题

## 0.4.3 - 2026-03-08

- 修正路由、权限、Webhook 卡片按钮挂载错误
- 权限卡片直接展示管理员列表

## 0.4.2 - 2026-03-08

- 将复制命令按钮升级为主色按钮，突出可复制操作
- 为 Telegram 按钮类型补充 `style` 字段支持

## 0.4.1 - 2026-03-08

- 在路由、权限、账号详情卡片加入 Telegram 复制命令按钮
- 管理员可一键复制默认目标与管理员编辑命令模板

## 0.4.0 - 2026-03-08

- 新增管理员白名单编辑命令：`admin list|add|remove|clear`
- 新增默认目标编辑命令：`set default-to`
- 面板中补充可编辑配置的中文操作提示
- 写回宿主配置后自动触发通道热重载

## 0.3.0 - 2026-03-08

- 扩展 `/vocechatctl` 面板为多视图运维卡片
- 新增路由摘要与访问控制摘要视图
- 增强账号详情展示，补充解析模式、模板状态、白名单摘要等信息
- 保持 Telegram 按钮原地编辑与静默回调行为

## 0.2.0 - 2026-03-08

- 新增 `/vocechatctl` 管理命令
- 新增 Telegram 卡片式管理面板，按钮原地编辑
- 新增 `management.adminSenderIds` 与 `management.panelStateFile` 配置
- 新增面板状态存储与 Telegram 面板投递模块
- 补齐 `src/**/*`、`tsconfig.json`、构建脚本与依赖声明

## 0.1.0 - 2026-03-07

- 将本地 VoceChat 通道整理为标准可移植 OpenClaw 插件包
- 新增 `package.json`
- 补齐 `README.md`
- 补齐 `CHANGELOG.md`
- 新增 `config/plugin-config.example.json5`
- 将插件清单升级为完整 `configSchema` 与 `uiHints`
- 保持现有 `index.ts` 通道逻辑不变
