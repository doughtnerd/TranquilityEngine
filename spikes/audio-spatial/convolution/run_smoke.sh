#!/usr/bin/env bash
# Smoke run of everything (a few minutes): the numbers in README.md's smoke tables came from this.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p results
cargo build --release --offline
./target/release/spike check > results/check-native.txt
node run_wasm.mjs check --stride 24 --secs 3 > results/check-wasm.txt
./target/release/spike memory > results/memory.md
./target/release/spike bench --runs 5 --quanta 2000 --json results/smoke-native.json > results/smoke-native.md
node run_wasm.mjs bench --runs 5 --quanta 2000 --json results/smoke-wasm-node.json > results/smoke-wasm-node.md
node run_browser.mjs main --runs 5 --quanta 2000 --json results/smoke-chromium-main.json > results/smoke-chromium-main.md
node run_browser.mjs worklet --runs 3 --quanta 4000 > results/smoke-chromium-worklet.md
node tables.mjs native=results/smoke-native.json wasm-node=results/smoke-wasm-node.json chromium=results/smoke-chromium-main.json > results/smoke-tables.md
echo done
