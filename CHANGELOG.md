# Changelog

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
