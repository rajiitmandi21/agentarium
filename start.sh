#!/usr/bin/env bash
# Start the Agentarium app (Khira task tracker) on http://localhost:4747
#
# Default mode: static server via `python3 -m http.server` (unchanged).
# API mode:     Node read API server (server.js) that also serves the SPA.
#               Enable with `AGENTARIUM_API=1 ./start.sh` or `./start.sh --api`.
# Override port with: PORT=5555 ./start.sh
set -euo pipefail

PORT="${PORT:-4747}"
cd "$(dirname "$0")"

# Mode selection: AGENTARIUM_API=1 env or --api flag launches the Node API server.
API_MODE="${AGENTARIUM_API:-0}"
for arg in "$@"; do
  case "$arg" in
    --api) API_MODE=1 ;;
  esac
done

# If port is busy, only stop a prior server this repo launched (python http.server
# or our own server.js) — never arbitrary processes.
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  killed=0
  for pid in $(lsof -ti:"$PORT"); do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if echo "$cmd" | grep -Eq 'python[0-9.]* .*http\.server.*( '"$PORT"'|$PORT)'; then
      echo "Port $PORT busy — stopping prior python http.server (pid $pid)"
      kill "$pid" 2>/dev/null || true
      killed=1
    elif echo "$cmd" | grep -Eq 'node .*server\.js'; then
      echo "Port $PORT busy — stopping prior Agentarium API server (pid $pid)"
      kill "$pid" 2>/dev/null || true
      killed=1
    else
      echo "Port $PORT is in use by another process (pid $pid): $cmd"
      echo "Stop that process or run with a different port, e.g. PORT=5555 ./start.sh"
      exit 1
    fi
  done
  if [ "$killed" = 1 ]; then
    sleep 0.3
  fi
fi

URL="http://localhost:$PORT/"

# Open the browser (macOS); ignore failure on other OSes
( sleep 0.5 && command -v open >/dev/null && open "$URL" ) &

if [ "$API_MODE" = "1" ]; then
  echo "Agentarium (API mode) → $URL"
  exec env PORT="$PORT" node server.js
fi

echo "Agentarium → $URL"
exec python3 -m http.server "$PORT"
