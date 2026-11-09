// Spatial spike runner: Node, then Playwright Chromium and WebKit (main thread; the first spike showed
// the worklet adds only a few percent). Usage, from the repo root: node spikes/audio-worklet/spatial/run.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, firefox } from "playwright";
import { runCases, nonUniformWorst } from "./cases.js";

const root = dirname(fileURLToPath(import.meta.url));
const files = ["spatial.wasm", "spatial-simd.wasm"];
const out = { platform: `${process.platform} ${process.arch}` };

for (const f of files) out[`node ${f}`] = await runCases(await readFile(join(root, "wasm", f)), () => performance.now());
for (const f of files) out[`node worst ${f}`] = [2, 4, 8].map(() => null);
for (const f of files) for (const [i, s] of [2, 4, 8].entries()) out[`node worst ${f}`][i] = await nonUniformWorst(await readFile(join(root, "wasm", f)), () => performance.now(), s);

const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>spatial</title>");
  try { const body = await readFile(join(root, p)); res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" }).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

for (const [label, type] of [["chromium", chromium], ["webkit", webkit], ["firefox", firefox]]) {
  let browser;
  try { browser = await type.launch(); } catch (e) { out[label] = { error: `launch: ${String(e).split(String.fromCharCode(10))[0]}` }; continue; }
  try {
    const page = await browser.newPage();
    await page.goto(url);
    for (const f of files) {
      out[`${label} ${f}`] = await page.evaluate(async (f) => {
        const { runCases } = await import("/cases.js");
        const bytes = await (await fetch(`/wasm/${f}`)).arrayBuffer();
        return runCases(bytes, () => performance.now());
      }, f);
    }
  } catch (e) {
    out[label] = { error: String(e) };
  } finally {
    await browser.close();
  }
}
server.close();
console.log(JSON.stringify(out, null, 1));
