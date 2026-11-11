// The bed probe in Node (ADR 0162 A2, #120): builds the `bed_probe` example for wasm32 (release,
// +simd128, the mixer's flags) into native/audio/target/dsp-probe and runs it.
//
//   node native/audio/crates/audio-dsp/examples/bed_probe/run.mjs digest
//   node native/audio/crates/audio-dsp/examples/bed_probe/run.mjs bench [voices=256] [runs=5] [quanta=6000] [warm=500]
//
// `--no-build` skips the cargo step (tests/bed_identity.rs builds first). Timing: performance.now()
// around each quantum, nearest-rank p50/p99 per run, median over runs (the bed spike's method).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const audio = fileURLToPath(new URL("../../../../", import.meta.url));
const targetDir = `${audio}target/dsp-probe`;
const wasmPath = `${targetDir}/wasm32-unknown-unknown/release/examples/bed_probe.wasm`;

const args = process.argv.slice(2).filter((a) => a !== "--no-build");
if (!process.argv.includes("--no-build")) {
  execFileSync("cargo", ["build", "--offline", "--release", "-p", "audio-dsp", "--example", "bed_probe", "--target", "wasm32-unknown-unknown", "--target-dir", targetDir], {
    cwd: audio,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "-C target-feature=+simd128" },
  });
}
const { exports } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasmPath)), {});
const num = (i, d) => (args[i] === undefined ? d : Number(args[i]));

if (args[0] === "digest") {
  console.log(BigInt.asUintN(64, exports.probe_digest()).toString(16).padStart(16, "0"));
} else if (args[0] === "bench") {
  const [voices, runs, quanta, warm] = [num(1, 256), num(2, 5), num(3, 6000), num(4, 500)];
  const p50s = [];
  const p99s = [];
  for (let run = 0; run < runs; run++) {
    exports.probe_new(voices);
    for (let i = 0; i < warm; i++) exports.probe_quantum();
    const t = new Float64Array(quanta);
    for (let i = 0; i < quanta; i++) {
      const t0 = performance.now();
      exports.probe_quantum();
      t[i] = (performance.now() - t0) * 1000;
    }
    t.sort();
    const rank = (p) => t[Math.min(Math.max(Math.ceil(p * t.length), 1), t.length) - 1];
    const [p50, p99] = [rank(0.5), rank(0.99)];
    console.log(JSON.stringify({ target: "wasm-node", voices, run, quanta, p50: +p50.toFixed(2), p99: +p99.toFixed(2) }));
    p50s.push(p50);
    p99s.push(p99);
  }
  const median = (v) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
  console.log(JSON.stringify({ target: "wasm-node", voices, runs, median_p50: +median(p50s).toFixed(2), median_p99: +median(p99s).toFixed(2) }));
} else {
  console.error("usage: run.mjs digest | bench [voices runs quanta warm] [--no-build]");
  process.exit(2);
}
