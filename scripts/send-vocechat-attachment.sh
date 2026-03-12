#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ $# -eq 0 ]; then
  exec sh "$SCRIPT_DIR/vocechat-send.sh" --help
fi

attachment=$1
shift

exec sh "$SCRIPT_DIR/vocechat-send.sh" --file "$attachment" "$@"
