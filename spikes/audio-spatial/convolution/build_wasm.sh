#!/usr/bin/env bash
# Builds the wasm the runners load (+simd128 like the mixer, release) and the size probes.
set -euo pipefail
cd "$(dirname "$0")"
export RUSTFLAGS="-C target-feature=+simd128"
cargo build --release --offline --target wasm32-unknown-unknown --lib
cargo build --release --offline --target wasm32-unknown-unknown --example probe_empty --example probe_m1 --example probe_zone
mkdir -p wasm
cp target/wasm32-unknown-unknown/release/convolution_spike.wasm wasm/
for p in probe_empty probe_m1 probe_zone; do cp target/wasm32-unknown-unknown/release/examples/$p.wasm wasm/; done
ls -l wasm/*.wasm | awk '{print $5, $9}'
