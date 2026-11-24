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
// (ANIM_BENCH_PORT, else E2E_PORT, else 3791), --out FILE, --keep (keep the temp project and a player this run built),
// --regen (regenerate the fixtures), --sizes (only the size review; needs nothing built).
// GPU: by default the page draws with SwiftShader (software WebGL2, no WebGPU), so stage times compare across machines
// and the container. --gpu asks for the machine's real adapter: Chromium's full browser in its new headless mode (the
// headless shell has no GPU) with the platform's ANGLE backend (d3d11 on Windows, metal on macOS, vulkan on Linux) and
// WebGPU on; --headed opens a visible window instead (the surest way to get the GPU, and implies --gpu); --angle NAME
// overrides the backend. The adapter actually used is probed and recorded; a --gpu run that still lands on a software
// renderer stops, unless --allow-software.
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

const run = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, stdio: "inherit" });

const playerDir = join(root, "dist/player");
const builtPlayer = !existsSync(join(playerDir, "player.html"));
if (builtPlayer) {
  console.log("building the player (dist/player/)...");
  run("npm", ["run", "build:player"]);
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
console.log(`[anim-bench] ${headed ? "headed" : "headless"}, ANGLE ${angle}: ${adapterText}`);
if (gpu && softwareGL && !flag("allow-software")) {
  await browser.close();
  server.kill();
  console.error("[anim-bench] --gpu asked for the hardware adapter but the page got a software renderer. Try --headed, another --angle (d3d11, d3d12, vulkan, gl, metal), or update the GPU driver; --allow-software runs anyway.");
  process.exit(1);
}

const rounds = Number(opt("rounds", 3));
const frames = Number(opt("frames", 300));
const warm = Number(opt("warm", 120));
const only = opt("only", "").split(",").filter(Boolean);
const chosen = SCENARIOS.filter((s) => only.length === 0 || only.includes(s.name));

async function runScenario(s) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${s.name}: no result in 240 s${problems.length ? `\n${problems.join("\n")}` : ""}`)), 240_000);
    page.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("[anim-bench] ")) {
        clearTimeout(timer);
        resolve(JSON.parse(text.slice("[anim-bench] ".length)));
      } else if (m.type() === "warning" || m.type() === "error") problems.push(text);
    });
  });
  try {
    await page.goto(`${base}?bench=${s.bench}&frames=${frames}&warm=${warm}&camera=${s.camera === false ? 0 : 1}`);
    const r = await result;
    return { ...r, problems: [...new Set(problems)].slice(0, 20) };
  } finally {
    await page.close();
  }
}

const results = new Map(chosen.map((s) => [s.name, []]));
try {
  for (let r = 0; r < rounds; r++) {
    for (const s of chosen) {
      process.stdout.write(`round ${r + 1}/${rounds}  ${s.name.padEnd(18)}`);
      const out = await runScenario(s);
      results.get(s.name).push(out);
      process.stdout.write(` animation ${out.stats.animation.mean.toFixed(3)} ms  step ${out.stats.step.mean.toFixed(2)} ms  (${out.playing ?? "-"}/${out.animators} animators with a state)\n`);
    }
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
  return row;
});
const byName = Object.fromEntries(table.map((r) => [r.scenario, r]));
const skinning = byName.characters && byName.characters_noskin ? byName.characters.rest.median - byName.characters_noskin.rest.median : null;

const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : "-");
console.log(`\nAnimation through the shipped player: ms per frame, median of ${rounds} round means (${frames} frames each after ${warm} warm-up)`);
console.log(`  ${"scenario".padEnd(18)} ${["timeline", "gather", "evaluate", "apply", "anim total", "rest*", "step"].map((h) => h.padStart(10)).join(" ")}  budget`);
for (const r of table) {
  const verdict = r.budget ? `${r.budget.ms} ms: evaluate ${r.evaluate.median <= r.budget.ms ? "under" : "OVER"}, total ${r.animation.median <= r.budget.ms ? "under" : "OVER"}` : "";
  console.log(`  ${r.scenario.padEnd(18)} ${[r.timeline, r.gather, r.evaluate, r.apply, r.animation, r.rest, r.step].map((x) => f(x.median).padStart(10)).join(" ")}  ${verdict}`);
}
console.log(`  * rest: lateUpdate scripts, propagation, render sync and the Babylon render (${adapterText}).`);
if (skinning !== null) console.log(`  GPU skinning (characters rest - characters_noskin rest: palette upload, mycoSkin dispatch and drawing 100 meshes): ${f(skinning)} ms`);
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
  machine: { cpus: cpus().length, model: cpus()[0]?.model, node: process.version, browser: `Chromium ${browserVersion} (${headed ? "headed" : "headless"}, ANGLE ${angle})`, gpu: { requested: gpu, angle, webgl: adapter.webgl, webgpu: adapter.webgpu, software: softwareGL, softwareWebGPU: softwareGPU }, note: softwareGL ? "software rendering: render and skinning times don't reflect a GPU" : "hardware GPU" },
  options: { rounds, frames, warm },
  scenarios: table,
  skinningMs: skinning,
  sizes: sizeRows,
  shippedWasm: shipped,
}, null, 2)}\n`);
console.log(`\nJSON: ${relative(root, outFile)}`);

if (flag("keep")) console.log(`kept: ${work}${builtPlayer ? " and dist/player/" : ""}`);
else {
  rmSync(work, { recursive: true, force: true });
  if (builtPlayer) rmSync(playerDir, { recursive: true, force: true });
}
