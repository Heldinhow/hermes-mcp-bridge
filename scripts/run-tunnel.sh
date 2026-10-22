#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$DIR/bin/cloudflared"
LOG_DIR="$DIR/logs"
LOG="$LOG_DIR/cloudflared.log"
PORT="$(sed -n 's/^MCP_PORT=//p' "$DIR/.env" | head -n1)"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Invalid or missing MCP_PORT in $DIR/.env" >&2
  exit 1
fi
if [ ! -x "$BIN" ]; then
  echo "Missing executable $BIN" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
: > "$LOG"
rm -f "$DIR/PUBLIC_URL" "$DIR/PUBLIC_URL.tmp"

"$BIN" tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" >>"$LOG" 2>&1 &
CF_PID=$!

(
  for _ in $(seq 1 180); do
    URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -n1 || true)"
    if [ -n "$URL" ]; then
      printf '%s\n' "$URL" > "$DIR/PUBLIC_URL.tmp"
      mv "$DIR/PUBLIC_URL.tmp" "$DIR/PUBLIC_URL"
      break
    fi
    sleep 1
  done
) &
WATCH_PID=$!

cleanup() {
  kill "$CF_PID" "$WATCH_PID" 2>/dev/null || true
  wait "$CF_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
}
trap cleanup TERM INT EXIT

wait "$CF_PID" || true
