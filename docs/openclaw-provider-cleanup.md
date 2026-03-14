# OpenClaw Provider 清理说明

本文档用于在新机器上移除已经废弃的 provider，并把相关运行态缓存、会话索引和历史痕迹一起清干净。

本次清理目标为：

- `free`
- `foxcode`
- `foxcodeCompany`
- `foxcodexCompanyCC`

## 变更目标

清理后应满足下面 4 点：

1. `~/.openclaw/openclaw.json` 不再声明上述 provider
2. 默认 agent 和业务 agent 不再引用上述 provider/model
3. 运行态缓存、auth profile、会话索引不再保留上述 provider 痕迹
4. 网关重启后，搜索活动目录不再命中这些 provider 名称

## 1. 修改宿主配置

编辑宿主配置文件：

```bash
${HOME}/.openclaw/openclaw.json
```

至少完成下面几项：

- 删除 `models.providers.free`
- 删除 `models.providers.foxcode`
- 删除 `models.providers.foxcodeCompany`
- 删除 `models.providers.foxcodexCompanyCC`
- 删除 `agents.defaults.models` 里对应的 provider/model 条目
- 删除各 agent 的 `primary` / `fallbacks` 中对上述 provider 的引用

推荐保留一个确定可用的视觉模型作为默认图片模型，例如：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "rightcode/gpt-5.4",
        "fallbacks": [
          "onedayai/minimax-m2-1",
          "onedayai/gpt-5.4",
          "onedayai/deepseek-3-2"
        ]
      },
      "imageModel": {
        "primary": "rightcode/gpt-5.4"
      }
    }
  }
}
```

如果某个业务 agent 原来主模型指向 `foxcodexCompanyCC/claude-opus-4-6`，可以改成：

```json
{
  "model": {
    "primary": "onedayai/claude-opus-4-6",
    "fallbacks": [
      "onedayai/gpt-5.4",
      "rightcode/gpt-5.4"
    ]
  }
}
```

## 2. 校验配置

```bash
openclaw config validate
```

只有校验通过后再做运行态清理。

## 3. 清理运行态缓存和会话

### 需要检查的目录

```text
~/.openclaw/agents/*/agent/auth-profiles.json
~/.openclaw/agents/*/agent/models.json
~/.openclaw/agents/*/sessions/sessions.json
~/.openclaw/agents/*/sessions/*.jsonl
~/.openclaw/logs/*.jsonl
~/.openclaw/cron/runs/*.jsonl
```

### 清理原则

- 不直接破坏式删除，先备份或移动到隔离目录
- 活跃会话不要原地改写历史正文，优先移除索引并隔离对应 `jsonl`
- 只清理命中废弃 provider 的文件或行

### 推荐做法

1. 先备份 `sessions.json`、`auth-profiles.json`、`models.json`
2. 从 `auth-profiles.json` 删除：
   - `foxcode:manual`
   - `foxcodeCompany:manual`
   - `foxcodexCompanyCC:manual`
3. 从 `models.json` 删除废弃 provider 条目；如果整个文件只剩这些条目，直接整体隔离
4. 从 `sessions.json` 删除引用旧 provider 的会话索引
5. 将对应 session 的 `jsonl` 历史移动到 `quarantine-YYYYMMDD-provider-clean/`
6. 对 `logs` 和 `cron/runs` 中命中旧 provider 的 `jsonl` 按行过滤，并保留 `.bak-*` 备份

可用下面命令先定位：

```bash
rg -n "free|foxcode|foxcodeCompany|foxcodexCompanyCC" \
  ~/.openclaw/agents \
  ~/.openclaw/logs \
  ~/.openclaw/cron \
  -g '!**/*.bak-*' \
  -g '!**/quarantine-*/*'
```

如果结果为空，说明活动目录已经清干净。

## 4. 重启网关

当前环境通常运行的是用户级服务，不是系统级服务，重启命令应为：

```bash
systemctl --user restart openclaw-gateway.service
systemctl --user is-active openclaw-gateway.service
```

预期状态是：

```text
active
```

## 5. 验证项

至少检查下面 5 项：

1. `openclaw config validate` 通过
2. `systemctl --user is-active openclaw-gateway.service` 返回 `active`
3. `rg` 搜索活动目录不再命中 `free|foxcode|foxcodeCompany|foxcodexCompanyCC`
4. 新会话不再继续继承旧 provider 的错误上下文
5. 图片消息和普通文本消息都能正常路由到现存 provider

## 6. 风险说明

如果某些旧会话正文里包含被删 provider 的历史记录，最稳的处理方式是隔离该会话并让系统重建新会话。

这会带来一个直接结果：

- 对应聊天上下文会被重置

这是有意为之，因为继续保留旧上下文，往往会反复触发旧 provider 或旧模型错误。

## 7. 回滚方式

如果清理后发现误删，可用下面两类材料回滚：

- `*.bak-*` 备份文件
- `quarantine-*` 隔离目录中的原始会话和缓存文件

回滚后重新执行：

```bash
systemctl --user restart openclaw-gateway.service
```

## 一句结论

这次清理不是只改一份配置，而是把废弃 provider 从 `配置 + 缓存 + 会话 + 历史日志` 四层一起摘掉，避免旧状态继续污染新请求。
