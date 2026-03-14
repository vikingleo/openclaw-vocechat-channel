#!/usr/bin/env sh
set -eu

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
TARGET_DIR="${OPENCLAW_VOCECHAT_INSTALL_PATH:-}"

if [ -z "$TARGET_DIR" ] && [ -f "$CONFIG_PATH" ]; then
  TARGET_DIR="$(node -e '
const fs = require("fs");
const file = process.argv[1];
try {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const installPath = json?.plugins?.installs?.vocechat?.installPath;
  if (typeof installPath === "string" && installPath.trim()) process.stdout.write(installPath.trim());
} catch {}
' "$CONFIG_PATH")"
fi

if [ -z "$TARGET_DIR" ]; then
  TARGET_DIR="$HOME/.openclaw/extensions/vocechat"
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "target not found: $TARGET_DIR" >&2
  exit 1
fi

copy_if_needed() {
  src="$1"
  dst="$2"
  if [ -e "$dst" ] && cmp -s "$src" "$dst"; then
    return 0
  fi
  install -m 0644 "$src" "$dst"
}

copy_if_needed "$SOURCE_DIR/index.ts" "$TARGET_DIR/index.ts"

if [ -f "$SOURCE_DIR/package.json" ]; then
  copy_if_needed "$SOURCE_DIR/package.json" "$TARGET_DIR/package.json"
fi

if [ -f "$SOURCE_DIR/tsconfig.json" ]; then
  copy_if_needed "$SOURCE_DIR/tsconfig.json" "$TARGET_DIR/tsconfig.json"
fi

if [ -d "$SOURCE_DIR/src" ]; then
  mkdir -p "$TARGET_DIR/src"
  find "$SOURCE_DIR/src" -type f | while IFS= read -r file; do
    rel="${file#"$SOURCE_DIR/"}"
    mkdir -p "$TARGET_DIR/$(dirname "$rel")"
    copy_if_needed "$file" "$TARGET_DIR/$rel"
  done
fi

if [ -f "$SOURCE_DIR/openclaw-plugin-sdk.d.ts" ]; then
  copy_if_needed "$SOURCE_DIR/openclaw-plugin-sdk.d.ts" "$TARGET_DIR/openclaw-plugin-sdk.d.ts"
fi

cd "$TARGET_DIR"
npm run build
