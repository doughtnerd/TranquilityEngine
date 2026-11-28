#!/usr/bin/env node
// Occlusion go/no-go gate runner (ADR 0447 section 0): one command, writes results.json next to this file.
//
//   node spikes/occlusion-gate/run.mjs                 # FULL: 12 configs x 3 runs (static 100 frames, fly 150) + pre-passes
//   node spikes/occlusion-gate/run.mjs --profile smoke # 1 run x 30 frames per config (checks it all works)
//   options: --runs N --frames N (static) --fly-frames N --warmup N --throttles 1,4 --scenes forest,city
//            --only <substring of config id, or the whole id then $> --resume --no-build --results <file in this folder> --port N
//
// EXPECTED DURATION on an IDLE 4-core machine: about 45-60 minutes for the full profile [est. from smoke runs on a shared
// machine: see README "How long it takes"]: model load with LOD generation (inline meshoptimizer + Hausdorff sampling, not
// timed) is about 20-40 s per page, 3 runs x 12 configs = 36 page loads plus 2 occlusion pre-passes (forest about 2.5 min,
// city about 0.5 min, SwiftShader, cached in generated/occlusion-<scene>.json). Use `--throttles 1,4` to add the 4x CPU
// throttle rows (about 3x longer). The runner appends a row per config as it finishes (`--resume` continues a stopped run).
//
// Configs, per scene (forest, city; `auto` instancing, High tier, 1280x720, engine LOD on in every one):
//   lod          LOD only                                                         (gate baseline)
//   lod+keep     LOD + occlusion oracle, hidden from the MAIN view only, casters kept (the gate's candidate)
//   lod+remove   LOD + occlusion oracle, objects deactivated: casters removed too  (the spike's old method)
// each on the static camera and the fly-through. "cpu" measurement mode only (draw calls counted by the WebGL hook, not
// issued: the engine's JS frame; exact draw and triangle counts). Each run is a fresh browser context.
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

// --- options ------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[i + 1]; };
const smoke = flag("profile", "full") === "smoke";
const RUNS = +flag("runs", smoke ? 1 : 3);
const FRAMES = +flag("frames", smoke ? 30 : 100);
const FLY_FRAMES = +flag("fly-frames", smoke ? 40 : 150);
const WARMUP = +flag("warmup", smoke ? 20 : 60);
const THROTTLES = String(flag("throttles", "1")).split(",").map(Number);
const SCENES = String(flag("scenes", "forest,city")).split(",");
const ONLY = flag("only", "");
const RESUME = flag("resume", false) === true;
const PORT = +flag("port", 3927);
const RESULTS = join(HERE, String(flag("results", "results.json")));

// --- stage 1/2: generate, build ----------------------------------------------------------------------------------------
const sh = (cmd, args, cwd, env = {}) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`); };
if (!existsSync(join(GEN, "forest-auto-base", "files.json"))) sh("node", ["generate.mjs"], HERE);
if (!existsSync(join(ROOT, "node_modules"))) throw new Error("repo node_modules missing: run npm install at the repo root (or symlink it)");
if (!flag("no-build", false) || !existsSync(join(BUILD, "bench.html"))) sh("npx", ["vite", "build", "--config", "spikes/occlusion-gate/vite.config.ts"], ROOT, { VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" });

// --- playwright: the repo's copy may want a newer Chromium than the image carries; fall back to the global one ---------
function loadPlaywright() {
  for (const base of [join(ROOT, "package.json"), "/opt/node-tools/package.json"]) {
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
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${project}: ${m.type()}: ${m.text()}`); });
  await page.goto(pageUrl(project));
  await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 900_000, polling: 500 });
  if (throttle !== 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
  return { context, page };
}

// --- stage 3: occlusion pre-pass (lazy) ------------------------------------------------------------------------------------
async function ensureOcclusion(scene) {
  const file = join(GEN, `occlusion-${scene}.json`);
  if (existsSync(file)) return;
  console.log(`occlusion pre-pass (${scene}): object-ID pass at the static pose and 26 fly-path poses...`);
  const { context, page } = await openBench(`${scene}-auto-lod`);
  const data = await page.evaluate(() => window.bench.computeOcclusion());
  writeFileSync(file, JSON.stringify(data));
  console.log(`  done in ${(data.tookMs / 1000).toFixed(0)} s`);
  await context.close();
}

// --- stage 4: the matrix -----------------------------------------------------------------------------------------------
const ORACLES = { base: "none", lod: "none", "lod+keep": "keep", "lod+remove": "remove" };
/** @type {{id:string, scene:string, oracle:string, mode:string, cfg:object}[]} */
const configs = [];
for (const scene of SCENES) for (const mode of ["static", "fly"]) for (const [oracle, occlusion] of Object.entries(ORACLES)) configs.push({ id: `${scene}-auto-${mode}-${oracle}`, scene, oracle, mode, cfg: { mode, occlusion } });

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN; };
const stats = (a) => ({ p50: pct(a, 50), p99: pct(a, 99), max: Math.max(...a), mean: a.reduce((x, y) => x + y, 0) / a.length });
const median = (a) => pct(a, 50);

/** main pass (1280x720 viewport: the MSAA scene target and the final canvas blit), shadow (square framebuffer viewports), other. */
function classify(buckets) {
  const out = { main: { draws: 0, tris: 0, sig: 0 }, shadow: { draws: 0, tris: 0, sig: 0, passes: 0 }, other: { draws: 0, tris: 0, sig: 0 } };
  for (const b of buckets) {
    const [kind, size] = b.key.split(":");
    const [w, h] = size.split("x").map(Number);
    const c = w === 1280 && h === 720 ? out.main : kind === "fbo" && w === h && w >= 512 ? out.shadow : out.other;
    c.draws += b.draws; c.tris += b.tris; c.sig = (Math.imul(c.sig, 33) + b.sig) >>> 0;
    if (c === out.shadow) c.passes++;
  }
  return out;
}

function summarise(cfgRow, throttle, runs) {
  const frames = runs.flat();
  const per = frames.map((f) => ({ ...f, cls: classify(f.buckets) }));
  const col = (fn) => per.map(fn);
  const med = (fn) => median(col(fn));
  return {
    id: `${cfgRow.id}@${throttle}x`,
    configId: cfgRow.id,
    scene: cfgRow.scene,
    oracle: cfgRow.oracle,
    path: cfgRow.mode,
    cpuThrottle: throttle,
    runs: runs.length,
    framesPerRun: runs[0]?.length ?? 0,
    drawCalls: { total: med((f) => f.cls.main.draws + f.cls.shadow.draws + f.cls.other.draws), main: med((f) => f.cls.main.draws), shadow: med((f) => f.cls.shadow.draws) },
    triangles: { total: med((f) => f.cls.main.tris + f.cls.shadow.tris + f.cls.other.tris), main: med((f) => f.cls.main.tris), shadow: med((f) => f.cls.shadow.tris), other: med((f) => f.cls.other.tris) },
    trianglesMax: { main: Math.max(...col((f) => f.cls.main.tris)), shadow: Math.max(...col((f) => f.cls.shadow.tris)) },
    shadowPasses: med((f) => f.cls.shadow.passes),
    babylonTris: med((f) => f.babylonTris),
    // JS CPU of engine.step, ms, pooled over all runs' measured frames; `net` excludes the oracle's own hidden-set write (hookMs)
    cpuMs: stats(col((f) => f.cpuMs)),
    cpuNetMs: stats(col((f) => f.cpuMs - f.hookMs)),
    hookMs: stats(col((f) => f.hookMs)),
    renderCpuMs: stats(col((f) => f.renderMs)),
    updateCpuMs: stats(col((f) => f.updateMs)),
    oracleBookkeepingMs: stats(col((f) => f.oracleMs)),
    perRun: { cpuNetMs: runs.map((r) => stats(r.map((f) => f.cpuMs - f.hookMs))) },
    oracleCounts: { hiddenByOcclusion: med((f) => f.hiddenOcc), lodCulledGroups: med((f) => f.lodCulled), lodLevels: [0, 1, 2, 3].map((l) => med((f) => f.lodLevels[l] ?? 0)) },
    // per-frame shadow-pass fingerprint of run 0, for the casters-kept check: [tris, draws, sig]
    shadowFrames: runs[0].map((f) => { const c = classify(f.buckets).shadow; return [c.tris, c.draws, c.sig]; }),
  };
}

let results = { meta: null, rows: [] };
if (RESUME && existsSync(RESULTS)) results = JSON.parse(readFileSync(RESULTS, "utf8"));
const have = new Set(results.rows.map((r) => r.id));
const jobs = [];
const picked = (id) => (String(ONLY).endsWith("$") ? id === String(ONLY).slice(0, -1) : id.includes(ONLY));
for (const c of configs.filter((x) => picked(x.id))) for (const throttle of THROTTLES) jobs.push({ c, throttle, runs: RUNS, frames: c.mode === "fly" ? FLY_FRAMES : FRAMES, warmup: WARMUP });
let framesDone = 0, secondsDone = 0;

const revision = () => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "?"; } };
let info = null;
for (const j of jobs) {
  const { c, throttle } = j;
  const id = `${c.id}@${throttle}x`;
  if (have.has(id)) continue;
  const runs = [], settle = [];
  if (c.cfg.occlusion !== "none") await ensureOcclusion(c.scene);
  for (let r = 0; r < j.runs; r++) {
    const { context, page } = await openBench(`${c.scene}-auto-${c.oracle === "base" ? "base" : "lod"}`, throttle);
    info ??= await page.evaluate(() => window.bench.info());
    const t0 = Date.now();
    const res = await page.evaluate((cfg) => window.bench.run(cfg), { ...c.cfg, frames: j.frames, warmup: j.warmup });
    runs.push(res.rows); settle.push(res.settleFrames);
    secondsDone += (Date.now() - t0) / 1000; framesDone += j.frames + j.warmup;
    await context.close();
  }
  results.rows = results.rows.filter((x) => x.id !== id);
  const row = summarise(c, throttle, runs);
  row.settleFrames = settle;
  results.rows.push(row);
  console.log(`${id}: draws ${row.drawCalls.total} tris ${(row.triangles.total / 1e6).toFixed(3)}M (main ${(row.triangles.main / 1e6).toFixed(3)}M shadow ${(row.triangles.shadow / 1e6).toFixed(3)}M) cpu net p50 ${row.cpuNetMs.p50.toFixed(1)} p99 ${row.cpuNetMs.p99.toFixed(1)} (${j.runs}x${j.frames})`);
  results.meta = {
    date: new Date().toISOString(),
    commit: revision(),
    profile: { runs: RUNS, frames: FRAMES, flyFrames: FLY_FRAMES, warmup: WARMUP, throttles: THROTTLES, smoke },
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
