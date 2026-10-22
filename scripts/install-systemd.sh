#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

mkdir -p "$DIR/logs" "$UNIT_DIR/default.target.wants"
chmod 700 "$DIR/logs"
chmod 600 "$DIR/.env" 2>/dev/null || true

NODE_BIN="$(command -v node || echo /usr/bin/node)"
TASKS_DIR="$(sed -n 's/^TASKS_DIR=//p' "$DIR/.env" 2>/dev/null | head -n1)"
TASKS_DIR="${TASKS_DIR:-$HOME/bridge-tasks}"

render_unit() {
  # Units ship with __BRIDGE_DIR__/__HOME__/__TASKS_DIR__/__NODE__ placeholders.
  sed -e "s|__BRIDGE_DIR__|$DIR|g" \
      -e "s|__TASKS_DIR__|$TASKS_DIR|g" \
      -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__HOME__|$HOME|g" \
      "$1" > "$2"
  chmod 644 "$2"
}

render_unit "$DIR/systemd/hermes-mcp-bridge.service" "$UNIT_DIR/hermes-mcp-bridge.service"
render_unit "$DIR/systemd/hermes-mcp-tunnel.service" "$UNIT_DIR/hermes-mcp-tunnel.service"
ln -sfn ../hermes-mcp-bridge.service "$UNIT_DIR/default.target.wants/hermes-mcp-bridge.service"
ln -sfn ../hermes-mcp-tunnel.service "$UNIT_DIR/default.target.wants/hermes-mcp-tunnel.service"

reload_units() {
  if systemctl --user daemon-reload >/dev/null 2>&1; then
    return 0
  fi
  busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
    org.freedesktop.systemd1.Manager Reload >/dev/null
}

restart_unit() {
  local unit="$1"
  if systemctl --user restart "$unit" >/dev/null 2>&1; then
    return 0
  fi
  busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
    org.freedesktop.systemd1.Manager RestartUnit ss "$unit" replace >/dev/null
}

reload_units
restart_unit hermes-mcp-bridge.service

PORT="$(sed -n 's/^MCP_PORT=//p' "$DIR/.env" | head -n1)"
PORT="${PORT:-8765}"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

restart_unit hermes-mcp-tunnel.service
echo "Installed and started hermes-mcp-bridge.service and hermes-mcp-tunnel.service."
echo "Public URL appears in $DIR/PUBLIC_URL after the tunnel handshake."
