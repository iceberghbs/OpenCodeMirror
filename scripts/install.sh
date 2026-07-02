#!/usr/bin/env bash
# oc-telebot installer — sets up loader shims + config for the current user.
# Usage:  cd /path/to/oc_telebot && ./scripts/install.sh
set -euo pipefail

# ── Resolve the repo path (parent of scripts/) ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "oc-telebot installer"
echo "  repo: $REPO_DIR"
echo ""

# ── Check prerequisites ─────────────────────────────────────────────────────
if ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: opencode not found in PATH. Install opencode first."
  exit 1
fi

# ── Create opencode config dir ──────────────────────────────────────────────
OC_DIR="${HOME}/.config/opencode"
PLUGINS_DIR="$OC_DIR/plugins"
mkdir -p "$PLUGINS_DIR"

# ── 1. Server plugin shim ───────────────────────────────────────────────────
SHIM_PATH="$PLUGINS_DIR/oc-telebot.ts"
echo "[1/3] Writing server plugin shim → $SHIM_PATH"
cat > "$SHIM_PATH" <<EOF
export { default } from "${REPO_DIR}/src/server.ts"
EOF
echo "      done"

# ── 2. TUI plugin entry in tui.json ─────────────────────────────────────────
TUI_JSON="$OC_DIR/tui.json"
TUI_TSX="${REPO_DIR}/src/tui.tsx"
echo "[2/3] Configuring TUI plugin → $TUI_JSON"

if [ -f "$TUI_JSON" ]; then
  # Patch existing: add tui.tsx to plugin[] if not already present
  if grep -qF "$TUI_TSX" "$TUI_JSON"; then
    echo "      already present, skipping"
  else
    # Use node to safely merge into the JSON plugin array
    node -e "
      const fs = require('fs');
      const p = process.argv[1];
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const arr = Array.isArray(j.plugin) ? j.plugin : [];
      if (!arr.includes(process.argv[2])) arr.push(process.argv[2]);
      j.plugin = arr;
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    " "$TUI_JSON" "$TUI_TSX"
    echo "      added to plugin[]"
  fi
else
  # Create new tui.json
  cat > "$TUI_JSON" <<EOF
{
  "\$schema": "https://opencode.ai/tui.json",
  "plugin": ["${TUI_TSX}"]
}
EOF
  echo "      created"
fi

# ── 3. Config file (token + chat_id) ───────────────────────────────────────
ENV_PATH="$OC_DIR/oc-telebot.env"
echo "[3/3] Configuring bot credentials → $ENV_PATH"

if [ -f "$ENV_PATH" ]; then
  echo "      already exists — leaving untouched"
  echo "      edit manually if token/chat_id changed: $ENV_PATH"
else
  echo ""
  echo "  Get your bot token from @BotFather, and your chat_id from @userinfobot."
  echo ""
  read -rp "  Bot token: " TOKEN
  read -rp "  Chat ID:   " CHAT_ID

  if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo "ERROR: token and chat_id are required."
    echo "       Create $ENV_PATH manually later."
    exit 1
  fi

  cat > "$ENV_PATH" <<EOF
OC_TELEBOT_TOKEN=${TOKEN}
OC_TELEBOT_CHAT_ID=${CHAT_ID}
EOF
  chmod 600 "$ENV_PATH"
  echo "      written (chmod 600)"
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "Installation complete."
echo ""
echo "Next steps:"
echo "  1. Run: opencode"
echo "  2. In the TUI, run /telegram to activate the current session"
echo "  3. Sidebar should show telebot status"
echo ""
echo "Optional env overrides (in $ENV_PATH):"
echo "  OC_TELEBOT_MODE=quiet|full   (default: full)"
echo "  OC_TELEBOT_DEBUG=1           (verbose stderr)"
echo "  OC_TELEBOT_DUMP_STREAM=1     (event dump to /tmp/oc-telebot-stream-dump.jsonl)"
