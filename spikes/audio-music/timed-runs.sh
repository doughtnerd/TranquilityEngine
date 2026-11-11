#!/usr/bin/env bash
# Coordinator's timed runs for the M4 spikes, one after another on an idle machine; commits after each stage.
set -u
cd "$(dirname "$0")"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/tmp/claude-0/-home-user-TranquilityEngine/29e8b922-4533-5b15-a67e-ee1ae99628d5/scratchpad/cargo-target}
LOG=$PWD/timed-runs.log
stage() {
  echo "== $1 start $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)" >> "$LOG"
  ( cd "$2" && eval "$3" ) > "$2/timed-$1.out" 2>&1; echo "== $1 exit $? end $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)" >> "$LOG"
  git add -A . >/dev/null 2>&1; git commit -qm "M4 spikes: timed run $1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QjpoPrr1A7EvFXxGBcrrxg" >/dev/null 2>&1; git push -q origin claude/confident-tesla-yvrqy8 >/dev/null 2>&1
}
stage s1 streams-align "bash run.sh"
stage s2 stream-throughput "node run.mjs --only q1,q4"
stage s3 beat-clock "node run.mjs --runs 5 --seconds 60"
stage s3-hint0 beat-clock "node run.mjs --runs 5 --seconds 60 --hint 0"
stage s4 cost "RUNS=5 SECONDS=10 node run.mjs"
echo "== all done $(date -u +%FT%TZ)" >> "$LOG"
