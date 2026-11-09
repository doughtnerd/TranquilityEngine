// Runs the messaging probe headlessly in Playwright Chromium and prints JSON.
// Usage: node spikes/audio-worklet/messaging/run.mjs [features] [rtt] [batch] [stream] [--seconds=20] [--trace]
//   no test names = all. Results are also written to messaging/results.json.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const args = process.argv.slice(2);
const seconds = Number((args.find((a) => a.startsWith("--seconds=")) ?? "--seconds=20").split("=")[1]);
const wanted = args.filter((a) => !a.startsWith("--"));
const want = (n) => wanted.length === 0 || wanted.includes(n);
const log = (...a) => console.error(...a);

function serve(isolated) {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
      const h = { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" };
      if (isolated) { h["Cross-Origin-Opener-Policy"] = "same-origin"; h["Cross-Origin-Embedder-Policy"] = "require-corp"; }
      try { res.writeHead(200, h).end(await readFile(path)); } catch { res.writeHead(404).end(); }
    }).listen(0, () => resolve({ s, url: `http://localhost:${s.address().port}/` }));
  });
}

const iso = await serve(true), plain = await serve(false);
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
const out = { date: new Date().toISOString(), chromium: browser.version(), seconds };

async function withPage(isolated, fn) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => log("pageerror", e.message));
  page.on("console", (m) => { if (m.type() === "error") log("console.error", m.text()); });
  await page.goto((isolated ? iso : plain).url);
  await page.waitForFunction(() => window.probe);
  try { return await fn(page); } catch (e) { return { error: String(e) }; } finally { await page.close(); }
}
const call = (page, name, ...a) => page.evaluate(([n, a]) => window.probe[n](...a), [name, a]);

if (want("features")) {
  out.features = {
    isolated: await withPage(true, (p) => call(p, "features")),
    notIsolated: await withPage(false, (p) => call(p, "features")),
  };
  log("features done");
}

if (want("rtt")) {
  out.rtt = [];
  for (const isolated of [false, true]) for (const jank of [false, true]) for (const kind of ["ping", "pingNext"]) {
    const r = await withPage(isolated, (p) => call(p, "rtt", kind, jank, 400));
    out.rtt.push({ isolated, ...r });
    log("rtt", isolated, jank, kind);
  }
}

if (want("batch")) {
  out.batch = [];
  for (const N of [64, 256, 1024]) {
    out.batch.push(await withPage(true, (p) => call(p, "batch", "pm", N)));
    out.batch.push(await withPage(true, (p) => call(p, "batch", "ring", N)));
    out.batch.push(await withPage(false, (p) => call(p, "batch", "pm", N)));
    log("batch", N);
  }
}

if (want("stream")) {
  out.stream = [];
  const runs = [];
  for (const chunk of [1024, 4096, 16384]) for (const target of [2048, 8192, 32768]) runs.push({ mode: "port", chunk, target });
  for (const target of [2048, 8192, 32768]) runs.push({ mode: "sab", chunk: 4096, target });
  for (const jank of ["mainJank", "workerJank"]) {
    for (const target of [2048, 8192, 32768]) {
      runs.push({ mode: "port", chunk: 4096, target, [jank]: true });
      runs.push({ mode: "sab", chunk: 4096, target, [jank]: true });
      if (jank === "mainJank") runs.push({ mode: "relay", chunk: 4096, target, [jank]: true });
    }
  }
  for (const cfg of runs) {
    const r = await withPage(true, (p) => call(p, "stream", { ...cfg, seconds }));
    out.stream.push(r);
    log("stream", JSON.stringify(cfg), "underruns", r.underruns, r.error ?? "");
  }
}

await browser.close();
iso.s.close(); plain.s.close();
await writeFile(join(root, "results.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
