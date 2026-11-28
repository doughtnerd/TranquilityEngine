#!/usr/bin/env node
// Validity check for the oracles, with real pixels: renders one real (SwiftShader) frame per configuration (the `<scene>-unlit`
// projects: same scene, flat unlit materials, because the lit High tier renders black in SwiftShader here, see README) at the static
// camera, saves validation/<scene>-<oracle>.png, and diffs each oracle's image against the baseline's.
//   - occlusion: hiding objects the ID pass found to have zero visible pixels must leave the picture unchanged
//     (shadows excepted: a hidden object no longer casts a shadow, so differences can only come from that).
//   - lod: the picture changes slightly (that is the point); the diff size says how visible the swap is.
// EXPECTED DURATION: about 3 minutes per baseline frame, less for the oracles: ~15 minutes for both scenes on 4 shared cores.
//   node spikes/render-bench/validate.mjs [--scenes forest,city]   (needs run.mjs to have made the occlusion data first)
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const GEN = join(HERE, "generated"), BUILD = join(HERE, ".build", "bench"), OUT = join(HERE, "validation");
const scenes = String(process.argv.includes("--scenes") ? process.argv[process.argv.indexOf("--scenes") + 1] : "forest,city").split(",");
mkdirSync(OUT, { recursive: true });
const { PNG } = createRequire(join(ROOT, "package.json"))("pngjs");
let chromium;
for (const base of [join(ROOT, "package.json"), "/opt/node-tools/package.json"]) {
  try { const c = createRequire(base)("playwright").chromium; if (existsSync(c.executablePath())) { chromium = c; break; } } catch { /* next */ }
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = null;
  if (url.startsWith("/bench/")) file = join(BUILD, url.slice(7));
  if (url.startsWith("/projects/")) file = join(GEN, url.slice(10));
  const occ = url.match(/^\/occlusion\/(\w+)\.json$/);
  if (occ) file = join(GEN, `occlusion-${occ[1]}.json`);
  if (!file || !normalize(file).startsWith(HERE + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(3923, "127.0.0.1", r));
const browser = await chromium.launch({ args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"] });
const hook = readFileSync(join(HERE, "glhook.js"), "utf8");

async function shot(scene, oracle, cfg) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.addInitScript(hook);
  const page = await context.newPage();
  if (process.env.VLOG) page.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 400)));
  await page.goto(`http://127.0.0.1:3923/bench/bench.html?project=${scene}-unlit`);
  await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 600_000 });
  const res = await page.evaluate((c) => window.bench.run(c), { mode: "static", frames: +(process.env.VFRAMES ?? 1), warmup: 60, raster: true, rasterWarmup: +(process.env.VRWARM ?? 1), capture: true, settleMs: +(process.env.VSETTLE ?? 0), ...cfg });
  const png = Buffer.from(res.capture.split(",")[1], "base64");
  writeFileSync(join(OUT, `${scene}-${oracle}.png`), png);
  await context.close();
  return { png: PNG.sync.read(png), frameMs: res.rows[0].intervalMs };
}
/**
 * Two comparisons. `coverage`: which pixels are not the sky (project background #9ec5e8): the geometry's silhouette, valid
 * whether or not the shading came out (see README: in SwiftShader the High tier often renders the shaded geometry black).
 * `colour`: any channel differing by more than 8/255 (only meaningful when both images are shaded).
 */
function diff(a, b) {
  const sky = (d, i) => Math.abs(d[i] - 158) < 12 && Math.abs(d[i + 1] - 197) < 12 && Math.abs(d[i + 2] - 232) < 12;
  let cov = 0, col = 0, geo = 0, sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const sa = sky(a.data, i), sb = sky(b.data, i);
    if (!sa) geo++;
    if (sa !== sb) cov++;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    sum += d;
    if (d > 8) col++;
  }
  const px = a.data.length / 4;
  return { geometryPixelsInBaseline: geo, coveragePixelsDiffering: cov, coverageFractionOfGeometry: +(cov / Math.max(1, geo)).toFixed(5), colourPixelsDiffering: col, meanAbsColourDiff: +(sum / px).toFixed(3) };
}
const out = {};
if (process.env.VPREFIX) {
  const r = await shot(scenes[0], `hide-${process.env.VPREFIX}`, { lod: false, occlusion: false, hidePrefix: process.env.VPREFIX });
  console.log('hidePrefix', process.env.VPREFIX, 'frameMs', r.frameMs);
  await browser.close(); server.close(); process.exit(0);
}
if (process.env.VHIDE) {
  const r = await shot(scenes[0], `hide${process.env.VHIDE}`, { lod: false, occlusion: false, hideBeyond: +process.env.VHIDE });
  console.log('hideBeyond', process.env.VHIDE, 'frameMs', r.frameMs);
  await browser.close(); server.close(); process.exit(0);
}
for (const scene of scenes) {
  const base = await shot(scene, "baseline", { lod: false, occlusion: false });
  out[scene] = { baselineFrameMs: base.frameMs };
  for (const [name, cfg] of (process.env.VONLYBASE ? [] : [["occlusion", { lod: false, occlusion: true }], ["lod", { lod: true, occlusion: false }]]).map((x) => x)) {
    const s = await shot(scene, name, cfg);
    out[scene][name] = { ...diff(base.png, s.png), frameMs: s.frameMs };
    console.log(scene, name, JSON.stringify(out[scene][name]));
  }
}
writeFileSync(join(OUT, "validation.json"), JSON.stringify(out, null, 1));
await browser.close();
server.close();
