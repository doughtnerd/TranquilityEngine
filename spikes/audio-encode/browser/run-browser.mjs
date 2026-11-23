// ADR 0351 spike A0/S1: runs the encoder reactor in a Web Worker in headless Chromium (Playwright's, from the repo's
// devDependencies), through wasi-shim.js. Not an e2e spec: a measurement script.
//
//   node spikes/audio-encode/browser/run-browser.mjs <encoder.wasm> <in.wav> <job>... [--workers=N] [--browser=chromium|webkit] [--exec=chrome]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import playwright from "playwright";

const argv = process.argv.slice(2);
const opts = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const [wasmPath, inPath, ...jobs] = argv.filter((a) => !a.startsWith("--"));
const workers = Number(opts.workers ?? 1);
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const files = {
  "/index.html": ["text/html", "<!doctype html><meta charset=utf-8><title>encode spike</title>"],
  "/worker.js": ["text/javascript", readFileSync(here("worker.js"))],
  "/wasi-shim.js": ["text/javascript", readFileSync(here("wasi-shim.js"))],
  "/encoder.wasm": ["application/wasm", readFileSync(wasmPath)],
  "/input.wav": ["audio/wav", readFileSync(inPath)],
};

// --exec=/path/to/chrome when Playwright's own build isn't installed (this container: /usr/bin/google-chrome).
const browser = await playwright[opts.browser ?? "chromium"].launch(opts.exec ? { executablePath: opts.exec } : {});
const page = await browser.newPage();
await page.route("http://spike.local/**", (route) => {
  const f = files[new URL(route.request().url()).pathname];
  return f ? route.fulfill({ contentType: f[0], body: f[1] }) : route.fulfill({ status: 404 });
});
page.on("console", (m) => console.error(`[page] ${m.text()}`));
await page.goto("http://spike.local/index.html");
const result = await page.evaluate(async ({ jobs, workers }) => {
  const [wasm, input] = await Promise.all(["encoder.wasm", "input.wav"].map((u) => fetch(u).then((r) => r.arrayBuffer())));
  const t0 = performance.now();
  const module = await WebAssembly.compile(wasm);
  const compileMs = performance.now() - t0;
  const t1 = performance.now();
  const all = await Promise.all(
    Array.from({ length: workers }, () => new Promise((resolve, reject) => {
      const w = new Worker("worker.js", { type: "module" });
      w.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data.results));
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ wasm: module, input: input.slice(0), jobs });
    })),
  );
  return { compileMs, wallMs: performance.now() - t1, ua: navigator.userAgent, all };
}, { jobs, workers });
await browser.close();
console.log(JSON.stringify({ host: opts.browser ?? "chromium", ua: result.ua, wasmBytes: files["/encoder.wasm"][1].length, compileMs: +result.compileMs.toFixed(1), workers }));
if (workers === 1) for (const s of result.all[0]) console.log(JSON.stringify(s));
else {
  const audioS = result.all.flat().reduce((s, r) => s + r.seconds, 0);
  console.log(JSON.stringify({ workers, jobs, wallMs: +result.wallMs.toFixed(0), aggregateXRealtime: +((audioS * 1000) / result.wallMs).toFixed(1), perWorker: result.all.map((rs) => rs.map((r) => r.xRealtime)) }));
}
