#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const home = String(process.env.HOME_DIR || process.env.HOME || os.homedir()).trim();
const mode = String(process.argv[2] || "").trim();

function trimQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function expandHomeLike(raw) {
  let value = trimQuotes(stripAnsi(String(raw || "").trim()));
  if (!value) return "";

  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }

  const parts = value.split(/[\\/]+/).filter(Boolean);
  const tildeIndex = parts.indexOf("~");
  if (tildeIndex >= 0) {
    const suffix = parts.slice(tildeIndex + 1);
    const candidate = path.join(home, ...suffix);
    const weirdPrefixPosix = `${home}/~/`;
    const weirdPrefixWindows = `${home}\\~\\`;
    if (
      !fs.existsSync(value) ||
      value.startsWith(weirdPrefixPosix) ||
      value.startsWith(weirdPrefixWindows)
    ) {
      return candidate;
    }
  }

  return value;
}

function resolvePathLike(raw) {
  const value = expandHomeLike(raw);
  if (!value) return "";
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function extractField(lines, prefix) {
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    if (value) return value;
  }
  return "";
}

function parsePluginDirFromInfo(raw) {
  const lines = stripAnsi(String(raw || ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidate =
    extractField(lines, "Install path:") ||
    extractField(lines, "Source path:") ||
    extractField(lines, "Source:");

  if (!candidate) return "";

  let resolved = expandHomeLike(candidate);
  if (!resolved) return "";

  if (/\.(?:[cm]?js|tsx?|jsx)$/i.test(resolved)) {
    resolved = path.dirname(resolved);
  }

  return resolvePathLike(resolved);
}

if (mode === "expand-home") {
  process.stdout.write(expandHomeLike(process.argv[3] || ""));
  process.exit(0);
}

if (mode === "resolve-path") {
  process.stdout.write(resolvePathLike(process.argv[3] || ""));
  process.exit(0);
}

if (mode === "plugin-dir-from-info") {
  const raw = fs.readFileSync(0, "utf8");
  process.stdout.write(parsePluginDirFromInfo(raw));
  process.exit(0);
}

process.stderr.write("unsupported mode\n");
process.exit(1);
