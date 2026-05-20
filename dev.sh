#!/usr/bin/env bash
#
# dev.sh — one command to bring up Concord locally.
#
# Boots the full single-machine stack: the coordinator (REST + WS on :8787),
# the host-owned demo agents, and the dashboard (:3000). This is the path
# that always works — no Fly, no Vercel, no tunnel, no cloud account needed.
#
#   ./dev.sh            boot coordinator + demo agents + dashboard
#   ./dev.sh --no-ui    coordinator + agents only (skip the dashboard)
#   ./dev.sh --help     this message
#
# Ctrl-C stops everything. Logs stream to ./.dev-logs/<service>.log.
#
set -euo pipefail
cd "$(dirname "$0")"

WITH_UI=1
case "${1:-}" in
  --no-ui) WITH_UI=0 ;;
  --help|-h) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown arg: $1 (try --help)"; exit 2 ;;
esac

log()  { printf '\033[1;36m[dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dev]\033[0m %s\n' "$*"; }

# --- prerequisites -----------------------------------------------------------
command -v pnpm >/dev/null || { echo "pnpm not found — install Node 22+ and 'npm i -g pnpm'"; exit 1; }

if [ ! -f .env ]; then
  warn ".env missing — copying from .env.example. Fill in ANTHROPIC_API_KEY,"
  warn "AC_HOST_API_KEY (24 hex), and X402_HMAC_SECRET before the LLM features work."
  cp .env.example .env
fi

log "installing deps (pnpm install)…"
pnpm install --silent

# --- process management ------------------------------------------------------
mkdir -p .dev-logs
PIDS=()
cleanup() { log "shutting down…"; for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

start() { # start <name> <pnpm-script>
  local name=$1 script=$2
  log "starting $name → .dev-logs/$name.log"
  pnpm "$script" >".dev-logs/$name.log" 2>&1 &
  PIDS+=($!)
}

# Coordinator first; give it a moment to bind :8787 and open the SQLite db.
start coordinator coordinator
sleep 3

# Demo agents register against the coordinator and wait for work.
start agents demo

[ "$WITH_UI" -eq 1 ] && start dashboard dashboard

log "Concord is up:"
log "  coordinator  http://localhost:8787   (REST + WS, SQLite-backed)"
[ "$WITH_UI" -eq 1 ] && log "  dashboard    http://localhost:3000"
log "  drive a scenario in another shell:  ./scripts/scenarios.sh page"
log "Ctrl-C to stop. Tailing logs…"
tail -f .dev-logs/*.log
