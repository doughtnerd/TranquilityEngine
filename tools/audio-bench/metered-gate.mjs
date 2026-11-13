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

/** The gated scenes (`audio-bench`'s `scene()`): the presets, the Stress sample's twins, focused ones, the bed scenes and M3's filter and worst-case scenes. */
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
  // ADR 0158 E2: automation (256 mixed voices x 3 bindings, and their twin without), on virtual voices, on buses, and
  // sustain loops released and replaced.
  "automation",
  "automation-base",
  "automation-virtual",
  "bus-automation",
  "sustain",
  // ADR 0162 A7: beds. 64 voices into one MagLS bed, 256 into two, and 64 voices crossing the HRTF/bed boundary.
  "bed-64",
  "bed-256",
  "bed-xfade",
  // ADR 0162 D6: 256 voices each with a ramping low-pass and high-pass (D1's pool), and each preset's worst case: beds,
  // ambisonic clips (one private), filters and zone slots sized (these three have no sends: the slots idle; see C7's `-sends` twins below).
  "filters-256",
  // ADR 0162 A7: four 3rd-order ambisonic clips rotated by a turning listener into one MagLS bed (B3's voice).
  "ambi-o3",
  "m3-worst-high",
  "m3-worst-default",
  "m3-worst-low",
  // ADR 0162 C7: zones with C4's sends. Two 2 s zones fed by 16 voices; zones swapping slots through the standby and eviction
  // paths (kernels uploaded as they go); the high preset's typical M3 scene; and D6's worst scenes with their slots convolving.
  "zones-2x2s",
  "zones-swap",
  "m3-high",
  "m3-worst-high-sends",
  "m3-worst-default-sends",
  "m3-worst-low-sends",
  // ADR 0166 M4-0 (Z5): per-quantum per-voice records stamped inside their quantum (applied in the voice; the bench asserts
  // `splitQuanta == 0` at the end of a stamped scene) beside the same records unstamped, one pair each: a FADE on one of
  // 256 voices; spatial plays with zone and aux sends and a low-pass ramp; a SET_LOOP (class S) on one of 128 voices; and
  // music (8 stems, equal-power crossfades, stamped stops). `STAMPED_TWINS` holds each pair's +60k instruction limit.
  "stamped-g",
  "stamped-g-twin",
  "stamped-spatial",
  "stamped-spatial-twin",
  "stamped-loop",
  "stamped-loop-twin",
  "stamped-music",
  "stamped-music-twin",
  // ADR 0166 M4b (Bench1): music on the default preset (8 music rings, 16 groups), decoded and streamed, each beside its
  // music-free twin. Music's own cost is a scene less its twin; `MUSIC_PAIRS` holds each one's allowance.
  "music-typ-twin",
  "music-typ",
  "music-typ-streamed",
  "music-trans-twin",
  "music-trans",
  "music-trans-streamed",
  "music-worst-twin",
  "music-worst",
  "music-worst-streamed",
  // ADR 0171/0172 M5 (Bn1): bus lanes ramping. 8 buses each with a BUS_RAMP every 4th quantum, stamped (class B) and asap
  // (`-twin`), beside the same 8 settled (`-base`); 32 buses configured with 4 ramping and 28 settled, beside the 32
  // settled. `BUS_LANE_PAIRS` reports the cost per ramping lane against architecture §7.1's 1.7-1.8k.
  "busramp-8-base",
  "busramp-8",
  "busramp-8-twin",
  "busramp-32-base",
  "busramp-32",
];

/** Bn1: each ramping scene -> its settled base and its number of ramping lanes (informational: §7.1's model is 1.7-1.8k
 *  instructions per ramping lane per quantum, today's ramping bus 5.4k). */
const BUS_LANE_PAIRS = {
  "busramp-8": { base: "busramp-8-base", lanes: 8 },
  "busramp-8-twin": { base: "busramp-8-base", lanes: 8 },
  "busramp-32": { base: "busramp-32-base", lanes: 4 },
};

/** Stamped scene -> its unstamped twin: the stamped one may cost at most this many more instructions per quantum
 *  (the waves plan's tripwire; a miss is logged and raised with the owner, not fixed by trading CPU or quality). */
const STAMPED_TWINS = Object.fromEntries(SCENES.filter((n) => n.startsWith("stamped-") && !n.endsWith("-twin")).map((n) => [n, `${n}-twin`]));
const TWIN_LIMIT = 60_000;

/** ADR 0166 M4b (Bench1): each music scene -> its music-free twin and the S7 allowance for music's own cost (scene less twin),
 *  in instructions per quantum. The design's allowances are reference microseconds (architecture §7.2, R23: default preset,
 *  typical 0.05 ms, worst 0.08 ms); a reference microsecond is 1.45 container microseconds (R23), and S4 measured the container
 *  at 0.075 microseconds per 1k instructions, so 0.05 ms = 966,667 and 0.08 ms = 1,546,667. The transition scene has no row of
 *  its own and is held to the worst one (a seam is never dearer than every voice fading). A miss is a tripwire move for the
 *  owner (CLAUDE.md), logged in the build log; it isn't fixed by trading CPU or quality. */
const REF_US_INSTRUCTIONS = (1.45 * 1000) / 0.075;
const MUSIC_TYPICAL_LIMIT = Math.round(50 * REF_US_INSTRUCTIONS);
const MUSIC_WORST_LIMIT = Math.round(80 * REF_US_INSTRUCTIONS);
const MUSIC_PAIRS = {
  "music-typ": { twin: "music-typ-twin", limit: MUSIC_TYPICAL_LIMIT },
  "music-typ-streamed": { twin: "music-typ-twin", limit: MUSIC_TYPICAL_LIMIT },
  "music-trans": { twin: "music-trans-twin", limit: MUSIC_WORST_LIMIT },
  "music-trans-streamed": { twin: "music-trans-twin", limit: MUSIC_WORST_LIMIT },
  "music-worst": { twin: "music-worst-twin", limit: MUSIC_WORST_LIMIT },
  "music-worst-streamed": { twin: "music-worst-twin", limit: MUSIC_WORST_LIMIT },
};

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
    splitQuanta: result.splitQuanta,
    voiceSplits: result.voiceSplits,
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
    const splits = scene in STAMPED_TWINS ? `; splitQuanta ${r.splitQuanta}, voiceSplits ${r.voiceSplits}` : "";
    console.log(`[metered] ${scene}: ${r.perQuantum.toLocaleString("en-US")} instructions per quantum${splits} (p99 ${r.p99.toLocaleString("en-US")}, max ${r.max.toLocaleString("en-US")}; ${r.quanta} quanta; ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }

  // M4-0: each stamped scene against its twin (when both ran), and no stamped scene splitting the quantum.
  const twinFailures = [];
  for (const [stamped, twin] of Object.entries(STAMPED_TWINS)) {
    const a = results[stamped];
    if (!a) continue;
    if (a.splitQuanta !== 0) twinFailures.push(`${stamped} split ${a.splitQuanta} quanta (stamped per-voice records apply in their voice)`);
    const b = results[twin];
    if (!b) continue;
    const delta = a.perQuantum - b.perQuantum;
    console.log(`[metered] ${stamped} vs ${twin}: ${a.perQuantum.toLocaleString("en-US")} vs ${b.perQuantum.toLocaleString("en-US")}, ${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US")} instructions per quantum (limit +${TWIN_LIMIT.toLocaleString("en-US")})`);
    if (delta > TWIN_LIMIT) twinFailures.push(`${stamped} costs ${delta.toLocaleString("en-US")} instructions per quantum more than ${twin} (limit ${TWIN_LIMIT.toLocaleString("en-US")})`);
  }
  // M4b: each music scene's own cost against its S7 allowance.
  for (const [scene, { twin, limit }] of Object.entries(MUSIC_PAIRS)) {
    const a = results[scene];
    const b = results[twin];
    if (!a || !b) continue;
    const delta = a.perQuantum - b.perQuantum;
    console.log(`[metered] ${scene} less ${twin}: ${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US")} instructions per quantum, ${((delta / limit) * 100).toFixed(0)}% of the S7 allowance (${limit.toLocaleString("en-US")})`);
    if (delta > limit) twinFailures.push(`${scene} costs ${delta.toLocaleString("en-US")} instructions per quantum over ${twin}, above its S7 allowance of ${limit.toLocaleString("en-US")}`);
  }
  // Bn1: the cost of a ramping lane (scene less its settled base, per ramping lane) against §7.1's model.
  for (const [scene, { base, lanes }] of Object.entries(BUS_LANE_PAIRS)) {
    const a = results[scene];
    const b = results[base];
    if (!a || !b) continue;
    const delta = a.perQuantum - b.perQuantum;
    console.log(`[metered] ${scene} less ${base}: ${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US")} instructions per quantum, ${Math.round(delta / lanes).toLocaleString("en-US")} per ramping lane (model 1.7-1.8k; splitQuanta ${a.splitQuanta})`);
  }
  if (results["busramp-8"] && results["busramp-8"].splitQuanta !== 0) twinFailures.push(`busramp-8 split ${results["busramp-8"].splitQuanta} quanta (stamped bus ramps apply inside their quantum)`);
  if (results["busramp-32"] && results["busramp-32"].splitQuanta !== 0) twinFailures.push(`busramp-32 split ${results["busramp-32"].splitQuanta} quanta (stamped bus ramps apply inside their quantum)`);
  if (twinFailures.length > 0 && !update) {
    fail(`stamped scenes against their twins:\n  ${twinFailures.join("\n  ")}`);
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
