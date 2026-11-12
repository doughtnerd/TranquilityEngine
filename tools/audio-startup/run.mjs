#!/usr/bin/env node
// F-37: the audio core's start-up under load, headless. Serves an exported web game, opens it in Chromium with CDP CPU
// throttling from navigation, and samples `Audio.debug()` in the page every 100 ms (an in-page timer, so the sampling
// doesn't add round trips) for `seconds` after load. Prints a timeline and a summary: underruns in the first N
// seconds, when the core started, the ladder state over time, the music lead.
//
// Usage (after `npm run build:player` and `npm run export -- samples/flappy --out DIR --target web`):
//   node tools/audio-startup/run.mjs DIR [throttle=6] [seconds=20] [runs=1] [port=3672] [hint=S] [timeline=1] [click=0] [flags="..."]
// `hint=0.04` forces a 40 ms device period (below); `click=1` clicks the canvas once there is one (a game that waits
// for a gesture); `flags` adds Chromium switches; `buffer=N` passes `--audio-buffer-size=N` (headless Linux ignores it).
//
// CDP throttling slows the page's main thread only; the AudioWorklet's thread keeps its speed. To starve it as a
// loaded phone does, pin the run and a few busy loops to one core (`taskset -c 0`).
//
// F-37 numbers (4-core Xeon VM, Flappy): before the fix, `hint=0.04` counted an underrun a second (15 in 15 s, the
// cap at its floor of 16 at 12.9 s) and `hint=0.08 throttle=4` 30 in 30 s, with no glitch to hear; after it, 0 and 0,
// the cap at 128 and the ladder idle. Default latency at 1× and 6×: 0 before and after.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [dir, ...rest] = process.argv.slice(2);
if (!dir) {
  console.error("usage: node tools/audio-startup/run.mjs <exportDir> [throttle=6] [seconds=20] [runs=1] [port=3672] [hint=S] [click=1]");
  process.exit(2);
}
const opt = Object.fromEntries(rest.map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const throttle = Number(opt.throttle ?? 6);
const seconds = Number(opt.seconds ?? 20);
const runs = Number(opt.runs ?? 1);
const port = Number(opt.port ?? 3672);
const buffer = Number(opt.buffer ?? 0);
const showTimeline = opt.timeline !== "0";
const click = opt.click === "1";
// `hint` (seconds) forces every AudioContext's latencyHint: Chromium's device period follows it (0.08 gives 80 ms
// bursts of process() calls), standing in for a device whose "interactive" buffer is large (an emulator, a phone
// without a low-latency path).
const hint = opt.hint ? Number(opt.hint) : 0;

const web = existsSync(join(dir, "web", "serve.mjs")) ? join(dir, "web") : dir;
const server = spawn(process.execPath, [join(web, "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.once("data", resolve));

const executablePath = !existsSync(chromium.executablePath()) && existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
const args = ["--autoplay-policy=no-user-gesture-required", ...(buffer > 0 ? [`--audio-buffer-size=${buffer}`] : []), ...(opt.flags ? opt.flags.split(" ") : [])];

// The in-page sampler: `__f37` holds one row per 100 ms from the first time `__myco.Audio` exists.
const forceHint = hint > 0 ? `(() => {
  const C = globalThis.AudioContext;
  globalThis.AudioContext = class extends C { constructor(o) { super({ ...(o ?? {}), latencyHint: ${hint} }); } };
})();` : "";
const sampler = `(() => {
  const rows = (globalThis.__f37 = []);
  const t0 = performance.now();
  const longTasks = (globalThis.__f37long = []);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
  setInterval(() => {
    const A = globalThis.__myco?.Audio;
    if (!A) return;
    let d; try { d = A.debug(); } catch { return; }
    const c = d.counters ?? {}, k = d.core ?? {};
    const town = (d.music ?? [])[0];
    rows.push({
      t: Math.round(performance.now() - t0), status: d.status, backend: k.backend,
      underruns: c.underruns, minSlack: c.minSlackFrames, late: c.lateCommands, wu: c.workUnits, wuMax: c.workUnitsMax,
      cap: c.mixedCap, mixed: c.mixedVoices, ladder: k.ladderState, starves: k.streamStarves,
      lead: town?.leadMs, prime: town?.primeEmaMs ?? d.musicTotals?.primeEmaMs, music: town?.state,
      lookahead: k.lookaheadFrames ?? k.L, base: k.baseLatency, out: k.outputLatency,
    });
  }, 100);
})();`;

const results = [];
for (let run = 0; run < runs; run++) {
  const browser = await chromium.launch({ executablePath, args });
  const context = await browser.newContext({ viewport: { width: 720, height: 680 } });
  await context.addInitScript(sampler);
  if (forceHint) await context.addInitScript(forceHint);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const t = Date.now();
  await page.goto(`http://localhost:${port}/`);
  if (click) {
    await page.locator("#game canvas").waitFor({ timeout: 60_000 });
    await page.locator("#game canvas").click().catch(() => {});
  }
  // Wait `seconds` after the core's first row (or 60 s at most for the core to appear).
  const deadline = Date.now() + 60_000;
  let first = null;
  while (Date.now() < deadline && first === null) {
    first = await page.evaluate(() => globalThis.__f37?.find((r) => r.backend === "core")?.t ?? null);
    if (first === null) await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const rows = await page.evaluate(() => globalThis.__f37);
  const longTasks = await page.evaluate(() => globalThis.__f37long);
  await browser.close();
  results.push({ rows, longTasks, wall: Date.now() - t });

  const core = rows.filter((r) => r.backend === "core");
  const coreAt = core[0]?.t ?? NaN;
  if (showTimeline) {
    console.log(`run ${run + 1}: throttle ${throttle}x, buffer ${buffer || "default"}, hint ${hint || "interactive"}; core first seen at ${coreAt} ms`);
    let last = "";
    for (const r of core) {
      const line = `u ${r.underruns} slack ${r.minSlack} late ${r.late} wu ${r.wu}/${r.wuMax} cap ${r.cap} ladder ${r.ladder} starves ${r.starves} music ${r.music} lead ${r.lead?.toFixed?.(0)} prime ${r.prime?.toFixed?.(1)}`;
      if (line !== last) console.log(`  ${String(r.t).padStart(6)} ms  ${line}`);
      last = line;
    }
    const lt = longTasks.filter(([s]) => s < coreAt + seconds * 1000);
    console.log(`  long tasks (main, > 50 ms): ${lt.length}, ${lt.reduce((a, [, d]) => a + d, 0)} ms total; longest ${Math.max(0, ...lt.map(([, d]) => d))} ms`);
  }
  const at = (s) => core.filter((r) => r.t <= coreAt + s * 1000).at(-1)?.underruns ?? 0;
  const lastRow = core.at(-1);
  console.log(
    `summary run ${run + 1}: underruns @2s ${at(2)} @5s ${at(5)} @10s ${at(10)} @${seconds}s ${lastRow?.underruns}; ladder end "${lastRow?.ladder}"; cap end ${lastRow?.cap}; starves ${lastRow?.starves}; lead ${lastRow?.lead?.toFixed?.(0)} ms`,
  );
}
server.kill();
