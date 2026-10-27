#!/usr/bin/env bash
# Runs HEISS UI as a server (no browser) from a source checkout.
#
#   HEISS_COMFY_ROOT=/path/to/ComfyUI ./scripts/run-server.sh
#
# Installs packages and builds the studio when needed (first run, a changed
# package-lock.json, a new commit), then starts it. Any variable below can be
# set in the shell instead; the shell wins.
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- Settings ---------------------------------------------------------------
# ComfyUI's own folder (the one with models/ and output/ in it). Required:
# model downloads land in its models folder.
export HEISS_COMFY_ROOT="${HEISS_COMFY_ROOT:-}"
export COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
export COMFY_OUTPUT_DIR="${COMFY_OUTPUT_DIR:-${HEISS_COMFY_ROOT:+$HEISS_COMFY_ROOT/output}}"
export PORT="${PORT:-8787}"
export HOST="${HOST:-0.0.0.0}"
# The address other devices open the studio at.
export HEISS_ALLOWED_HOSTS="${HEISS_ALLOWED_HOSTS:-100.65.23.88}"
# Signed-in devices may install models and nodes, update, change folders.
export HEISS_ADMIN_FROM_DEVICES="${HEISS_ADMIN_FROM_DEVICES:-1}"
export HEISS_NO_BROWSER=1
# HEISS_STUDIO_PASSWORD: set it in the shell to choose the password. Without
# it, the first start makes one up and prints it once.
# -----------------------------------------------------------------------------

if [ -z "$HEISS_COMFY_ROOT" ] || [ ! -d "$HEISS_COMFY_ROOT/models" ]; then
  echo "Set HEISS_COMFY_ROOT to ComfyUI's folder (the one with models/ in it)." >&2
  echo "  e.g. HEISS_COMFY_ROOT=/workspace/ComfyUI $0" >&2
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

exec node scripts/start.mjs
