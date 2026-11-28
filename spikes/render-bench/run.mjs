#!/usr/bin/env node
// Render-bench runner: one command, writes results.json next to this file.
//
//   node spikes/render-bench/run.mjs                  # FULL profile (the spec): CPU mode 5 runs x 300 frames at 1x and 4x CPU
//                                                     #   throttle, plus raster mode (5 runs x 10 real frames, 1x)
//   node spikes/render-bench/run.mjs --profile smoke  # 1 run x 30 frames, 1x, no raster: checks it all works (about 5 minutes)
//   options: --runs N --frames N --warmup N --throttles 1,4 --scenes forest,city --only <substring of config id>
//            --raster on|off --raster-runs N --raster-frames N --raster-warmup N --raster-only <substring>
//            --resume (keep rows already in the results file) --no-build --results <file in this folder> --port N
//
// EXPECTED DURATION of the FULL profile on an idle 4-core machine, extrapolated from what I measured on a loaded one
// (README "How long the full run takes"): CPU mode about 45 min at 1x plus about 3 h at 4x [est.]; raster mode about
// 6-8 h [est.] because one software-GL frame of the forest takes 47 s (thin instancing: minutes). So: use
// `--raster off` (CPU mode only, ~4 h) or `--raster-runs 2 --raster-frames 3 --raster-only -auto-static-` (~1 h) unless
// you want the whole raster table. `--profile smoke` and `--only` / `--scenes` / `--runs` run slices. The runner appends a
// row per config as it finishes, so a stopped run keeps its rows (`--resume` continues).
//
// Stages: (1) install spike deps + generate the projects if missing, (2) build the harness page (vite),
// (3) the occlusion pre-pass per scene, made the first time a config needs it (object-ID pass, cached in
// generated/occlusion-<scene>.json; 2.5 min forest, 0.5 min city), (4) the measurement matrix. Each run is a fresh browser
// context (cold page) of headless Chromium on SwiftShader at 1280x720, default quality tier ("High": MSAA, 3 shadow
// cascades to 80 m). Row ids are `<config>@<throttle>x/<cpu|raster>`.
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const GEN = join(HERE, "generated");
const BUILD = join(HERE, ".build", "bench");
const RESULTS = join(HERE, String(process.argv.includes("--results") ? process.argv[process.argv.indexOf("--results") + 1] : "results.json"));

// --- options ------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[i + 1]; };
const smoke = flag("profile", "full") === "smoke";
const RUNS = +flag("runs", smoke ? 1 : 5);
const FRAMES = +flag("frames", smoke ? 30 : 300);
const WARMUP = +flag("warmup", smoke ? 20 : 60);
const THROTTLES = String(flag("throttles", smoke ? "1" : "1,4")).split(",").map(Number);
const SCENES = String(flag("scenes", "forest,city")).split(",");
const ONLY = flag("only", "");
const RESUME = flag("resume", false) === true;
const PORT = +flag("port", 3917);
// Raster mode (real draws on SwiftShader): a frame costs about a minute here, so it gets its own, much smaller budget.
const RASTER = String(flag("raster", smoke ? "off" : "on")) !== "off";
const R_RUNS = +flag("raster-runs", 5);
const R_FRAMES = +flag("raster-frames", 10);
const R_WARMUP = +flag("raster-warmup", 2);
const R_ONLY = flag("raster-only", ""); // substring filter on the config id for raster rows

// --- stage 1/2: deps, generate, build ----------------------------------------------------------------------------------
const sh = (cmd, args, cwd, env = {}) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`); };
if (!existsSync(join(HERE, "node_modules", "meshoptimizer"))) sh("npm", ["install", "--no-audit", "--no-fund"], HERE);
if (!existsSync(join(GEN, "forest-auto", "files.json"))) sh("node", ["generate.mjs"], HERE);
if (!existsSync(join(ROOT, "node_modules"))) throw new Error("repo node_modules missing: run npm install at the repo root (or symlink it)");
if (!flag("no-build", false) || !existsSync(join(BUILD, "bench.html"))) sh("npx", ["vite", "build", "--config", "spikes/render-bench/vite.config.ts"], ROOT, { VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" });

// --- playwright: the repo's copy wants a newer Chromium than some images carry; fall back to the global one ---------------
function loadPlaywright() {
  for (const base of [join(ROOT, "package.json"), "/opt/node-tools/package.json", join(HERE, "package.json")]) {
    try {
      const { chromium } = createRequire(base)("playwright");
      if (existsSync(chromium.executablePath())) return chromium;
    } catch { /* try the next */ }
  }
  throw new Error("no usable playwright + Chromium found");
}
const chromium = loadPlaywright();

// --- static server ------------------------------------------------------------------------------------------------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".obj": "text/plain", ".mtl": "text/plain" };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const map = [["/bench/", BUILD], ["/projects/", GEN]];
  let file = null;
  for (const [prefix, dir] of map) if (url.startsWith(prefix)) file = join(dir, url.slice(prefix.length));
  const occ = url.match(/^\/occlusion\/(\w+)\.json$/);
  if (occ) file = join(GEN, `occlusion-${occ[1]}.json`);
  if (!file || !normalize(file).startsWith(HERE + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const pageUrl = (project) => `http://127.0.0.1:${PORT}/bench/bench.html?project=${project}`;

// --- browser ------------------------------------------------------------------------------------------------------------
const hook = readFileSync(join(HERE, "glhook.js"), "utf8");
const browser = await chromium.launch({ args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"] });
const errors = [];

async function openBench(project, throttle = 1) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.addInitScript(hook);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${project}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${project}: ${m.text()}`); });
  await page.goto(pageUrl(project));
  await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 600_000, polling: 500 });
  if (throttle !== 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
  return { context, page };
}

// --- stage 3: occlusion pre-pass (lazy: the first config that needs a scene's visibility data makes it) -------------
async function ensureOcclusion(scene) {
  const file = join(GEN, `occlusion-${scene}.json`);
  if (existsSync(file)) return;
  console.log(`occlusion pre-pass (${scene}): object-ID pass at the static pose and 26 fly-path poses...`);
  const { context, page } = await openBench(`${scene}-auto`);
  const data = await page.evaluate(() => window.bench.computeOcclusion());
  writeFileSync(file, JSON.stringify(data));
  console.log(`  done in ${(data.tookMs / 1000).toFixed(0)} s`);
  await context.close();
}

// --- stage 4: the matrix -----------------------------------------------------------------------------------------------
// Two measurement modes per config (README explains why):
//   cpu    draw calls are counted by the WebGL hook but not issued, so there is no software-raster time; the frame is the
//          JS frame (engine step: scripts, transform sync, culling, batching, command encoding). >= 300 frames x 5 runs,
//          at 1x and 4x CPU throttle. Draw calls and triangle counts are exact (the draws the engine WOULD issue).
//   raster real draws on SwiftShader; per-frame wall time includes software raster of ~10^7-10^8 triangles. 1x only.
/** @type {{id:string, scene:string, instancing:string, oracle:string, mode:string, cfg:object}[]} */
const configs = [];
const ORACLES = { baseline: { lod: false, occlusion: false }, lod: { lod: true, occlusion: false }, occlusion: { lod: false, occlusion: true }, both: { lod: true, occlusion: true } };
for (const scene of SCENES) {
  for (const instancing of ["auto", "thin"]) for (const [oracle, o] of Object.entries(ORACLES)) configs.push({ id: `${scene}-${instancing}-static-${oracle}`, scene, instancing, oracle, mode: "static", cfg: { mode: "static", ...o } });
  configs.push({ id: `${scene}-auto-static-lod-nocull`, scene, instancing: "auto", oracle: "lod-nocull", mode: "static", cfg: { mode: "static", lod: true, lodCull: false, occlusion: false } });
  for (const [instancing, oracle] of [["auto", "baseline"], ["thin", "baseline"], ["auto", "both"]]) configs.push({ id: `${scene}-${instancing}-fly-${oracle}`, scene, instancing, oracle, mode: "fly", cfg: { mode: "fly", ...ORACLES[oracle] } });
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN; };
const stats = (a) => ({ p50: pct(a, 50), p99: pct(a, 99), max: Math.max(...a), mean: a.reduce((x, y) => x + y, 0) / a.length });
const median = (a) => pct(a, 50);

/** Classify one frame's buckets: main pass (1280x720 viewport: the MSAA scene target and the final canvas blit), shadow (square framebuffer viewports), other. */
function classify(buckets) {
  const out = { main: { draws: 0, tris: 0, spanMs: 0 }, shadow: { draws: 0, tris: 0, spanMs: 0, passes: 0 }, other: { draws: 0, tris: 0, spanMs: 0 } };
  for (const b of buckets) {
    const [kind, size] = b.key.split(":");
    const [w, h] = size.split("x").map(Number);
    const c = w === 1280 && h === 720 ? out.main : kind === "fbo" && w === h && w >= 512 ? out.shadow : out.other;
    c.draws += b.draws; c.tris += b.tris; c.spanMs += b.t1 - b.t0;
    if (c === out.shadow) c.passes++;
  }
  return out;
}

function summarise(cfgRow, throttle, mode, runs) {
  const frames = runs.flat();
  const per = frames.map((f) => ({ ...f, cls: classify(f.buckets) }));
  const col = (fn) => per.map(fn);
  const runStat = (fn) => runs.map((r) => stats(r.map((f) => fn({ ...f, cls: classify(f.buckets) }))));
  const med = (fn) => median(col(fn));
  return {
    id: `${cfgRow.id}@${throttle}x/${mode}`,
    configId: cfgRow.id,
    scene: cfgRow.scene,
    instancing: cfgRow.instancing,
    oracle: cfgRow.oracle,
    path: cfgRow.mode,
    measure: mode,
    cpuThrottle: throttle,
    runs: runs.length,
    framesPerRun: runs[0]?.length ?? 0,
    // per-frame counts: exact for draw calls and triangles (WebGL hook), the median over the measured frames
    drawCalls: { total: med((f) => f.cls.main.draws + f.cls.shadow.draws + f.cls.other.draws), main: med((f) => f.cls.main.draws), shadow: med((f) => f.cls.shadow.draws), other: med((f) => f.cls.other.draws) },
    triangles: { total: med((f) => f.cls.main.tris + f.cls.shadow.tris + f.cls.other.tris), main: med((f) => f.cls.main.tris), shadow: med((f) => f.cls.shadow.tris), other: med((f) => f.cls.other.tris) },
    drawCallsMax: Math.max(...col((f) => f.cls.main.draws + f.cls.shadow.draws + f.cls.other.draws)),
    trianglesMax: Math.max(...col((f) => f.cls.main.tris + f.cls.shadow.tris + f.cls.other.tris)),
    shadowPasses: med((f) => f.cls.shadow.passes),
    babylonTris: med((f) => f.babylonTris),
    // JS submit span of the main and shadow passes (first draw -> last draw issued), ms
    submitSpanMs: { main: med((f) => f.cls.main.spanMs), shadow: med((f) => f.cls.shadow.spanMs) },
    // timings in ms, pooled over all runs' measured frames (p50/p99/max), and per-run spread
    cpuMs: stats(col((f) => f.cpuMs)),
    renderCpuMs: stats(col((f) => f.renderMs)),
    updateCpuMs: stats(col((f) => f.updateMs)),
    frameMs: stats(col((f) => f.intervalMs)),
    oracleBookkeepingMs: stats(col((f) => f.oracleMs)),
    perRun: { cpuMs: runStat((f) => f.cpuMs), frameMs: runStat((f) => f.intervalMs) },
    oracleCounts: { hiddenByOcclusion: med((f) => f.hiddenOcc), culledByLod: med((f) => f.culledLod), lodLevels: [0, 1, 2, 3].map((l) => med((f) => f.lodCounts[l])) },
  };
}

let results = { meta: null, rows: [] };
if (RESUME && existsSync(RESULTS)) results = JSON.parse(readFileSync(RESULTS, "utf8"));
const have = new Set(results.rows.map((r) => r.id));
const jobs = [];
for (const c of configs.filter((x) => x.id.includes(ONLY))) {
  for (const throttle of THROTTLES) jobs.push({ c, throttle, mode: "cpu", runs: RUNS, frames: FRAMES, warmup: WARMUP });
  if (RASTER && c.id.includes(R_ONLY) && c.mode === "static") jobs.push({ c, throttle: 1, mode: "raster", runs: R_RUNS, frames: R_FRAMES, warmup: WARMUP });
}
jobs.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "cpu" ? -1 : 1)); // cpu rows first: they are the quick ones
let framesDone = 0, secondsDone = 0;

const revision = () => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "?"; } };
let info = null;
for (const j of jobs) {
  const { c, throttle, mode } = j;
  const id = `${c.id}@${throttle}x/${mode}`;
  if (have.has(id)) continue;
  const runs = [], settle = [];
  if (c.cfg.occlusion) await ensureOcclusion(c.scene);
  for (let r = 0; r < j.runs; r++) {
    const { context, page } = await openBench(`${c.scene}-${c.instancing}`, throttle);
    info ??= await page.evaluate(() => window.bench.info());
    const t0 = Date.now();
    const res = await page.evaluate((cfg) => window.bench.run(cfg), { ...c.cfg, frames: j.frames, warmup: j.warmup, raster: mode === "raster", rasterWarmup: R_WARMUP });
    runs.push(res.rows); settle.push(res.settleFrames);
    secondsDone += (Date.now() - t0) / 1000; framesDone += j.frames + j.warmup;
    await context.close();
  }
  results.rows = results.rows.filter((x) => x.id !== id);
  const row = summarise(c, throttle, mode, runs);
  row.settleFrames = settle;
  results.rows.push(row);
  console.log(`${id}: draws ${row.drawCalls.total} tris ${(row.triangles.total / 1e6).toFixed(2)}M cpu p50 ${row.cpuMs.p50.toFixed(1)} p99 ${row.cpuMs.p99.toFixed(1)} frame p50 ${row.frameMs.p50.toFixed(1)} ms (${j.runs}x${j.frames})`);
  results.meta = {
    date: new Date().toISOString(),
    commit: revision(),
    profile: { runs: RUNS, frames: FRAMES, warmup: WARMUP, throttles: THROTTLES, smoke, raster: RASTER, rasterRuns: R_RUNS, rasterFrames: R_FRAMES, rasterWarmup: R_WARMUP },
    browser: browser.version(),
    renderer: info?.renderer,
    tier: info?.tier,
    canvas: info?.canvas,
    machine: { cpus: (await import("node:os")).cpus().length, load: (await import("node:os")).loadavg() },
    pageInfo: info,
    errors: [...new Set(errors)].slice(0, 20),
  };
  writeFileSync(RESULTS, JSON.stringify(results, null, 1));
}
console.log(`wrote ${RESULTS} (${results.rows.length} rows; ${framesDone} frames in ${(secondsDone / 60).toFixed(1)} min)`);
await browser.close();
server.close();
