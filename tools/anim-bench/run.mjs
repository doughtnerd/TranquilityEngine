#!/usr/bin/env node
// The animation benches through the shipped player (T82): `npm run bench:anim [-- options]`.
//
// 1. Makes sure the prebuilt player exists (dist/player/; built with `vite build --config vite.player.config.ts` when
//    missing, and removed again afterwards unless --keep).
// 2. Generates anim-bench's fixtures once (`cargo run --release -p anim-bench --example fixtures`, into
//    native/anim/target/bench-fixtures/, the files bench_budgets.mjs uses; --regen makes them again).
// 3. Writes a bench project into a temp folder (project.mjs; the game script is game/bench.ts) and exports it with
//    `npm run export` (web target), the same build a game ships.
// 4. Serves the build with its own serve.mjs and opens each scenario in headless Chromium (Playwright's library, not the
//    test runner), one fresh page per scenario and round. The page reports its timings itself through the public
//    `myco` API (probe systems ordered around the animation systems, see game/bench.ts) as one console line.
// 5. Prints ms per frame per stage against ADR 0370's budgets, the wasm sizes against their gates, and writes all of it
//    as JSON (default test-results/anim-bench/latest.json, gitignored).
//
// Options: --rounds N (3), --frames N (300 measured), --warm N (120), --only a,b (scenario names), --port N
// (ANIM_BENCH_PORT, else E2E_PORT, else 3791), --viewport WxH (960x540; 64x36 makes SwiftShader's "rest" mostly CPU), --out FILE, --keep (keep the temp project and a player this run built),
// --regen (regenerate the fixtures), --sizes (only the size review; needs nothing built).
// GPU: by default the page draws with SwiftShader (software WebGL2, no WebGPU), so stage times compare across machines
// and the container. --gpu asks for the machine's real adapter: Chromium's full browser in its new headless mode (the
// headless shell has no GPU) with the platform's ANGLE backend (d3d11 on Windows, metal on macOS, vulkan on Linux) and
// WebGPU on; --headed opens a visible window instead (the surest way to get the GPU, and implies --gpu); --angle NAME
// overrides the backend. The adapter actually used is probed and recorded; a --gpu run that still lands on a software
// renderer stops, unless --allow-software.
// Renderer: --renderer auto (default: what the player picks, WebGPU where the page has an adapter, else WebGL2),
// webgl2 (the page sees no `navigator.gpu`, so the player starts its WebGL2 engine) or webgpu (without --gpu, Chromium's
// SwiftShader WebGPU adapter is switched on). Every page records the renderer and the skinning backend it ran
// (gpuCounts.js: the contexts the page's canvases got, and the skinning kernel's compute pipeline or transform-feedback
// program, read from the browser's own WebGL2/WebGPU calls). --count adds one counted page per scenario: GPU calls per
// frame (uploads, dispatches, transform-feedback passes, draws, submits, state changes, waits); wrapping every call slows
// that page, so its timings are not used. --profile adds one page of `characters` under the DevTools CPU profiler (CDP
// `Profiler`), writes test-results/anim-bench/characters.cpuprofile and prints the heaviest functions by self time.
//
// Budgets are tripwires (CLAUDE.md, ADR 0370): this prints and records, and exits 0 whatever the numbers say.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { writeProject } from "./project.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

/**
 * The rows: `name` (the table's), `bench` (game/bench.ts's scenario), `camera` (false: the camera is switched off, so
 * nothing renders and the renderer doesn't compete for the CPU), and the 0370 budget it is checked against.
 */
const CHARACTERS = { ms: 1.5, what: "0370: 100 characters, 80 bones, state machine + 2D blend space + upper-body slot + two-foot IK + look-at" };
const MATCHING = { ms: 0.6, what: "0370: motion matching, 20 characters, synthetic 30-minute database" };
const TWEENS = { ms: 0.2, what: "0370: 1,000 property tweens" };
const SCENARIOS = [
  { name: "empty", bench: "empty", budget: null },
  { name: "characters", bench: "characters", budget: CHARACTERS },
  { name: "characters_static", bench: "characters_static", budget: CHARACTERS },
  { name: "characters_noskin", bench: "characters_noskin", budget: CHARACTERS },
  { name: "characters_norender", bench: "characters_noskin", camera: false, budget: CHARACTERS },
  { name: "locomotion", bench: "locomotion", budget: null },
  { name: "clips", bench: "clips", budget: null },
  { name: "clips_norender", bench: "clips", camera: false, budget: null },
  { name: "tweens", bench: "tweens", budget: TWEENS },
  { name: "timeline", bench: "timeline", budget: null },
  { name: "matching", bench: "matching", budget: MATCHING },
  { name: "matching_norender", bench: "matching", camera: false, budget: MATCHING },
];

// --- Sizes ----------------------------------------------------------------------------------------------------------

/** Every committed wasm with a size gate: [label, wasm path, build script, gate constant]. */
const GATED = [
  ["animation runtime (games)", "src/plugins/animation/runtime/wasm/myco_anim_bg.wasm", "native/anim/build.mjs", "SIZE_LIMIT"],
  ["animation editor (editor, exports)", "src/plugins/animation/runtime/wasm/editor/myco_anim_editor_bg.wasm", "native/anim/build.mjs", "EDITOR_SIZE_LIMIT"],
  ["audio mixer (games)", "src/plugins/audio/runtime/wasm/myco_audio.wasm", "native/audio/build.mjs", "MIXER_LIMIT"],
  ["audio decoder (games)", "src/plugins/audio/runtime/wasm/myco_audio_decode.wasm", "native/audio/build.mjs", "DECODER_LIMIT"],
  ["audio decoder + AAC (opt-in)", "src/plugins/audio/runtime/wasm/myco_audio_decode_aac.wasm", "native/audio/build.mjs", "DECODER_AAC_LIMIT"],
  ["audio offline render (Studio, export)", "src/engine/audio/sample/wasm/myco_audio_offline.wasm", "native/audio/build.mjs", "OFFLINE_LIMIT"],
  ["audio encoder (editor, export)", "src/export/wasm/myco_audio_encode.wasm", "native/audio/build.mjs", "ENCODER_LIMIT"],
];

function sizes() {
  return GATED.map(([label, wasm, script, constant]) => {
    const source = readFileSync(join(root, script), "utf8");
    const m = new RegExp(`const ${constant} = (\\d+) \\* 1024`).exec(source);
    const bytes = readFileSync(join(root, wasm));
    const gate = m ? Number(m[1]) * 1024 : null;
    return { label, wasm, bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, gate, gateConstant: `${script} ${constant}`, share: gate ? bytes.length / gate : null };
  });
}

const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
function printSizes(rows) {
  console.log("\nWasm sizes against their gates (tripwires, CLAUDE.md):");
  console.log(`  ${"module".padEnd(40)} ${"bytes".padStart(11)} ${"gzip".padStart(10)} ${"gate".padStart(10)} ${"used".padStart(6)}`);
  for (const r of rows) console.log(`  ${r.label.padEnd(40)} ${r.bytes.toLocaleString("en-US").padStart(11)} ${kb(r.gzip).padStart(10)} ${(r.gate ? kb(r.gate) : "-").padStart(10)} ${(r.share ? `${(r.share * 100).toFixed(1)}%` : "-").padStart(6)}`);
}

if (flag("sizes")) {
  const rows = sizes();
  printSizes(rows);
  process.exit(0);
}

// --- Build and project ----------------------------------------------------------------------------------------------

// npm is npm.cmd on Windows, which execFileSync only finds through a shell.
const run = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, stdio: "inherit", shell: process.platform === "win32" });

/** The newest modification time under `dir` (files only; node_modules, dist and target skipped). */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "target" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

// The bench measures the engine in dist/player, so a player older than the sources would measure old code (a pull
// doesn't rebuild it): rebuild when it's missing or any engine source, plugin or the player config is newer.
const playerDir = join(root, "dist/player");
const playerPage = join(playerDir, "player.html");
const playerAge = existsSync(playerPage) ? statSync(playerPage).mtimeMs : 0;
const sourcesAge = Math.max(newestMtime(join(root, "src")), ...["vite.player.config.ts", "vite.shared.ts", "package.json"].map((f) => (existsSync(join(root, f)) ? statSync(join(root, f)).mtimeMs : 0)));
const builtPlayer = playerAge === 0 || sourcesAge > playerAge;
if (builtPlayer) {
  console.log(playerAge === 0 ? "building the player (dist/player/)..." : "the player is older than the sources: rebuilding dist/player/...");
  run("npm", ["run", "build:player"]);
}
/** The commit the measured player was built from (and whether the tree had changes), for the JSON. */
let commit = null;
try {
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: root, encoding: "utf8" }).trim() !== "";
  commit = `${head}${dirty ? "+changes" : ""}`;
} catch {
  commit = null;
}

const fixtures = join(root, "native/anim/target/bench-fixtures");
if (flag("regen") || !existsSync(join(fixtures, "bench.json"))) {
  console.log("generating anim-bench fixtures (cargo run --release -p anim-bench --example fixtures)...");
  run("cargo", ["run", "--release", "-q", "-p", "anim-bench", "--example", "fixtures", "--", fixtures], join(root, "native/anim"));
}

// The skeleton reader is the engine's own (assetInfo.ts), loaded through the dedicated server's TypeScript hooks.
const hooks = new URL("../../src/server/tsLoader.mjs", import.meta.url);
if (typeof nodeModule.registerHooks === "function") nodeModule.registerHooks(await import(hooks.href));
else nodeModule.register(hooks.href);
const { readSkeletonInfo } = await import(new URL("../../src/plugins/animation/runtime/assetInfo.ts", import.meta.url).href);
const info = readSkeletonInfo(new Uint8Array(readFileSync(join(fixtures, "humanoid80.skel"))));
if (!info || info.bones !== 80) throw new Error("anim-bench's humanoid80.skel didn't read as an 80-bone skeleton; run with --regen");

const work = mkdtempSync(join(tmpdir(), "myco-anim-bench-"));
const project = join(work, "project");
const build = join(work, "build");
writeProject(project, fixtures, info);
console.log(`bench project: ${project}`);
run(process.execPath, [join(root, "src/export/cli.mjs"), project, "--out", build, "--target", "web", "--no-audio-convert"]);

// The skinning render feature's chunk (its sync, palette uploads, dispatches): the profile reports the time spent under it.
const skinChunks = readdirSync(join(build, "assets")).filter((f) => f.endsWith(".js") && readFileSync(join(build, "assets", f), "utf8").includes("endDispatches"));

// --- Run ------------------------------------------------------------------------------------------------------------

const port = Number(opt("port", process.env.ANIM_BENCH_PORT ?? process.env.E2E_PORT ?? 3791));
const server = spawn(process.execPath, [join(build, "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.once("data", resolve));
const base = `http://localhost:${port}/`;

const { chromium } = await import("playwright");
// The project's Playwright browser, else the container's (as tools/audio-startup does), else CHROMIUM_PATH.
const executablePath = process.env.CHROMIUM_PATH ?? (!existsSync(chromium.executablePath()) && existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const headed = flag("headed");
const gpu = flag("gpu") || headed;
const PLATFORM_ANGLE = { win32: "d3d11", darwin: "metal" };
const angle = opt("angle", gpu ? (PLATFORM_ANGLE[process.platform] ?? "vulkan") : "swiftshader");
const launchArgs = ["--autoplay-policy=no-user-gesture-required", `--use-angle=${angle}`];
if (angle === "swiftshader") launchArgs.push("--enable-unsafe-swiftshader");
else {
  launchArgs.push("--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu");
  if (angle === "vulkan") launchArgs.push("--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan");
}
const renderer = opt("renderer", "auto");
if (!["auto", "webgpu", "webgl2"].includes(renderer)) throw new Error(`--renderer ${renderer}: auto, webgpu or webgl2`);
// Software WebGPU (SwiftShader) for a webgpu run without the GPU, so the WebGPU skinning path runs in a container too.
if (renderer === "webgpu" && angle === "swiftshader") launchArgs.push("--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader");
const countsScript = join(dirname(fileURLToPath(import.meta.url)), "gpuCounts.js");
// The headless shell (Playwright's default headless browser) draws in software only; the full browser's new headless
// mode (channel "chromium") can use the GPU. A CHROMIUM_PATH or the container's browser is used as it is.
const browser = await chromium.launch({ executablePath, headless: !headed, ...(gpu && !executablePath && { channel: "chromium" }), args: launchArgs });
const browserVersion = browser.version();

/** The WebGL2 renderer and WebGPU adapter a page gets, read through the browser's own APIs on a served page. */
async function probeAdapter() {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}anim-bench-gpu-probe`); // any page on the server (a 404 too): localhost is a secure context, so navigator.gpu exists
    return await page.evaluate(async () => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const webgl = gl ? String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
      let webgpu = null;
      try {
        const adapter = await navigator.gpu?.requestAdapter();
        if (adapter) {
          const i = adapter.info ?? {};
          webgpu = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" ") || "available";
        }
      } catch {
        webgpu = null;
      }
      return { webgl, webgpu };
    });
  } finally {
    await page.close();
  }
}
const adapter = await probeAdapter();
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const softwareGL = !adapter.webgl || SOFTWARE.test(adapter.webgl);
const softwareGPU = adapter.webgpu !== null && SOFTWARE.test(adapter.webgpu);
const adapterText = `WebGL2 ${adapter.webgl ?? "unavailable"}${softwareGL ? " (software)" : ""}; WebGPU ${adapter.webgpu ?? "none"}${softwareGPU ? " (software)" : ""}`;
console.log(`[anim-bench] player built from ${commit ?? "an unknown commit"}; ${headed ? "headed" : "headless"}, ANGLE ${angle}: ${adapterText}`);
if (gpu && softwareGL && !flag("allow-software")) {
  await browser.close();
  server.kill();
  console.error("[anim-bench] --gpu asked for the hardware adapter but the page got a software renderer. Try --headed, another --angle (d3d11, d3d12, vulkan, gl, metal), or update the GPU driver; --allow-software runs anyway.");
  process.exit(1);
}

const rounds = Number(opt("rounds", 3));
// --viewport WxH (default 960x540): a tiny one (64x36) leaves software rasterising nearly nothing to do, so on SwiftShader
// "rest" is closer to the main thread's own cost of driving the GPU.
const [vw, vh] = opt("viewport", "960x540").split("x").map(Number);
if (!(vw > 0 && vh > 0)) throw new Error("--viewport WxH, e.g. 960x540");
const viewport = { width: vw, height: vh };
const frames = Number(opt("frames", 300));
const warm = Number(opt("warm", 120));
/** How long a page may take: software rendering of 100 skinned meshes runs at a few frames a second. */
const pageTimeout = Math.max(240_000, (frames + warm) * 1500);
const only = opt("only", "").split(",").filter(Boolean);
const chosen = SCENARIOS.filter((s) => only.length === 0 || only.includes(s.name));

/** A bench page: --renderer webgl2 hides WebGPU from it; gpuCounts.js records the backend (and counts calls when `count`). */
async function benchPage(count = false) {
  const page = await browser.newPage({ viewport });
  if (renderer === "webgl2") await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true }));
  if (count) await page.addInitScript(() => (globalThis.__animBenchCountCalls = true));
  await page.addInitScript({ path: countsScript });
  return page;
}

async function runScenario(s, { count = false, profile = null } = {}) {
  const page = await benchPage(count);
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${s.name}: no result in ${Math.round(pageTimeout / 1000)} s${problems.length ? `\n${problems.join("\n")}` : ""}`)), pageTimeout);
    page.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("[anim-bench] ")) {
        clearTimeout(timer);
        resolve(JSON.parse(text.slice("[anim-bench] ".length)));
      } else if (m.type() === "warning" || m.type() === "error") problems.push(text);
    });
  });
  try {
    let cdp = null;
    if (profile) {
      cdp = await page.context().newCDPSession(page);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    }
    await page.goto(`${base}?bench=${s.bench}&frames=${frames}&warm=${warm}&camera=${s.camera === false ? 0 : 1}`);
    if (cdp) {
      // Profile the measured part: the scene has settled and warmed once the page reports its warm-up frames.
      await page.waitForFunction(() => globalThis.__animBenchMeasuring === true, null, { timeout: pageTimeout, polling: 100 });
      await cdp.send("Profiler.start");
    }
    const r = await result;
    if (cdp) writeFileSync(profile, JSON.stringify((await cdp.send("Profiler.stop")).profile));
    return { ...r, problems: [...new Set(problems)].slice(0, 20) };
  } finally {
    await page.close();
  }
}

/** The heaviest functions of a .cpuprofile by self time, and the share of the profile in GC, idle and program (native). */
function profileSummary(file, top = 25) {
  const p = JSON.parse(readFileSync(file, "utf8"));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  /** Whether a node runs under the skinning feature's code (it or an ancestor is in its chunk): sync work and the GL/WebGPU calls it makes. */
  const underSkin = new Map();
  const isSkin = (id) => {
    if (underSkin.has(id)) return underSkin.get(id);
    const n = byId.get(id);
    const url = n.callFrame.url ?? "";
    const v = skinChunks.some((c) => url.endsWith(c)) || (parent.has(id) ? isSkin(parent.get(id)) : false);
    underSkin.set(id, v);
    return v;
  };
  let skinUs = 0;
  const dt = new Map();
  for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
  const self = new Map();
  let total = 0;
  for (const [id, us] of dt) {
    const n = byId.get(id);
    const cf = n.callFrame;
    const file = cf.url ? cf.url.replace(/^.*\//, "") : "";
    const key = `${cf.functionName || "(anonymous)"} ${file}${cf.url ? `:${cf.lineNumber + 1}` : ""}`;
    self.set(key, (self.get(key) ?? 0) + us);
    total += us;
    if (isSkin(id)) skinUs += us;
  }
  const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, top);
  return { totalMs: total / 1000, skinningSyncMs: skinUs / 1000, skinningSyncMsPerFrame: skinUs / 1000 / frames, top: rows.map(([fn, us]) => ({ fn, ms: us / 1000, share: us / total })) };
}

const results = new Map(chosen.map((s) => [s.name, []]));
const counted = new Map();
const profileFile = join(root, "test-results/anim-bench/characters.cpuprofile");
try {
  for (let r = 0; r < rounds; r++) {
    for (const s of chosen) {
      process.stdout.write(`round ${r + 1}/${rounds}  ${s.name.padEnd(18)}`);
      const out = await runScenario(s);
      results.get(s.name).push(out);
      process.stdout.write(` animation ${out.stats.animation.mean.toFixed(3)} ms  step ${out.stats.step.mean.toFixed(2)} ms  (${out.playing ?? "-"}/${out.animators} animators with a state)\n`);
    }
  }
  if (flag("count")) {
    for (const s of chosen) {
      if (s.camera === false) continue; // nothing renders
      process.stdout.write(`counting        ${s.name.padEnd(18)}`);
      const out = await runScenario(s, { count: true });
      counted.set(s.name, out.counts);
      process.stdout.write(` ${Object.keys(out.counts?.perFrame ?? {}).length} counters\n`);
    }
  }
  if (flag("profile") && chosen.some((s) => s.name === "characters")) {
    mkdirSync(join(root, "test-results/anim-bench"), { recursive: true });
    process.stdout.write("profiling       characters");
    await runScenario(SCENARIOS.find((s) => s.name === "characters"), { profile: profileFile });
    process.stdout.write(`  ${relative(root, profileFile)}\n`);
  }
} finally {
  await browser.close();
  server.kill();
}

// --- Report ---------------------------------------------------------------------------------------------------------

const STAGES = ["timeline", "gather", "evaluate", "apply", "animation", "rest", "step", "interval"];
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const table = chosen.map((s) => {
  const runs = results.get(s.name);
  const row = { scenario: s.name, note: runs[0].note, animators: runs[0].animators, playing: runs[0].playing === null ? null : Math.min(...runs.map((x) => x.playing)), budget: s.budget, rounds: runs.length };
  for (const k of STAGES) {
    const means = runs.map((x) => x.stats[k].mean);
    row[k] = { median: median(means), min: Math.min(...means), max: Math.max(...means), p95: median(runs.map((x) => x.stats[k].p95)) };
  }
  row.problems = [...new Set(runs.flatMap((x) => x.problems))];
  row.renderer = runs[0].counts?.contexts.find((c) => c === "webgpu" || c === "webgl2") ?? null;
  row.skinningBackend = runs[0].counts?.skinning ?? null;
  row.counts = counted.get(s.name)?.perFrame ?? null;
  return row;
});
const byName = Object.fromEntries(table.map((r) => [r.scenario, r]));
const restOf = (name) => byName[name]?.rest.median ?? null;
const diff = (a, b) => (restOf(a) !== null && restOf(b) !== null ? restOf(a) - restOf(b) : null);
const skinning = diff("characters", "characters_noskin");
/** Main-thread "rest" split: skinned meshes vs none, skinning alone (skinned vs the same meshes static), drawing them. */
const skinningBreakdown = { total: skinning, skinningOnly: diff("characters", "characters_static"), staticDraws: diff("characters_static", "characters_noskin") };

const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : "-");
console.log(`\nAnimation through the shipped player: ms per frame, median of ${rounds} round means (${frames} frames each after ${warm} warm-up)`);
console.log(`  ${"scenario".padEnd(18)} ${["timeline", "gather", "evaluate", "apply", "anim total", "rest*", "step"].map((h) => h.padStart(10)).join(" ")}  budget`);
for (const r of table) {
  const verdict = r.budget ? `${r.budget.ms} ms: evaluate ${r.evaluate.median <= r.budget.ms ? "under" : "OVER"}, total ${r.animation.median <= r.budget.ms ? "under" : "OVER"}` : "";
  console.log(`  ${r.scenario.padEnd(18)} ${[r.timeline, r.gather, r.evaluate, r.apply, r.animation, r.rest, r.step].map((x) => f(x.median).padStart(10)).join(" ")}  ${verdict}`);
}
console.log(`  * rest: lateUpdate scripts, propagation, render sync and the Babylon render (${adapterText}).`);
const backends = [...new Set(table.filter((r) => r.renderer).map((r) => `${r.renderer}${r.skinningBackend ? `, skinning ${r.skinningBackend}` : ""}`))];
console.log(`  renderer (--renderer ${renderer}): ${backends.join("; ") || "unknown"}`);
if (skinning !== null) console.log(`  GPU skinning (characters rest - characters_noskin rest: palette upload, mycoSkin dispatch and drawing 100 meshes): ${f(skinning)} ms`);
if (skinningBreakdown.skinningOnly !== null) console.log(`    skinning alone (characters - characters_static: sync, palette uploads, dispatches, and drawing 100 distinct meshes where the static copies share one instanced draw): ${f(skinningBreakdown.skinningOnly)} ms; drawing the static copies (characters_static - characters_noskin): ${f(skinningBreakdown.staticDraws)} ms`);
if (counted.size) {
  const names = table.filter((r) => r.counts).map((r) => r.scenario);
  const keys = [...new Set(names.flatMap((n) => Object.keys(byName[n].counts)))].sort();
  console.log(`\nGPU calls per frame (--count; one counted page per scenario, ${frames} frames):`);
  console.log(`  ${"counter".padEnd(28)} ${names.map((n) => n.slice(0, 18).padStart(18)).join(" ")}`);
  for (const k of keys) console.log(`  ${k.padEnd(28)} ${names.map((n) => String(byName[n].counts[k] ?? 0).padStart(18)).join(" ")}`);
}
let profile = null;
if (existsSync(profileFile) && flag("profile")) {
  profile = profileSummary(profileFile);
  console.log(`\nCPU profile of characters (${f(profile.totalMs)} ms sampled over ${frames} frames):`);
  console.log(`  skinning render sync (the skinning feature's code and the GL/WebGPU calls it makes; not Babylon's draws): ${f(profile.skinningSyncMsPerFrame)} ms per frame`);
  console.log("  heaviest by self time ((program) is native work outside JavaScript, including GL/WebGPU calls):");
  for (const t of profile.top) console.log(`  ${f(t.ms).padStart(10)} ms ${(t.share * 100).toFixed(1).padStart(5)}%  ${t.fn}`);
}
console.log("  CPU skinning matrices are written inside the core's evaluate (FrameMeter: not separable).");
for (const r of table) {
  if (r.playing !== null && r.playing < r.animators) console.log(`  note: ${r.scenario}: only ${r.playing} of ${r.animators} animators reported a state`);
  if (r.problems.length) console.log(`  ${r.scenario} warnings: ${r.problems.slice(0, 3).join(" | ")}`);
}

const sizeRows = sizes();
printSizes(sizeRows);
const shipped = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".wasm")) shipped.push({ file: relative(build, p), bytes: statSync(p).size });
  }
};
walk(build);
console.log("\nWasm files in the exported web build:");
for (const s of shipped.sort((a, b) => b.bytes - a.bytes)) console.log(`  ${s.file.padEnd(60)} ${s.bytes.toLocaleString("en-US").padStart(11)}`);

const outFile = opt("out", join(root, "test-results/anim-bench/latest.json"));
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify({
  when: new Date().toISOString(),
  commit,
  machine: { cpus: cpus().length, model: cpus()[0]?.model, node: process.version, browser: `Chromium ${browserVersion} (${headed ? "headed" : "headless"}, ANGLE ${angle})`, gpu: { requested: gpu, angle, webgl: adapter.webgl, webgpu: adapter.webgpu, software: softwareGL, softwareWebGPU: softwareGPU }, note: softwareGL ? "software rendering: render and skinning times don't reflect a GPU" : "hardware GPU" },
  options: { rounds, frames, warm, viewport: `${vw}x${vh}`, renderer, count: flag("count"), profile: flag("profile") },
  scenarios: table,
  skinningMs: skinning,
  skinningBreakdown,
  profile,
  sizes: sizeRows,
  shippedWasm: shipped,
}, null, 2)}\n`);
console.log(`\nJSON: ${relative(root, outFile)}`);

// A player this run built from nothing is removed again (unless --keep); one that existed, rebuilt or not, stays.
if (flag("keep")) console.log(`kept: ${work}${builtPlayer && playerAge === 0 ? " and dist/player/" : ""}`);
else {
  rmSync(work, { recursive: true, force: true });
  if (builtPlayer && playerAge === 0) rmSync(playerDir, { recursive: true, force: true });
}
