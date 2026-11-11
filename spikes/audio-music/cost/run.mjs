#!/usr/bin/env node
// S4 runner: the timed measurement of M4's audio-thread cost (see README.md). Builds the spike's bench natively and as wasm
// (+simd128, release, as `npm run build:audio` builds the mixer), then runs, in this order:
//   1. correctness checks (`mode=check`, native and wasm);
//   2. the microbenchmarks (`mode=micro`: gain-ramp shapes, the music clock), RUNS times each, native and wasm;
//   3. the scenes (`mode=scene`), RUNS runs x SECONDS s each (+WARMUP s warm-up), native then wasm, one fresh wasm instance per scene;
//   4. the metered wasm (instruction counts per quantum: deterministic, load-independent), one 4 s run per scene.
// and writes results/<stamp>/{raw.jsonl,summary.md}. Medians are over runs. Defaults: RUNS=5 SECONDS=20 WARMUP=2.
//
//   node run.mjs                  # the full timed run (about 35 min on an idle 4-vCPU machine; see README)
//   node run.mjs --smoke          # 1 run x 2 s per scene: a correctness/plumbing check, NOT timing
//   node run.mjs --only=native,micro   # parts: check, micro, native, wasm, metered
//   node run.mjs --scenes=mus-typ,mus-typ-base
//   PACE=1 node run.mjs           # pace=1: sleep to each 2.667 ms deadline (caches evicted between quanta; takes SECONDS wall per run)
//   RUNS=5 SECONDS=20 node run.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COUNTER_EXPORT, meter } from "../../../tools/audio-bench/meter.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const smoke = argv.includes("--smoke");
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const RUNS = smoke ? 1 : Number(process.env.RUNS ?? 5);
const SECONDS = smoke ? 2 : Number(process.env.SECONDS ?? 20);
const WARMUP = smoke ? 1 : Number(process.env.WARMUP ?? 2);
const PACE = process.env.PACE === "1" ? 1 : 0;
const parts = (flag("only") ?? "check,micro,native,wasm,metered").split(",");
const QUANTUM_US = 2666.667;

const CORE = ["mus-typ-base", "mus-typ", "mus-trans-base", "mus-trans", "mus-worst-base", "mus-worst", "mus-worst-split"];
const ISO = ["iso-empty", "iso-clip48", "iso-clip441", "iso-clip48-sp", "iso-clip441-sp", "iso-stream48", "iso-stream441", "iso-clip48-64", "iso-clip441-64"];
const scenes = flag("scenes")?.split(",") ?? [...CORE, ...ISO];
const TWIN = { "mus-typ": "mus-typ-base", "mus-trans": "mus-trans-base", "mus-worst": "mus-worst-base", "mus-worst-split": "mus-worst-base" };

const targetDir = process.env.CARGO_TARGET_DIR ?? `${here}target`;
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const native = `${targetDir}/release/musiccost`;
const wasmPath = `${targetDir}/wasm32-unknown-unknown/release/musiccost.wasm`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = `${here}results/${smoke ? "smoke-" : ""}${stamp}/`;
mkdirSync(out, { recursive: true });
const raw = `${out}raw.jsonl`;
const log = (...a) => console.error(`[run] ${new Date().toISOString().slice(11, 19)}`, ...a);

// --- builds ---
log("building native and wasm");
execFileSync("cargo", ["build", "--release"], { cwd: here, env, stdio: ["ignore", "inherit", "inherit"] });
execFileSync("cargo", ["build", "--release", "--lib", "--target", "wasm32-unknown-unknown"], {
  cwd: here,
  env: { ...env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "-C target-feature=+simd128" },
  stdio: ["ignore", "inherit", "inherit"],
});
const wasmBytes = readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const meteredModule = parts.includes("metered") ? new WebAssembly.Module(meter(wasmBytes).bytes) : null;

// --- executors: each returns the parsed JSON lines the bench printed ---
function runNative(args) {
  const r = spawnSync(native, args.split(" "), { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`native ${args}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function runWasm(args, module = wasmModule, clock = null) {
  let memory;
  let counter;
  const lines = [];
  const instance = new WebAssembly.Instance(module, {
    env: {
      bench_now: clock ? () => Number(counter.value) / 1000 : () => performance.now(),
      bench_print: (ptr, len) => lines.push(Buffer.from(memory.buffer, ptr >>> 0, len).toString("utf8")),
      bench_sleep: (ms) => ms > 0 && Atomics.wait(sleeper, 0, 0, ms),
    },
  });
  memory = instance.exports.memory;
  if (clock) counter = instance.exports[COUNTER_EXPORT];
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
const f = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "n/a");
const md = [];
const P = (s = "") => md.push(s);
P(`# S4 run ${stamp}${smoke ? " (SMOKE: 1 run x 2 s, plumbing only, not timing)" : ""}`);
P();
P(`RUNS=${RUNS} SECONDS=${SECONDS} WARMUP=${WARMUP} PACE=${PACE}; quantum = 128 frames at 48 kHz = ${QUANTUM_US.toFixed(0)} us. Medians over runs. Times in us per quantum.`);
P();

// --- 1. checks ---
if (parts.includes("check")) {
  P("## Correctness checks");
  for (const [t, rows] of [["native", runNative("mode=check")], ["wasm", runWasm("mode=check")]]) {
    record(`check-${t}`, rows);
    P(`- ${t}: ${rows.map((r) => `${r.check}${r.pass === undefined ? "" : r.pass ? " PASS" : " FAIL"}${r.worstErrFrames !== undefined ? ` (worst error ${r.worstErrFrames} frames over ${r.beats} beats)` : ""}`).join("; ")}`);
  }
  P();
}

// --- 2. micros ---
if (parts.includes("micro")) {
  const results = {};
  for (const t of ["native", "wasm"]) {
    for (let i = 0; i < RUNS; i++) {
      log(`micro ${t} run ${i + 1}/${RUNS}`);
      const args = `mode=micro reps=${smoke ? 500 : 20000} blocks=${smoke ? 5 : 50}`;
      for (const r of record(`micro-${t}-${i}`, t === "native" ? runNative(args) : runWasm(args))) {
        if (!r.case) continue;
        ((results[r.micro] ??= {})[r.case] ??= {})[t] ??= [];
        results[r.micro][r.case][t].push(r);
      }
    }
  }
  for (const [group, cases] of Object.entries(results)) {
    P(`## Micro: ${group} (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)`);
    P();
    P("| case | native p50 | native p99 | wasm p50 | wasm p99 |");
    P("|---|---:|---:|---:|---:|");
    for (const [name, v] of Object.entries(cases)) {
      const c = (t, k) => f(median((v[t] ?? []).map((r) => r[k])), 1);
      P(`| ${name} | ${c("native", "p50")} | ${c("native", "p99")} | ${c("wasm", "p50")} | ${c("wasm", "p99")} |`);
    }
    P();
  }
}

// --- 3. scenes ---
const stat = (rows, k) => median(rows.map((r) => r[k]));
const byScene = { native: {}, wasm: {} };
for (const t of ["native", "wasm"]) {
  if (!parts.includes(t)) continue;
  for (const name of scenes) {
    log(`scene ${t} ${name} (${RUNS} x ${SECONDS} s)`);
    const args = `mode=scene name=${name} seconds=${SECONDS} warmup=${WARMUP} runs=${RUNS} pace=${PACE}`;
    const rows = record(`scene-${t}`, t === "native" ? runNative(args) : runWasm(args)).filter((r) => r.scene === name);
    byScene[t][name] = rows;
  }
  P(`## Scenes, ${t} (median over ${RUNS} runs of each run's statistic, us per quantum)`);
  P();
  P("| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |");
  P("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const name of scenes) {
    const r = byScene[t][name];
    if (!r?.length) continue;
    P(`| ${name} | ${f(stat(r, "p50"), 0)} | ${f(stat(r, "p99"), 0)} | ${f(stat(r, "p999"), 0)} | ${f(stat(r, "max"), 0)} | ${f(stat(r, "mean"), 0)} | ${f(stat(r, "mixed"), 1)} | ${f(stat(r, "peak"), 3)} | ${f(Math.max(...r.map((x) => x.starved)), 0)} |`);
  }
  P();
  P(`### Music delta, ${t} (scene minus its twin without the music voices; us per quantum; % of the ${QUANTUM_US.toFixed(0)} us quantum)`);
  P();
  P("| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |");
  P("|---|---:|---:|---:|---:|---:|");
  for (const [name, twin] of Object.entries(TWIN)) {
    const a = byScene[t][name];
    const b = byScene[t][twin];
    if (!a?.length || !b?.length) continue;
    const d = (k) => stat(a, k) - stat(b, k);
    P(`| ${name} (vs ${twin}) | ${f(d("p50"), 0)} | ${f(d("p99"), 0)} | ${f(d("p999"), 0)} | ${f(d("mean"), 0)} | ${f((100 * d("mean")) / QUANTUM_US, 2)} |`);
  }
  P();
  const empty = byScene[t]["iso-empty"];
  if (empty?.length) {
    P(`### Q4 per-voice cost, ${t} ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)`);
    P();
    P("| scene | voices | source | ns / voice / quantum |");
    P("|---|---:|---|---:|");
    for (const name of ISO.filter((n) => n !== "iso-empty")) {
      const r = byScene[t][name];
      if (!r?.length) continue;
      const voices = stat(r, "mixed");
      P(`| ${name} | ${f(voices, 0)} | ${name.includes("stream") ? "stream ring" : "decoded"}, ${name.includes("441") ? "44.1 kHz" : "48 kHz"}, ${name.endsWith("-sp") ? "spatial (equal-power)" : "non-spatial"} | ${f(((stat(r, "mean") - stat(empty, "mean")) * 1000) / voices, 0)} |`);
    }
    P();
  }
}

// --- 4. metered ---
if (meteredModule) {
  P("## Metered wasm (wasm instructions per quantum: deterministic, identical on every machine and load; 4 s run, seed 1)");
  P();
  P("| scene | instr/quantum | p99 | max |");
  P("|---|---:|---:|---:|");
  const counts = {};
  for (const name of scenes) {
    log(`metered ${name}`);
    const row = record("metered", runWasm(`mode=scene name=${name} seconds=4 warmup=1 runs=1 seed=1`, meteredModule, true)).find((r) => r.scene === name);
    counts[name] = row;
    P(`| ${name} | ${f(row.mean)} | ${f(row.p99)} | ${f(row.max)} |`);
  }
  P();
  P("| scene (vs twin) | d instr/quantum | ratio | note |");
  P("|---|---:|---:|---|");
  for (const [name, twin] of Object.entries(TWIN)) {
    if (!counts[name] || !counts[twin]) continue;
    P(`| ${name} (vs ${twin}) | ${f(counts[name].mean - counts[twin].mean)} | ${f(counts[name].mean / counts[twin].mean, 4)} | multiply the ratio by the twin's timed wasm mean for a load-free estimate |`);
  }
  P();
}

writeFileSync(`${out}summary.md`, md.join("\n") + "\n");
console.log(md.join("\n"));
log(`wrote ${out}`);
