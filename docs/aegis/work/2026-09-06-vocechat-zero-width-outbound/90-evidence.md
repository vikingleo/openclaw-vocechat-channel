# VoceChat 零宽空消息修复 - Evidence

已记录测试、脚本语法、diff 和运行时重载证据。

## EvidenceBundleDraft

- Artifact key: npm-test-green
- Type: test
- Source: npm test && sh -n scripts/install.sh && sh -n scripts/doctor.sh && git diff --check
- Summary: 32 个测试全部通过；install.sh、doctor.sh 语法检查通过；git diff --check 通过。
- Verifier: Codex CLI

## EvidenceBundleDraft

- Artifact key: runtime-gateway-reload
- Type: runtime
- Source: systemctl --user restart openclaw-gateway.service; openclaw plugins info vocechat; journalctl --user -u openclaw-gateway.service
- Summary: gateway active；VoceChat 插件从仓库 dist/index.js 加载；webhook 路由、队列路由和 approval route 注册成功，gateway ready。
- Verifier: Codex CLI
