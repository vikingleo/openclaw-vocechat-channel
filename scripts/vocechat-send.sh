#!/bin/sh

set -eu

SCRIPT_NAME=$(basename "$0")
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
TMP_DIR=""

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

usage() {
  cat <<EOF
用法:
  $SCRIPT_NAME --to <user:2|group:5|2> [--text "文本"] [--file <文件路径或URL>] [选项]
  $SCRIPT_NAME <附件路径或URL>

说明:
  1. 自动读取 OpenClaw 的 VoceChat 渠道配置。
  2. 若配置中缺少 baseUrl/apiKey，则继续从本机 .env 兜底查找。
  3. 若 .env 仍缺失，则在终端中提示输入。
  4. 默认交互式选择账号、目标与确认；传入完整参数后也可非交互执行。
  5. 可发送纯文本、附件，或“文本 + 附件”。

常用选项:
  --to <目标>             目标，支持 user:2 / group:5 / 纯数字(按 user 处理)
  --text <文本>           发送文本
  --file <路径或URL>      发送附件
  --account <账号ID>      指定 VoceChat 账号，默认自动选择
  --base-url <URL>        覆盖配置中的 baseUrl
  --api-key <KEY>         覆盖配置中的 apiKey
  --yes                   跳过最终确认
  --non-interactive       缺少必要参数时直接报错，不进入交互
  -h, --help              显示帮助

依赖:
  node
  curl
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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少依赖命令: $1"
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
    return
  fi
  printf '%s\n' "$default_value"
}

prompt_secret() {
  message=$1
  printf '%s: ' "$message" >&2
  old_stty=""
  if [ -t 0 ] && command -v stty >/dev/null 2>&1; then
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

normalize_target() {
  raw_target=$1
  node --input-type=commonjs - "$raw_target" <<'NODE'
const raw = String(process.argv[2] ?? "").trim();
if (!raw) process.exit(2);
const withoutPrefix = raw.replace(/^(vocechat|vc):/i, "").trim();
if (!withoutPrefix) process.exit(2);
const match = withoutPrefix.match(/^(user|u|dm|private|group|g|room|channel):\s*(.+)$/i);
if (match) {
  const rawKind = match[1].toLowerCase();
  const id = String(match[2] ?? "").trim();
  if (!id) process.exit(2);
  const kind = rawKind === "group" || rawKind === "g" || rawKind === "room" || rawKind === "channel" ? "group" : "user";
  process.stdout.write(`${kind}\t${id}\t${kind}:${id}`);
  process.exit(0);
}
if (/^\d+$/.test(withoutPrefix)) {
  process.stdout.write(`user\t${withoutPrefix}\tuser:${withoutPrefix}`);
  process.exit(0);
}
process.exit(2);
NODE
}

build_send_url() {
  base_url=$1
  template=$2
  target_id=$3
  node --input-type=commonjs - "$base_url" "$template" "$target_id" <<'NODE'
const baseUrl = String(process.argv[2] ?? "").trim().replace(/\/+$/g, "");
const template = String(process.argv[3] ?? "").trim();
const targetId = String(process.argv[4] ?? "");
const encodedId = encodeURIComponent(targetId);
let rawPath = template;
if (template.includes("{id}")) {
  rawPath = template.split("{id}").join(encodedId);
} else if (template.includes(":id")) {
  rawPath = template.split(":id").join(encodedId);
} else {
  rawPath = `${template.replace(/\/+$/g, "")}/${encodedId}`;
}
if (/^https?:\/\//i.test(rawPath)) {
  process.stdout.write(rawPath);
} else if (rawPath.startsWith("/")) {
  process.stdout.write(`${baseUrl}${rawPath}`);
} else {
  process.stdout.write(`${baseUrl}/${rawPath}`);
}
NODE
}

detect_content_type() {
  file_path=$1
  if command -v file >/dev/null 2>&1; then
    file -b --mime-type "$file_path" 2>/dev/null || printf '%s\n' "application/octet-stream"
    return
  fi
  printf '%s\n' "application/octet-stream"
}

download_remote_attachment() {
  source_url=$1
  target_name=$(node --input-type=commonjs - "$source_url" <<'NODE'
const raw = String(process.argv[2] ?? "");
try {
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
  process.stdout.write(name || "attachment.bin");
} catch {
  process.stdout.write("attachment.bin");
}
NODE
)
  target_path="$TMP_DIR/$target_name"
  log "下载远程附件: $source_url"
  curl --fail --silent --show-error --location "$source_url" --output "$target_path" || die "下载附件失败: $source_url"
  printf '%s\n' "$target_path"
}

load_account_catalog() {
  config_path=$1
  output_file=$2
  CONFIG_PATH="$config_path" SCRIPT_DIR="$SCRIPT_DIR" OUTPUT_FILE="$output_file" node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const configPath = process.env.CONFIG_PATH;
const scriptDir = process.env.SCRIPT_DIR;
const outputFile = process.env.OUTPUT_FILE;
const DEFAULT_PRIVATE_PATH_TEMPLATE = "/api/bot/send_to_user/{id}";
const DEFAULT_GROUP_PATH_TEMPLATE = "/api/bot/send_to_group/{id}";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeBaseUrl(value) {
  return normalizeString(value).replace(/\/+$/g, "");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAccountId(value) {
  const normalized = normalizeString(value);
  return normalized || "default";
}

function uniquePush(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function walkUpEnvFiles(startDir) {
  const out = [];
  let current = path.resolve(startDir);
  while (true) {
    uniquePush(out, path.join(current, ".env"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function parseEnvFile(filePath) {
  const result = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
    result[key] = value;
  }
  return result;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
}

function toEnvKeyPart(accountId) {
  const normalized = normalizeAccountId(accountId).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized ? normalized.toUpperCase() : "DEFAULT";
}

const warnings = [];
let root = {};
let configLoaded = false;
let configExists = false;

if (configPath && fs.existsSync(configPath)) {
  configExists = true;
  try {
    root = JSON.parse(fs.readFileSync(configPath, "utf8"));
    configLoaded = true;
  } catch (error) {
    warnings.push(`配置文件读取失败，已继续使用 .env/交互输入兜底: ${error instanceof Error ? error.message : String(error)}`);
    root = {};
  }
}

const envCandidates = [];
if (process.env.VOCECHAT_ENV_FILE) {
  uniquePush(envCandidates, path.resolve(process.env.VOCECHAT_ENV_FILE));
}
for (const filePath of walkUpEnvFiles(process.cwd())) uniquePush(envCandidates, filePath);
for (const filePath of walkUpEnvFiles(scriptDir)) uniquePush(envCandidates, filePath);
if (configPath) {
  for (const filePath of walkUpEnvFiles(path.dirname(path.resolve(configPath)))) uniquePush(envCandidates, filePath);
}
uniquePush(envCandidates, path.join(os.homedir(), ".env"));

const envMap = {};
const envFilesUsed = [];
for (const filePath of envCandidates) {
  if (!fs.existsSync(filePath)) continue;
  try {
    const parsed = parseEnvFile(filePath);
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in envMap)) envMap[key] = value;
    }
    envFilesUsed.push(filePath);
  } catch (error) {
    warnings.push(`读取 .env 失败，已忽略: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string" && value.trim()) envMap[key] = value;
}

const channels = isRecord(root.channels) ? root.channels : {};
const section = isRecord(channels.vocechat) ? channels.vocechat : {};
const accountSection = isRecord(section.accounts) ? section.accounts : {};
const accountIds = Object.keys(accountSection).map((item) => normalizeAccountId(item));
if (!accountIds.includes("default")) accountIds.unshift("default");
if (accountIds.length === 0) accountIds.push("default");

const baseConfig = { ...section };
delete baseConfig.accounts;
const baseEnabled = section.enabled !== false;

const accounts = accountIds.map((accountId) => {
  const rawAccount = isRecord(accountSection[accountId]) ? accountSection[accountId] : {};
  const merged = { ...baseConfig, ...rawAccount };
  const envKeyPart = toEnvKeyPart(accountId);
  const fallbackBaseUrl = firstNonEmpty([
    envMap[`VOCECHAT_${envKeyPart}_BASE_URL`],
    envMap[`OPENCLAW_VOCECHAT_${envKeyPart}_BASE_URL`],
    envMap[`VOCECHAT_${envKeyPart}_URL`],
    accountId === "default" ? envMap.VOCECHAT_BASE_URL : "",
    accountId === "default" ? envMap.OPENCLAW_VOCECHAT_BASE_URL : "",
    accountId === "default" ? envMap.VOCECHAT_URL : "",
  ]);
  const fallbackApiKey = firstNonEmpty([
    envMap[`VOCECHAT_${envKeyPart}_API_KEY`],
    envMap[`OPENCLAW_VOCECHAT_${envKeyPart}_API_KEY`],
    envMap[`VOCECHAT_${envKeyPart}_BOT_API_KEY`],
    accountId === "default" ? envMap.VOCECHAT_API_KEY : "",
    accountId === "default" ? envMap.OPENCLAW_VOCECHAT_API_KEY : "",
    accountId === "default" ? envMap.VOCECHAT_BOT_API_KEY : "",
    accountId === "default" ? envMap.OPENCLAW_VOCECHAT_BOT_API_KEY : "",
  ]);

  const baseUrl = sanitizeBaseUrl(firstNonEmpty([merged.baseUrl, fallbackBaseUrl]));
  const apiKey = firstNonEmpty([merged.apiKey, fallbackApiKey]);
  return {
    accountId,
    name: normalizeString(merged.name),
    enabled: baseEnabled && merged.enabled !== false,
    baseUrl,
    apiKey,
    privatePathTemplate: normalizeString(merged.privatePathTemplate) || DEFAULT_PRIVATE_PATH_TEMPLATE,
    groupPathTemplate: normalizeString(merged.groupPathTemplate) || DEFAULT_GROUP_PATH_TEMPLATE,
    defaultTo: normalizeString(merged.defaultTo),
    configured: Boolean(baseUrl && apiKey),
  };
});

fs.writeFileSync(
  outputFile,
  JSON.stringify(
    {
      configPath,
      configExists,
      configLoaded,
      envFilesUsed,
      warnings,
      accounts,
    },
    null,
    2,
  ),
);
NODE
}

catalog_string_value() {
  json_path=$1
  expression=$2
  node --input-type=commonjs - "$json_path" "$expression" <<'NODE'
const fs = require("fs");
const [jsonPath, expression] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const parts = expression.split(".");
let current = data;
for (const part of parts) {
  if (!part) continue;
  if (Array.isArray(current)) {
    current = current[Number(part)];
  } else if (current && typeof current === "object") {
    current = current[part];
  } else {
    current = "";
    break;
  }
}
if (typeof current === "string") {
  process.stdout.write(current);
} else if (typeof current === "number" || typeof current === "boolean") {
  process.stdout.write(String(current));
}
NODE
}

catalog_number_value() {
  json_path=$1
  expression=$2
  node --input-type=commonjs - "$json_path" "$expression" <<'NODE'
const fs = require("fs");
const [jsonPath, expression] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const parts = expression.split(".");
let current = data;
for (const part of parts) {
  if (!part) continue;
  if (Array.isArray(current)) {
    current = current[Number(part)];
  } else if (current && typeof current === "object") {
    current = current[part];
  } else {
    current = 0;
    break;
  }
}
if (typeof current === "number") {
  process.stdout.write(String(current));
  process.exit(0);
}
if (Array.isArray(current)) {
  process.stdout.write(String(current.length));
  process.exit(0);
}
process.stdout.write("0");
NODE
}

print_warnings() {
  json_path=$1
  node --input-type=commonjs - "$json_path" <<'NODE'
const fs = require("fs");
const jsonPath = process.argv[2];
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
for (const warning of data.warnings || []) {
  process.stdout.write(`${warning}\n`);
}
NODE
}

print_account_menu() {
  json_path=$1
  node --input-type=commonjs - "$json_path" <<'NODE'
const fs = require("fs");
const jsonPath = process.argv[2];
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
for (const [index, account] of (data.accounts || []).entries()) {
  const label = account.name ? `${account.accountId} (${account.name})` : account.accountId;
  const enabled = account.enabled ? "启用" : "禁用";
  const configured = account.configured ? "已配置" : "待补全";
  const defaultTo = account.defaultTo ? ` 默认目标=${account.defaultTo}` : "";
  process.stdout.write(`${index + 1}. ${label} | ${enabled} | ${configured}${defaultTo}\n`);
}
NODE
}

account_field_value() {
  json_path=$1
  index=$2
  field=$3
  node --input-type=commonjs - "$json_path" "$index" "$field" <<'NODE'
const fs = require("fs");
const jsonPath = process.argv[2];
const index = Number(process.argv[3]) - 1;
const field = process.argv[4];
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const account = (data.accounts || [])[index];
if (!account) process.exit(2);
const value = account[field];
if (typeof value === "boolean") {
  process.stdout.write(value ? "true" : "false");
} else if (typeof value === "string" || typeof value === "number") {
  process.stdout.write(String(value));
}
NODE
}

parse_prepare_file_id() {
  response_file=$1
  node --input-type=commonjs - "$response_file" <<'NODE'
const fs = require("fs");
const raw = fs.readFileSync(process.argv[2], "utf8").trim();
let fileId = raw.replace(/^"+|"+$/g, "").trim();
if (!fileId) {
  try {
    const parsed = JSON.parse(raw);
    fileId = String(parsed.file_id || parsed.fileId || parsed.id || "").trim();
  } catch {
    fileId = "";
  }
}
if (!fileId) process.exit(2);
process.stdout.write(fileId);
NODE
}

parse_upload_path() {
  response_file=$1
  node --input-type=commonjs - "$response_file" <<'NODE'
const fs = require("fs");
const raw = fs.readFileSync(process.argv[2], "utf8").trim();
let uploadPath = "";
try {
  const parsed = JSON.parse(raw);
  uploadPath = String(parsed.path || "").trim();
} catch {
  uploadPath = "";
}
if (!uploadPath) process.exit(2);
process.stdout.write(uploadPath);
NODE
}

parse_message_id() {
  response_file=$1
  node --input-type=commonjs - "$response_file" <<'NODE'
const fs = require("fs");
const rawBody = fs.readFileSync(process.argv[2], "utf8").trim();
if (!rawBody) process.exit(0);
let messageId = "";
try {
  const parsed = JSON.parse(rawBody);
  const data = parsed && typeof parsed.data === "object" ? parsed.data : {};
  const result = parsed && typeof parsed.result === "object" ? parsed.result : {};
  const candidates = [
    parsed.messageId,
    parsed.message_id,
    parsed.msgId,
    parsed.msg_id,
    parsed.id,
    data.id,
    data.messageId,
    result.id,
    result.messageId,
  ];
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized) {
      messageId = normalized;
      break;
    }
  }
} catch {
  messageId = rawBody;
}
if (messageId) process.stdout.write(messageId);
NODE
}

send_text_message() {
  url=$1
  api_key=$2
  text=$3
  response_file=$4
  status=$(curl \
    --silent \
    --show-error \
    --location \
    --output "$response_file" \
    --write-out "%{http_code}" \
    --request POST \
    --header "x-api-key: $api_key" \
    --header "content-type: text/plain" \
    --header "accept: application/json, text/plain;q=0.9, */*;q=0.8" \
    --data-binary "$text" \
    "$url") || die "文本发送失败，curl 请求异常"

  case "$status" in
    2*)
      return 0
      ;;
    *)
      body=$(cat "$response_file")
      die "文本发送失败，HTTP $status: $body"
      ;;
  esac
}

send_attachment_message() {
  url=$1
  api_key=$2
  payload_type=$3
  upload_path=$4
  response_file=$5
  json_payload=$(node --input-type=commonjs - "$upload_path" <<'NODE'
const uploadPath = String(process.argv[2] ?? "");
process.stdout.write(JSON.stringify({ path: uploadPath }));
NODE
)

  status=$(curl \
    --silent \
    --show-error \
    --location \
    --output "$response_file" \
    --write-out "%{http_code}" \
    --request POST \
    --header "x-api-key: $api_key" \
    --header "content-type: $payload_type" \
    --header "accept: application/json, text/plain;q=0.9, */*;q=0.8" \
    --data "$json_payload" \
    "$url") || die "附件消息发送失败，curl 请求异常"

  case "$status" in
    2*)
      return 0
      ;;
    *)
      body=$(cat "$response_file")
      die "附件消息发送失败，HTTP $status: $body"
      ;;
  esac
}

prepare_upload() {
  base_url=$1
  api_key=$2
  content_type=$3
  file_name=$4
  response_file=$5
  payload=$(node --input-type=commonjs - "$content_type" "$file_name" <<'NODE'
const contentType = String(process.argv[2] ?? "").trim() || "application/octet-stream";
const fileName = String(process.argv[3] ?? "").trim() || "attachment.bin";
process.stdout.write(JSON.stringify({ content_type: contentType, filename: fileName }));
NODE
)

  status=$(curl \
    --silent \
    --show-error \
    --location \
    --output "$response_file" \
    --write-out "%{http_code}" \
    --request POST \
    --header "x-api-key: $api_key" \
    --header "content-type: application/json; charset=utf-8" \
    --header "accept: application/json, text/plain;q=0.9, */*;q=0.8" \
    --data "$payload" \
    "$base_url/api/bot/file/prepare") || die "附件预上传失败，curl 请求异常"

  case "$status" in
    2*)
      return 0
      ;;
    *)
      body=$(cat "$response_file")
      die "附件预上传失败，HTTP $status: $body"
      ;;
  esac
}

upload_file_chunk() {
  base_url=$1
  api_key=$2
  file_id=$3
  file_path=$4
  content_type=$5
  file_name=$6
  response_file=$7
  status=$(curl \
    --silent \
    --show-error \
    --location \
    --output "$response_file" \
    --write-out "%{http_code}" \
    --request POST \
    --header "x-api-key: $api_key" \
    --header "accept: application/json, text/plain;q=0.9, */*;q=0.8" \
    --form "file_id=$file_id" \
    --form "chunk_data=@$file_path;type=$content_type;filename=$file_name" \
    --form "chunk_is_last=true" \
    "$base_url/api/bot/file/upload") || die "附件上传失败，curl 请求异常"

  case "$status" in
    2*)
      return 0
      ;;
    *)
      body=$(cat "$response_file")
      die "附件上传失败，HTTP $status: $body"
      ;;
  esac
}

pick_default_account_index() {
  json_path=$1
  node --input-type=commonjs - "$json_path" <<'NODE'
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const accounts = data.accounts || [];
let index = 0;
for (let i = 0; i < accounts.length; i += 1) {
  if (accounts[i].enabled && accounts[i].configured) {
    index = i;
    break;
  }
}
process.stdout.write(String(index + 1));
NODE
}

POSITIONAL_FILE=""
ACCOUNT_ARG=""
TARGET_ARG=""
TEXT_ARG=""
FILE_ARG=""
BASE_URL_ARG=""
API_KEY_ARG=""
AUTO_CONFIRM="false"
NON_INTERACTIVE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --to)
      [ $# -ge 2 ] || die "--to 需要一个参数"
      TARGET_ARG=$2
      shift 2
      ;;
    --text)
      [ $# -ge 2 ] || die "--text 需要一个参数"
      TEXT_ARG=$2
      shift 2
      ;;
    --file)
      [ $# -ge 2 ] || die "--file 需要一个参数"
      FILE_ARG=$2
      shift 2
      ;;
    --account)
      [ $# -ge 2 ] || die "--account 需要一个参数"
      ACCOUNT_ARG=$2
      shift 2
      ;;
    --base-url)
      [ $# -ge 2 ] || die "--base-url 需要一个参数"
      BASE_URL_ARG=$2
      shift 2
      ;;
    --api-key)
      [ $# -ge 2 ] || die "--api-key 需要一个参数"
      API_KEY_ARG=$2
      shift 2
      ;;
    --yes|-y)
      AUTO_CONFIRM="true"
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE="true"
      shift
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        if [ -n "$POSITIONAL_FILE" ]; then
          die "仅支持一个位置参数"
        fi
        POSITIONAL_FILE=$1
        shift
      done
      ;;
    -*)
      die "未知参数: $1"
      ;;
    *)
      if [ -n "$POSITIONAL_FILE" ]; then
        die "仅支持一个位置参数"
      fi
      POSITIONAL_FILE=$1
      shift
      ;;
  esac
done

if [ -z "$FILE_ARG" ] && [ -n "$POSITIONAL_FILE" ]; then
  FILE_ARG=$POSITIONAL_FILE
fi

if [ -z "$TEXT_ARG" ] && [ -z "$FILE_ARG" ]; then
  usage
  exit 0
fi

require_cmd node
require_cmd curl
require_cmd mktemp

CONFIG_PATH=$(resolve_config_path)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vocechat-send.XXXXXX")
CATALOG_JSON="$TMP_DIR/catalog.json"

load_account_catalog "$CONFIG_PATH" "$CATALOG_JSON"

warnings=$(print_warnings "$CATALOG_JSON" || true)
if [ -n "$warnings" ]; then
  printf '%s\n' "$warnings" >&2
fi

config_exists=$(catalog_string_value "$CATALOG_JSON" "configExists")
env_file_count=$(catalog_number_value "$CATALOG_JSON" "envFilesUsed")
account_count=$(catalog_number_value "$CATALOG_JSON" "accounts")

if [ "$config_exists" = "true" ]; then
  log "OpenClaw 配置: $CONFIG_PATH"
else
  warn "未找到 OpenClaw 配置文件: $CONFIG_PATH，已继续使用 .env/交互输入兜底"
fi

if [ "$env_file_count" -gt 0 ]; then
  first_env=$(catalog_string_value "$CATALOG_JSON" "envFilesUsed.0")
  log ".env 兜底: $first_env"
fi

if [ "$account_count" -le 0 ]; then
  die "未发现任何可用的 VoceChat 账号信息"
fi

default_index=$(pick_default_account_index "$CATALOG_JSON")

if [ -n "$ACCOUNT_ARG" ]; then
  account_index=$(node --input-type=commonjs - "$CATALOG_JSON" "$ACCOUNT_ARG" <<'NODE'
const fs = require("fs");
const jsonPath = process.argv[2];
const requested = String(process.argv[3] ?? "").trim().toLowerCase();
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const index = (data.accounts || []).findIndex((account) => String(account.accountId || "").trim().toLowerCase() === requested);
if (index < 0) process.exit(2);
process.stdout.write(String(index + 1));
NODE
) || die "未找到账号: $ACCOUNT_ARG"
else
  if [ "$NON_INTERACTIVE" = "true" ]; then
    account_index=$default_index
  else
    log ""
    log "可用 VoceChat 账号:"
    print_account_menu "$CATALOG_JSON"
    account_index=$(prompt "选择账号序号" "$default_index")
  fi
fi

ACCOUNT_ID=$(account_field_value "$CATALOG_JSON" "$account_index" "accountId") || die "无效的账号序号: $account_index"
ACCOUNT_NAME=$(account_field_value "$CATALOG_JSON" "$account_index" "name" || true)
ACCOUNT_ENABLED=$(account_field_value "$CATALOG_JSON" "$account_index" "enabled" || true)
BASE_URL=$(account_field_value "$CATALOG_JSON" "$account_index" "baseUrl" || true)
API_KEY=$(account_field_value "$CATALOG_JSON" "$account_index" "apiKey" || true)
PRIVATE_PATH_TEMPLATE=$(account_field_value "$CATALOG_JSON" "$account_index" "privatePathTemplate" || true)
GROUP_PATH_TEMPLATE=$(account_field_value "$CATALOG_JSON" "$account_index" "groupPathTemplate" || true)
DEFAULT_TO=$(account_field_value "$CATALOG_JSON" "$account_index" "defaultTo" || true)

if [ -n "$BASE_URL_ARG" ]; then
  BASE_URL=$BASE_URL_ARG
fi
if [ -n "$API_KEY_ARG" ]; then
  API_KEY=$API_KEY_ARG
fi

if [ -z "$BASE_URL" ]; then
  if [ "$NON_INTERACTIVE" = "true" ]; then
    die "缺少 baseUrl，请通过配置、.env 或 --base-url 提供"
  fi
  BASE_URL=$(prompt "该账号缺少 baseUrl，请输入 VoceChat 服务地址")
fi
[ -n "$BASE_URL" ] || die "baseUrl 不能为空"

if [ -z "$API_KEY" ]; then
  if [ "$NON_INTERACTIVE" = "true" ]; then
    die "缺少 apiKey，请通过配置、.env 或 --api-key 提供"
  fi
  API_KEY=$(prompt_secret "该账号缺少 apiKey，请输入 VoceChat API Key")
fi
[ -n "$API_KEY" ] || die "apiKey 不能为空"

if [ -z "$TARGET_ARG" ]; then
  if [ "$NON_INTERACTIVE" = "true" ]; then
    [ -n "$DEFAULT_TO" ] || die "缺少目标，请通过 --to 提供，或先在配置里设置 defaultTo"
    TARGET_ARG=$DEFAULT_TO
  else
    TARGET_ARG=$(prompt "输入目标 (user:2 / group:5 / 纯数字)" "$DEFAULT_TO")
  fi
fi
[ -n "$TARGET_ARG" ] || die "目标不能为空"

target_line=$(normalize_target "$TARGET_ARG") || die "目标格式无效，请使用 user:2 / group:5 / 纯数字"
IFS='	' read -r TARGET_KIND TARGET_ID NORMALIZED_TARGET <<EOF
$target_line
EOF

if [ -z "$TEXT_ARG" ] && [ -z "$FILE_ARG" ]; then
  if [ "$NON_INTERACTIVE" = "true" ]; then
    die "至少需要 --text 或 --file 之一"
  fi
  TEXT_ARG=$(prompt "输入文本（可留空）")
fi

ATTACHMENT_FILE=""
FILE_NAME=""
CONTENT_TYPE=""
PAYLOAD_CONTENT_TYPE=""
if [ -n "$FILE_ARG" ]; then
  if [ -f "$FILE_ARG" ]; then
    ATTACHMENT_FILE=$FILE_ARG
  elif echo "$FILE_ARG" | grep -Eq '^https?://'; then
    ATTACHMENT_FILE=$(download_remote_attachment "$FILE_ARG")
  else
    die "附件不存在，也不是有效的 http/https URL: $FILE_ARG"
  fi

  FILE_NAME=$(basename "$ATTACHMENT_FILE")
  CONTENT_TYPE=$(detect_content_type "$ATTACHMENT_FILE")
  case "$CONTENT_TYPE" in
    audio/*)
      PAYLOAD_CONTENT_TYPE="vocechat/audio"
      ;;
    *)
      PAYLOAD_CONTENT_TYPE="vocechat/file"
      ;;
  esac
fi

if [ "$TARGET_KIND" = "group" ]; then
  SEND_URL=$(build_send_url "$BASE_URL" "$GROUP_PATH_TEMPLATE" "$TARGET_ID")
else
  SEND_URL=$(build_send_url "$BASE_URL" "$PRIVATE_PATH_TEMPLATE" "$TARGET_ID")
fi

log ""
log "发送确认:"
log "  账号: ${ACCOUNT_ID}${ACCOUNT_NAME:+ ($ACCOUNT_NAME)}"
log "  状态: $( [ "$ACCOUNT_ENABLED" = "true" ] && printf '启用' || printf '禁用' )"
log "  Base URL: $BASE_URL"
log "  目标: $NORMALIZED_TARGET"
if [ -n "$TEXT_ARG" ]; then
  log "  文本: $TEXT_ARG"
fi
if [ -n "$ATTACHMENT_FILE" ]; then
  log "  附件: $ATTACHMENT_FILE"
  log "  MIME: $CONTENT_TYPE"
fi

if [ "$AUTO_CONFIRM" != "true" ]; then
  confirm=$(prompt "确认发送？输入 y 继续" "y")
  case "$confirm" in
    y|Y|yes|YES)
      ;;
    *)
      die "已取消发送"
      ;;
  esac
fi

text_response="$TMP_DIR/text.json"
prepare_response="$TMP_DIR/prepare.json"
upload_response="$TMP_DIR/upload.json"
send_response="$TMP_DIR/send.json"

TEXT_MESSAGE_ID=""
MEDIA_MESSAGE_ID=""
UPLOAD_PATH=""

if [ -n "$TEXT_ARG" ]; then
  send_text_message "$SEND_URL" "$API_KEY" "$TEXT_ARG" "$text_response"
  TEXT_MESSAGE_ID=$(parse_message_id "$text_response" || true)
fi

if [ -n "$ATTACHMENT_FILE" ]; then
  prepare_upload "$BASE_URL" "$API_KEY" "$CONTENT_TYPE" "$FILE_NAME" "$prepare_response"
  FILE_ID=$(parse_prepare_file_id "$prepare_response") || die "无法解析 file/prepare 返回的 file_id"

  upload_file_chunk "$BASE_URL" "$API_KEY" "$FILE_ID" "$ATTACHMENT_FILE" "$CONTENT_TYPE" "$FILE_NAME" "$upload_response"
  UPLOAD_PATH=$(parse_upload_path "$upload_response") || die "无法解析 file/upload 返回的 path"

  send_attachment_message "$SEND_URL" "$API_KEY" "$PAYLOAD_CONTENT_TYPE" "$UPLOAD_PATH" "$send_response"
  MEDIA_MESSAGE_ID=$(parse_message_id "$send_response" || true)
fi

log ""
log "发送成功"
if [ -n "$TEXT_MESSAGE_ID" ]; then
  log "  文本消息 ID: $TEXT_MESSAGE_ID"
fi
if [ -n "$UPLOAD_PATH" ]; then
  log "  上传路径: $UPLOAD_PATH"
fi
if [ -n "$MEDIA_MESSAGE_ID" ]; then
  log "  附件消息 ID: $MEDIA_MESSAGE_ID"
fi
