#!/usr/bin/env node
// The audio core's CI cost gate (ADR 0157 task C1b, architecture §6.5 "CI": +10% fails). Runs fixed `audio-bench`
// scenes through the metered wasm (`metered/audio_bench.metered.wasm`, written by `npm run build:audio`: the bench
// built like the mixer, +simd128 and release, then instrumented by `meter.mjs`) and compares each scene's wasm
// instructions per quantum with `metered/baseline.json`. Wall time on a shared machine moves ±15% between runs; the
// count is the same on every machine and every run, so a 10% threshold is meaningful. Needs Node only (no Rust).
//
//   node tools/audio-bench/metered-gate.mjs                 # all scenes; exit 1 if any rose more than 10%
//   node tools/audio-bench/metered-gate.mjs scene=fx,high   # a subset
//   UPDATE_METERED_BASELINE=1 node tools/audio-bench/metered-gate.mjs   # rewrite the baseline from this run
//
// The counted region is the bench's timed one, the audio thread's work per quantum: the batch submit, the stream
// copies, `process`, `after_quantum`, the clip events and (every 6th quantum) the STATUS take. The bench reads the
// clock through its `bench_now` import; here that import returns the counter, so the bench's per-quantum "times" are
// instruction counts. Each scene runs on a fresh instance (the allocator's state never carries over between scenes).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COUNTER_EXPORT, METER_VERSION } from "./meter.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const WASM = here("metered/audio_bench.metered.wasm");
const META = here("metered/metered.json");
const BASELINE = here("metered/baseline.json");
const HASH_JSON = here("../../src/plugins/audio/runtime/wasm/hash.json");
const REBUILD = "run `npm run build:audio`";

/** A rise above this fails the gate; a drop below its inverse is reported (update the baseline to keep the gain). */
const THRESHOLD = 0.1;
/** Audio seconds per scene after the warm-up. Counts don't vary, so a short run is as good as a long one; two seconds
 *  takes in 125 batches, 125 STATUS takes and (for the one-shot scenes) several hundred voice starts. */
const SECONDS = 2;
const WARMUP = 1;
const SEED = 1;

/** The gated scenes (`audio-bench`'s `scene()`): the presets, the Stress sample's twins, and focused ones. */
const SCENES = [
  "low",
  "default",
  "high",
  "high-pitch16",
  "stress",
  "stress-cap",
  "fx",
  "hrtf-static",
  "hrtf-moving",
  "streams",
  "pitch4",
  "virtual",
  "updates",
];

function fail(message) {
  console.error(`[metered] ${message}`);
  process.exit(1);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail(`${what} (${path}) is missing or unreadable: ${REBUILD}`);
  }
}

/** Runs one scene on a fresh instance of `module`; returns the bench's result line. */
function runScene(module, scene) {
  let memory = null;
  let counter = null;
  const lines = [];
  const instance = new WebAssembly.Instance(module, {
    env: {
      // ms, as `performance.now()` would give: the bench multiplies by 1,000 for µs.
      bench_now: () => Number(counter.value) / 1000,
      bench_print: (ptr, len) => lines.push(Buffer.from(memory.buffer, ptr >>> 0, len).toString("utf8")),
      bench_sleep: () => {},
    },
  });
  memory = instance.exports.memory;
  counter = instance.exports[COUNTER_EXPORT];
  const args = Buffer.from(`mode=scene name=${scene} seconds=${SECONDS} warmup=${WARMUP} runs=1 seed=${SEED}`);
  const ptr = instance.exports.bench_alloc(args.length);
  new Uint8Array(memory.buffer, ptr >>> 0, args.length).set(args);
  instance.exports.bench_main(ptr, args.length);
  const result = lines.map((l) => JSON.parse(l)).find((r) => r.scene === scene);
  if (!result) fail(`scene ${scene} printed no result: ${lines.join(" ") || "(nothing)"}`);
  return {
    quanta: result.quanta,
    perQuantum: Math.round(result.mean),
    total: Math.round(result.mean * result.quanta),
    p99: Math.round(result.p99),
    max: Math.round(result.max),
    wuMean: result.wuMean,
  };
}

const pct = (ratio) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(2)}%`;

function main() {
  const meta = readJson(META, "metered/metered.json");
  const { sourceHash } = readJson(HASH_JSON, "wasm/hash.json");
  if (meta.sourceHash !== sourceHash) {
    fail(`the metered wasm was built from source ${meta.sourceHash}, the mixer from ${sourceHash}: ${REBUILD}`);
  }
  if (meta.meterVersion !== METER_VERSION) {
    fail(`the metered wasm was instrumented by meter.mjs version ${meta.meterVersion}, this is ${METER_VERSION}: ${REBUILD}`);
  }
  const subset = process.argv.slice(2).find((a) => a.startsWith("scene="));
  const scenes = subset ? subset.slice("scene=".length).split(",") : SCENES;
  const update = process.env.UPDATE_METERED_BASELINE === "1";
  const module = new WebAssembly.Module(readFileSync(WASM));

  const results = {};
  for (const scene of scenes) {
    const t0 = performance.now();
    results[scene] = runScene(module, scene);
    const r = results[scene];
    console.log(`[metered] ${scene}: ${r.perQuantum.toLocaleString("en-US")} instructions per quantum (p99 ${r.p99.toLocaleString("en-US")}, max ${r.max.toLocaleString("en-US")}; ${r.quanta} quanta; ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }

  if (update) {
    const previous = (() => {
      try {
        return JSON.parse(readFileSync(BASELINE, "utf8")).scenes ?? {};
      } catch {
        return {};
      }
    })();
    const baseline = {
      note: "Wasm instructions per quantum of audio-bench scenes in the metered build (ADR 0157 C1b). Rewrite with UPDATE_METERED_BASELINE=1 node tools/audio-bench/metered-gate.mjs.",
      meterVersion: METER_VERSION,
      sourceHash,
      settings: { seconds: SECONDS, warmup: WARMUP, seed: SEED },
      scenes: subset ? { ...previous, ...results } : results,
    };
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[metered] wrote ${BASELINE}`);
    return;
  }

  const baseline = readJson(BASELINE, "metered/baseline.json");
  if (baseline.meterVersion !== METER_VERSION) {
    fail(`the baseline was counted by meter.mjs version ${baseline.meterVersion}, this is ${METER_VERSION}: rewrite it with UPDATE_METERED_BASELINE=1`);
  }
  const s = baseline.settings ?? {};
  if (s.seconds !== SECONDS || s.warmup !== WARMUP || s.seed !== SEED) {
    fail("the baseline was counted with other scene settings: rewrite it with UPDATE_METERED_BASELINE=1");
  }
  const rises = [];
  const drops = [];
  let sumNow = 0;
  let sumBase = 0;
  console.log(`[metered] against the baseline from source ${baseline.sourceHash} (fails above +${THRESHOLD * 100}%):`);
  for (const scene of scenes) {
    const base = baseline.scenes[scene];
    if (!base) {
      rises.push(`${scene} has no baseline (add it with UPDATE_METERED_BASELINE=1)`);
      continue;
    }
    const now = results[scene];
    const ratio = now.perQuantum / base.perQuantum;
    sumNow += now.total;
    sumBase += base.total;
    const flag = ratio > 1 + THRESHOLD ? "  FAIL" : ratio < 1 / (1 + THRESHOLD) ? "  (drop: update the baseline to keep it)" : "";
    console.log(`  ${scene.padEnd(13)} ${String(base.perQuantum).padStart(11)} -> ${String(now.perQuantum).padStart(11)}  ${pct(ratio).padStart(8)}   p99 ${pct(now.p99 / base.p99).padStart(8)}${flag}`);
    if (ratio > 1 + THRESHOLD) rises.push(`${scene} rose ${pct(ratio)} (${base.perQuantum} -> ${now.perQuantum} instructions per quantum)`);
    else if (ratio < 1 / (1 + THRESHOLD)) drops.push(scene);
  }
  if (sumBase > 0) console.log(`  ${"all".padEnd(13)} ${pct(sumNow / sumBase).padStart(35)}`);
  if (drops.length > 0) {
    console.log(`[metered] ${drops.join(", ")} dropped more than ${THRESHOLD * 100}%; to lock the gain in: UPDATE_METERED_BASELINE=1 npm run check:audio-metered`);
  }
  if (rises.length > 0) {
    fail(`the audio core's cost rose more than ${THRESHOLD * 100}%:\n  ${rises.join("\n  ")}\nIf the rise is intended (a feature that costs more), rewrite the baseline with UPDATE_METERED_BASELINE=1 npm run check:audio-metered and say why in the PR.`);
  }
  console.log("[metered] pass");
}

main();
