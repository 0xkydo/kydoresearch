#!/usr/bin/env bash
# Continuous Codex worker for GOAL.md.
# Usage: ./scripts/codex-loop.sh [max_sessions]   (default 20)
# Stop anytime with ctrl+c; every session commits its own work, so nothing is lost.
set -u
cd "$(dirname "$0")/.."

MAX_SESSIONS="${1:-20}"
PROMPT='Read GOAL.md at the repo root and follow it exactly. Pick the single
highest-priority unchecked work item, implement it with tests, run the
verification gate (npm run typecheck && npm test), check the item off in
GOAL.md, append one line to the Progress log, and commit. One work item per
session. Respect every rule in "Hard safety rules" — especially: no real
leaderboard submissions, no real LLM API calls in tests, scratch copies of the
challenge repo only. If genuinely blocked, write the blocker into the Progress
log and stop.'

for i in $(seq 1 "$MAX_SESSIONS"); do
  echo "=== codex session $i/$MAX_SESSIONS — $(date '+%H:%M:%S') ==="
  codex exec --full-auto -C "$PWD" "$PROMPT" || {
    echo "codex exited nonzero; pausing 60s before retry"
    sleep 60
  }
  # All boxes checked → done.
  if ! grep -q '^\- \[ \]' GOAL.md; then
    echo "=== all GOAL.md items checked — stopping ==="
    break
  fi
done
