#!/usr/bin/env node
// S4 (audio M5) runner: the timed cost of sidechain ducking, stamped bus ramps and snapshot blending, native and wasm, plus the
// deterministic analyses (zipper, one-quantum delay, blend clicks, bus ordering of the samples, live edits through the real core).
//
//   node run.mjs                 # full run: RUNS=5 x CALLS=60000 per case and target (about 3-4 min on an idle 4-vCPU machine)
//   node run.mjs --smoke         # 1 run x 2000 calls: plumbing and correctness, NOT timing
//   node run.mjs --only=check,micro   # parts: build,check,analysis,micro,metered,ordering,live
//   RUNS=5 CALLS=60000 node run.mjs
// Output: results/<stamp>/{raw.jsonl,summary.md}. Medians are over runs of each run's p50 / p99 / p99.9 / max (ns per 128-frame quantum).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COUNTER_EXPORT, meter } from "../../../tools/audio-bench/meter.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const smoke = argv.includes("--smoke");
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const RUNS = smoke ? 1 : Number(process.env.RUNS ?? 5);
const CALLS = smoke ? 2000 : Number(process.env.CALLS ?? 60000);
const parts = (flag("only") ?? "build,check,analysis,micro,metered,ordering,live").split(",");
const QUANTUM_NS = 2_666_667;

const targetDir = process.env.CARGO_TARGET_DIR ?? `${here}target`;
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const native = `${targetDir}/release/mixcore`;
const wasmPath = `${targetDir}/wasm32-unknown-unknown/release/mixcore.wasm`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = `${here}results/${smoke ? "smoke-" : ""}${stamp}/`;
mkdirSync(out, { recursive: true });
const raw = `${out}raw.jsonl`;
const log = (...a) => console.error(`[run] ${new Date().toISOString().slice(11, 19)}`, ...a);
const record = (tag, rows) => { for (const r of rows) appendFileSync(raw, JSON.stringify({ tag, ...r }) + "\n"); return rows; };

if (parts.includes("build")) {
  log("building native and wasm");
  execFileSync("cargo", ["build", "--release"], { cwd: here, env, stdio: ["ignore", "inherit", "inherit"] });
  execFileSync("cargo", ["build", "--release", "--lib", "--target", "wasm32-unknown-unknown"], { cwd: here, env: { ...env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "-C target-feature=+simd128" }, stdio: ["ignore", "inherit", "inherit"] });
}
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

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const f = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "n/a");
const md = [];
const P = (s = "") => md.push(s);
const t0 = Date.now();
P(`# S4 (M5 mix in the core) run ${stamp}${smoke ? " (SMOKE: 1 run x 2000 calls, plumbing only, NOT timing)" : ""}`);
P();
P(`RUNS=${RUNS} CALLS=${CALLS}; quantum = 128 frames at 48 kHz = ${QUANTUM_NS.toLocaleString("en-US")} ns. Medians over runs. Times in ns per quantum (one rule, one ramping bus, one filter: stereo).`);
P();

if (parts.includes("check")) {
  P("## Correctness checks (deterministic)");
  for (const [t, rows] of [["native", runNative("mode=check")], ["wasm", runWasm("mode=check")]]) {
    record(`check-${t}`, rows);
    for (const r of rows) P(`- ${t}: ${r.check}: ${r.pass ? "PASS" : "**FAIL**"} (${r.detail})`);
  }
  P();
}

if (parts.includes("analysis")) {
  log("analyses (native, deterministic)");
  const z = record("zipper", runNative("mode=zipper"));
  P("## Zipper: main-thread BUS_MIX updates vs a stamped ramp (1 kHz sine, 0.5 peak; best constant delay removed first)");
  P();
  P("`ramp` is the BUS_MIX `rampFrames`: 128 frames is the brief's premise (2.7 ms per update); `interval` is what main sends today (`clock.ts` `rampFrames`: the frame interval clamped to 5..50 ms, 800 frames at 60 fps). `jitter` = the update lands up to 3 quanta late. `delay` is the lag of the heard gain behind the true curve; error is measured after removing it.");
  P();
  P("| shape | fps | ramp | jitter | lag ms | error rms dB | error peak dBFS | gain-step click dBFS |");
  P("|---|---:|---|---:|---:|---:|---:|---:|");
  for (const r of z.filter((r) => r.zipper === "main-updates")) P(`| ${r.shape.split(" ")[0]} | ${r.fps} | ${r.ramp} | ${r.jitterQuanta} | ${r.bestDelayMs} | ${r.errRmsDb} | ${r.errPeakDbfs} | ${r.clickDbfs} |`);
  for (const r of z.filter((r) => r.zipper === "stamped-linear")) P(`| fade | - | stamped linear ramp in the core | - | ${r.bestDelayMs} | ${r.errRmsDb} | ${r.errPeakDbfs} | ${r.clickDbfs} |`);
  P();
  P(`Reference: the true 250 ms fade's own gain step per sample is ${z.find((r) => r.zipper === "reference").idealFadeStepPerSampleDbfs} dBFS at 0.5 peak.`);
  P();
  const d = record("delay", runNative("mode=delay"));
  P("## A one-quantum-late detector (trigger bus computed after the target)");
  P();
  P("| detector | duck attack ms | release ms | depth dB | max gain difference dB | % of depth |");
  P("|---|---:|---:|---:|---:|---:|");
  for (const r of d) P(`| ${r.detector} | ${r.attackMs} | ${r.releaseMs} | ${r.depthDb} | ${r.maxGainDifferenceDb} | ${r.percentOfDepth} |`);
  P();
  const b = record("blend", runNative("mode=blend"));
  P("## Snapshot blending of effect parameters (biquad: tones 300 Hz, 3 kHz, 9 kHz; worst over the 12 cases of each scheme)");
  P();
  P("`glitch vs own per-sample` = largest second difference around the transition over that of the same trajectory evaluated per sample (1.00: the per-quantum update adds nothing). `glitch vs exact` is against the exact log-Hz per-sample reference (trajectories differ for the lerp schemes, so only the first two are comparable).");
  P();
  P("| scheme | worst glitch vs own per-sample | worst glitch vs exact log-Hz | end-state error |");
  P("|---|---:|---:|---|");
  const schemes = [...new Set(b.filter((r) => r.scheme && r.blend && !String(r.blend).startsWith("compressor")).map((r) => r.scheme))];
  for (const s of schemes) {
    const rows = b.filter((r) => r.scheme === s && !String(r.blend).startsWith("compressor"));
    const own = rows.map((r) => r.glitchRatioD2VsOwnPerSample).filter((x) => x !== null && Number.isFinite(x));
    P(`| ${s} | ${own.length ? f(Math.max(...own), 2) : "(is the reference)"} | ${f(Math.max(...rows.map((r) => r.glitchRatioD2VsExactLogHz)), 2)} | ${rows.every((r) => r.errAtEndDb < -100) ? "converges exactly" : "differs"} |`);
  }
  P();
  P("Compressor threshold (tones 220/880/1760 Hz; `abrupt` = largest step of the difference to the unedited run over its peak: <= 0.2 smooth, 1 a jump):");
  P();
  P("| edit | scheme | abrupt | largest step dBFS | peak difference dBFS |");
  P("|---|---|---:|---:|---:|");
  for (const r of b.filter((r) => String(r.blend).startsWith("compressor"))) P(`| ${r.blend} | ${r.scheme} | ${r.abrupt} | ${r.largestStepDbfs} | ${r.peakDifferenceDbfs} |`);
  P();
}

if (parts.includes("micro")) {
  for (const t of ["native", "wasm"]) {
    for (let i = 0; i < RUNS; i++) {
      log(`micro ${t} run ${i + 1}/${RUNS}`);
      const args = `mode=micro calls=${CALLS}`;
      record(`micro-${t}-${i}`, t === "native" ? runNative(args) : runWasm(args));
    }
  }
  // second pass over raw rows (kept in the file) to fill the table
  const rows = readFileSync(raw, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.tag?.startsWith("micro-"));
  const agg = {};
  for (const r of rows) (((agg[r.group] ??= {})[r.case] ??= {})[r.target] ??= []).push(r);
  P("## Micro: ns per quantum (median over runs of each run's value; per-call clock reads, so p50 includes the timer overhead row; `blk64` is the mean of 64-call blocks)");
  P();
  const over = (t) => median((agg.sidechain?.["timer-overhead"]?.[t] ?? []).map((r) => r.p50));
  const copy = (t) => median((agg.sidechain?.["copy-only-baseline"]?.[t] ?? []).map((r) => r.p50)) - over(t);
  for (const [group, cases] of Object.entries(agg)) {
    P(`### ${group}`);
    P();
    P("| case | native p50 | p99 | p99.9 | max | blk64 | wasm p50 | p99 | p99.9 | max | blk64 | wasm p50 % of quantum |");
    P("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const [name, v] of Object.entries(cases)) {
      const c = (t, k) => f(median((v[t] ?? []).map((r) => r[k])));
      const w50 = median((v.wasm ?? []).map((r) => r.p50));
      P(`| ${name} | ${c("native", "p50")} | ${c("native", "p99")} | ${c("native", "p999")} | ${c("native", "max")} | ${c("native", "mean64_p50")} | ${c("wasm", "p50")} | ${c("wasm", "p99")} | ${c("wasm", "p999")} | ${c("wasm", "max")} | ${c("wasm", "mean64_p50")} | ${f((w50 / QUANTUM_NS) * 100, 3)} |`);
    }
    P();
  }
  P(`Timer overhead p50: native ${f(over("native"))} ns, wasm ${f(over("wasm"))} ns. Copy-only baseline (the per-call refresh of the target buffer, in cases that process in place), net of the timer: native ${f(copy("native"))} ns, wasm ${f(copy("wasm"))} ns. Subtract the matching one from a case's p50 for the work itself.`);
  P();
}

if (parts.includes("metered")) {
  log("metered wasm (instruction counts, deterministic)");
  const metered = new WebAssembly.Module(meter(wasmBytes).bytes);
  const rows = runWasm(`mode=micro calls=${smoke ? 500 : 2000}`, metered, true);
  record("metered", rows);
  P("## Metered wasm: instructions per quantum (p50 of per-call counter deltas / 1000; includes the timer's own few instructions: see `timer-overhead`)");
  P();
  P("| group | case | instructions |");
  P("|---|---|---:|");
  for (const r of rows) P(`| ${r.group} | ${r.case} | ${f(r.p50 / 1000)} |`);
  P();
}

if (parts.includes("ordering")) {
  log("ordering of the samples' bus trees");
  const o = JSON.parse(execFileSync("node", [`${here}ordering.mjs`], { encoding: "utf8" }));
  record("ordering", o);
  P("## Bus order vs sidechain order in the samples (`ordering.mjs`)");
  P();
  for (const s of o) {
    P(`- **${s.sample}** (${s.buses} buses, depth ${s.maxDepth}); every ordered bus pair: ${s.allPairs.triggerFirst} trigger-first, ${s.allPairs.delayed} delayed one quantum, ${s.allPairs.triggerIsAncestor} trigger-is-ancestor (cycle); all rules reorderable at BUS_CONFIG: ${s.allRulesReorderable}`);
    for (const r of s.rules) P(`  - rule ${r.trigger} -> ${r.target} (attack ${r.attackMs} ms, amount ${r.amount}): ${r.verdict}; reorderable: ${r.reorderableAtConfig}`);
  }
  P();
}

if (parts.includes("live")) {
  log("live edits through the real core");
  execFileSync("node", [`${here}live/build.mjs`], { stdio: ["ignore", "inherit", "inherit"] });
  const rows = JSON.parse(execFileSync("node", [`${here}live/build/live.mjs`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  record("live", rows);
  P("## Live edits through the real core (Node loopback, committed myco_audio.wasm; worst of 8 edit phases)");
  P();
  P("`abrupt` = largest sample-to-sample step of (edited - unedited output) over its peak (<= 0.23 is what a smooth change of these tones can give; above 0.3 is a click); `step dBFS` = that largest step in absolute terms; `onset` = frames from the batch to the first changed sample.");
  P();
  P("| edit | abrupt | verdict | click step dBFS | peak change | onset frames | settle ms |");
  P("|---|---:|---|---:|---:|---:|---:|");
  for (const r of rows.filter((r) => r.abrupt !== undefined)) P(`| ${r.edit} | ${r.abrupt} | ${r.verdict} | ${r.stepDbfs} | ${r.diffPeak} | ${r.onsetFramesMin} | ${r.settleMs ?? "-"} |`);
  for (const r of rows.filter((r) => r.abrupt === undefined)) P(`\n${JSON.stringify(r)}`);
  P();
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
P(`Run took ${mins} min.`);
writeFileSync(`${out}summary.md`, md.join("\n") + "\n");
log(`done in ${mins} min: ${out}summary.md`);
