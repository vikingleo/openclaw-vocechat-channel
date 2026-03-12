#!/bin/sh

set -eu

SKILL_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
STATE_DIR="${OPENCLAW_STATE_DIR:-${CLAWDBOT_STATE_DIR:-$HOME/.openclaw}}"

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

resolve_from_plugin_info() {
  command -v openclaw >/dev/null 2>&1 || return 1
  openclaw plugins info vocechat >/dev/null 2>&1 || return 1

  plugin_info=$(openclaw plugins info vocechat 2>/dev/null || true)
  [ -n "$plugin_info" ] || return 1

  plugin_dir=$(printf '%s' "$plugin_info" | node --input-type=commonjs -e '
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
')

  [ -n "$plugin_dir" ] || return 1
  plugin_dir=$(expand_home "$plugin_dir")
  target="$plugin_dir/scripts/vocechat-send.sh"
  [ -f "$target" ] || return 1
  printf '%s\n' "$target"
}

find_sender_script() {
  for candidate in \
    "${OPENCLAW_VOCECHAT_SEND_SCRIPT:-}" \
    "$(resolve_from_plugin_info 2>/dev/null || true)" \
    "$(expand_home "$STATE_DIR")/extensions/vocechat/scripts/vocechat-send.sh" \
    "$SKILL_DIR/../../../scripts/vocechat-send.sh"
  do
    [ -n "$candidate" ] || continue
    candidate=$(expand_home "$candidate")
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

SENDER_SCRIPT=$(find_sender_script) || {
  printf '%s\n' "错误: 未找到 vocechat-send.sh，请确认 VoceChat 插件已安装，或设置 OPENCLAW_VOCECHAT_SEND_SCRIPT" >&2
  exit 1
}

exec sh "$SENDER_SCRIPT" "$@"
