// Usage (repo root): node spikes/audio-worklet/occlusion/run.mjs
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import RAPIER from "@dimforge/rapier3d-compat";
import { runAll } from "./bench.js";

const root = dirname(fileURLToPath(import.meta.url));
const rapierMjs = join(dirname(createRequire(import.meta.url).resolve("@dimforge/rapier3d-compat")), "rapier.mjs");

await RAPIER.init();
const node = runAll(RAPIER, () => performance.now(), (k) => console.error("node", k));

const files = { "/": join(root, "index.html"), "/bench.js": join(root, "bench.js"), "/rapier.mjs": rapierMjs };
const server = createServer(async (req, res) => {
  const f = files[new URL(req.url, "http://x").pathname];
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : "text/javascript" }).end(await readFile(f));
}).listen(0);
const browser = await chromium.launch();
let chrome;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(e.message));
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForFunction(() => window.results, null, { timeout: 900_000 });
  chrome = await page.evaluate(() => window.results);
} finally { await browser.close(); server.close(); }

const out = { node: { ...node, version: process.version }, chromium: chrome };
await writeFile(join(root, "results.json"), JSON.stringify(out, null, 1));
for (const [env, r] of Object.entries(out)) {
  console.log(`\n== ${env}`);
  for (const x of r.rows) console.log(x.alloc ? `${x.scene} alloc-vs-reuse p50 ms (S64,R1): ${JSON.stringify(x.alloc)}` :
    `${x.scene.padEnd(11)} S=${String(x.S).padEnd(3)} R=${x.R} ${x.method.padEnd(7)} p50 ${x.p50.toFixed(3)} p95 ${x.p95.toFixed(3)} ms  ${x.usPerRay.toFixed(2)} us/ray`);
  for (const u of r.upd) console.log(`${u.scene} step idle p50 ${u.idleStep.p50.toFixed(3)} p95 ${u.idleStep.p95.toFixed(3)}; 50 moved p50 ${u.movedStep.p50.toFixed(3)} p95 ${u.movedStep.p95.toFixed(3)}; sees move before step: ${u.seesMoveBeforeStep}, after: ${u.seesMoveAfterStep}`);
  console.log(JSON.stringify(r.info));
}
