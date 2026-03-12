#!/bin/sh

set -eu

CONFIG_PATH=""
SERVER_INSTALL_DIR="$HOME/.vocechat-server"
SERVER_DATA_DIR=""
SERVER_SERVICE_NAME="vocechat"
SERVER_SERVICE_SCOPE="auto"
SERVER_SERVICE_SCOPE_RESOLVED="none"
FAIL_COUNT=0
WARN_COUNT=0

usage() {
  cat <<EOF
用法:
  $(basename "$0") [选项]

说明:
  检查 VoceChat 插件、OpenClaw 配置、runtime 依赖、managed skill，以及本机 VoceChat 服务端状态。

选项:
  --config <路径>             指定 OpenClaw 配置文件
  --server-install-dir <路径> VoceChat 安装目录，默认 ~/.vocechat-server
  --server-data-dir <路径>    VoceChat 数据目录，默认 <install-dir>/data
  --server-service-name <名称>
                              systemd 服务名，默认 vocechat
  --server-service-scope <auto|system|user|none>
                              auto: root 用 system，普通用户用 user；none: 跳过 systemd 检查
  -h, --help                  显示帮助
EOF
}

ok() {
  printf 'OK   %s\n' "$*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf 'WARN %s\n' "$*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL %s\n' "$*"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

expand_home() {
  case "$1" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${1#~/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

resolve_config_path() {
  if [ -n "${CONFIG_PATH:-}" ]; then
    expand_home "$CONFIG_PATH"
    return
  fi
  if [ -n "${OPENCLAW_CONFIG_PATH:-}" ]; then
    expand_home "$OPENCLAW_CONFIG_PATH"
    return
  fi
  if [ -n "${CLAWDBOT_CONFIG_PATH:-}" ]; then
    expand_home "$CLAWDBOT_CONFIG_PATH"
    return
  fi
  state_dir="${OPENCLAW_STATE_DIR:-${CLAWDBOT_STATE_DIR:-$HOME/.openclaw}}"
  state_dir=$(expand_home "$state_dir")
  printf '%s/openclaw.json\n' "${state_dir%/}"
}

resolve_service_scope() {
  scope=$1
  if [ "$scope" = "none" ]; then
    printf '%s\n' "none"
    return
  fi
  if ! have_cmd systemctl; then
    printf '%s\n' "none"
    return
  fi
  if [ "$scope" = "auto" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      printf '%s\n' "system"
    else
      printf '%s\n' "user"
    fi
    return
  fi
  printf '%s\n' "$scope"
}

systemctl_action() {
  action=$1
  unit_name=${2-}
  case "$SERVER_SERVICE_SCOPE_RESOLVED" in
    system)
      if [ -n "$unit_name" ]; then
        systemctl "$action" "$unit_name"
      else
        systemctl "$action"
      fi
      ;;
    user)
      if [ -n "$unit_name" ]; then
        systemctl --user "$action" "$unit_name"
      else
        systemctl --user "$action"
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      CONFIG_PATH=$2
      shift 2
      ;;
    --server-install-dir)
      SERVER_INSTALL_DIR=$2
      shift 2
      ;;
    --server-data-dir)
      SERVER_DATA_DIR=$2
      shift 2
      ;;
    --server-service-name)
      SERVER_SERVICE_NAME=$2
      shift 2
      ;;
    --server-service-scope)
      SERVER_SERVICE_SCOPE=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '错误: 未知参数: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

CONFIG_FILE=$(resolve_config_path)
SERVER_INSTALL_DIR_RESOLVED=$(expand_home "$SERVER_INSTALL_DIR")
if [ -n "$SERVER_DATA_DIR" ]; then
  SERVER_DATA_DIR_RESOLVED=$(expand_home "$SERVER_DATA_DIR")
else
  SERVER_DATA_DIR_RESOLVED="$SERVER_INSTALL_DIR_RESOLVED/data"
fi
SERVER_BINARY_TARGET="$SERVER_INSTALL_DIR_RESOLVED/vocechat-server"
SERVER_SERVICE_SCOPE_RESOLVED=$(resolve_service_scope "$SERVER_SERVICE_SCOPE")

printf 'VoceChat Doctor\n'
printf '  config: %s\n' "$CONFIG_FILE"
printf '  server install dir: %s\n' "$SERVER_INSTALL_DIR_RESOLVED"
printf '  server service: %s (%s)\n' "$SERVER_SERVICE_NAME" "$SERVER_SERVICE_SCOPE_RESOLVED"
printf '\n'

if have_cmd openclaw; then
  ok "openclaw 命令可用"
else
  fail "缺少 openclaw 命令"
fi

if have_cmd node; then
  ok "node 命令可用"
else
  fail "缺少 node 命令"
fi

if have_cmd curl; then
  ok "curl 命令可用"
else
  warn "缺少 curl，远程附件与制品 URL 安装将不可用"
fi

if [ -f "$CONFIG_FILE" ]; then
  ok "OpenClaw 配置文件存在"
else
  fail "OpenClaw 配置文件不存在: $CONFIG_FILE"
fi

if ! have_cmd node; then
  printf '\n'
  printf 'Summary: %s failure(s), %s warning(s)\n' "$FAIL_COUNT" "$WARN_COUNT"
  exit 1
fi

CONFIG_SUMMARY=$(CONFIG_PATH="$CONFIG_FILE" node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;
if (!path || !fs.existsSync(path)) {
  process.stdout.write("missing");
  process.exit(0);
}
let root = {};
try {
  root = JSON.parse(fs.readFileSync(path, "utf8"));
} catch {
  process.stdout.write("invalid");
  process.exit(0);
}
const vocechat = root.channels && typeof root.channels === "object" ? root.channels.vocechat || {} : {};
const adminIds = Array.isArray(vocechat.management?.adminSenderIds) ? vocechat.management.adminSenderIds : [];
const parts = [
  "ok",
  String(vocechat.enabled === true),
  String(vocechat.baseUrl || "").trim(),
  String(vocechat.apiKey || "").trim(),
  String(vocechat.inboundEnabled === true),
  String(vocechat.webhookPath || "").trim(),
  String(vocechat.webhookApiKey || "").trim(),
  String(vocechat.defaultTo || "").trim(),
  String(adminIds.length),
];
process.stdout.write(parts.join("\t"));
NODE
)

case "$CONFIG_SUMMARY" in
  missing)
    fail "无法读取 OpenClaw 配置文件"
    ;;
  invalid)
    fail "OpenClaw 配置文件不是合法 JSON"
    ;;
  *)
    IFS='	' read -r _ CFG_ENABLED CFG_BASE_URL CFG_API_KEY CFG_INBOUND CFG_WEBHOOK_PATH CFG_WEBHOOK_API_KEY CFG_DEFAULT_TO CFG_ADMIN_COUNT <<EOF
$CONFIG_SUMMARY
EOF
    if [ "$CFG_BASE_URL" != "" ]; then
      ok "channels.vocechat.baseUrl 已配置"
    else
      fail "channels.vocechat.baseUrl 缺失"
    fi
    if [ "$CFG_API_KEY" != "" ]; then
      ok "channels.vocechat.apiKey 已配置"
    else
      warn "channels.vocechat.apiKey 缺失；出站发送暂不可用"
    fi
    if [ "$CFG_ENABLED" = "true" ]; then
      ok "channels.vocechat 已启用"
    else
      warn "channels.vocechat 未启用"
    fi
    if [ "$CFG_INBOUND" = "true" ]; then
      if [ "$CFG_WEBHOOK_PATH" != "" ]; then
        ok "VoceChat 入站 webhookPath 已配置"
      else
        fail "VoceChat 已启用入站，但 webhookPath 缺失"
      fi
      if [ "$CFG_WEBHOOK_API_KEY" != "" ]; then
        ok "VoceChat webhookApiKey 已配置"
      else
        warn "VoceChat 入站已启用，但 webhookApiKey 缺失"
      fi
    else
      warn "VoceChat 入站 webhook 未启用"
    fi
    if [ "$CFG_DEFAULT_TO" != "" ]; then
      ok "VoceChat defaultTo 已配置"
    else
      warn "VoceChat defaultTo 未配置"
    fi
    if [ "$CFG_ADMIN_COUNT" -gt 0 ] 2>/dev/null; then
      ok "VoceChat 管理员白名单已配置"
    else
      warn "VoceChat 管理员白名单为空，将继承宿主授权范围"
    fi
    ;;
esac

PLUGIN_INFO=""
if have_cmd openclaw && openclaw plugins info vocechat >/dev/null 2>&1; then
  ok "VoceChat 插件已安装"
  PLUGIN_INFO=$(openclaw plugins info vocechat 2>/dev/null)
  PLUGIN_INSTALL_PATH=$(printf '%s' "$PLUGIN_INFO" | node --input-type=commonjs -e '
const fs = require("fs");
const path = require("path");

const raw = fs.readFileSync(0, "utf8");
const lines = raw.split(/\r?\n/);

function extract(prefix) {
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      if (value) return value;
    }
  }
  return "";
}

const installPath = extract("Install path:");
if (installPath) {
  process.stdout.write(installPath);
  process.exit(0);
}

const sourcePath = extract("Source path:");
if (sourcePath) {
  process.stdout.write(sourcePath);
  process.exit(0);
}

const source = extract("Source:");
if (!source) process.exit(0);

if (/\.(?:[cm]?js|tsx?|jsx)$/i.test(source)) {
  process.stdout.write(path.dirname(source));
  process.exit(0);
}

process.stdout.write(source);
'
)
  case "$PLUGIN_INSTALL_PATH" in
    "~"|"~/"*)
      PLUGIN_INSTALL_PATH=$(expand_home "$PLUGIN_INSTALL_PATH")
      ;;
  esac
  if [ -n "$PLUGIN_INSTALL_PATH" ]; then
    ok "VoceChat 插件安装目录可解析"
    if node --input-type=commonjs - "$PLUGIN_INSTALL_PATH" <<'NODE' >/dev/null 2>&1
const pluginDir = process.argv[2];
try {
  require.resolve("undici", { paths: [pluginDir] });
  process.exit(0);
} catch {
  process.exit(1);
}
NODE
    then
      ok "插件 runtime 依赖 undici 已安装"
    else
      fail "插件缺少 runtime 依赖 undici"
    fi
  else
    fail "无法解析 VoceChat 插件安装目录"
  fi
else
  fail "VoceChat 插件未安装"
fi

if have_cmd openclaw && openclaw skills info vocechat-send >/dev/null 2>&1; then
  ok "vocechat-send skill 已注册"
else
  warn "vocechat-send skill 未注册"
fi

if [ -d "$HOME/.openclaw/skills/vocechat-send" ]; then
  ok "managed skill 目录存在"
else
  warn "managed skill 目录不存在: $HOME/.openclaw/skills/vocechat-send"
fi

if [ -x "$SERVER_BINARY_TARGET" ]; then
  version_output=$("$SERVER_BINARY_TARGET" --version 2>/dev/null || true)
  if [ -n "$version_output" ]; then
    ok "VoceChat 服务端二进制存在: $version_output"
  else
    ok "VoceChat 服务端二进制存在"
  fi
else
  warn "VoceChat 服务端二进制不存在: $SERVER_BINARY_TARGET"
fi

if [ -d "$SERVER_DATA_DIR_RESOLVED" ]; then
  ok "VoceChat 数据目录存在"
else
  warn "VoceChat 数据目录不存在: $SERVER_DATA_DIR_RESOLVED"
fi

if [ "$SERVER_SERVICE_SCOPE_RESOLVED" != "none" ]; then
  if systemctl_action status "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1; then
    ok "VoceChat systemd 服务可查询"
  else
    warn "VoceChat systemd 服务不存在或无法查询"
  fi
  if systemctl_action is-enabled "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1; then
    ok "VoceChat systemd 服务已启用"
  else
    warn "VoceChat systemd 服务未启用"
  fi
  if systemctl_action is-active "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1; then
    ok "VoceChat systemd 服务运行中"
  else
    warn "VoceChat systemd 服务未运行"
  fi
else
  warn "已跳过 systemd 检查"
fi

printf '\n'
printf 'Summary: %s failure(s), %s warning(s)\n' "$FAIL_COUNT" "$WARN_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
