#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

node "$DIR/scripts/gen-token.mjs"

if command -v systemctl >/dev/null 2>&1 && systemctl --user restart hermes-mcp-bridge.service >/dev/null 2>&1; then
  echo "Bridge restarted with the new token."
elif command -v busctl >/dev/null 2>&1 && busctl --user call \
  org.freedesktop.systemd1 /org/freedesktop/systemd1 \
  org.freedesktop.systemd1.Manager RestartUnit \
  ss hermes-mcp-bridge.service replace >/dev/null 2>&1; then
  echo "Bridge restarted with the new token."
else
  echo "Token rotated. Restart hermes-mcp-bridge.service manually." >&2
  exit 1
fi

echo "New token is only in $DIR/.env (mode 600). Update the client agent to read that file; never paste the token in chat."
