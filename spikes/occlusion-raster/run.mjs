#!/usr/bin/env node
// Occlusion-raster spike runner. ONE COMMAND: `node spikes/occlusion-raster/run.mjs`  (add --quick for a ~1 minute smoke run,
// --no-chromium to skip the browser).
//
// Expected duration on an idle 4-core machine: about 6-10 minutes (EXPECTED_MINUTES below; measured on a shared machine: see README).
//   cargo builds (native + 2 wasm variants): ~1 min cold, seconds warm
//   native + Node wasm (simd128 module, scalar module) + headless Chromium wasm (both modules): the rest.
//
// What it does: builds the release binaries; writes jobs.json/jobs.tsv; runs the same job list natively (crates/occ-bench),
// in Node over the wasm modules and in headless Chromium over the wasm modules (harness.mjs, identical code in both);
// every job takes RUNS x FRAMES per-frame samples and reports p50/p99/max; writes results.json and tables.md.
// Machine must be idle for publishable numbers: the script records loadavg and refuses nothing, but flags load > 1.
//
// Needs: cargo (stable), wasm32-unknown-unknown target, node 22, `playwright` resolvable (repo node_modules) with Chromium.
// Env: CARGO_TARGET_DIR (default: <spike>/target). The wasm-bindgen pin from native/anim is not used: the module is raw
// exports with no glue (see README).
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_MINUTES = "6-10";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const QUICK = args.has("--quick");
const NO_CHROMIUM = args.has("--no-chromium");
const RUNS = QUICK ? 2 : 7;
const FRAMES = QUICK ? 15 : 40;
const TD = process.env.CARGO_TARGET_DIR ?? path.join(here, "target");
const dist = path.join(here, "dist");
mkdirSync(dist, { recursive: true });
const log = (...a) => console.log("[occ]", ...a);

// ------------------------------------------------------------------ build
function sh(cmd, argv, env = {}, opts = {}) {
  return execFileSync(cmd, argv, { cwd: here, env: { ...process.env, ...env }, stdio: opts.quiet ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", maxBuffer: 1 << 28 });
}
log("building (native, wasm simd128, wasm scalar)");
sh("cargo", ["build", "--release", "-p", "occ-bench"], { CARGO_TARGET_DIR: TD });
const wasmTarget = "wasm32-unknown-unknown";
sh("cargo", ["build", "--release", "-p", "occ-wasm", "--target", wasmTarget], { CARGO_TARGET_DIR: path.join(TD, "wasm-simd"), RUSTFLAGS: "-C target-feature=+simd128" });
sh("cargo", ["build", "--release", "-p", "occ-wasm", "--target", wasmTarget], { CARGO_TARGET_DIR: path.join(TD, "wasm-scalar"), RUSTFLAGS: "" });
const wasmFiles = { simd: path.join(dist, "occ_simd.wasm"), scalar: path.join(dist, "occ_scalar.wasm") };
for (const [k, d] of [["simd", "wasm-simd"], ["scalar", "wasm-scalar"]]) writeFileSync(wasmFiles[k], readFileSync(path.join(TD, d, wasmTarget, "release", "occ_wasm.wasm")));
const sizes = Object.fromEntries(Object.entries(wasmFiles).map(([k, f]) => { const b = readFileSync(f); return [k, { bytes: b.length, gzip: gzipSync(b, { level: 9 }).length }]; }));
log("wasm sizes", JSON.stringify(sizes));
sh("cargo", ["test", "--release", "-p", "occ"], { CARGO_TARGET_DIR: TD }, { quiet: true });
log("unit tests (scalar == simd depth buffer, hierarchical == pixel test) passed");

// ------------------------------------------------------------------ jobs
const SCENES = ["city-box", "city-coarse", "forest"];
const RES = [[256, 128], [320, 180], [512, 256]];
const jobs = [];
const job = (o) => jobs.push({ cap: 0, minArea: 0, dilate: 1, simd: 1, inner: 0, frames: FRAMES, runs: RUNS, cam2: 0, kind: "main", w: 256, h: 128, ...o });
for (let s = 0; s < 3; s++)
  for (const [w, h] of RES)
    for (const simd of [1, 0]) job({ id: `base/${SCENES[s]}/${w}x${h}/${simd ? "simd" : "scalar"}`, scene: s, w, h, simd });
for (const s of [1, 2]) {
  for (const cap of [20000, 10000, 5000, 2000]) job({ id: `cap/${SCENES[s]}/${cap}`, scene: s, cap });
  for (const minArea of [0.0001, 0.0005, 0.002, 0.01]) job({ id: `area/${SCENES[s]}/${minArea}`, scene: s, minArea });
}
for (let s = 0; s < 3; s++) for (const inner of [0.25, 0.5]) job({ id: `inner/${SCENES[s]}/${inner}`, scene: s, inner });
for (let s = 0; s < 3; s++) for (const cam2 of [1, 2]) job({ id: `twocam/${SCENES[s]}/${cam2 === 1 ? "persp" : "ortho"}`, kind: "twocam", scene: s, cam2 });
for (const s of [0, 2]) job({ id: `temporal/${SCENES[s]}`, kind: "temporal", scene: s, frames: Math.max(10, FRAMES / 2) });
for (let s = 0; s < 3; s++) job({ id: `boundary/${SCENES[s]}`, kind: "boundary", scene: s });
writeFileSync(path.join(dist, "jobs.json"), JSON.stringify(jobs));
const tsv = jobs.filter((j) => j.kind !== "boundary").map((j) => [j.id, j.kind, j.scene, j.w, j.h, j.cap, j.minArea, j.dilate, j.simd, j.inner, j.frames, j.runs, j.cam2].join("\t")).join("\n");
writeFileSync(path.join(dist, "jobs.tsv"), tsv + "\n");
log(`${jobs.length} jobs, ${RUNS} runs x ${FRAMES} frames`);

const load = os.loadavg();
const results = {
  meta: {
    date: new Date().toISOString(),
    quick: QUICK, runs: RUNS, frames: FRAMES,
    cpu: os.cpus()[0]?.model, cores: os.cpus().length, loadavg: load,
    node: process.version, platform: `${os.platform()} ${os.release()}`,
    rustc: sh("rustc", ["--version"], {}, { quiet: true }).trim(),
    wasmSizes: sizes,
    idle: load[0] < 1.0,
  },
  env: {},
};
if (load[0] >= 1.0) log(`WARNING: load average ${load[0].toFixed(2)}; timings are smoke-level, rerun on an idle machine`);

// ------------------------------------------------------------------ native
log("native");
{
  const bin = path.join(TD, "release", process.platform === "win32" ? "occ-bench.exe" : "occ-bench");
  const out = sh(bin, [path.join(dist, "jobs.tsv")], {}, { quiet: true });
  results.env.native = JSON.parse(out);
}

// ------------------------------------------------------------------ node
const harness = await import(path.join(here, "harness.mjs"));
async function runNode(kind) {
  const bytes = readFileSync(wasmFiles[kind]);
  // the scalar module only runs scalar-path jobs (it has no simd128 to exercise); the simd128 module runs everything
  const list = jobs.filter((j) => (kind === "simd" ? true : j.simd === 0 && j.kind === "main"));
  return harness.runJobs(bytes, list, (id) => log(`node-${kind}`, id));
}
results.env.node_simd = await runNode("simd");
results.env.node_scalar = await runNode("scalar");

// ------------------------------------------------------------------ chromium
if (!NO_CHROMIUM) {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  const types = { ".html": "text/html", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
  const files = { "/page.html": path.join(here, "page.html"), "/harness.mjs": path.join(here, "harness.mjs"), "/occ_simd.wasm": wasmFiles.simd, "/occ_scalar.wasm": wasmFiles.scalar, "/jobs.json": path.join(dist, "jobs.json") };
  const server = createServer((req, res) => {
    const f = files[req.url.split("?")[0]];
    if (!f || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(f)], "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    // playwright/browser build mismatch (as on the spike machine): fall back to any installed Chromium build
    const { readdirSync } = await import("node:fs");
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), ".cache", "ms-playwright");
    const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
    const exe = process.env.OCC_CHROMIUM ?? (dir && path.join(root, dir, "chrome-linux64", "chrome"));
    log("chromium.launch() failed, falling back to", exe);
    browser = await chromium.launch({ executablePath: exe });
  }
  results.meta.chromium = browser.version();
  for (const kind of ["simd", "scalar"]) {
    log("chromium", kind);
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.text().startsWith("[occ]")) log(`chromium-${kind}`, m.text().slice(6)); });
    page.on("pageerror", (e) => log("page error", e.message));
    await page.goto(`http://127.0.0.1:${port}/page.html?kind=${kind}`);
    await page.waitForFunction(() => window.__done === true, null, { timeout: 30 * 60 * 1000, polling: 1000 });
    const r = await page.evaluate(() => ({ result: window.__result, isolated: self.crossOriginIsolated, error: window.__error ?? null }));
    if (r.error) throw new Error(r.error);
    results.env["chromium_" + kind] = r.result;
    results.meta.crossOriginIsolated = r.isolated;
    await page.close();
  }
  await browser.close();
  server.close();
}

writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 1));
log("wrote results.json");
writeFileSync(path.join(here, "tables.md"), tables(results));
log("wrote tables.md");

// ------------------------------------------------------------------ report
function tables(R) {
  const f = (v) => (v == null ? "-" : v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1));
  const get = (env, id) => R.env[env]?.jobs.find((j) => j.id === id)?.result;
  const envs = [["native", "native"], ["node_simd", "Node wasm simd"], ["node_scalar", "Node wasm scalar"], ["chromium_simd", "Chromium wasm simd"], ["chromium_scalar", "Chromium wasm scalar"]];
  const L = [];
  L.push(`Run ${R.meta.date}; ${R.meta.cpu} x${R.meta.cores}; load ${R.meta.loadavg.map((x) => x.toFixed(2)).join("/")}; ${R.meta.quick ? "QUICK; " : ""}${R.meta.runs} runs x ${R.meta.frames} frames per job; ${R.meta.rustc}; node ${R.meta.node}; ${R.meta.chromium ? "chromium " + R.meta.chromium + (R.meta.crossOriginIsolated ? " (cross-origin isolated)" : " (NOT isolated: 100us timer)") : "no chromium"}. wasm: ${JSON.stringify(R.meta.wasmSizes)}\n`);
  // 1. cost
  L.push("### 1. Frame cost, one camera, ms per frame (p50 / p99 / max)\n");
  for (const scene of SCENES) {
    L.push(`**${scene}**\n`);
    L.push("| buffer | environment | path | total p50 | p99 | max | clear | select | setup | raster | mip | test |");
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [w, h] of RES)
      for (const [env, label] of envs)
        for (const simd of ["simd", "scalar"]) {
          if (env === "node_scalar" || env === "chromium_scalar") { if (simd === "simd") continue; }
          const r = get(env, `base/${scene}/${w}x${h}/${simd}`);
          if (!r) continue;
          const s = r.stages;
          L.push(`| ${w}x${h} | ${label} | ${simd} | ${f(r.total.p50)} | ${f(r.total.p99)} | ${f(r.total.max)} | ${f(s.clear.p50)} | ${f(s.select.p50)} | ${f(s.setup.p50)} | ${f(s.raster.p50)} | ${f(s.mip.p50)} | ${f(s.test.p50)} |`);
        }
    L.push("");
  }
  // triangle counts
  L.push("### Triangles (mean over 8 frames, 256x128)\n");
  L.push("| scene | occluder instances | in frustum | source tris of those | not outside frustum | back-facing/degenerate | clipped | rasterised (covers a pixel centre) | occludees | outside frustum | near-crossing | culled | visible |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const scene of SCENES) {
    const s = get("native", `base/${scene}/256x128/simd`)?.stats;
    if (s) L.push(`| ${scene} | ${s.inst_total} | ${s.inst_frustum} | ${s.tris_src} | ${s.tris_frustum} | ${s.tris_back} | ${s.tris_clipped} | ${s.tris_raster} | ${s.occ_total} | ${s.occ_outside} | ${s.occ_near} | ${s.occ_culled} | ${s.occ_visible} |`);
  }
  L.push("");
  // 2. accuracy
  L.push("### 2. Accuracy vs 1920x1080 oracle (8 frames summed; in-frustum occludees)\n");
  L.push("| scene | buffer | in frustum | oracle culled | buffer culled | lost culls | FALSE OCCLUDED | dilate |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const scene of SCENES)
    for (const [w, h] of RES) {
      const a = get("native", `base/${scene}/${w}x${h}/simd`)?.acc;
      if (!a) continue;
      for (const d of ["d0", "d1"]) L.push(`| ${scene} | ${w}x${h} | ${a[d].in_frustum} | ${a[d].oracle_culled} | ${a[d].buf_culled} | ${a[d].lost} | ${a[d].false_occluded} | ${d === "d0" ? 0 : 1} |`);
    }
  L.push("");
  L.push("Coverage rule (256x128, dilate 1 / dilate 0):\n");
  L.push("| scene | shrink | buffer culled | oracle culled | lost | FALSE OCCLUDED (d1) | FALSE OCCLUDED (d0) | native total p50 ms |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const scene of SCENES)
    for (const inner of [0, 0.25, 0.5]) {
      const id = inner === 0 ? `base/${scene}/256x128/simd` : `inner/${scene}/${inner}`;
      const r = get("native", id);
      if (r) L.push(`| ${scene} | ${inner} | ${r.acc.d1.buf_culled} | ${r.acc.d1.oracle_culled} | ${r.acc.d1.lost} | ${r.acc.d1.false_occluded} | ${r.acc.d0.false_occluded} | ${f(r.total.p50)} |`);
    }
  L.push("");
  // 3. selection
  L.push("### 3. Occluder selection (256x128, native simd; Node wasm simd total p50 in last column)\n");
  L.push("| scene | setting | tris rasterised | buffer culled / oracle culled (dilate 1) | false occluded | native p50 ms | native p99 | node wasm p50 ms |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of [1, 2]) {
    const scene = SCENES[s];
    const rows = [["no limit", `base/${scene}/256x128/simd`]];
    for (const cap of [20000, 10000, 5000, 2000]) rows.push([`cap ${cap} tris`, `cap/${scene}/${cap}`]);
    for (const a of [0.0001, 0.0005, 0.002, 0.01]) rows.push([`min screen area ${(a * 100).toFixed(2)}%`, `area/${scene}/${a}`]);
    for (const [label, id] of rows) {
      const r = get("native", id);
      const n = get("node_simd", id);
      if (r) L.push(`| ${scene} | ${label} | ${r.stats.tris_raster} | ${r.acc.d1.buf_culled} / ${r.acc.d1.oracle_culled} | ${r.acc.d1.false_occluded} | ${f(r.total.p50)} | ${f(r.total.p99)} | ${f(n?.total.p50)} |`);
    }
  }
  L.push("");
  // 4. size
  L.push(`### 4. Wasm size (release, includes workload generators, oracle and temporal code)\n`);
  L.push(`simd128 module: ${R.meta.wasmSizes.simd.bytes} B, gzip ${R.meta.wasmSizes.simd.gzip} B. scalar module: ${R.meta.wasmSizes.scalar.bytes} B, gzip ${R.meta.wasmSizes.scalar.gzip} B.\n`);
  // 5. two cameras
  L.push("### 5. Two cameras (256x128; ms p50 / p99; second camera: perspective side view or orthographic sun cascade)\n");
  L.push("| scene | second cam | environment | cam A | cam B | A+B in one go | B in frustum: instances / culled of tested | B false occluded (d1) |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const scene of SCENES)
    for (const k of ["persp", "ortho"])
      for (const [env, label] of envs.filter(([e]) => e === "native" || e === "node_simd" || e === "chromium_simd")) {
        const r = get(env, `twocam/${scene}/${k}`);
        if (r) L.push(`| ${scene} | ${k} | ${label} | ${f(r.cam_a.p50)} / ${f(r.cam_a.p99)} | ${f(r.cam_b.p50)} / ${f(r.cam_b.p99)} | ${f(r.both.p50)} / ${f(r.both.p99)} | ${r.stats_b.inst_frustum} / ${r.acc_b.d1.buf_culled} of ${r.acc_b.d1.in_frustum} | ${r.acc_b.d1.false_occluded} |`);
      }
  L.push("");
  // 6. temporal
  L.push("### 6. Temporal (native, 256x128): fresh frame vs reprojecting last frame's tiles; culls vs oracle (8 frames summed)\n");
  L.push("| scene | fresh frame p50 ms | reproject+mip+test p50 ms | age (frames) | variant | buffer culled | lost | FALSE OCCLUDED |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of [0, 2]) {
    const r = get("native", `temporal/${SCENES[s]}`);
    if (!r) continue;
    for (const step of [1, 4, 12])
      for (const v of ["stale", "reprojected", "fresh"]) {
        const a = r["step" + step][v];
        L.push(`| ${SCENES[s]} | ${f(r.fresh.p50)} | ${f(r.reproject.p50)} | ${step} | ${v} | ${a.buf_culled} (oracle ${a.oracle_culled}) | ${a.lost} | ${a.false_occluded} |`);
      }
  }
  L.push("");
  // boundary
  L.push("### JS to wasm boundary (per frame, p50 ms, typed-array views over wasm memory)\n");
  L.push("| scene | environment | instances | occludees | bytes in | set instances (bulk) | write instances (JS loop) | set AABBs (bulk) | write AABBs (JS loop) | read vis (copy) | read vis (scan) | 1000 empty calls |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const scene of SCENES)
    for (const [env, label] of envs.filter(([e]) => e.endsWith("_simd") && e !== "native")) {
      const r = get(env, `boundary/${scene}`);
      if (r) L.push(`| ${scene} | ${label} | ${r.n_inst} | ${r.n_occludees} | ${r.bytes_in} | ${f(r.set_instances_bulk.p50)} | ${f(r.write_instances_loop.p50)} | ${f(r.set_aabbs_bulk.p50)} | ${f(r.write_aabbs_loop.p50)} | ${f(r.read_vis_copy.p50)} | ${f(r.read_vis_scan.p50)} | ${f(r.call_overhead_empty.p50)} |`);
    }
  L.push("");
  // determinism cross-check
  L.push("### Cross-environment determinism (visibility hash over 8 frames, must match everywhere)\n");
  let bad = 0, checked = 0;
  for (const j of R.env.native.jobs.filter((x) => x.kind === "main"))
    for (const [env] of envs.slice(1)) {
      const o = get(env, j.id);
      if (!o) continue;
      checked++;
      if (o.hash !== j.result.hash || JSON.stringify(o.acc) !== JSON.stringify(j.result.acc)) { bad++; L.push(`MISMATCH ${env} ${j.id}`); }
    }
  L.push(`${checked} job results compared native vs wasm: ${bad} mismatches.\n`);
  return L.join("\n");
}
console.log("\n" + tables(results));
