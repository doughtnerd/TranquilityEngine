#!/usr/bin/env bash
# Builds one wasm per symphonia 0.5.5 feature set into wasm/sym-*.wasm and prints sizes. Run from decode/.
set -e
mkdir -p wasm
for set in sym-mp3 sym-vorbis sym-flac sym-wav sym-4 sym-5 sym-aac; do
  cargo build --release --target wasm32-unknown-unknown --lib --no-default-features --features $set 2>&1 | grep -E "^error|warning: unused" || true
  cp target/wasm32-unknown-unknown/release/decode_spike.wasm wasm/$set.wasm
  echo "$set $(stat -c %s wasm/$set.wasm)"
done
