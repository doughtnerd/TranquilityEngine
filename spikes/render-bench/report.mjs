#!/usr/bin/env node
// Prints markdown tables from results.json (and the occlusion pre-pass files). `node report.mjs`
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { rows, meta } = JSON.parse(readFileSync(join(HERE, "results.json"), "utf8"));
const get = (cfg, throttle, measure) => rows.find((r) => r.configId === cfg && r.cpuThrottle === throttle && r.measure === measure);
const f = (v, d = 1) => (v === undefined || Number.isNaN(v) ? "-" : v.toFixed(d));
const M = (v) => (v === undefined ? "-" : (v / 1e6).toFixed(2) + "M");
const pctOf = (v, base) => (v === undefined || !base ? "" : ` (${v <= base ? "" : "+"}${(((v - base) / base) * 100).toFixed(0)}%)`);

console.log(`profile: ${JSON.stringify(meta.profile)}  renderer: ${meta.renderer}\n`);

console.log("### Baseline (static camera)\n");
console.log("| scene | instancing | draw calls (main/shadow/other) | triangles (main/shadow) | JS submit span main / shadow ms | JS CPU ms p50 / p99 / max, 1x | JS CPU ms, 4x (est.) | raster frame ms (SwiftShader) |");
console.log("|---|---|---|---|---|---|---|---|");
for (const scene of ["forest", "city"]) for (const inst of ["auto", "thin"]) {
  const id = `${scene}-${inst}-static-baseline`;
  const a = get(id, 1, "cpu"), b = get(id, 4, "cpu"), r = get(id, 1, "raster");
  if (!a) continue;
  console.log(`| ${scene} | ${inst} | ${a.drawCalls.total} (${a.drawCalls.main}/${a.drawCalls.shadow}/${a.drawCalls.other}) | ${M(a.triangles.total)} (${M(a.triangles.main)}/${M(a.triangles.shadow)}) | ${f(a.submitSpanMs.main)} / ${f(a.submitSpanMs.shadow)} | ${f(a.cpuMs.p50)} / ${f(a.cpuMs.p99)} / ${f(a.cpuMs.max)} | ${b ? `${f(b.cpuMs.p50)} / ${f(b.cpuMs.p99)} / ${f(b.cpuMs.max)}` : "-"} | ${r ? `${f(r.frameMs.p50, 0)} (n=${r.runs * r.framesPerRun})` : "-"} |`);
}

console.log("\n### Oracles (static camera; deltas vs baseline of the same row group)\n");
console.log("| scene | instancing | oracle | triangles | draw calls | JS CPU ms p50 (1x) | JS CPU ms p50 (4x est.) | raster ms | hidden by occlusion | culled by LOD |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const scene of ["forest", "city"]) for (const inst of ["auto", "thin"]) {
  const base = get(`${scene}-${inst}-static-baseline`, 1, "cpu");
  const base4 = get(`${scene}-${inst}-static-baseline`, 4, "cpu");
  const baseR = get(`${scene}-${inst}-static-baseline`, 1, "raster");
  for (const o of ["baseline", "lod", "occlusion", "both"]) {
    const a = get(`${scene}-${inst}-static-${o}`, 1, "cpu");
    if (!a) continue;
    const b = get(`${scene}-${inst}-static-${o}`, 4, "cpu"), r = get(`${scene}-${inst}-static-${o}`, 1, "raster");
    console.log(`| ${scene} | ${inst} | ${o} | ${M(a.triangles.total)}${pctOf(a.triangles.total, base?.triangles.total)} | ${a.drawCalls.total}${pctOf(a.drawCalls.total, base?.drawCalls.total)} | ${f(a.cpuMs.p50)}${pctOf(a.cpuMs.p50, base?.cpuMs.p50)} | ${b ? f(b.cpuMs.p50) + pctOf(b.cpuMs.p50, base4?.cpuMs.p50) : "-"} | ${r ? f(r.frameMs.p50, 0) + pctOf(r.frameMs.p50, baseR?.frameMs.p50) : "-"} | ${a.oracleCounts.hiddenByOcclusion} | ${a.oracleCounts.culledByLod} |`);
  }
  const nc = get(`${scene}-${inst}-static-lod-nocull`, 1, "cpu");
  if (nc) console.log(`| ${scene} | ${inst} | lod, no cull | ${M(nc.triangles.total)}${pctOf(nc.triangles.total, base?.triangles.total)} | ${nc.drawCalls.total}${pctOf(nc.drawCalls.total, base?.drawCalls.total)} | ${f(nc.cpuMs.p50)} | - | - | 0 | 0 |`);
}

console.log("\n### LOD level occupancy (static camera, LOD oracle with cull): objects per level L0/L1/L2/L3, culled\n");
for (const scene of ["forest", "city"]) {
  const a = get(`${scene}-auto-static-lod`, 1, "cpu");
  if (a) console.log(`- ${scene}: ${a.oracleCounts.lodLevels.join(" / ")}, culled ${a.oracleCounts.culledByLod}`);
}

console.log("\n### Fly-through (10 s equivalent path, JS CPU frame ms; draw calls / triangles are per-frame medians and maxima)\n");
console.log("| scene | variant | throttle | frames | CPU p50 | CPU p99 | CPU max | draws med / max | tris med / max |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const scene of ["forest", "city"]) for (const [inst, o] of [["auto", "baseline"], ["thin", "baseline"], ["auto", "both"]]) for (const t of [1, 4]) {
  const a = get(`${scene}-${inst}-fly-${o}`, t, "cpu");
  if (a) console.log(`| ${scene} | ${inst} ${o} | ${t}x${t === 4 ? " (est.)" : ""} | ${a.runs}x${a.framesPerRun} | ${f(a.cpuMs.p50)} | ${f(a.cpuMs.p99)} | ${f(a.cpuMs.max)} | ${a.drawCalls.total} / ${a.drawCallsMax} | ${M(a.triangles.total)} / ${M(a.trianglesMax)} |`);
}

console.log("\n### Occlusion pre-pass (object-ID pass, 1280x720, full-resolution geometry)\n");
for (const scene of ["forest", "city"]) {
  const p = join(HERE, "generated", `occlusion-${scene}.json`);
  if (!existsSync(p)) continue;
  const o = JSON.parse(readFileSync(p, "utf8"));
  const pc = (x) => (100 * x.occluded) / Math.max(1, x.inFrustum);
  const fly = o.poses.slice(1).map(pc).sort((a, b) => a - b);
  const s = o.poses[0];
  console.log(`- ${scene}: static pose ${s.inFrustum} objects in frustum, ${s.visible} with visible pixels, ${s.occluded} occluded = ${pc(s).toFixed(1)}%; fly path (${fly.length} poses) occluded % min ${fly[0].toFixed(1)} / median ${fly[fly.length >> 1].toFixed(1)} / max ${fly.at(-1).toFixed(1)}; pass took ${(o.tookMs / 1000).toFixed(0)} s`);
}

if (existsSync(join(HERE, "crosscheck.json"))) {
  const cc = JSON.parse(readFileSync(join(HERE, "crosscheck.json"), "utf8")).rows;
  console.log("\n### Cross-check: WebGL-hook triangle total vs Babylon's own scene.getActiveIndices()/3 (median per frame)\n");
  console.log("| config | hook | Babylon |");
  console.log("|---|---|---|");
  for (const r of cc) console.log(`| ${r.configId} | ${(r.triangles.total).toFixed(0)} | ${(r.babylonTris).toFixed(0)} |`);
}
const vp = join(HERE, "validation", "validation.json");
if (existsSync(vp)) {
  const v = JSON.parse(readFileSync(vp, "utf8"));
  console.log("\n### Pixel validation (one real SwiftShader frame, unlit flavour of each scene, static camera)\n");
  console.log("| scene | oracle | non-sky pixels in baseline | silhouette pixels differing | pixels differing by >8/255 | mean abs diff |");
  console.log("|---|---|---|---|---|---|");
  for (const [scene, o] of Object.entries(v)) for (const k of ["occlusion", "lod"]) console.log(`| ${scene} | ${k} | ${o[k].geometryPixelsInBaseline} | ${o[k].coveragePixelsDiffering} | ${o[k].colourPixelsDiffering} (${(100 * o[k].colourPixelsDiffering / 921600).toFixed(3)}%) | ${o[k].meanAbsColourDiff} |`);
}
