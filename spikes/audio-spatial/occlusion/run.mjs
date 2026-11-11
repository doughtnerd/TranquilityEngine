// One command for the timed runs:  node spikes/audio-spatial/occlusion/run.mjs
// Runs the correctness tests, then the timed harness (RUNS=5 x FRAMES=600 per case by default), then prints tables.
// Env: RUNS, FRAMES, WARMUP, SECTIONS=rays,sched,transmission, SMOKE=1 (marks the output as smoke and defaults to RUNS=2 FRAMES=120).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const config = join(here, "vitest.config.mts");
const smoke = process.env.SMOKE === "1";
const env = { ...process.env, ...(smoke ? { RUNS: process.env.RUNS ?? "2", FRAMES: process.env.FRAMES ?? "120", WARMUP: process.env.WARMUP ?? "20" } : {}) };
const OUT = join(here, smoke ? "results.smoke.json" : "results.json");
env.OUT = OUT;

const vitest = (file, extra = []) => spawnSync("npx", ["vitest", "run", "--config", config, file, ...extra], { cwd: root, stdio: "inherit", env });
if (!process.env.SKIP_CORRECTNESS && vitest("correctness", ["--reporter=verbose"]).status !== 0) { console.error("correctness tests FAILED; not timing"); process.exit(1); }
if (vitest("bench").status !== 0) process.exit(1);

const r = JSON.parse(readFileSync(OUT, "utf8"));
const f = (x, d = 0) => (x === null || x === undefined ? "-" : Number(x).toFixed(d));
const table = (head, rows) => { console.log("| " + head.join(" | ") + " |\n|" + head.map(() => "---").join("|") + "|"); for (const row of rows) console.log("| " + row.join(" | ") + " |"); console.log(); };
console.log(`\n${smoke ? "SMOKE (not final) " : ""}Results: ${r.meta.cpu} x${r.meta.cores}, node ${r.meta.node}, ${r.meta.runs} runs x ${r.meta.framesPerRun} frames (+${r.meta.warmupFrames} warm-up), ${r.meta.colliders} colliders (${r.meta.occluders} occluders). Times are per frame in us, pooled over runs.\n`);
if (r.rays) { console.log("### 1. Rays through Physics.raycast (all S sources every frame)"); table(["S", "variant", "filter", "rays/frame", "p50", "p99", "p99.9", "max", "rays/ms", "us/ray", "run p50 min-max"], r.rays.map((x) => [x.S, x.variant, x.filter, f(x.raysPerFrame), f(x.p50), f(x.p99), f(x.p999), f(x.max), f(x.raysPerMs), f(x.usPerRay, 2), `${f(x.runP50Min)}-${f(x.runP50Max)}`])); }
if (r.sched) { console.log("### 2 + 4. Time-sliced scheduler (frame = rank + rays + smoothing of all S)"); table(["S", "R", "scheme", "motion", "casts/frame", "rays/frame", "p50", "p99", "p99.9", "max", "rays/ms", "frames to refresh all (median / max)", "stale-wrong %"], r.sched.map((x) => [x.S, x.R, x.scheme, x.motion, f(x.castsPerFrame, 1), f(x.raysPerFrame, 1), f(x.p50), f(x.p99), f(x.p999), f(x.max), f(x.raysPerMs), x.scheme.includes("only") ? "never (no round-robin, by design)" : x.framesToRefreshAll.median === null ? `not within ${r.meta.framesPerRun + r.meta.warmupFrames}` : `${x.framesToRefreshAll.median} / ${x.framesToRefreshAll.max}${x.framesToRefreshAll.unfinishedRuns ? ` (${x.framesToRefreshAll.unfinishedRuns} unfinished)` : ""}`, f(x.staleWrongPct, 1)])); }
if (r.transmission) { console.log("### 3. Transmission model (no rays)"); table(["S", "R", "part", "p50 us", "p99", "p99.9", "max", "ns/source p50"], r.transmission.map((x) => [x.S, x.R, x.part, f(x.p50, 2), f(x.p99, 2), f(x.p999, 2), f(x.max, 2), f(x.nsPerSourceP50, 1)])); }
console.log(`raw: ${OUT}`);
