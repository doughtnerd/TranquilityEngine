#!/usr/bin/env bash
# symphonia 0.6.1 size builds into ../wasm/v06-*.wasm. Run from decode/.
set -e
cd v06
mkdir -p ../wasm
for set in sym-mp3 sym-vorbis sym-flac sym-wav sym-aac sym-opus sym-4 sym-5 sym-6; do
  cargo build --release --target wasm32-unknown-unknown --lib --no-default-features --features $set 2>&1 | grep -E "^error" -A8 || true
  cp target/wasm32-unknown-unknown/release/decode_spike06.wasm ../wasm/v06-$set.wasm
  echo "v06-$set $(stat -c %s ../wasm/v06-$set.wasm)"
done
