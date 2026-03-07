# Changelog

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
