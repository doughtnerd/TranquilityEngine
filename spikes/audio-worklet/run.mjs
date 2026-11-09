// Drives the spike headlessly: Node's own wasm numbers, then the page in Playwright's Chromium and
// WebKit through a tiny static server (no COOP/COEP: the design needs no SharedArrayBuffer).
// Usage: node spikes/audio-worklet/run.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, firefox } from "playwright";
import { benchWasm } from "./bench.js";

const root = dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

const out = {};
for (const name of ["mixer.wasm", "mixer-simd.wasm"]) {
  out[`node ${name}`] = await benchWasm(await readFile(join(root, "wasm", name)), () => performance.now());
}

const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

// Autoplay allowed so the start-up pass can run a real-time AudioContext headless.
const launch = {
  chromium: { args: ["--autoplay-policy=no-user-gesture-required"] },
  webkit: {},
  firefox: { firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 } },
};
for (const [label, type] of [["chromium", chromium], ["webkit", webkit], ["firefox", firefox]]) {
  let browser;
  try { browser = await type.launch(launch[label]); } catch (e) { out[label] = { error: `launch: ${String(e).split(String.fromCharCode(10))[0]}` }; continue; }
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`[${label}] ${e.message}`));
    await page.goto(url);
    await page.click("#run");
    await page.waitForFunction(() => window.spikeResults?.done === true, null, { timeout: 180_000 });
    out[label] = await page.evaluate(() => window.spikeResults);
  } catch (e) {
    out[label] = { error: String(e) };
  } finally {
    await browser.close();
  }
}
server.close();
console.log(JSON.stringify(out, null, 1));
