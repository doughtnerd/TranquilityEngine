// Chromium runner (Playwright). Usage:
//   node run_browser.mjs main   [--runs 7] [--quanta 4000] [--filter a,b] [--json out.json]
//   node run_browser.mjs worklet [--runs 5] [--quanta 8000]
// Needs Chromium: set CHROMIUM=/path/to/chrome (default /opt/pw-browsers/chromium-*/chrome-linux64/chrome).
// No audio device is needed: the worklet runs in an OfflineAudioContext.
import { createServer } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { parseArgs } from './bench_core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const a = parseArgs(process.argv.slice(2));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const p = join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(here)) throw new Error('outside');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let exe = process.env.CHROMIUM;
if (!exe) {
  const root = '/opt/pw-browsers';
  const dir = (await readdir(root)).filter((d) => d.startsWith('chromium-')).sort().pop();
  exe = join(root, dir, 'chrome-linux64', 'chrome');
}
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error', e));
  await page.goto(`http://127.0.0.1:${server.address().port}/browser.html`);
  await page.waitForFunction(() => window.ready === true);
  if (a.mode === 'worklet') {
    const names = ['single_2s_noise', 'single_4s_noise', 'm1_real_1.8s', 'zones_4x2s_unstaggered', 'zones_4x2s_staggered', 'zones_8x2s_unstaggered', 'zones_8x2s_staggered', 'blend_2x2s_staggered', 'event_256_filter_send'].filter((n) => !a.filter.length || a.filter.some((f) => n.includes(f)));
    const r = await page.evaluate((o) => window.runWorklet(o), { runs: a.runs === 7 ? 5 : a.runs, quanta: a.quanta === 4000 ? 8000 : a.quanta, names });
    console.log(`${r.ua}\n\n| case | wall us per quantum, median of runs | min | max | minus empty processor (median) | % of quantum | max Date.now() gap between process() calls, worst run (ms) |\n|---|---|---|---|---|---|---|`);
    const f = (v) => v.toFixed(2);
    for (const row of r.rows) {
      const med = row.per[row.per.length >> 1];
      const net = med - row.baseline;
      console.log(`| ${row.name} | ${f(med)} | ${f(row.per[0])} | ${f(row.per[row.per.length - 1])} | ${row.name.startsWith('(') ? '-' : f(net)} | ${row.name.startsWith('(') ? '-' : f((net / 2666.67) * 100)} | ${Math.max(...row.gap)} |`);
    }
  } else {
    const r = await page.evaluate((o) => window.runMain(o), { runs: a.runs, quanta: a.quanta, filter: a.filter });
    console.log(r.ua + '\n\n' + r.table);
    if (a.json) await writeFile(a.json, r.json);
  }
} finally {
  await browser.close();
  server.close();
}
