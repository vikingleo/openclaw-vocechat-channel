#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PATH_HELPER="$REPO_DIR/skills/vocechat-send/scripts/lib/openclaw-path-utils.cjs"

LINK_MODE="false"
CONFIG_PATH=""
BASE_URL=""
API_KEY=""
DEFAULT_TO=""
ALLOW_FROM_RAW=""
GROUP_ALLOW_FROM_RAW=""
ADMIN_SENDER_IDS_RAW=""
WEBHOOK_PATH="/vocechat/webhook"
WEBHOOK_API_KEY=""
PUBLIC_WEBHOOK_BASE=""
INBOUND_ENABLED="true"
SKIP_RESTART="false"
AUTO_CONFIRM="false"
SKILL_SCOPE="managed"

INSTALL_SERVER="false"
SERVER_BIN=""
SERVER_BIN_URL=""
SERVER_BIN_SHA256=""
SERVER_VERSION=""
SERVER_INSTALL_DIR="$HOME/.vocechat-server"
SERVER_DATA_DIR=""
SERVER_HOST="127.0.0.1"
SERVER_PORT="3000"
SERVER_FRONTEND_URL=""
SERVER_SERVICE_NAME="vocechat"
SERVER_SERVICE_SCOPE="auto"

TMP_DIR=""
CONFIG_FILE=""
PLUGIN_SKILL_SOURCE=""
SKILL_TARGET_DIR=""
SERVER_INSTALL_DIR_RESOLVED=""
SERVER_DATA_DIR_RESOLVED=""
SERVER_FRONTEND_URL_RESOLVED=""
SERVER_BINARY_TARGET=""
SERVER_SERVICE_SCOPE_RESOLVED="none"
SERVER_SERVICE_UNIT_PATH=""
SERVER_SERVICE_ENABLED="false"
CHANNEL_ENABLED="false"
PLUGIN_INSTALL_PATH=""
PLUGIN_ALREADY_PRESENT="false"

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

usage() {
  cat <<EOF
用法:
  $(basename "$0") [选项]

说明:
  一键安装 VoceChat 插件，补齐 OpenClaw 本地配置，并把 vocechat-send skill 安装到 OpenClaw managed skills。
  可选同时安装/升级本机 VoceChat 服务端，并用 systemd 托管。

选项:
  --link                    使用 openclaw link 安装当前仓库（默认复制安装）
  --copy                    显式指定复制安装
  --config <路径>           指定 OpenClaw 配置文件
  --base-url <URL>          VoceChat 服务地址；若同时安装服务端且未指定，默认 http://127.0.0.1:3000
  --api-key <KEY>           VoceChat Bot API Key；首次安装服务端时可暂时留空
  --default-to <目标>       默认目标，如 user:2
  --allow-from <列表>       私聊白名单，逗号分隔
  --group-allow-from <列表> 群聊白名单，逗号分隔
  --admin-sender-ids <列表> 插件管理员白名单，逗号分隔，如 telegram:123,vocechat:user:1
  --webhook-path <路径>     入站 webhook 路径，默认 /vocechat/webhook
  --webhook-api-key <KEY>   webhook 鉴权密钥；未提供时自动生成
  --public-webhook-base <URL>
                            公开 webhook 基础地址，用于安装完成后输出最终 webhook URL
  --disable-inbound         只配置出站，不启用 webhook 入站
  --skill-scope <managed|none>
                            managed: 安装到 ~/.openclaw/skills；none: 不安装 skill
  --install-server          同时安装/升级本机 VoceChat 服务端
  --server-bin <路径>       从本地二进制安装/升级 vocechat-server
  --server-bin-url <URL>    从制品 URL 安装/升级 vocechat-server
  --server-bin-sha256 <值>  对 server-bin 或 server-bin-url 做 SHA256 校验
  --server-version <版本>   未指定二进制来源时，回退使用官方 sh.voce.chat 版本，如 v0.4.2
  --server-install-dir <路径>
                            VoceChat 安装目录，默认 ~/.vocechat-server
  --server-data-dir <路径>  VoceChat 数据目录，默认 <install-dir>/data
  --server-host <地址>      VoceChat 监听地址，默认 127.0.0.1
  --server-port <端口>      VoceChat 监听端口，默认 3000
  --server-frontend-url <URL>
                            写入 VoceChat config.toml 的 frontend_url；默认取 baseUrl 或本地地址
  --server-service-name <名称>
                            systemd 服务名，默认 vocechat
  --server-service-scope <auto|system|user|none>
                            auto: root 用 system，普通用户用 user；none: 不写 systemd
  --skip-restart            不自动重启 OpenClaw gateway
  --yes                     尽量接受默认值，跳过最终确认
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

expand_home() {
  HOME_DIR="$HOME" node "$PATH_HELPER" expand-home "$1"
}

resolve_path() {
  HOME_DIR="$HOME" node "$PATH_HELPER" resolve-path "$1"
}

same_path() {
  left=$1
  right=$2
  left=$(resolve_path "$left")
  right=$(resolve_path "$right")
  [ -n "$left" ] && [ -n "$right" ] && [ "$left" = "$right" ]
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

prompt_secret() {
  message=$1
  printf '%s: ' "$message" >&2
  old_stty=""
  if [ -t 0 ] && have_cmd stty; then
    old_stty=$(stty -g 2>/dev/null || true)
    stty -echo 2>/dev/null || true
  fi
  IFS= read -r answer || true
  if [ -n "$old_stty" ]; then
    stty "$old_stty" 2>/dev/null || true
  fi
  printf '\n' >&2
  printf '%s\n' "$answer"
}

normalize_csv_list() {
  raw=$1
  node --input-type=commonjs - "$raw" <<'NODE'
const raw = String(process.argv[2] ?? "");
const items = raw
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
process.stdout.write(items.join(","));
NODE
}

normalize_target_default() {
  raw=$1
  if [ -z "$raw" ]; then
    printf '\n'
    return
  fi
  node --input-type=commonjs - "$raw" <<'NODE'
const raw = String(process.argv[2] ?? "").trim();
const withoutPrefix = raw.replace(/^(vocechat|vc):/i, "").trim();
if (!withoutPrefix) process.exit(2);
const match = withoutPrefix.match(/^(user|u|dm|private|group|g|room|channel):\s*(.+)$/i);
if (match) {
  const rawKind = match[1].toLowerCase();
  const id = String(match[2] ?? "").trim();
  if (!id) process.exit(2);
  const kind = rawKind === "group" || rawKind === "g" || rawKind === "room" || rawKind === "channel" ? "group" : "user";
  process.stdout.write(`${kind}:${id}`);
  process.exit(0);
}
if (/^\d+$/.test(withoutPrefix)) {
  process.stdout.write(`user:${withoutPrefix}`);
  process.exit(0);
}
process.exit(2);
NODE
}

random_secret() {
  node --input-type=commonjs - <<'NODE'
const crypto = require("crypto");
process.stdout.write(crypto.randomBytes(24).toString("hex"));
NODE
}

calc_sha256() {
  file_path=$1
  if have_cmd sha256sum; then
    sha256sum "$file_path" | awk '{print $1}'
    return
  fi
  if have_cmd shasum; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return
  fi
  if have_cmd openssl; then
    openssl dgst -sha256 "$file_path" | awk '{print $NF}'
    return
  fi
  die "无法计算 SHA256；请安装 sha256sum、shasum 或 openssl"
}

verify_sha256() {
  file_path=$1
  expected=$2
  [ -n "$expected" ] || return 0
  actual=$(calc_sha256 "$file_path")
  [ "$actual" = "$expected" ] || die "VoceChat 二进制 SHA256 校验失败"
}

detect_official_platform() {
  os_name=$(uname -s)
  arch_name=$(uname -m)
  case "$arch_name" in
    arm64)
      if [ "$os_name" = "Darwin" ]; then
        printf '%s\n' "aarch64-apple-darwin"
      else
        printf '%s\n' "aarch64-unknown-linux-musl"
      fi
      ;;
    aarch64)
      printf '%s\n' "aarch64-unknown-linux-musl"
      ;;
    armv7l|arm)
      printf '%s\n' "armv7-unknown-linux-musleabihf"
      ;;
    x86_64)
      if [ "$os_name" = "Darwin" ]; then
        printf '%s\n' "x86_64-apple-darwin"
      else
        printf '%s\n' "x86_64-unknown-linux-musl"
      fi
      ;;
    *)
      die "官方下载暂不支持当前架构: $arch_name"
      ;;
  esac
}

fetch_latest_official_server_version() {
  require_cmd curl
  version=$(curl --fail --silent --show-error --location https://sh.voce.chat/LATEST_SERVER_TAG.txt)
  printf '%s\n' "$(printf '%s' "$version" | tr -d '\r\n')"
}

create_minimal_template_file() {
  file_path=$1
  title=$2
  body=$3
  cat >"$file_path" <<EOF
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>$title</title>
</head>
<body>
  <p>$body</p>
</body>
</html>
EOF
}

ensure_server_support_files() {
  mkdir -p "$SERVER_INSTALL_DIR_RESOLVED/config/templates" "$SERVER_DATA_DIR_RESOLVED"

  if [ ! -f "$SERVER_INSTALL_DIR_RESOLVED/config/config.toml" ]; then
    cat >"$SERVER_INSTALL_DIR_RESOLVED/config/config.toml" <<EOF
webclient_url = "https://s.voce.chat/web_client/v0.3.x"

[system]
data_dir = "$SERVER_DATA_DIR_RESOLVED"
token_expiry_seconds = 300
refresh_token_expiry_seconds = 604800

[network]
bind = "$SERVER_HOST:$SERVER_PORT"
frontend_url = "$SERVER_FRONTEND_URL_RESOLVED"

[template.register_by_email]
subject = "Register code"
file = "config/templates/register_by_email.html"

[template.login_by_email]
subject = "Your sign-in link for Vocechat"
file = "config/templates/login_by_email.html"
EOF
  fi

  register_tpl="$SERVER_INSTALL_DIR_RESOLVED/config/templates/register_by_email.html"
  login_tpl="$SERVER_INSTALL_DIR_RESOLVED/config/templates/login_by_email.html"

  if [ ! -f "$register_tpl" ]; then
    if have_cmd curl; then
      curl --fail --silent --show-error --location \
        https://raw.githubusercontent.com/Privoce/vocechat-server-rust/master/config/templates/register_by_email.html \
        --output "$register_tpl" || create_minimal_template_file "$register_tpl" "VoceChat Register" "Your register code is ready."
    else
      create_minimal_template_file "$register_tpl" "VoceChat Register" "Your register code is ready."
    fi
  fi

  if [ ! -f "$login_tpl" ]; then
    if have_cmd curl; then
      curl --fail --silent --show-error --location \
        https://raw.githubusercontent.com/Privoce/vocechat-server-rust/master/config/templates/login_by_email.html \
        --output "$login_tpl" || create_minimal_template_file "$login_tpl" "VoceChat Login" "Your sign-in link is ready."
    else
      create_minimal_template_file "$login_tpl" "VoceChat Login" "Your sign-in link is ready."
    fi
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

service_unit_exists() {
  if [ -n "$SERVER_SERVICE_UNIT_PATH" ] && [ -f "$SERVER_SERVICE_UNIT_PATH" ]; then
    return 0
  fi
  return 1
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

install_server_service() {
  SERVER_SERVICE_SCOPE_RESOLVED=$(resolve_service_scope "$SERVER_SERVICE_SCOPE")
  SERVER_SERVICE_ENABLED="false"

  case "$SERVER_SERVICE_SCOPE_RESOLVED" in
    system)
      SERVER_SERVICE_UNIT_PATH="/etc/systemd/system/$SERVER_SERVICE_NAME.service"
      ;;
    user)
      SERVER_SERVICE_UNIT_PATH="$HOME/.config/systemd/user/$SERVER_SERVICE_NAME.service"
      mkdir -p "$(dirname "$SERVER_SERVICE_UNIT_PATH")"
      ;;
    none)
      SERVER_SERVICE_UNIT_PATH=""
      warn "当前环境不支持或未启用 systemd；VoceChat 已完成文件安装，但未写入服务单元"
      return 0
      ;;
    *)
      die "不支持的 --server-service-scope: $SERVER_SERVICE_SCOPE_RESOLVED"
      ;;
  esac

  mkdir -p "$(dirname "$SERVER_SERVICE_UNIT_PATH")"
  service_identity=""
  if [ "$SERVER_SERVICE_SCOPE_RESOLVED" = "system" ]; then
    service_identity=$(cat <<EOF
User=$(id -un)
Group=$(id -gn)
EOF
)
  fi

  cat >"$SERVER_SERVICE_UNIT_PATH" <<EOF
[Unit]
Description=VoceChat Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$SERVER_INSTALL_DIR_RESOLVED
ExecStart=$SERVER_BINARY_TARGET $SERVER_INSTALL_DIR_RESOLVED/config/config.toml
Restart=always
RestartSec=5
$service_identity

[Install]
WantedBy=$( [ "$SERVER_SERVICE_SCOPE_RESOLVED" = "system" ] && printf '%s' "multi-user.target" || printf '%s' "default.target" )
EOF

  if ! systemctl_action daemon-reload "" >/dev/null 2>&1; then
    warn "systemd daemon-reload 失败，已写入单元文件但未自动启动"
    return 0
  fi
  if systemctl_action enable "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1; then
    SERVER_SERVICE_ENABLED="true"
  else
    warn "systemd enable 失败，已写入单元文件但未自动启用"
  fi
}

start_server_service() {
  [ "$SERVER_SERVICE_SCOPE_RESOLVED" != "none" ] || return 0

  if systemctl_action restart "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1; then
    return 0
  fi
  if systemctl_action start "$SERVER_SERVICE_NAME.service" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

copy_zip_support_files() {
  extracted_dir=$1

  if [ -d "$extracted_dir/config" ]; then
    mkdir -p "$SERVER_INSTALL_DIR_RESOLVED/config"
    if [ -d "$extracted_dir/config/templates" ]; then
      mkdir -p "$SERVER_INSTALL_DIR_RESOLVED/config/templates"
      for tpl in "$extracted_dir"/config/templates/*; do
        [ -f "$tpl" ] || continue
        target_tpl="$SERVER_INSTALL_DIR_RESOLVED/config/templates/$(basename "$tpl")"
        if [ ! -f "$target_tpl" ]; then
          cp "$tpl" "$target_tpl"
        fi
      done
    fi
  fi
}

install_server_binary() {
  require_cmd cp
  require_cmd mkdir
  require_cmd mktemp

  SERVER_INSTALL_DIR_RESOLVED=$(expand_home "$SERVER_INSTALL_DIR")
  if [ -n "$SERVER_DATA_DIR" ]; then
    SERVER_DATA_DIR_RESOLVED=$(expand_home "$SERVER_DATA_DIR")
  else
    SERVER_DATA_DIR_RESOLVED="$SERVER_INSTALL_DIR_RESOLVED/data"
  fi
  if [ -n "$SERVER_FRONTEND_URL" ]; then
    SERVER_FRONTEND_URL_RESOLVED=$SERVER_FRONTEND_URL
  elif [ -n "$BASE_URL" ]; then
    SERVER_FRONTEND_URL_RESOLVED=$BASE_URL
  else
    SERVER_FRONTEND_URL_RESOLVED="http://$SERVER_HOST:$SERVER_PORT"
  fi

  mkdir -p "$SERVER_INSTALL_DIR_RESOLVED" "$SERVER_DATA_DIR_RESOLVED"

  source_path=""
  extract_dir="$TMP_DIR/vocechat-server-extract"
  mkdir -p "$extract_dir"

  if [ -n "$SERVER_BIN" ]; then
    source_path=$(expand_home "$SERVER_BIN")
    [ -f "$source_path" ] || die "未找到 --server-bin 指定文件: $source_path"
    verify_sha256 "$source_path" "$SERVER_BIN_SHA256"
  elif [ -n "$SERVER_BIN_URL" ]; then
    require_cmd curl
    source_path="$TMP_DIR/vocechat-server-download"
    case "$SERVER_BIN_URL" in
      *.zip) source_path="$source_path.zip" ;;
      *.tar.gz|*.tgz) source_path="$source_path.tgz" ;;
      *.bin) source_path="$source_path.bin" ;;
    esac
    curl --fail --silent --show-error --location "$SERVER_BIN_URL" --output "$source_path"
    verify_sha256 "$source_path" "$SERVER_BIN_SHA256"
  else
    require_cmd curl
    require_cmd unzip
    if [ -z "$SERVER_VERSION" ]; then
      SERVER_VERSION=$(fetch_latest_official_server_version)
    fi
    [ -n "$SERVER_VERSION" ] || die "无法获取官方 VoceChat 版本号"
    platform=$(detect_official_platform)
    source_path="$TMP_DIR/vocechat-server-official.zip"
    curl --fail --silent --show-error --location \
      "https://sh.voce.chat/vocechat-server-$SERVER_VERSION-$platform.zip" \
      --output "$source_path"
    verify_sha256 "$source_path" "$SERVER_BIN_SHA256"
  fi

  extracted_binary=""
  case "$source_path" in
    *.zip)
      require_cmd unzip
      unzip -oq "$source_path" -d "$extract_dir"
      copy_zip_support_files "$extract_dir"
      if [ -f "$extract_dir/vocechat-server" ]; then
        extracted_binary="$extract_dir/vocechat-server"
      else
        extracted_binary=$(find "$extract_dir" -type f \( -name "vocechat-server" -o -name "vocechat-server.bin" \) | head -n 1)
      fi
      ;;
    *.tar.gz|*.tgz)
      require_cmd tar
      tar -xzf "$source_path" -C "$extract_dir"
      copy_zip_support_files "$extract_dir"
      extracted_binary=$(find "$extract_dir" -type f \( -name "vocechat-server" -o -name "vocechat-server.bin" \) | head -n 1)
      ;;
    *)
      extracted_binary="$source_path"
      ;;
  esac

  [ -n "$extracted_binary" ] || die "未能从提供的制品中识别 vocechat-server 二进制"
  [ -f "$extracted_binary" ] || die "VoceChat 二进制文件不存在: $extracted_binary"

  SERVER_BINARY_TARGET="$SERVER_INSTALL_DIR_RESOLVED/vocechat-server"
  binary_backup=""
  if [ -f "$SERVER_BINARY_TARGET" ]; then
    binary_backup="$SERVER_BINARY_TARGET.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$SERVER_BINARY_TARGET" "$binary_backup"
  fi

  cp "$extracted_binary" "$SERVER_BINARY_TARGET"
  chmod +x "$SERVER_BINARY_TARGET"

  ensure_server_support_files
  install_server_service

  if ! "$SERVER_BINARY_TARGET" --version >/dev/null 2>&1; then
    warn "新的 vocechat-server 不支持 --version 或返回非零，继续以服务启动结果为准"
  fi

  if [ "$SERVER_SERVICE_SCOPE_RESOLVED" != "none" ]; then
    if ! start_server_service; then
      if [ -n "$binary_backup" ] && [ -f "$binary_backup" ]; then
        warn "VoceChat 服务启动失败，回滚到备份二进制: $binary_backup"
        cp "$binary_backup" "$SERVER_BINARY_TARGET"
        chmod +x "$SERVER_BINARY_TARGET"
        start_server_service || true
      fi
      die "VoceChat 服务启动失败，请检查 systemd 日志"
    fi
  fi
}

discover_plugin_install_path() {
  if openclaw plugins info vocechat >/dev/null 2>&1; then
    plugin_info=$(openclaw plugins info vocechat 2>/dev/null || true)
    printf '%s' "$plugin_info" | HOME_DIR="$HOME" node "$PATH_HELPER" plugin-dir-from-info
    return
  fi
  printf '\n'
}

plugin_has_undici() {
  plugin_dir=$1
  [ -n "$plugin_dir" ] || return 1
  [ -f "$plugin_dir/package.json" ] || return 1
  node --input-type=commonjs - "$plugin_dir" <<'NODE' >/dev/null 2>&1
const pluginDir = process.argv[2];
try {
  require.resolve("undici", { paths: [pluginDir] });
  process.exit(0);
} catch {
  process.exit(1);
}
NODE
}

ensure_plugin_runtime_deps() {
  PLUGIN_INSTALL_PATH=$(discover_plugin_install_path)
  if [ -n "$PLUGIN_INSTALL_PATH" ]; then
    PLUGIN_INSTALL_PATH=$(expand_home "$PLUGIN_INSTALL_PATH")
  fi
  [ -n "$PLUGIN_INSTALL_PATH" ] || {
    warn "未发现已安装的 VoceChat 插件目录，跳过 runtime 依赖安装"
    return 0
  }
  if plugin_has_undici "$PLUGIN_INSTALL_PATH"; then
    log "插件 runtime 依赖: 已就绪"
    return 0
  fi
  require_cmd npm
  log "安装插件 runtime 依赖到: $PLUGIN_INSTALL_PATH"
  (
    cd "$PLUGIN_INSTALL_PATH"
    npm install --omit=dev --no-package-lock >/dev/null
  )
}

upgrade_existing_plugin() {
  target_dir=$1
  [ -n "$target_dir" ] || die "缺少插件升级目标目录"
  target_dir=$(expand_home "$target_dir")
  [ -d "$target_dir" ] || die "插件升级目标目录不存在: $target_dir"
  [ -w "$target_dir" ] || die "插件升级目标目录不可写: $target_dir"

  if same_path "$target_dir" "$REPO_DIR"; then
    log "当前仓库已是活动插件目录，跳过文件覆盖"
    return 0
  fi

  backup_dir="$target_dir.bak-$(date +%Y%m%d-%H%M%S)"
  log "检测到已安装插件，开始覆盖升级并复用现有配置"
  log "插件升级目标: $target_dir"
  log "插件目录备份: $backup_dir"

  cp -R "$target_dir" "$backup_dir"

  find "$target_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -R "$REPO_DIR"/. "$target_dir"/

  rm -rf "$target_dir/.git" "$target_dir/node_modules"
  chmod +x "$target_dir/scripts/"*.sh 2>/dev/null || true
}

while [ $# -gt 0 ]; do
  case "$1" in
    --link)
      LINK_MODE="true"
      shift
      ;;
    --copy)
      LINK_MODE="false"
      shift
      ;;
    --config)
      CONFIG_PATH=$2
      shift 2
      ;;
    --base-url)
      BASE_URL=$2
      shift 2
      ;;
    --api-key)
      API_KEY=$2
      shift 2
      ;;
    --default-to)
      DEFAULT_TO=$2
      shift 2
      ;;
    --allow-from)
      ALLOW_FROM_RAW=$2
      shift 2
      ;;
    --group-allow-from)
      GROUP_ALLOW_FROM_RAW=$2
      shift 2
      ;;
    --admin-sender-ids)
      ADMIN_SENDER_IDS_RAW=$2
      shift 2
      ;;
    --webhook-path)
      WEBHOOK_PATH=$2
      shift 2
      ;;
    --webhook-api-key)
      WEBHOOK_API_KEY=$2
      shift 2
      ;;
    --public-webhook-base)
      PUBLIC_WEBHOOK_BASE=$2
      shift 2
      ;;
    --disable-inbound)
      INBOUND_ENABLED="false"
      shift
      ;;
    --skill-scope)
      SKILL_SCOPE=$2
      shift 2
      ;;
    --install-server)
      INSTALL_SERVER="true"
      shift
      ;;
    --server-bin)
      SERVER_BIN=$2
      shift 2
      ;;
    --server-bin-url)
      SERVER_BIN_URL=$2
      shift 2
      ;;
    --server-bin-sha256)
      SERVER_BIN_SHA256=$2
      shift 2
      ;;
    --server-version)
      SERVER_VERSION=$2
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
    --server-host)
      SERVER_HOST=$2
      shift 2
      ;;
    --server-port)
      SERVER_PORT=$2
      shift 2
      ;;
    --server-frontend-url)
      SERVER_FRONTEND_URL=$2
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

require_cmd openclaw
require_cmd node
require_cmd cp
require_cmd mkdir
require_cmd mktemp

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vocechat-install.XXXXXX")
CONFIG_FILE=$(resolve_config_path)
CONFIG_FILE=$(expand_home "$CONFIG_FILE")
SKILL_TARGET_DIR="$HOME/.openclaw/skills/vocechat-send"
PLUGIN_SKILL_SOURCE="$REPO_DIR/skills/vocechat-send"

CURRENT_FIELDS=$(CONFIG_PATH="$CONFIG_FILE" node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;
let cfg = {};
if (path && fs.existsSync(path)) {
  try {
    cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {}
}
const vocechat = cfg.channels && typeof cfg.channels === "object" ? cfg.channels.vocechat || {} : {};
const telegram = cfg.channels && typeof cfg.channels === "object" ? cfg.channels.telegram || {} : {};
const fields = [
  String(vocechat.enabled === false ? "false" : "true"),
  String(vocechat.baseUrl || "").trim(),
  String(vocechat.apiKey || "").trim(),
  String(vocechat.defaultTo || "").trim(),
  Array.isArray(vocechat.allowFrom) ? vocechat.allowFrom.join(",") : String(vocechat.allowFrom || "").trim(),
  Array.isArray(vocechat.groupAllowFrom) ? vocechat.groupAllowFrom.join(",") : String(vocechat.groupAllowFrom || "").trim(),
  Array.isArray(vocechat.management?.adminSenderIds) ? vocechat.management.adminSenderIds.join(",") : "",
  String(vocechat.webhookPath || "/vocechat/webhook").trim(),
  String(vocechat.webhookApiKey || "").trim(),
  Array.isArray(telegram.allowFrom) && telegram.allowFrom.length > 0 ? `telegram:${String(telegram.allowFrom[0]).trim()}` : "",
];
process.stdout.write(fields.join("\t"));
NODE
)

IFS='	' read -r EXISTING_ENABLED EXISTING_BASE_URL EXISTING_API_KEY EXISTING_DEFAULT_TO EXISTING_ALLOW_FROM EXISTING_GROUP_ALLOW_FROM EXISTING_ADMIN_IDS EXISTING_WEBHOOK_PATH EXISTING_WEBHOOK_API_KEY SUGGESTED_TELEGRAM_ADMIN <<EOF
$CURRENT_FIELDS
EOF

[ -n "$BASE_URL" ] || BASE_URL=$EXISTING_BASE_URL
[ -n "$API_KEY" ] || API_KEY=$EXISTING_API_KEY
[ -n "$DEFAULT_TO" ] || DEFAULT_TO=$EXISTING_DEFAULT_TO
[ -n "$ALLOW_FROM_RAW" ] || ALLOW_FROM_RAW=$EXISTING_ALLOW_FROM
[ -n "$GROUP_ALLOW_FROM_RAW" ] || GROUP_ALLOW_FROM_RAW=$EXISTING_GROUP_ALLOW_FROM
[ -n "$ADMIN_SENDER_IDS_RAW" ] || ADMIN_SENDER_IDS_RAW=$EXISTING_ADMIN_IDS
[ -n "$WEBHOOK_PATH" ] || WEBHOOK_PATH=$EXISTING_WEBHOOK_PATH
[ -n "$WEBHOOK_API_KEY" ] || WEBHOOK_API_KEY=$EXISTING_WEBHOOK_API_KEY

if [ "$INSTALL_SERVER" = "true" ] && [ -z "$BASE_URL" ]; then
  BASE_URL="http://$SERVER_HOST:$SERVER_PORT"
fi

if [ "$AUTO_CONFIRM" != "true" ]; then
  [ -n "$BASE_URL" ] || BASE_URL=$(prompt "输入 VoceChat baseUrl" "$BASE_URL")
  if [ -n "$API_KEY" ]; then
    :
  elif [ "$INSTALL_SERVER" = "true" ]; then
    API_KEY=$(prompt_secret "输入 VoceChat Bot API Key（首次安装服务端时可留空，后续再补）")
  else
    API_KEY=$(prompt_secret "输入 VoceChat Bot API Key")
  fi
  [ -n "$DEFAULT_TO" ] || DEFAULT_TO=$(prompt "输入默认目标（可留空，如 user:2）" "$EXISTING_DEFAULT_TO")
  if [ -z "$ADMIN_SENDER_IDS_RAW" ] && [ -n "$SUGGESTED_TELEGRAM_ADMIN" ]; then
    ADMIN_SENDER_IDS_RAW=$(prompt "输入管理员发送者ID（逗号分隔，可留空）" "$SUGGESTED_TELEGRAM_ADMIN")
  else
    ADMIN_SENDER_IDS_RAW=$(prompt "输入管理员发送者ID（逗号分隔，可留空）" "$ADMIN_SENDER_IDS_RAW")
  fi
  ALLOW_FROM_RAW=$(prompt "输入私聊白名单（逗号分隔，可留空）" "$ALLOW_FROM_RAW")
  GROUP_ALLOW_FROM_RAW=$(prompt "输入群聊白名单（逗号分隔，可留空）" "$GROUP_ALLOW_FROM_RAW")
fi

if [ -z "$BASE_URL" ]; then
  die "baseUrl 不能为空"
fi

if [ -n "$DEFAULT_TO" ]; then
  DEFAULT_TO=$(normalize_target_default "$DEFAULT_TO") || die "defaultTo 格式无效，请使用 user:2 / group:5 / 纯数字"
fi

ALLOW_FROM_RAW=$(normalize_csv_list "$ALLOW_FROM_RAW")
GROUP_ALLOW_FROM_RAW=$(normalize_csv_list "$GROUP_ALLOW_FROM_RAW")
ADMIN_SENDER_IDS_RAW=$(normalize_csv_list "$ADMIN_SENDER_IDS_RAW")

if [ "$INBOUND_ENABLED" = "true" ] && [ -z "$WEBHOOK_API_KEY" ]; then
  WEBHOOK_API_KEY=$(random_secret)
fi

if [ -n "$BASE_URL" ] && [ -n "$API_KEY" ]; then
  CHANNEL_ENABLED="true"
else
  CHANNEL_ENABLED="false"
fi

if [ "$INSTALL_SERVER" != "true" ] && [ "$CHANNEL_ENABLED" != "true" ]; then
  die "baseUrl 和 apiKey 不能为空"
fi

PLUGIN_INSTALL_PATH=$(discover_plugin_install_path)
if [ -n "$PLUGIN_INSTALL_PATH" ]; then
  PLUGIN_INSTALL_PATH=$(expand_home "$PLUGIN_INSTALL_PATH")
  PLUGIN_ALREADY_PRESENT="true"
fi

BACKUP_FILE=""
if [ -f "$CONFIG_FILE" ]; then
  BACKUP_FILE="$CONFIG_FILE.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$CONFIG_FILE" "$BACKUP_FILE"
fi

log "配置文件: $CONFIG_FILE"
[ -n "$BACKUP_FILE" ] && log "配置备份: $BACKUP_FILE"
log "插件来源: $REPO_DIR"
log "安装模式: $( [ "$LINK_MODE" = "true" ] && printf 'link' || printf 'copy' )"
log "VoceChat baseUrl: $BASE_URL"
log "默认目标: ${DEFAULT_TO:-<未设置>}"
log "入站模式: $( [ "$INBOUND_ENABLED" = "true" ] && printf 'webhook+outbound' || printf 'outbound-only' )"
log "Skill 安装: $SKILL_SCOPE"
if [ "$INSTALL_SERVER" = "true" ]; then
  log "VoceChat 服务端: 安装/升级"
  log "VoceChat 安装目录: $(expand_home "$SERVER_INSTALL_DIR")"
  log "VoceChat 服务名: $SERVER_SERVICE_NAME"
fi
if [ "$CHANNEL_ENABLED" != "true" ]; then
  warn "当前未提供 Bot API Key；将先安装 VoceChat 服务端与插件骨架，channels.vocechat 会保持禁用，后续补上 apiKey 后重新运行本脚本即可"
fi

if [ "$AUTO_CONFIRM" != "true" ]; then
  answer=$(prompt "确认开始安装？输入 y 继续" "y")
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      die "已取消安装"
      ;;
  esac
fi

if [ "$INSTALL_SERVER" = "true" ]; then
  install_server_binary
fi

if [ "$PLUGIN_ALREADY_PRESENT" != "true" ]; then
  if [ "$LINK_MODE" = "true" ]; then
    openclaw plugins install -l "$REPO_DIR"
  else
    openclaw plugins install "$REPO_DIR"
  fi
else
  if [ -n "$PLUGIN_INSTALL_PATH" ]; then
    upgrade_existing_plugin "$PLUGIN_INSTALL_PATH"
  fi
  log "插件已存在或已加载，跳过 openclaw plugins install"
  if [ -n "$PLUGIN_INSTALL_PATH" ]; then
    log "当前插件目录: $PLUGIN_INSTALL_PATH"
  fi
fi

ensure_plugin_runtime_deps

CONFIG_PATH="$CONFIG_FILE" \
BASE_URL="$BASE_URL" \
API_KEY="$API_KEY" \
DEFAULT_TO="$DEFAULT_TO" \
ALLOW_FROM_RAW="$ALLOW_FROM_RAW" \
GROUP_ALLOW_FROM_RAW="$GROUP_ALLOW_FROM_RAW" \
ADMIN_SENDER_IDS_RAW="$ADMIN_SENDER_IDS_RAW" \
WEBHOOK_PATH="$WEBHOOK_PATH" \
WEBHOOK_API_KEY="$WEBHOOK_API_KEY" \
INBOUND_ENABLED="$INBOUND_ENABLED" \
CHANNEL_ENABLED="$CHANNEL_ENABLED" \
node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;

function ensureRecord(parent, key) {
  const value = parent[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const created = {};
  parent[key] = created;
  return created;
}

function parseList(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (/^-?\d+$/.test(item) ? Number(item) : item));
}

let root = {};
if (fs.existsSync(path)) {
  root = JSON.parse(fs.readFileSync(path, "utf8"));
}
const channels = ensureRecord(root, "channels");
const vocechat = ensureRecord(channels, "vocechat");
vocechat.enabled = String(process.env.CHANNEL_ENABLED || "false") === "true";
if (String(process.env.BASE_URL || "").trim()) {
  vocechat.baseUrl = String(process.env.BASE_URL || "").trim();
}
if (String(process.env.API_KEY || "").trim()) {
  vocechat.apiKey = String(process.env.API_KEY || "").trim();
}
vocechat.timeoutMs = vocechat.timeoutMs ?? 15000;
if (String(process.env.DEFAULT_TO || "").trim()) {
  vocechat.defaultTo = String(process.env.DEFAULT_TO).trim();
}
const allowFrom = parseList(process.env.ALLOW_FROM_RAW);
const groupAllowFrom = parseList(process.env.GROUP_ALLOW_FROM_RAW);
if (allowFrom.length > 0) {
  vocechat.allowFrom = allowFrom;
}
if (groupAllowFrom.length > 0) {
  vocechat.groupAllowFrom = groupAllowFrom;
}
vocechat.inboundEnabled = String(process.env.INBOUND_ENABLED || "true") === "true";
if (vocechat.inboundEnabled) {
  vocechat.webhookPath = String(process.env.WEBHOOK_PATH || "/vocechat/webhook").trim() || "/vocechat/webhook";
  if (String(process.env.WEBHOOK_API_KEY || "").trim()) {
    vocechat.webhookApiKey = String(process.env.WEBHOOK_API_KEY || "").trim();
  }
}
const management = ensureRecord(vocechat, "management");
const adminSenderIds = parseList(process.env.ADMIN_SENDER_IDS_RAW).map((item) => String(item));
if (adminSenderIds.length > 0) {
  management.adminSenderIds = adminSenderIds;
}

const plugins = ensureRecord(root, "plugins");
const entries = ensureRecord(plugins, "entries");
const vocechatEntry = ensureRecord(entries, "vocechat");
vocechatEntry.enabled = true;

const skills = ensureRecord(root, "skills");
const skillEntries = ensureRecord(skills, "entries");
const vocechatSkill = ensureRecord(skillEntries, "vocechat-send");
vocechatSkill.enabled = true;

fs.mkdirSync(require("path").dirname(path), { recursive: true });
fs.writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
NODE

if [ "$SKILL_SCOPE" = "managed" ]; then
  [ -d "$PLUGIN_SKILL_SOURCE" ] || die "未找到插件自带 skill: $PLUGIN_SKILL_SOURCE"
  rm -rf "$SKILL_TARGET_DIR"
  mkdir -p "$(dirname "$SKILL_TARGET_DIR")"
  cp -R "$PLUGIN_SKILL_SOURCE" "$SKILL_TARGET_DIR"
  chmod +x "$SKILL_TARGET_DIR/scripts/send.sh"
  log "已安装 managed skill: $SKILL_TARGET_DIR"
elif [ "$SKILL_SCOPE" != "none" ]; then
  die "不支持的 --skill-scope: $SKILL_SCOPE"
fi

if [ "$SKIP_RESTART" != "true" ]; then
  openclaw gateway restart
fi

SKILL_READY="unknown"
if openclaw skills info vocechat-send >/dev/null 2>&1; then
  SKILL_READY="yes"
else
  SKILL_READY="no"
fi

WEBHOOK_URL=""
if [ -n "$PUBLIC_WEBHOOK_BASE" ] && [ "$INBOUND_ENABLED" = "true" ]; then
  PUBLIC_WEBHOOK_BASE=$(expand_home "$PUBLIC_WEBHOOK_BASE")
  case "$PUBLIC_WEBHOOK_BASE" in
    */)
      WEBHOOK_URL="${PUBLIC_WEBHOOK_BASE%/}$WEBHOOK_PATH"
      ;;
    *)
      WEBHOOK_URL="$PUBLIC_WEBHOOK_BASE$WEBHOOK_PATH"
      ;;
  esac
fi

log ""
log "安装完成"
if [ "$INSTALL_SERVER" = "true" ]; then
  log "  VoceChat 服务端: 已处理"
  log "  VoceChat 二进制: $SERVER_BINARY_TARGET"
  if [ "$SERVER_SERVICE_SCOPE_RESOLVED" != "none" ] && service_unit_exists; then
    log "  VoceChat systemd: $SERVER_SERVICE_UNIT_PATH"
  else
    log "  VoceChat systemd: 未启用"
  fi
fi
log "  插件安装: 已完成"
log "  插件 runtime 依赖: 已处理"
log "  OpenClaw 本地配置: 已完成"
log "  OpenClaw agent skill: $( [ "$SKILL_READY" = "yes" ] && printf '已就绪' || printf '待检查' )"
if [ "$CHANNEL_ENABLED" = "true" ]; then
  log "  出站通路: 已完成（baseUrl/apiKey 已写入）"
else
  log "  出站通路: 待补 Bot API Key"
fi
if [ "$INBOUND_ENABLED" = "true" ]; then
  log "  入站本地路由: 已配置 ($WEBHOOK_PATH)"
  if [ -n "$WEBHOOK_URL" ]; then
    log "  webhook URL: $WEBHOOK_URL"
    if [ -n "$WEBHOOK_API_KEY" ]; then
      log "  webhook 鉴权头: x-webhook-api-key: $WEBHOOK_API_KEY"
    fi
    log "  说明: OpenClaw 侧已配置完成；仍需确保外部网络能访问该 URL，并在 VoceChat 服务端把 webhook 指向这里。"
  else
    log "  说明: OpenClaw 本地入站已配置，但 VoceChat -> OpenClaw 的外部回调仍需你提供公网 URL/反向代理并在 VoceChat 端完成 webhook 指向。"
  fi
else
  log "  入站模式: 已关闭（仅出站）"
fi
