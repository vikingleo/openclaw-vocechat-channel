#!/bin/sh

set -eu

SKILL_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
STATE_DIR="${OPENCLAW_STATE_DIR:-${CLAWDBOT_STATE_DIR:-$HOME/.openclaw}}"
PATH_HELPER="$SKILL_DIR/lib/openclaw-path-utils.cjs"
OPENCLAW_BIN="${OPENCLAW_BIN:-}"

have_cmd() {
  command -v "$1" >/dev/null 2>&1
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
  HOME_DIR="$HOME" node "$PATH_HELPER" expand-home "$1"
}

resolve_from_plugin_info() {
  OPENCLAW_RESOLVED_BIN=$(find_openclaw_bin) || return 1
  "$OPENCLAW_RESOLVED_BIN" plugins info vocechat >/dev/null 2>&1 || return 1

  plugin_info=$("$OPENCLAW_RESOLVED_BIN" plugins info vocechat 2>/dev/null || true)
  [ -n "$plugin_info" ] || return 1

  plugin_dir=$(printf '%s' "$plugin_info" | HOME_DIR="$HOME" node "$PATH_HELPER" plugin-dir-from-info)

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
