// GC check: record a Chromium trace (all threads, including the audio worklet thread) while the
// batch test runs, then count V8 GC events per thread. Usage: node gc-trace.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  try {
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }).end(await readFile(path));
  } catch { res.writeHead(404).end(); }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"] });
const out = {};
for (const [mode, N] of [["pm", 1024], ["ring", 1024], ["pm", 64]]) {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.probe);
  await browser.startTracing(page, { categories: ["v8", "v8.gc", "disabled-by-default-v8.gc", "toplevel", "__metadata"] });
  const r = await page.evaluate(([m, n]) => window.probe.batch(m, n), [mode, N]);
  const buf = await browser.stopTracing();
  const events = JSON.parse(buf.toString()).traceEvents ?? JSON.parse(buf.toString());
  const names = new Map();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name);
  const per = {};
  for (const e of events) {
    if (!/GC|Scavenge|MinorMC|MajorMC|MarkCompact/i.test(e.name) || e.ph === "M") continue;
    if (!/^V8\.GC_(SCAVENGER|MARK_COMPACTOR|MINOR_MC|MC)$|^V8\.GCScavenger$|^MajorGC$|^MinorGC$|^V8\.GC_MARK_COMPACTOR$|^V8\.GC_SCAVENGER$/i.test(e.name) && !/^(MinorGC|MajorGC)$/.test(e.name)) continue;
    const t = names.get(`${e.pid}:${e.tid}`) ?? `tid ${e.tid}`;
    const k = `${t} / ${e.name}`;
    per[k] ??= { count: 0, maxMs: 0 };
    per[k].count++;
    per[k].maxMs = Math.max(per[k].maxMs, (e.dur ?? 0) / 1000);
  }
  const gcNames = [...new Set(events.filter((e) => /gc/i.test(e.name)).map((e) => e.name))].slice(0, 20);
  out[`${mode} ${N}`] = { gcEventsPerThread: per, sampleGcEventNames: gcNames, totalEvents: events.length,
    threads: [...new Set(names.values())] , mainHeap: r.mainHeap };
  await page.close();
}
await browser.close();
server.close();
console.log(JSON.stringify(out, null, 1));
