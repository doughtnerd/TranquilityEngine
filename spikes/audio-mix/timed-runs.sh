#!/usr/bin/env bash
# Coordinator's timed runs for the M5 spikes, one after another on an idle machine; commits after each stage.
set -u
cd "$(dirname "$0")"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/tmp/claude-0/-home-user-TranquilityEngine/f135ce04-10e3-5b06-88ee-a9f64de34c3c/scratchpad/cargo-target}
LOG=$PWD/timed-runs.log
stage() {
  echo "== $1 start $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)" >> "$LOG"
  ( cd "$2" && eval "$3" ) > "$2/timed-$1.out" 2>&1; echo "== $1 exit $? end $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)" >> "$LOG"
  git add -A . >/dev/null 2>&1; git commit -qm "M5 spikes: timed run $1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QjpoPtaJ9s3FxkPmJvSHTF" >/dev/null 2>&1; git push -q origin claude/loving-fermi-g98916 >/dev/null 2>&1
}
# Each stage: the decision it informs, and its expected duration on an idle machine.
stage s1 loudness "node run.mjs"            # loudness allowance per metered bus; ~2.5 min
stage s4 mix-core "node run.mjs"            # sidechain and bus-ramp allowance; ~3-4 min
stage s2 cpu-clock "node run.mjs"           # loadPermille method accuracy; ~2.5 min
stage s3 capture "node --experimental-strip-types --expose-gc run.mjs"  # recorder cost on main; ~3-4 min
echo "== all done $(date -u +%FT%TZ)" >> "$LOG"
