#!/usr/bin/env bash
# Full no-GitHub/no-Claude dry run of the v2 session protocol, mirroring the
# skill: serve in background, wait for triage, scripted emit sequence (watch
# the progress view live), advance to reply, dry-run posting.
#
#   scripts/demo.sh              # full flow
#   scripts/demo.sh reply-only   # --start-phase reply fast path
#   scripts/demo.sh home         # the cross-session hub (history/templates)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRV="$ROOT/server/server.js"
MODE="${1:-full}"

# The hub needs no session dir; it serves the history/templates routes
# from a seeded, throwaway config dir so it never touches your real ~/.config.
if [ "$MODE" = "home" ]; then
  CFG="$(mktemp -d "${TMPDIR:-/tmp}/pr-replies-home.XXXXXX")"
  cp "$ROOT/examples/templates.json" "$CFG/templates.json"
  mkdir -p "$CFG/history"
  cp "$ROOT/examples/history.example.json" "$CFG/history/astromar96-demo-repo-pr42-1718500000.json"
  cleanup_home() { rm -rf "$CFG"; }
  trap cleanup_home EXIT
  echo "--- hub: history / templates (Ctrl+C to quit) ---"
  PR_REPLIES_CONFIG_DIR="$CFG" node "$SRV" serve --home --repo-dir "$ROOT"
  exit 0
fi

SESSION="/tmp/pr-replies/demo-pr42-$(date +%s)"
mkdir -p "$SESSION"

cleanup() { node "$SRV" stop --session "$SESSION" 2>/dev/null || true; }
trap cleanup EXIT

emit() { node "$SRV" emit --session "$SESSION" "$@"; }

if [ "$MODE" = "reply-only" ]; then
  cp "$ROOT/examples/payload.reply.json" "$SESSION/reply.payload.json"
  node "$SRV" serve --session "$SESSION" --no-post --repo-dir "$ROOT" --start-phase reply --linger-secs 5 &
  sleep 1
  echo "--- reply-only: review drafts and send (dry run) ---"
  node "$SRV" wait --session "$SESSION" --phase reply --timeout-secs 600
  exit 0
fi

cp "$ROOT/examples/payload.triage.json" "$SESSION/triage.payload.json"
node "$SRV" serve --session "$SESSION" --no-post --repo-dir "$ROOT" --linger-secs 5 &
sleep 1

echo "--- triage: make your choices in the browser ---"
node "$SRV" wait --session "$SESSION" --phase triage --timeout-secs 600

echo "--- simulating the fix loop (watch the progress view) ---"
emit --type fix_start --item review:PRRT_kwDOExample001
sleep 1.5
emit --type check --name "npm test" --status running
sleep 1.5
emit --type check --name "npm test" --status pass
emit --type fix_done --item review:PRRT_kwDOExample001 --sha abc1234 --summary "early return on cache miss"
sleep 1
emit --type fix_start --item issue:333222111
sleep 1.5
emit --type fix_done --item issue:333222111 --sha def5678 --summary "changelog entry"
emit --type push --status ok
sleep 1
emit --type drafting

cp "$ROOT/examples/payload.reply.json" "$SESSION/reply.payload.json"
node "$SRV" advance --session "$SESSION" --phase reply

echo "--- reply: review drafts and send (dry run) ---"
node "$SRV" wait --session "$SESSION" --phase reply --timeout-secs 600
