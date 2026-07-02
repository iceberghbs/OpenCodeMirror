#!/usr/bin/env bash
# oc-telebot uninstaller — reverses what install.sh did.
# Usage:  cd /path/to/oc_telebot && ./scripts/uninstall.sh
set -euo pipefail

OC_DIR="${HOME}/.config/opencode"
SHIM_PATH="$OC_DIR/plugins/oc-telebot.ts"
TUI_JSON="$OC_DIR/tui.json"
ENV_PATH="$OC_DIR/oc-telebot.env"
STATE_FILE="/tmp/oc-telebot.state.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TUI_TSX="${REPO_DIR}/src/tui.tsx"

# ── Check prerequisites ─────────────────────────────────────────────────────
# 1. node or bun required for JSON manipulation
JSON_RUNNER=""
for cmd in node bun; do
  if command -v "$cmd" >/dev/null 2>&1; then
    JSON_RUNNER="$cmd"; break
  fi
done
if [ -z "$JSON_RUNNER" ]; then
  echo "ERROR: node or bun required for JSON manipulation. Install one and retry."
  exit 1
fi

# 2. Warn if opencode is running
if pgrep -x opencode >/dev/null 2>&1; then
  echo "WARNING: opencode is running. Stop opencode before uninstalling to avoid issues."
  read -rp "Continue anyway? [y/N] " CONT
  case "$CONT" in [yY]*) ;; *) echo "Aborted."; exit 0 ;; esac
  echo ""
fi

# 3. Note if repo is not at expected location (e.g. script run from elsewhere)
if [ ! -d "${REPO_DIR}/src" ]; then
  echo "NOTE: repo not found at $REPO_DIR — exact-match cleanup will rely on path suffix fallback."
  echo ""
fi

# ── Preview ─────────────────────────────────────────────────────────────────
echo "oc-telebot uninstaller"
echo ""
echo "The following will be removed or cleaned:"
echo -n "  $SHIM_PATH — "
[ -f "$SHIM_PATH" ] && echo "plugin shim" || echo "not found (skip)"
echo -n "  $TUI_JSON   — "
[ -f "$TUI_JSON" ] && echo "TUI plugin entry" || echo "not found (skip)"
echo -n "  $ENV_PATH  — "
[ -f "$ENV_PATH" ] && echo "credentials (will prompt before removal)" || echo "not found (skip)"
echo -n "  $STATE_FILE  — "
[ -f "$STATE_FILE" ] && echo "runtime state" || echo "not found (skip)"
echo ""

read -rp "Proceed? [Y/n] " CONFIRM
case "$CONFIRM" in [nN]*) echo "Aborted."; exit 0 ;; esac
echo ""

# ── 1. Remove plugin shim ──────────────────────────────────────────────────
if [ -f "$SHIM_PATH" ]; then
  if [ ! -w "$SHIM_PATH" ]; then
    echo "ERROR: no write permission for $SHIM_PATH (try sudo or check ownership)"
    exit 1
  fi
  rm "$SHIM_PATH"
  echo "Removed: $SHIM_PATH"
fi

# ── 2. Clean TUI plugin entry from tui.json ─────────────────────────────────
if [ -f "$TUI_JSON" ]; then
  if [ ! -w "$TUI_JSON" ]; then
    echo "ERROR: no write permission for $TUI_JSON"
    exit 1
  fi
  STDERR_TMP=$(mktemp)
  RESULT=$("$JSON_RUNNER" -e '
    const fs = require("fs");
    const file = process.argv[1];
    const exactPath = process.argv[2];
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.log("malformed"); process.exit(0); }
    const arr = Array.isArray(j.plugin) ? j.plugin : null;
    if (!arr) { console.log("not-array"); process.exit(0); }
    // Two-pass: exact match first, then suffix match (repo may have moved)
    let removed = false;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] === exactPath) { arr.splice(i, 1); removed = true; break; }
    }
    if (!removed) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].endsWith("/src/tui.tsx")) { arr.splice(i, 1); removed = true; break; }
      }
    }
    if (!removed) { console.log("not-found"); process.exit(0); }
    j.plugin = arr;
    if (arr.length === 0) delete j.plugin;
    const keys = Object.keys(j);
    if (keys.length === 0 || (keys.length === 1 && j["$schema"])) {
      fs.unlinkSync(file);
      console.log("deleted-file");
    } else {
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
      console.log("updated");
    }
  ' "$TUI_JSON" "$TUI_TSX" 2>"$STDERR_TMP") || RESULT="error"

  case "$RESULT" in
    malformed)    echo "Skipping: $TUI_JSON is malformed — manual cleanup may be needed" ;;
    not-array)    echo "Skipping: plugin field in $TUI_JSON is not an array" ;;
    not-found)    echo "No oc-telebot entry found in $TUI_JSON (repo may have moved)" ;;
    deleted-file) echo "Removed empty file: $TUI_JSON" ;;
    updated)      echo "Cleaned TUI entry from $TUI_JSON" ;;
    error)        echo "Error during JSON cleanup:"; cat "$STDERR_TMP" >&2 ;;
    *)            echo "Unexpected result from JSON cleanup: $RESULT"; cat "$STDERR_TMP" >&2 ;;
  esac
  rm -f "$STDERR_TMP"
fi

# ── 3. Remove credentials file ──────────────────────────────────────────────
if [ -f "$ENV_PATH" ]; then
  read -rp "Remove credentials file ($ENV_PATH)? [Y/n] " RM_ENV
  case "$RM_ENV" in
    [nN]*) echo "Kept: $ENV_PATH" ;;
    *)
      if [ ! -w "$ENV_PATH" ]; then
        echo "ERROR: no write permission for $ENV_PATH"
        exit 1
      fi
      rm "$ENV_PATH"
      echo "Removed: $ENV_PATH"
      ;;
  esac
fi

# ── 4. Remove state file ────────────────────────────────────────────────────
if [ -f "$STATE_FILE" ]; then
  if [ ! -w "$STATE_FILE" ]; then
    echo "Skipping: no write permission for $STATE_FILE"
  else
    rm "$STATE_FILE"
    echo "Removed: $STATE_FILE"
  fi
fi

echo ""
echo "Uninstall complete."
