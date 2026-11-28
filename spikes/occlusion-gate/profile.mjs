#!/usr/bin/env node
// CPU profile of one gate config: node spikes/occlusion-gate/profile.mjs --project forest-auto-lod --mode fly [--frames 150]
// Needs an unminified build: npx vite build --config spikes/occlusion-gate/vite.config.ts --minify false
// Prints self and total time by function over the measured frames, and writes the .cpuprofile beside it.
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const GEN = join(HERE, "generated");
const BUILD = join(HERE, ".build", "bench");
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const PROJECT = flag("project", "forest-auto-lod");
const MODE = flag("mode", "fly");
const FRAMES = +flag("frames", MODE === "fly" ? 150 : 100);
const WARMUP = +flag("warmup", 60);
const PORT = +flag("port", 3931);
const OUT = resolve(HERE, flag("out", `profile-${PROJECT}-${MODE}.cpuprofile`));

const { chromium } = createRequire("/opt/node-tools/package.json")("playwright");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = null;
  for (const [prefix, dir] of [["/bench/", BUILD], ["/projects/", GEN]]) if (url.startsWith(prefix)) file = join(dir, url.slice(prefix.length));
  if (!file || !normalize(file).startsWith(HERE + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const browser = await chromium.launch({ args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.addInitScript(readFileSync(join(HERE, "glhook.js"), "utf8"));
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.goto(`http://127.0.0.1:${PORT}/bench/bench.html?project=${PROJECT}`);
await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 900_000, polling: 500 });
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
const res = await page.evaluate((cfg) => window.bench.run(cfg), { mode: MODE, occlusion: "none", frames: FRAMES, warmup: WARMUP, engineOcclusion: argv.includes("--engine") });
const { profile } = await cdp.send("Profiler.stop");
writeFileSync(OUT, JSON.stringify(profile));
const dbg = await page.evaluate(() => window.bench.debug().active);
console.log(`babylon meshes ${dbg.meshes}, enabled ${dbg.enabled}, active ${dbg.am}`);
const cpu = res.rows.map((r) => r.cpuMs).sort((a, b) => a - b);
console.log(`${PROJECT} ${MODE}: cpu p50 ${cpu[cpu.length >> 1].toFixed(1)} ms over ${cpu.length} frames`);

// self time per node, then total per function (a function counted once per stack)
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const dt = new Map();
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i + 1] ?? 0));
const key = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
const self = new Map(), total = new Map();
for (const [id, us] of dt) {
  const n = byId.get(id);
  self.set(key(n), (self.get(key(n)) ?? 0) + us);
  const seen = new Set();
  for (let c = id; c != null; c = parent.get(c)) { const k = key(byId.get(c)); if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + us); } }
}
const all = [...dt.values()].reduce((a, b) => a + b, 0);
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(100 * v / all).toFixed(1).padStart(5)}%  ${k}`).join("\n");
console.log("--- self ---\n" + top(self, 40) + "\n--- total ---\n" + top(total, 60));
await browser.close(); server.close();
