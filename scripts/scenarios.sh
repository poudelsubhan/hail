#!/usr/bin/env bash
#
# scenarios.sh — drive a Concord marketplace scenario against a running
# coordinator. Boot the stack first with ./dev.sh, then run a scenario here.
#
#   ./scripts/scenarios.sh summarize   simple smoke: post → bid → deliver
#   ./scripts/scenarios.sh page        Coframe — page-on-demand render
#   ./scripts/scenarios.sh research    OpenHome — researcher decomposes a job
#   ./scripts/scenarios.sh war         bidding war (two summarizers + skeptic)
#   ./scripts/scenarios.sh all         run every scenario in sequence
#   ./scripts/scenarios.sh present     keypress-driven stage demo
#
# Each scenario maps to a `pnpm scenario:*` script in package.json.
#
set -euo pipefail
cd "$(dirname "$0")/.."

run() { echo "▶ pnpm $1"; pnpm "$1"; }

case "${1:-}" in
  summarize) run scenario:summarize ;;
  page)      run scenario:page ;;
  research)  run scenario:research ;;
  war)       run scenario:war ;;
  present)   run present ;;
  all)
    run scenario:summarize
    run scenario:page
    run scenario:research
    run scenario:war
    ;;
  ""|--help|-h)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown scenario: $1 (try --help)"
    exit 2
    ;;
esac
