# 群聊触发器配置功能 - 快速总结

## ✅ 已实现的功能

### 1. 四种可配置触发器

| 触发方式 | 配置键 | 默认值 | 说明 |
|---------|--------|--------|------|
| 原生 @ 机器人 | `nativeMention` | ✅ true | VoceChat 原生 @ 提及 |
| 文本名称匹配 | `textMention` | ✅ true | 消息中包含机器人名称/自定义关键词 |
| 问句自动触发 | `questionAuto` | ✅ true | 自动识别疑问句 |
| 回复机器人消息 | `replyToBot` | ❌ false | 回复/引用触发（预留，需验证 webhook 支持）|

### 2. 灵活配置方式

- ✅ JSON 配置文件
- ✅ 环境变量配置（优先级更高）
- ✅ 按群组单独配置
- ✅ 自定义文本匹配关键词
- ✅ 两种匹配模式（追加/替换）

### 3. 完整的文档和示例

- ✅ `.env.example` - 详细的环境变量配置示例（带中文说明）
- ✅ `plugin-config.example.json5` - 更新的 JSON 配置示例
- ✅ `README.md` - 完整的使用说明
- ✅ `docs/group-trigger-config-upgrade.md` - 详细的升级说明

## 🚀 快速开始

### 使用环境变量配置（推荐）

```bash
# 1. 复制示例文件
cp .env.example .env

# 2. 编辑配置
vim .env

# 3. 示例：严格模式（只响应 @）
cat > .env << 'EOF'
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=false
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
VOCECHAT_GROUP_DEFAULT_REPLY_TO_BOT=false
EOF

# 4. 重启 OpenClaw
openclaw gateway restart
```

### 使用 JSON 配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  "channels": {
    "vocechat": {
      "groups": {
        "*": {
          "triggers": {
            "nativeMention": true,
            "textMention": false,
            "questionAuto": false,
            "replyToBot": false
          }
        }
      }
    }
  }
}
```

## 📊 配置优先级

```
环境变量(群组) > 环境变量(默认) > 环境变量(全局) > JSON配置 > 代码默认值
```

## 🔍 常见配置场景

### 场景 1: 严格模式（只响应 @）

```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=false
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
```

### 场景 2: 主动模式（响应所有疑问）

```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=true
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=true
```

### 场景 3: 客服模式（多触发 + 自定义关键词）

```bash
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=true
VOCECHAT_GROUP_DEFAULT_QUESTION_AUTO=false
VOCECHAT_GROUP_DEFAULT_MENTION_PATTERNS=客服,帮助,咨询,报修
```

### 场景 4: 不同群组不同策略

```bash
# 默认：只响应 @
VOCECHAT_GROUP_DEFAULT_NATIVE_MENTION=true
VOCECHAT_GROUP_DEFAULT_TEXT_MENTION=false

# 客服群：全面响应
VOCECHAT_GROUP_12345_NATIVE_MENTION=true
VOCECHAT_GROUP_12345_TEXT_MENTION=true
VOCECHAT_GROUP_12345_QUESTION_AUTO=true
VOCECHAT_GROUP_12345_MENTION_PATTERNS=客服,帮助
```

## 🐛 调试

查看触发器日志：

```bash
journalctl --user -u openclaw-gateway.service -f | grep "group trigger"
```

关键日志：
- `group trigger activated reason=native-mention` - @ 触发
- `group trigger activated reason=text-mention` - 文本匹配触发
- `group trigger activated reason=question` - 问句触发
- `skip group event: no reply trigger reason=none` - 未触发

## ✅ 向后兼容

- 未配置时使用默认值（全部启用，除了 `replyToBot`）
- 现有配置无需修改
- 默认行为与升级前完全一致

## 📝 文件变更

### 新增
- `.env.example`
- `docs/group-trigger-config-upgrade.md`
- `docs/group-trigger-quick-summary.md`（本文件）

### 修改
- `index.ts`
- `src/vocechat-group-trigger.ts`
- `README.md`
- `config/plugin-config.example.json5`

## 🔄 升级步骤

```bash
# 1. 更新代码
git pull  # 或同步最新代码
npm run build

# 2. 重新安装
openclaw plugins install -l /path/to/openclaw-vocechat-channel
openclaw gateway restart

# 3. 配置（可选）
# 方式 A：环境变量配置
cp .env.example .env
vim .env

# 方式 B：JSON 配置
# 参考 config/plugin-config.example.json5 中的完整示例
openclaw config edit

# 4. 验证
journalctl --user -u openclaw-gateway.service -f | grep "group trigger"
```

## 🎯 下一步

### 需要验证的功能

- [ ] **回复触发器** - 需要先验证 VoceChat webhook 是否提供 `reply_to` 字段

### 验证步骤

1. 在 VoceChat 中回复机器人的一条消息
2. 查看 webhook payload 日志
3. 确认是否包含引用字段（`reply_to`/`replied_to`/`quote_mid` 等）
4. 如果支持，实现完整的回复触发功能

想要测试？运行：

```bash
# 临时启用调试日志
journalctl --user -u openclaw-gateway.service -f
```

然后在 VoceChat 中回复机器人消息，查看 webhook payload。

## 📚 详细文档

- [完整升级说明](./group-trigger-config-upgrade.md)
- [README 使用指南](../README.md)
- [环境变量配置示例](../.env.example)
- [JSON 配置示例](../config/plugin-config.example.json5)

## 💡 技术亮点

1. **灵活的配置系统**：JSON + 环境变量双重支持
2. **按群组定制**：不同群聊可以有完全不同的触发策略
3. **向后兼容**：现有部署无需修改配置
4. **详细日志**：触发原因清晰可追溯
5. **可扩展设计**：预留了回复触发器接口

## ✨ 贡献

欢迎提交 Issue 和 PR：
- Bug 报告
- 功能建议
- 文档改进
- 代码优化
