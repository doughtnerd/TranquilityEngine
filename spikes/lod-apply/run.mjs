// Runner for the lod-apply spike. One command, writes results.json next to this file:
//
//     node spikes/lod-apply/run.mjs            (RUNS=5 by default; QUICK=1 for 2 runs; timings are smoke-level on a shared machine)
//
// Expected duration on an idle 4-core machine: about 7 minutes (about 1 minute of correctness checks, then RUNS x
// ~70 s of timing: each run is a fresh page and WebGL context, builds 40k InstancedMeshes per timing variant).
// Headless Chromium, WebGL2 on SwiftShader (no GPU, no WebGPU). Draw-call logs and pixel counts are exact; times are JS-side only.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSpike } from "./browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = process.env.QUICK ? 2 : Number(process.env.RUNS ?? 5);
const spike = await openSpike();

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const summary = (xs) => ({ p50: +pct(xs, 50).toFixed(3), p99: +pct(xs, 99).toFixed(3), max: +Math.max(...xs).toFixed(3), n: xs.length });
const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === "raw" || k === "png" ? undefined : v)));

async function call(page, name, ...args) {
  try {
    return await page.evaluate(([n, a]) => window.tests[n](...a), [name, args]);
  } catch (e) {
    return { error: String(e).slice(0, 500) };
  }
}

// ---- correctness: once, one page per check so a failure can't contaminate the next ----------------------------------
const correctness = {};
const checks = [
  ["1-selectorProbe", []],
  ["1-parity/a", ["a"]],
  ["1-parity/b", ["b"]],
  ["1-parity/b-noCurrentLod", ["b-noCurrentLod"]],
  ["1-parity/c-setEnabled (render hook only)", ["c-setEnabled", false]],
  ["1-parity/c-setEnabled (hook on geometry pass too)", ["c-setEnabled", true]],
  ["2-scenario/baseline", ["baseline", false]],
  ["2-scenario/sharedVB", ["sharedVB", false]],
  ["2-scenario/sharedGeo", ["sharedGeo", false]],
  ["2-scenario/baseline skinned", ["baseline", true]],
  ["2-scenario/sharedVB skinned", ["sharedVB", true]],
  ["2-dispose", []],
  ["3-views", []],
  ["3-cascades/all", ["all"]],
  ["3-cascades/perCascade", ["perCascade"]],
  ["3-cascades/perCascade-emptyLayer0", ["perCascade-emptyLayer", 0]],
  ["3-cascades/perCascade-emptyLayer1", ["perCascade-emptyLayer", 1]],
  ["3-cascades/perCascade-emptyLayer2", ["perCascade-emptyLayer", 2]],
];
for (const [label, args] of checks) {
  const page = await spike.newPage();
  const test = label.split("/")[0];
  const t = Date.now();
  correctness[label] = strip(await call(page, test, ...args));
  console.error(`[correctness] ${label} ${Date.now() - t} ms`);
  await page.close();
}

// ---- timings: RUNS fresh pages, samples pooled -----------------------------------------------------------------------
const variants = ["a", "b", "c-setEnabled", "c-isVisible"];
const pooled = Object.fromEntries(variants.map((v) => [v, { applyA: [], applyB: [], renderMs: [], perRunP50: { applyA: [], render: [] } }]));
const perf3 = { fill: [[], [], [], [], []], upload: [[], [], [], [], []], frameTotal: [], perRunP50: [] };
for (let run = 0; run < RUNS; run++) {
  const t = Date.now();
  for (const v of variants) {
    const page = await spike.newPage();
    const r = await call(page, "1-timing", v, 30);
    if (r.error) { console.error(r.error); await page.close(); continue; }
    const p = pooled[v];
    p.applyA.push(...r.raw.applyA); p.applyB.push(...r.raw.applyB); p.renderMs.push(...r.raw.renderMs);
    p.perRunP50.applyA.push(r.applyPerViewMs.A.p50); p.perRunP50.render.push(r.renderTotalMs.p50);
    if (r.check.mismatches) console.error(`WARNING ${v}: ${r.check.mismatches} pixel mismatches`);
    await page.close();
  }
  const page = await spike.newPage();
  const r = await call(page, "3-perf", 40);
  r.raw.fill.forEach((a, i) => perf3.fill[i].push(...a));
  r.raw.upload.forEach((a, i) => perf3.upload[i].push(...a));
  perf3.frameTotal.push(...r.raw.frameTotal);
  perf3.perRunP50.push(r.allFivePassesMs.p50);
  await page.close();
  console.error(`[timing] run ${run + 1}/${RUNS} ${Date.now() - t} ms`);
}
const timing = {
  note: "ms, JS side, pooled over runs; applyA/applyB = per-view apply cost; renderMs = whole scene.render() of both views (cull + geometry-free render pass + GL calls)",
  runs: RUNS,
  perViewSelection10k: Object.fromEntries(variants.map((v) => [v, { applyA: summary(pooled[v].applyA), applyB: summary(pooled[v].applyB), sceneRender: summary(pooled[v].renderMs), perRunP50: pooled[v].perRunP50 }])),
  perPassFillUpload10k: {
    passes: ["view A (60 %)", "view B (60 %)", "cascade 0 (25 %)", "cascade 1 (40 %)", "cascade 2 (60 %)"],
    fillMs: perf3.fill.map(summary), uploadMs: perf3.upload.map(summary), allFivePassesPerFrame: summary(perf3.frameTotal), perRunP50: perf3.perRunP50,
    bytesPerPassBuffer: 640000, bytesAllFivePasses: 3200000,
  },
};

const info = await (async () => {
  const page = await spike.newPage();
  const r = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return { webgl2: !!gl, renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?", crossOriginIsolated: self.crossOriginIsolated };
  });
  await page.close();
  return r;
})();
const out = { info, date: new Date().toISOString(), runs: RUNS, correctness, timing };
writeFileSync(join(here, "results.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(timing, null, 1));
await spike.close();
