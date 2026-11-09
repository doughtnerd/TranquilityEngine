// Usage from the repo root: node spikes/audio-worklet/bookkeeping/run.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, firefox } from "playwright";
import { runAll } from "./bench.js";

const root = dirname(fileURLToPath(import.meta.url));
const out = { node: runAll(() => performance.now()) };
const server = createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>bookkeeping</title>");
  try { const body = await readFile(join(root, p)); res.writeHead(200, { "Content-Type": "text/javascript" }).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
for (const [label, type] of [["chromium", chromium], ["webkit", webkit], ["firefox", firefox]]) {
  let browser;
  try { browser = await type.launch(); } catch (e) { out[label] = { error: "launch failed" }; continue; }
  try {
    const page = await browser.newPage();
    await page.goto(url);
    out[label] = await page.evaluate(async () => (await import("/bench.js")).runAll(() => performance.now()));
  } catch (e) { out[label] = { error: String(e) }; } finally { await browser.close(); }
}
server.close();
console.log(JSON.stringify(out, null, 1));
