// The timed harness. Env: RUNS (default 5), FRAMES (default 600 timed frames per run), WARMUP (default 60),
// SECTIONS (comma list of rays,sched,transmission; default all), OUT (results json path).
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { it } from "vitest";
import { Physics } from "../../../src/myco";
import { aggregateHits, Occlusion, smooth, type SchedOptions } from "./occlusion";
import { buildLevel, freeListener, MATERIALS, OCCLUDER, placeSources, rng, type Level, type Pt } from "./scene";

const RUNS = Number(process.env.RUNS ?? 5), FRAMES = Number(process.env.FRAMES ?? 600), WARMUP = Number(process.env.WARMUP ?? 60);
const SECTIONS = (process.env.SECTIONS ?? "rays,sched,transmission").split(",");
const OUT = process.env.OUT ?? new URL("./results.json", import.meta.url).pathname;
const SMOKE = process.env.SMOKE === "1";
const COUNTS = [64, 256, 1024];
const DT = 1 / 60;
const now = () => performance.now();

/** Pooled per-frame quantiles in microseconds. */
function stats(runs: Float64Array[]) {
  const all = new Float64Array(runs.reduce((n, r) => n + r.length, 0));
  let o = 0;
  for (const r of runs) { all.set(r, o); o += r.length; }
  all.sort();
  const q = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))];
  const p50s = runs.map((r) => { const s = Float64Array.from(r).sort(); return s[Math.floor(s.length / 2)]; });
  return { p50: q(0.5), p99: q(0.99), p999: q(0.999), max: all[all.length - 1], mean: all.reduce((a, b) => a + b, 0) / all.length, runP50Min: Math.min(...p50s), runP50Max: Math.max(...p50s), frames: all.length };
}
const us = (ms: number) => ms * 1000;

/** Listener walking a circle (m/s) -- moved outside the timed region. */
function moveListener(L: Pt, t: number, speed = 6, radius = 15) {
  const a = (t * speed) / radius;
  L.x = Math.cos(a) * radius; L.z = Math.sin(a) * radius; L.y = 1.5;
}
function moveSources(pos: Float64Array, vel: Float64Array, S: number, r: number) {
  for (let i = 0; i < S; i++) {
    for (let a = 0; a < 3; a += 2) {
      let p = pos[i * 3 + a] + vel[i * 3 + a] * DT;
      if (p > r || p < -r) { vel[i * 3 + a] = -vel[i * 3 + a]; p = Math.max(-r, Math.min(r, p)); }
      pos[i * 3 + a] = p;
    }
  }
}

function raysSection(level: Level) {
  const rows: object[] = [];
  const variants: { name: string; R: number; chain: number }[] = [
    { name: "R1", R: 1, chain: 1 }, { name: "R3", R: 3, chain: 1 }, { name: "R5", R: 5, chain: 1 }, { name: "R1x3 (continue through up to 3 walls)", R: 1, chain: 3 },
  ];
  for (const S of COUNTS) for (const v of variants) for (const filter of ["none", "occluder"]) {
    if (v.chain > 1 && filter === "none") continue;
    const perRun: Float64Array[] = []; let totalRays = 0, totalMs = 0;
    for (let run = 0; run < RUNS; run++) {
      const { pos, loud } = placeSources(level, S, 1000 + run);
      const L = freeListener(level, 5 + run);
      const occ = new Occlusion(level, pos, loud, L, { R: v.R, layers: filter === "none" ? undefined : OCCLUDER, tier: 0, tierShare: 0, roundRobin: false, budgetCasts: 0, tau: 0.1 });
      const t = new Float64Array(FRAMES);
      for (let f = 0; f < WARMUP + FRAMES; f++) {
        moveListener(L, f * DT);
        const r0 = occ.rays, t0 = now();
        for (let i = 0; i < S; i++) occ.castSource(i, f, v.R, occ.opt.layers, v.chain);
        const dt = now() - t0;
        if (f >= WARMUP) { t[f - WARMUP] = us(dt); totalRays += occ.rays - r0; totalMs += dt; }
      }
      perRun.push(t);
    }
    const st = stats(perRun);
    rows.push({ S, variant: v.name, filter, raysPerFrame: totalRays / (RUNS * FRAMES), raysPerMs: totalRays / totalMs, usPerRay: (totalMs * 1000) / totalRays, ...st });
    console.log(`[rays] S=${S} ${v.name} filter=${filter}: p50 ${st.p50.toFixed(0)} us, p99.9 ${st.p999.toFixed(0)} us, ${(totalRays / totalMs).toFixed(0)} rays/ms`);
  }
  return rows;
}

function schedSection(level: Level) {
  const rows: object[] = [];
  type Case = { S: number; label: string; R: number; moving: boolean; opt: Partial<SchedOptions> };
  const cases: Case[] = [];
  for (const S of COUNTS) for (const R of [1, 3]) for (const budgetMs of [0.25, 0.5]) for (const moving of [false, true])
    cases.push({ S, R, moving, label: `${budgetMs} ms, tier 16 + round-robin`, opt: { tier: 16, tierShare: 0.5, roundRobin: true, budgetMs } });
  // "Re-cast the top N every frame" with no round-robin, to see what moving sources need.
  for (const S of [256, 1024]) for (const N of [32, 128]) for (const moving of [false, true])
    cases.push({ S, R: 1, moving, label: `top ${N} only, every frame`, opt: { tier: N, tierShare: 1, roundRobin: false, budgetCasts: N } });
  for (const c of cases) {
    const perRun: Float64Array[] = []; const refresh: number[] = []; const errRates: number[] = [];
    let totalRays = 0, totalMs = 0, castsSum = 0, worstCasts = 0;
    for (let run = 0; run < RUNS; run++) {
      const { pos, loud } = placeSources(level, c.S, 2000 + run);
      const vel = new Float64Array(c.S * 3), r = rng(77 + run);
      for (let i = 0; i < c.S; i++) { const a = r() * Math.PI * 2, sp = 1 + r() * 3; vel[i * 3] = Math.cos(a) * sp; vel[i * 3 + 2] = Math.sin(a) * sp; }
      const L = freeListener(level, 5 + run);
      const opt: SchedOptions = { R: c.R, layers: OCCLUDER, tier: 0, tierShare: 0.5, roundRobin: true, tau: 0.1, ...c.opt };
      const occ = new Occlusion(level, pos, loud, L, opt);
      const t = new Float64Array(FRAMES);
      let done = -1, wrong = 0, sampled = 0;
      for (let f = 0; f < WARMUP + FRAMES; f++) {
        if (c.moving) { moveListener(L, f * DT); moveSources(pos, vel, c.S, 80); }
        const r0 = occ.rays, t0 = now();
        const casts = occ.frame(f, DT);
        const dt = now() - t0;
        if (done < 0 && occ.stamp.every((s) => s >= 0)) done = f + 1;
        if (f >= WARMUP) {
          t[f - WARMUP] = us(dt); totalRays += occ.rays - r0; totalMs += dt; castsSum += casts; worstCasts = Math.max(worstCasts, casts);
          if (c.moving && (f - WARMUP) % 10 === 0) { // untimed truth: centre-ray state of every source right now
            for (let i = 0; i < c.S; i++) {
              const dx = L.x - pos[i * 3], dy = L.y - pos[i * 3 + 1], dz = L.z - pos[i * 3 + 2], d = Math.hypot(dx, dy, dz);
              const h = Physics.raycast({ x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2] }, { x: dx / d, y: dy / d, z: dz / d }, d - 0.05, OCCLUDER) ? 1 : 0;
              if (h !== occ.centerHit[i]) wrong++;
              sampled++;
            }
          }
        }
      }
      perRun.push(t); refresh.push(done); errRates.push(c.moving ? wrong / sampled : 0);
    }
    const st = stats(perRun);
    const done = refresh.filter((x) => x > 0);
    const row = {
      S: c.S, scheme: c.label, R: c.R, motion: c.moving ? "moving" : "static",
      castsPerFrame: castsSum / (RUNS * FRAMES), maxCastsPerFrame: worstCasts, raysPerFrame: totalRays / (RUNS * FRAMES), raysPerMs: totalRays / totalMs,
      framesToRefreshAll: done.length ? { median: done.sort((a, b) => a - b)[Math.floor(done.length / 2)], max: Math.max(...done), unfinishedRuns: refresh.length - done.length } : { median: null, max: null, unfinishedRuns: refresh.length },
      staleWrongPct: c.moving ? (errRates.reduce((a, b) => a + b, 0) / errRates.length) * 100 : null,
      ...st,
    };
    rows.push(row);
    console.log(`[sched] S=${c.S} R=${c.R} ${c.label} ${row.motion}: p50 ${st.p50.toFixed(0)} us, p99.9 ${st.p999.toFixed(0)}, max ${st.max.toFixed(0)}, refresh ${JSON.stringify(row.framesToRefreshAll)}, wrong ${row.staleWrongPct?.toFixed(1)}`);
  }
  return rows;
}

function transmissionSection(level: Level) {
  const rows: object[] = [];
  const hits = level.colliders.slice(0, 256);
  for (const S of COUNTS) for (const R of [1, 3, 5]) {
    const mats = new Uint8Array(S * R), r = rng(3);
    for (let i = 0; i < mats.length; i++) mats[i] = r() < 0.3 ? 255 : Math.floor(r() * MATERIALS.length);
    const tg = new Float64Array(S).fill(1), tl = new Float64Array(S).fill(14), g = new Float64Array(S).fill(1), l = new Float64Array(S).fill(14), og = new Float32Array(S), ol = new Float32Array(S);
    const o = { S, gain: g, lpLog: l, tgtGain: tg, tgtLp: tl, outGain: og, outLp: ol };
    const a = 1 - Math.exp(-DT / 0.1);
    for (const part of ["aggregate hits (Map lookup + tables), every source", "smooth + write outputs, every source"]) {
      const perRun: Float64Array[] = [];
      let sink = 0;
      for (let run = 0; run < RUNS; run++) {
        const t = new Float64Array(FRAMES);
        for (let f = 0; f < WARMUP + FRAMES; f++) {
          const t0 = now();
          if (part.startsWith("aggregate")) sink += aggregateHits(level, hits, mats, S, R, tg, tl); else smooth(o, a);
          const dt = now() - t0;
          if (f >= WARMUP) t[f - WARMUP] = us(dt);
        }
        perRun.push(t);
      }
      if (sink === -1) console.log(sink);
      const st = stats(perRun);
      rows.push({ S, R, part, nsPerSourceP50: (st.p50 * 1000) / S, nsPerSourceP999: (st.p999 * 1000) / S, ...st });
    }
  }
  return rows;
}

it("measures occlusion cost", async () => {
  const level = await buildLevel(1);
  const out: Record<string, unknown> = {
    meta: {
      node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, date: new Date().toISOString(), runs: RUNS, framesPerRun: FRAMES, warmupFrames: WARMUP, smoke: SMOKE,
      colliders: level.colliders.length, occluders: level.boxes.filter((b) => b.layer === "Occluder").length, props: level.boxes.filter((b) => b.layer === "Default").length,
    },
  };
  if (SECTIONS.includes("rays")) out.rays = raysSection(level);
  if (SECTIONS.includes("sched")) out.sched = schedSection(level);
  if (SECTIONS.includes("transmission")) out.transmission = transmissionSection(level);
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  level.engine.dispose();
});
