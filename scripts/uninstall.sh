#!/bin/sh

set -eu

CONFIG_PATH=""
KEEP_CHANNEL_CONFIG="false"
KEEP_SKILL="false"
KEEP_FILES="false"
SKIP_RESTART="false"
AUTO_CONFIRM="false"

UNINSTALL_SERVER="false"
KEEP_SERVER_FILES="false"
REMOVE_SERVER_DATA="false"
SERVER_INSTALL_DIR="$HOME/.vocechat-server"
SERVER_DATA_DIR=""
SERVER_SERVICE_NAME="vocechat"
SERVER_SERVICE_SCOPE="auto"
SERVER_SERVICE_SCOPE_RESOLVED="none"
SERVER_SERVICE_UNIT_PATH=""
OPENCLAW_BIN="${OPENCLAW_BIN:-}"

usage() {
  cat <<EOF
用法:
  $(basename "$0") [选项]

说明:
  卸载 VoceChat 插件，并可选清理 OpenClaw 配置、managed skill，以及本机 VoceChat 服务端。

选项:
  --config <路径>           指定 OpenClaw 配置文件
  --keep-channel-config     保留 channels.vocechat 配置
  --keep-skill              保留 ~/.openclaw/skills/vocechat-send
  --keep-files              卸载插件时保留已安装文件
  --uninstall-server        停止并移除 VoceChat systemd 服务
  --keep-server-files       与 --uninstall-server 搭配使用；保留 vocechat-server 二进制与目录
  --remove-server-data      与 --uninstall-server 搭配使用；同时删除数据目录
  --server-install-dir <路径>
                            VoceChat 安装目录，默认 ~/.vocechat-server
  --server-data-dir <路径>  VoceChat 数据目录，默认 <install-dir>/data
  --server-service-name <名称>
                            systemd 服务名，默认 vocechat
  --server-service-scope <auto|system|user|none>
                            auto: root 用 system，普通用户用 user；none: 不处理 systemd
  --skip-restart            不自动重启 OpenClaw gateway
  --yes                     跳过确认
  -h, --help                显示帮助
EOF
}

log() {
  printf '%s\n' "$*"
}

warn() {
  printf '警告: %s\n' "$*" >&2
}

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

require_cmd() {
  have_cmd "$1" || die "缺少依赖命令: $1"
}

find_openclaw_bin() {
  if [ -n "${OPENCLAW_BIN:-}" ] && [ -x "$OPENCLAW_BIN" ]; then
    printf '%s\n' "$OPENCLAW_BIN"
    return 0
  fi
  if have_cmd openclaw; then
    command -v openclaw
    return 0
  fi
  for candidate in \
    "$HOME/.npm-global/bin/openclaw" \
    "$HOME/.local/bin/openclaw" \
    "/usr/local/bin/openclaw" \
    "/usr/bin/openclaw"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
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

prompt() {
  message=$1
  default_value=${2-}
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$message" "$default_value" >&2
  else
    printf '%s: ' "$message" >&2
  fi
  IFS= read -r answer || true
  if [ -n "$answer" ]; then
    printf '%s\n' "$answer"
  else
    printf '%s\n' "$default_value"
  fi
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
    --keep-channel-config)
      KEEP_CHANNEL_CONFIG="true"
      shift
      ;;
    --keep-skill)
      KEEP_SKILL="true"
      shift
      ;;
    --keep-files)
      KEEP_FILES="true"
      shift
      ;;
    --uninstall-server)
      UNINSTALL_SERVER="true"
      shift
      ;;
    --keep-server-files)
      KEEP_SERVER_FILES="true"
      shift
      ;;
    --remove-server-data)
      REMOVE_SERVER_DATA="true"
      shift
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
    --skip-restart)
      SKIP_RESTART="true"
      shift
      ;;
    --yes|-y)
      AUTO_CONFIRM="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数: $1"
      ;;
  esac
done

require_cmd node
require_cmd cp
OPENCLAW_BIN=$(find_openclaw_bin) || die "缺少依赖命令: openclaw（已检查 PATH、~/.npm-global/bin、~/.local/bin、/usr/local/bin、/usr/bin）"

CONFIG_FILE=$(resolve_config_path)
CONFIG_FILE=$(expand_home "$CONFIG_FILE")
SKILL_TARGET_DIR="$HOME/.openclaw/skills/vocechat-send"
BACKUP_FILE=""
SERVER_INSTALL_DIR_RESOLVED=$(expand_home "$SERVER_INSTALL_DIR")
if [ -n "$SERVER_DATA_DIR" ]; then
  SERVER_DATA_DIR_RESOLVED=$(expand_home "$SERVER_DATA_DIR")
else
  SERVER_DATA_DIR_RESOLVED="$SERVER_INSTALL_DIR_RESOLVED/data"
fi
SERVER_BINARY_TARGET="$SERVER_INSTALL_DIR_RESOLVED/vocechat-server"
SERVER_SERVICE_SCOPE_RESOLVED=$(resolve_service_scope "$SERVER_SERVICE_SCOPE")
case "$SERVER_SERVICE_SCOPE_RESOLVED" in
  system) SERVER_SERVICE_UNIT_PATH="/etc/systemd/system/$SERVER_SERVICE_NAME.service" ;;
  user) SERVER_SERVICE_UNIT_PATH="$HOME/.config/systemd/user/$SERVER_SERVICE_NAME.service" ;;
  *) SERVER_SERVICE_UNIT_PATH="" ;;
esac

if [ -f "$CONFIG_FILE" ]; then
  BACKUP_FILE="$CONFIG_FILE.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$CONFIG_FILE" "$BACKUP_FILE"
fi

log "配置文件: $CONFIG_FILE"
[ -n "$BACKUP_FILE" ] && log "配置备份: $BACKUP_FILE"
log "保留通道配置: $KEEP_CHANNEL_CONFIG"
log "保留 skill: $KEEP_SKILL"
log "保留插件文件: $KEEP_FILES"
if [ "$UNINSTALL_SERVER" = "true" ]; then
  log "卸载 VoceChat 服务端: 是"
  log "保留服务端文件: $KEEP_SERVER_FILES"
  log "删除服务端数据: $REMOVE_SERVER_DATA"
fi

if [ "$AUTO_CONFIRM" != "true" ]; then
  answer=$(prompt "确认开始卸载？输入 y 继续" "y")
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      die "已取消卸载"
      ;;
  esac
fi

UNINSTALL_ARGS="vocechat --force"
if [ "$KEEP_FILES" = "true" ]; then
  UNINSTALL_ARGS="$UNINSTALL_ARGS --keep-files"
fi

if "$OPENCLAW_BIN" plugins info vocechat >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  "$OPENCLAW_BIN" plugins uninstall $UNINSTALL_ARGS
else
  log "插件当前未安装，跳过 openclaw plugins uninstall"
fi

CONFIG_PATH="$CONFIG_FILE" KEEP_CHANNEL_CONFIG="$KEEP_CHANNEL_CONFIG" node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;
if (!fs.existsSync(path)) process.exit(0);
const root = JSON.parse(fs.readFileSync(path, "utf8"));

function deletePath(parent, key) {
  if (parent && typeof parent === "object" && !Array.isArray(parent)) {
    delete parent[key];
  }
}

if (String(process.env.KEEP_CHANNEL_CONFIG || "false") !== "true") {
  deletePath(root.channels, "vocechat");
}
if (root.plugins && typeof root.plugins === "object" && !Array.isArray(root.plugins) && root.plugins.entries && typeof root.plugins.entries === "object") {
  delete root.plugins.entries["vocechat"];
}
if (root.skills && typeof root.skills === "object" && !Array.isArray(root.skills) && root.skills.entries && typeof root.skills.entries === "object") {
  delete root.skills.entries["vocechat-send"];
}

fs.writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
NODE

if [ "$KEEP_SKILL" != "true" ] && [ -d "$SKILL_TARGET_DIR" ]; then
  rm -rf "$SKILL_TARGET_DIR"
  log "已移除 managed skill: $SKILL_TARGET_DIR"
fi

if [ "$UNINSTALL_SERVER" = "true" ]; then
  if [ "$SERVER_SERVICE_SCOPE_RESOLVED" != "none" ]; then
    systemctl_action stop "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1 || true
    systemctl_action disable "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1 || true
    if [ -n "$SERVER_SERVICE_UNIT_PATH" ] && [ -f "$SERVER_SERVICE_UNIT_PATH" ]; then
      rm -f "$SERVER_SERVICE_UNIT_PATH"
      systemctl_action daemon-reload >/dev/null 2>&1 || true
      log "已移除 systemd 单元: $SERVER_SERVICE_UNIT_PATH"
    fi
  else
    warn "当前环境未检测到 systemd，跳过服务单元处理"
  fi

  if [ "$KEEP_SERVER_FILES" != "true" ]; then
    if [ -f "$SERVER_BINARY_TARGET" ]; then
      rm -f "$SERVER_BINARY_TARGET"
      log "已移除 VoceChat 二进制: $SERVER_BINARY_TARGET"
    fi
    if [ "$REMOVE_SERVER_DATA" = "true" ] && [ -d "$SERVER_INSTALL_DIR_RESOLVED" ]; then
      rm -rf "$SERVER_INSTALL_DIR_RESOLVED"
      log "已移除 VoceChat 目录: $SERVER_INSTALL_DIR_RESOLVED"
    elif [ "$REMOVE_SERVER_DATA" = "true" ] && [ -d "$SERVER_DATA_DIR_RESOLVED" ]; then
      rm -rf "$SERVER_DATA_DIR_RESOLVED"
      log "已移除 VoceChat 数据目录: $SERVER_DATA_DIR_RESOLVED"
    fi
  fi
fi

if [ "$SKIP_RESTART" != "true" ]; then
  "$OPENCLAW_BIN" gateway restart
fi

log ""
log "卸载完成"
log "  插件: 已卸载"
log "  通道配置: $( [ "$KEEP_CHANNEL_CONFIG" = "true" ] && printf '已保留' || printf '已清理' )"
log "  managed skill: $( [ "$KEEP_SKILL" = "true" ] && printf '已保留' || printf '已清理' )"
if [ "$UNINSTALL_SERVER" = "true" ]; then
  log "  VoceChat 服务端: 已处理"
fi
