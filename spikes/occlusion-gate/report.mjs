#!/usr/bin/env node
// Prints the README's tables and the gate arithmetic from a results file:  node report.mjs [results.json]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? "results.json";
const { meta, rows } = JSON.parse(readFileSync(join(HERE, file), "utf8"));
const row = (scene, path, oracle) => rows.find((r) => r.scene === scene && r.path === path && r.oracle === oracle && r.cpuThrottle === 1);
const f1 = (v) => v.toFixed(1);
const M = (v) => (v / 1e6).toFixed(3) + "M";
const pc = (a, b) => (a === 0 ? "-" : `${((b / a - 1) * 100).toFixed(0)}%`);
const OCC_COST = 1.2; // ms per view, ADR 0447 section 0 (Chromium wasm, measured)
const THRESHOLD = 2 * OCC_COST;

console.log(`profile ${JSON.stringify(meta.profile)}  commit ${meta.commit}  renderer ${meta.renderer}  load ${meta.machine.load.map((x) => x.toFixed(1)).join("/")}\n`);

console.log("### Rows (JS CPU = engine.step minus the oracle's own hidden-set write; draws/triangles are per-frame medians)\n");
console.log("| scene | path | config | runs x frames | JS CPU ms p50 / p99 / max | draws (main/shadow) | triangles total | main | shadow | hidden by occlusion | LOD-culled groups |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const scene of ["forest", "city"]) for (const path of ["static", "fly"]) for (const o of ["lod", "lod+keep", "lod+remove"]) {
  const r = row(scene, path, o);
  if (!r) continue;
  console.log(`| ${scene} | ${path} | ${o} | ${r.runs} x ${r.framesPerRun} | ${f1(r.cpuNetMs.p50)} / ${f1(r.cpuNetMs.p99)} / ${f1(r.cpuNetMs.max)} | ${r.drawCalls.total} (${r.drawCalls.main}/${r.drawCalls.shadow}) | ${M(r.triangles.total)} | ${M(r.triangles.main)} | ${M(r.triangles.shadow)} | ${r.oracleCounts.hiddenByOcclusion} | ${r.oracleCounts.lodCulledGroups} |`);
}

console.log("\n### Per-run JS CPU p50 (ms), to see the spread\n");
for (const r of rows.filter((x) => x.cpuThrottle === 1)) console.log(`- ${r.configId}: ${r.perRun.cpuNetMs.map((s) => f1(s.p50)).join(" / ")}`);

console.log(`\n### Gate arithmetic (threshold = 2 x ${OCC_COST} ms = ${THRESHOLD} ms of JS CPU, p50)\n`);
console.log("| scene | path | LOD p50 | LOD+keep p50 | CPU saving ms (keep vs LOD) | gate (>= 2.4 ms) | main-view tris saving | total tris saving | LOD+remove p50 | remove saving ms | caster check |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const scene of ["forest", "city"]) for (const path of ["static", "fly"]) {
  const a = row(scene, path, "lod"), k = row(scene, path, "lod+keep"), x = row(scene, path, "lod+remove");
  if (!a || !k) continue;
  const save = a.cpuNetMs.p50 - k.cpuNetMs.p50;
  // casters kept: every measured frame's shadow-pass fingerprint (tris, draws, checksum of all draw arguments) of run 0 equals the LOD-only frame's
  let same = 0;
  const n = Math.min(a.shadowFrames.length, k.shadowFrames.length);
  for (let i = 0; i < n; i++) if (a.shadowFrames[i].join() === k.shadowFrames[i].join()) same++;
  const ck = x ? (() => { let s2 = 0; for (let i = 0; i < n; i++) if (a.shadowFrames[i].join() === x.shadowFrames[i].join()) s2++; return `kept ${same}/${n} frames identical; remove ${s2}/${n}`; })() : `kept ${same}/${n}`;
  console.log(`| ${scene} | ${path} | ${f1(a.cpuNetMs.p50)} | ${f1(k.cpuNetMs.p50)} | ${f1(save)} | ${save >= THRESHOLD ? "PASS" : "FAIL"} (${(save / OCC_COST).toFixed(1)}x cost) | ${M(a.triangles.main - k.triangles.main)} (${pc(a.triangles.main, k.triangles.main)}) | ${M(a.triangles.total - k.triangles.total)} (${pc(a.triangles.total, k.triangles.total)}) | ${x ? f1(x.cpuNetMs.p50) : "-"} | ${x ? f1(a.cpuNetMs.p50 - x.cpuNetMs.p50) : "-"} | ${ck} |`);
}
console.log("\np99 saving (keep vs LOD):");
for (const scene of ["forest", "city"]) for (const path of ["static", "fly"]) {
  const a = row(scene, path, "lod"), k = row(scene, path, "lod+keep");
  if (a && k) console.log(`- ${scene} ${path}: ${f1(a.cpuNetMs.p99)} -> ${f1(k.cpuNetMs.p99)} (${f1(a.cpuNetMs.p99 - k.cpuNetMs.p99)} ms)`);
}
