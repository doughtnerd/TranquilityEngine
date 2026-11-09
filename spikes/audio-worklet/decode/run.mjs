// Reproduces the wasm measurements: Node, then Playwright browsers (main thread + decodeAudioData).
// Build first (see README), then from the repo root: node spikes/audio-worklet/decode/run.mjs
// Env: BROWSERS=chromium,webkit,firefox (default chromium); SKIP_OLD=1 skips the mp3/wav + fundsp runs of the first spike;
//      SKIP_NODE=1; WASM=name (old runs, default all-o3); WASM_FMT=name (format runs, default sym-5; ./build-sizes.sh builds them).
// Fixtures (git-ignored) come from `node run.mjs --make-fixtures` or the README's docker command; the page cannot decode formats it has no file for.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, firefox } from "playwright";
import { load, benchDecode, benchFx, benchFormats, benchStream } from "./bench.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const FILES = { "town.mp3": "samples/flappy/music/town.mp3", "foo.mp3": "samples/flappy/music/foo.mp3", "ocean_loop.wav": "samples/pirates/audio/ocean_loop.wav" };
const FIXTURES = ["town.mp3", "town.ogg", "town.flac", "town.opus.ogg", "town.opus.webm", "town.m4a"];
const skipOld = !!process.env.SKIP_OLD;
const out = {};

if (process.argv.includes("--make-fixtures")) {
  // ffmpeg (any build with libvorbis, libopus, aac) must be on PATH; the README shows the docker route.
  const { execFileSync } = await import("node:child_process");
  const src = join(repo, "samples/flappy/music/town.mp3"), d = join(here, "fixtures");
  const f = (name, ...a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, ...a, join(d, name)]);
  (await import("node:fs")).mkdirSync(d, { recursive: true });
  f("town.ogg", "-c:a", "libvorbis", "-q:a", "5"); f("town.flac", "-c:a", "flac");
  f("town.opus.ogg", "-c:a", "libopus", "-b:a", "128k"); f("town.opus.webm", "-c:a", "libopus", "-b:a", "128k"); f("town.m4a", "-c:a", "aac", "-b:a", "128k");
  (await import("node:fs")).copyFileSync(src, join(d, "town.mp3"));
  process.exit(0);
}

const fixtures = {};
for (const n of FIXTURES) { try { fixtures[n] = new Uint8Array(await readFile(join(here, "fixtures", n))); } catch {} }
if (!Object.keys(fixtures).length) console.error("no fixtures: run with --make-fixtures or see README");

if (!process.env.SKIP_NODE) {
  if (!skipOld) {
    const files = {};
    for (const [n, p] of Object.entries(FILES)) files[n] = new Uint8Array(await readFile(join(repo, p)));
    const x = await load(await readFile(join(here, `wasm/${process.env.WASM ?? "all-o3"}.wasm`)));
    out.nodeDecode = benchDecode(x, files, () => performance.now());
    out.nodeFx = benchFx(x, () => performance.now());
  }
  const x = await load(await readFile(join(here, `wasm/${process.env.WASM_FMT ?? "sym-5"}.wasm`)));
  out.nodeFormats = benchFormats(x, fixtures, () => performance.now());
  out.nodeStream = benchStream(x, fixtures, () => performance.now());
}

const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const path = p.startsWith("/samples/") ? join(repo, p) : join(here, p === "/" ? "index.html" : p);
  // COOP/COEP give performance.now() its fine (5 us) resolution in Chromium; chunk costs are well under 1 ms.
  const h = { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  try { const body = await readFile(path); res.writeHead(200, h).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0);

const launchers = { chromium, webkit, firefox };
for (const name of (process.env.BROWSERS ?? "chromium").split(",")) {
  const key = name === "chromium" ? "chromium" : name;
  let browser;
  try {
    browser = await launchers[name].launch();
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(name, e.message));
    await page.goto(`http://localhost:${server.address().port}/`);
    const r = {};
    if (name === "chromium" && !skipOld) { await page.evaluate(() => window.run()); r.old = await page.evaluate(() => window.results); }
    r.formats = await page.evaluate((w) => window.runFormats(w), process.env.WASM_FMT ?? "sym-5");
    out[key] = r;
  } catch (e) { out[key] = { error: String(e) }; }
  finally { await browser?.close(); }
}
server.close();
console.log(JSON.stringify(out, null, 1));
