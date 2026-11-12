#!/usr/bin/env node
// S1 runner: loudness metering cost (see README.md). Builds native and wasm (+simd128, release, as native/audio/build.mjs does),
// then: 1. correctness (`mode=check`, native and wasm); 2. timed cost per quantum, RUNS runs per case, native and wasm;
// 3. metered wasm (instructions per quantum: deterministic, load-independent); 4. wasm size deltas. Writes results/<stamp>/.
//
//   node run.mjs                 # the full timed run: expected about 4 min on an idle 4-vCPU machine (see README for the smoke figure)
//   node run.mjs --smoke         # 1 run x 2000 quanta per case: plumbing/correctness only, NOT timing
//   node run.mjs --only=check,native,wasm,metered,size
//   RUNS=5 QUANTA=20000 node run.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { COUNTER_EXPORT, meter } from "../../../tools/audio-bench/meter.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const smoke = argv.includes("--smoke");
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const RUNS = smoke ? 1 : Number(process.env.RUNS ?? 5);
const QUANTA = smoke ? 2000 : Number(process.env.QUANTA ?? 20000);
const parts = (flag("only") ?? "check,native,wasm,metered,size").split(",");
const QUANTUM_US = 2666.667;

// [case, sig, [k...]]: what each informs is in README "Method".
const MATRIX = [
  ["floor", "music", [1]],
  ["peak", "music", [1, 8]], //     the existing per-bus sample-peak meter (audio-core meters.rs): the baseline to add to
  ["kw", "music", [1, 4, 8]], //    K-weighting + sub-block energy
  ["kw", "burst", [1]], //          same, with digital silence (denormal flush)
  ["tp", "music", [1, 4, 8]], //    true peak alone (4x polyphase, every quantum)
  ["both", "music", [1, 4, 8]], //  the full audio-thread part
  ["both_gated", "music", [1, 4, 8]], // + true peak only when sample peak >= -6 dBFS
  ["both_gated", "hot", [1, 8]], //  ... on a loud master (gate always open)
  ["ebur_add", "music", [1, 4, 8]], //  the ebur128 crate, add_frames only (M|S|I|LRA|TP)
  ["ebur_full", "music", [1, 4, 8]], // ... plus a STATUS-rate read (momentary + true peak every 6 quanta)
  ["ebur_i", "music", [1]], //       crate, integrated only
  ["ebur_tp", "music", [1]], //      crate, true peak only
];

const targetDir = process.env.CARGO_TARGET_DIR ?? `${here}target`;
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const native = `${targetDir}/release/loudspike`;
const wasmPath = `${targetDir}/wasm32-unknown-unknown/release/loudspike.wasm`;
const SIMD = { CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "-C target-feature=+simd128" };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = `${here}results/${smoke ? "smoke-" : ""}${stamp}/`;
mkdirSync(out, { recursive: true });
const raw = `${out}raw.jsonl`;
const log = (...a) => console.error(`[run] ${new Date().toISOString().slice(11, 19)}`, ...a);
const cargo = (args, extra = {}) => execFileSync("cargo", args, { cwd: here, env: { ...env, ...extra }, stdio: ["ignore", "inherit", "inherit"] });

log("building native and wasm");
cargo(["build", "--release", "-p", "myco-loudness-spike"]);
cargo(["build", "--release", "--lib", "--target", "wasm32-unknown-unknown", "-p", "myco-loudness-spike"], SIMD);
const wasmBytes = readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);

function runNative(args) {
  const r = spawnSync(native, args.split(" "), { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`native ${args}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function runWasm(args, module = wasmModule, counted = false) {
  let memory, counter;
  const lines = [];
  const instance = new WebAssembly.Instance(module, {
    env: {
      bench_now: counted ? () => Number(counter.value) / 1000 : () => performance.now(),
      bench_print: (ptr, len) => lines.push(Buffer.from(memory.buffer, ptr >>> 0, len).toString("utf8")),
    },
  });
  memory = instance.exports.memory;
  if (counted) counter = instance.exports[COUNTER_EXPORT];
  const bytes = Buffer.from(args);
  const ptr = instance.exports.bench_alloc(bytes.length);
  new Uint8Array(memory.buffer, ptr >>> 0, bytes.length).set(bytes);
  instance.exports.bench_main(ptr, bytes.length);
  return lines.map((l) => JSON.parse(l));
}
const record = (tag, rows) => {
  for (const r of rows) appendFileSync(raw, JSON.stringify({ tag, ...r }) + "\n");
  return rows;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const f = (x, d = 2) => (Number.isFinite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "n/a");
const md = [];
const P = (s = "") => md.push(s);
P(`# S1 run ${stamp}${smoke ? " (SMOKE: 1 run x 2000 quanta, plumbing only, not timing)" : ""}`);
P();
P(`RUNS=${RUNS} QUANTA=${QUANTA}; quantum = 128 frames at 48 kHz = ${QUANTUM_US.toFixed(0)} us. Times are us per quantum for ALL k buses together; medians over runs of each run's statistic; "max" is the max over runs.`);
P();
let failed = false;

if (parts.includes("check")) {
  P("## Correctness checks");
  for (const [t, rows] of [["native", runNative("mode=check")], ["wasm", runWasm("mode=check")]]) {
    record(`check-${t}`, rows);
    const all = rows.find((r) => r.check === "ALL");
    const n = rows.filter((r) => r.pass !== undefined && r.check !== "ALL");
    if (!all?.pass) failed = true;
    P(`- ${t}: ${n.filter((r) => r.pass).length}/${n.length} checks pass${all?.pass ? "" : " (FAIL: " + n.filter((r) => !r.pass).map((r) => r.check + " " + r.what).join("; ") + ")"}`);
  }
  P();
}

const table = (target, rows) => {
  P(`## Cost per quantum, ${target} (us; % of the 2,667 us quantum is p50/2667)`);
  P();
  P("| case | signal | k | p50 | p99 | p99.9 | max | tp ran | allocs/run |");
  P("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [key, rs] of rows) {
    const [c, s, k] = key.split("|");
    P(`| ${c} | ${s} | ${k} | ${f(median(rs.map((r) => r.p50)))} | ${f(median(rs.map((r) => r.p99)))} | ${f(median(rs.map((r) => r.p999)))} | ${f(Math.max(...rs.map((r) => r.max)), 1)} | ${f(median(rs.map((r) => r.tp_ran)), 2)} | ${rs.reduce((a, r) => a + r.allocs_all, 0)} |`);
  }
  P();
};
for (const t of ["native", "wasm"]) {
  if (!parts.includes(t)) continue;
  const rows = new Map();
  for (const [c, sig, ks] of MATRIX) {
    for (const k of ks) {
      log(`${t} ${c} ${sig} k=${k}`);
      const args = `mode=cost case=${c} sig=${sig} k=${k} runs=${RUNS} quanta=${QUANTA}`;
      const rs = record(`cost-${t}`, t === "native" ? runNative(args) : runWasm(args));
      rows.set(`${c}|${sig}|${k}`, rs);
    }
  }
  table(t, rows);
}

if (parts.includes("metered")) {
  log("metered wasm");
  const metered = new WebAssembly.Module(meter(wasmBytes).bytes);
  P("## Metered wasm: instructions per quantum (deterministic; every wasm instruction weighs 1, so it is a work measure, not time)");
  P();
  P("| case | signal | k | instr p50 | instr p99 | instr max |");
  P("|---|---|---:|---:|---:|---:|");
  for (const [c, sig, k] of [["peak", "music", 1], ["kw", "music", 1], ["tp", "music", 1], ["both", "music", 1], ["both", "music", 8], ["both_gated", "music", 1], ["both_gated", "hot", 1], ["ebur_add", "music", 1], ["ebur_full", "music", 1]]) {
    const [r] = record("metered", runWasm(`mode=cost case=${c} sig=${sig} k=${k} runs=1 quanta=${smoke ? 800 : 3000}`, metered, true));
    P(`| ${c} | ${sig} | ${k} | ${f(r.p50, 0)} | ${f(r.p99, 0)} | ${f(r.max, 0)} |`);
  }
  P();
}

if (parts.includes("size")) {
  log("size probes");
  P("## wasm size (release, +simd128, opt-level 3 + LTO, no wasm-opt on this machine; the core is 318,306 B)");
  P();
  P("| variant | bytes | delta vs base | gzip |");
  P("|---|---:|---:|---:|");
  const sizes = {};
  for (const [name, feats] of [["base", []], ["own", ["own"]], ["ebur128 crate", ["ebur"]]]) {
    cargo(["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "loudspike-size", ...(feats.length ? ["--features", feats.join(",")] : [])], SIMD);
    const b = readFileSync(`${targetDir}/wasm32-unknown-unknown/release/loudspike_size.wasm`);
    writeFileSync(`${out}size-${name.replace(/\W+/g, "-")}.wasm`, b);
    sizes[name] = b.length;
    P(`| ${name} | ${f(b.length, 0)} | ${f(b.length - (sizes.base ?? b.length), 0)} | ${f(gzipSync(b).length, 0)} |`);
    record("size", [{ name, bytes: b.length }]);
  }
  P();
}

writeFileSync(`${out}summary.md`, md.join("\n") + "\n");
log(`wrote ${out}summary.md`);
if (failed) process.exit(1);
