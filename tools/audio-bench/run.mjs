#!/usr/bin/env node
// The audio core's lab benchmark as wasm in Node (ADR 0157 A3.5, architecture §6.5): builds
// native/audio/crates/audio-bench for wasm32 with +simd128 and the release profile (as
// `npm run build:audio` builds the mixer), then runs it with the same `key=value` arguments as the
// native binary. Prints one JSON line per run or fit.
//
//   node tools/audio-bench/run.mjs mode=scene name=high seconds=60 runs=5
//   node tools/audio-bench/run.mjs mode=fit seconds=10 runs=3 [term=mixed,pitch]
//   node tools/audio-bench/run.mjs --no-build mode=memory
//
// Needs the toolchain pinned in native/audio/rust-toolchain.toml (with its wasm32 target).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const audio = fileURLToPath(new URL("../../native/audio/", import.meta.url));
const wasmPath = fileURLToPath(new URL("../../native/audio/target/bench/wasm32-unknown-unknown/release/audio_bench.wasm", import.meta.url));

const argv = process.argv.slice(2);
if (!argv.includes("--no-build")) {
  execFileSync("cargo", ["build", "-p", "audio-bench", "--lib", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", "target/bench"], {
    cwd: audio,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "-C target-feature=+simd128" },
  });
}
const args = argv.filter((a) => a !== "--no-build").join(" ");

let memory;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
  env: {
    bench_now: () => performance.now(),
    bench_print: (ptr, len) => console.log(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))),
    bench_sleep: (ms) => {
      if (ms > 0) Atomics.wait(sleeper, 0, 0, ms);
    },
  },
});
memory = instance.exports.memory;
const bytes = new TextEncoder().encode(args);
const ptr = instance.exports.bench_alloc(bytes.length);
new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
instance.exports.bench_main(ptr, bytes.length);
