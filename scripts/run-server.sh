#!/usr/bin/env bash
# Runs HEISS UI as a server (no browser) from a source checkout, in the background.
#
#   ./scripts/run-server.sh                           start (or restart)
#   ./scripts/run-server.sh stop | status | logs      manage it
#   ./scripts/run-server.sh --foreground              run in this terminal
#
# ComfyUI is looked for in /workspace/ComfyUI; set HEISS_COMFY_ROOT for another folder.
#
# Installs packages and builds the studio when needed (first run, a changed
# package-lock.json, a new commit), then starts it in the background with a
# new studio password, printed here and kept in data/server-password.txt
# (readable by you only). A new password signs every device out. Any variable
# below can be set in the shell instead; the shell wins.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p data
pid_file="data/server.pid"
log_file="data/server.log"
password_file="data/server-password.txt"

running_pid() {
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
}

stop_server() {
  local pid
  pid="$(running_pid)"
  if [ -z "$pid" ]; then rm -f "$pid_file"; return 1; fi
  # The whole group: the start script and the server it runs.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f "$pid_file"
  return 0
}

foreground=0
case "${1:-start}" in
  stop)
    if stop_server; then echo "HEISS UI stopped."; else echo "HEISS UI isn't running."; fi
    exit 0 ;;
  status)
    pid="$(running_pid)"
    if [ -n "$pid" ]; then echo "HEISS UI is running (pid $pid). Log: $log_file"; else echo "HEISS UI isn't running."; fi
    exit 0 ;;
  logs)
    exec tail -n 100 -f "$log_file" ;;
  --foreground|-f) foreground=1 ;;
  start) ;;
  *)
    echo "Usage: $0 [start|stop|status|logs|--foreground]" >&2
    exit 2 ;;
esac

# ---- Settings ---------------------------------------------------------------
# ComfyUI's own folder (the one with models/ and output/ in it): model
# downloads land in its models folder.
export HEISS_COMFY_ROOT="${HEISS_COMFY_ROOT:-/workspace/ComfyUI}"
export COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
export COMFY_OUTPUT_DIR="${COMFY_OUTPUT_DIR:-${HEISS_COMFY_ROOT:+$HEISS_COMFY_ROOT/output}}"
export PORT="${PORT:-8787}"
export HOST="${HOST:-0.0.0.0}"
# The address other devices open the studio at.
export HEISS_ALLOWED_HOSTS="${HEISS_ALLOWED_HOSTS:-100.65.23.88}"
# Signed-in devices may install models and nodes, update, change folders.
export HEISS_ADMIN_FROM_DEVICES="${HEISS_ADMIN_FROM_DEVICES:-1}"
export HEISS_NO_BROWSER=1
# HEISS_STUDIO_PASSWORD: set it in the shell to keep a password of your own.
# Without it, every start makes a new one.
# -----------------------------------------------------------------------------

if [ -z "$HEISS_COMFY_ROOT" ] || [ ! -d "$HEISS_COMFY_ROOT/models" ]; then
  echo "No ComfyUI at $HEISS_COMFY_ROOT (a folder with models/ in it)." >&2
  echo "Set HEISS_COMFY_ROOT to ComfyUI's folder, e.g. HEISS_COMFY_ROOT=/path/to/ComfyUI $0" >&2
  exit 1
fi

# Packages: on the first run, and again when package-lock.json changed.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing packages…"
  npm ci --no-audit --no-fund
fi

# The studio itself: built when there is none yet, or it was built from another commit.
commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [ ! -f dist/index.html ] || [ "$(cat dist/.built-from 2>/dev/null)" != "$commit" ]; then
  echo "Building the studio…"
  npm run build
  echo "$commit" > dist/.built-from
fi

# A fresh password for this start, unless the shell chose one.
if [ -z "${HEISS_STUDIO_PASSWORD:-}" ]; then
  HEISS_STUDIO_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(15).toString("base64url"))')"
  export HEISS_STUDIO_PASSWORD
  (umask 077 && printf '%s\n' "$HEISS_STUDIO_PASSWORD" > "$password_file")
  password_note="Studio password: $HEISS_STUDIO_PASSWORD   (also in $password_file)"
else
  rm -f "$password_file"
  password_note="Studio password: the one in HEISS_STUDIO_PASSWORD"
fi

# One server at a time: a running one is replaced.
if stop_server; then echo "Stopped the HEISS UI that was running."; fi

url="http://${HEISS_ALLOWED_HOSTS%%,*}:$PORT"
if [ "$foreground" = 1 ]; then
  echo "$password_note"
  echo "Open $url"
  exec node scripts/start.mjs
fi

# Its own session (setsid), so it outlives this terminal and stops as one group.
setsid nohup node scripts/start.mjs >>"$log_file" 2>&1 < /dev/null &
echo $! > "$pid_file"
sleep 2
if [ -z "$(running_pid)" ]; then
  echo "HEISS UI didn't start. The end of $log_file:" >&2
  tail -n 30 "$log_file" >&2
  exit 1
fi

echo "HEISS UI is running in the background (pid $(cat "$pid_file"))."
echo "$password_note"
echo "Open $url"
echo "Log: $0 logs   Stop: $0 stop"
