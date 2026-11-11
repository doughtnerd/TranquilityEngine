#!/usr/bin/env bash
# Spike S1 runner. Correctness (assertions; load-independent, ~15 s) then the decode-latency timing (native decoder;
# run on an idle machine: 9 runs x 200 iterations per stage, expected ~20-30 s (est.)).
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/claude-0/-home-user-TranquilityEngine/29e8b922-4533-5b15-a67e-ee1ae99628d5/scratchpad/cargo-target}"
cargo run --release --bin align > results.md
tail -1 results.md
{ echo "# decode_lat (native), $(date -u +%FT%TZ), load: $(cut -d' ' -f1-3 /proc/loadavg)"; echo; cargo run --release --bin decode_lat -- --runs 9 --iters 200; } | tee results-decode.md
