// Runs the cases inside an AudioWorklet in Chromium (OfflineAudioContext: no audio device needed).
import { chromium } from '/home/user/TranquilityEngine/node_modules/playwright-core/index.mjs';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pct = (s, p) => s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1];
const stats = (t) => { const s = Float64Array.from(t).sort(); return { p50: pct(s, 0.5), p99: pct(s, 0.99), p999: pct(s, 0.999), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length }; };

export async function runChromium({ wasmBytes, hrir, names, names0, runs, quanta, warm }) {
  const exe = process.env.E2E_CHROMIUM || ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find(existsSync);
  if (!exe) throw new Error('no Chromium found (set E2E_CHROMIUM)');
  const files = {
    '/processor.js': ['text/javascript', readFileSync(join(here, 'processor.js'))],
    '/clock.js': ['text/javascript', readFileSync(join(here, 'clock.js'))],
    '/bedspike.wasm': ['application/wasm', wasmBytes],
    '/hrir.bin': ['application/octet-stream', hrir],
  };
  const srv = http.createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const f = files[req.url];
    if (f) { res.setHeader('content-type', f[0]); res.end(f[1]); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body>bed spike</body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  try {
    const pg = await browser.newPage();
    pg.on('console', (m) => console.error('[page]', m.text()));
    pg.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await pg.goto(`http://127.0.0.1:${port}/`);
    const info = await pg.evaluate(() => ({ ua: navigator.userAgent, isolated: self.crossOriginIsolated }));
    if (!info.isolated) throw new Error('page not cross-origin isolated: no SharedArrayBuffer clock');
    // The spinning clock worker, shared by every case.
    await pg.evaluate(async () => {
      const sab = new SharedArrayBuffer(8);
      const w = new Worker('/clock.js');
      await new Promise((r) => { w.onmessage = r; w.postMessage(sab); });
      window.__sab = sab; window.__w = w;
      const f = new Float64Array(sab);
      while (f[0] === 0) await new Promise((r) => setTimeout(r, 5));
    });
    const out = { target: 'chromium-audioworklet', ua: info.ua, clock_step_us: 5, note: 'the shared clock is quantised to 5 us in the data (all cases with k=1); time from a spinning worker writing performance.now() into a SharedArrayBuffer (no performance in the worklet; the spinner occupies one core); cheap cases are timed as the mean of k quanta (k in the case entry)', cases: {} };
    for (const name of names) {
      const id = names0.indexOf(name);
      const r = await pg.evaluate(async ({ id, runs, quanta, warm }) => {
        const [wasm, hrir] = await Promise.all([fetch('/bedspike.wasm').then((r) => r.arrayBuffer()), fetch('/hrir.bin').then((r) => r.arrayBuffer())]);
        const ctx = new OfflineAudioContext(1, runs * (warm + quanta) * 128, 48000);
        await ctx.audioWorklet.addModule('/processor.js');
        const node = new AudioWorkletNode(ctx, 'bed', { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { wasm, hrir, caseId: id, runs, quanta, warm, sab: window.__sab } });
        const msg = new Promise((res, rej) => { node.port.onmessage = (e) => res(e.data); node.onprocessorerror = (e) => rej(new Error('processorerror ' + (e.message || ''))); });
        node.connect(ctx.destination);
        const t0 = performance.now();
        await ctx.startRendering();
        const m = await msg;
        if (m.error) throw new Error('worklet: ' + m.error);
        return { runs: m.runs.map((a) => Array.from(a)), k: m.k, checksum50: m.checksum50, wall_ms: performance.now() - t0 };
      }, { id, runs, quanta, warm });
      const entries = r.runs.map((a) => ({ ...stats(a), k: r.k }));
      entries.push({ checksum50: r.checksum50 });
      out.cases[name] = entries;
      console.error(`chromium ${name}: p50 ${entries[0].p50.toFixed(1)} us (k=${r.k}, ${(r.wall_ms / 1000).toFixed(1)} s)`);
    }
    return out;
  } finally {
    await browser.close();
    srv.close();
  }
}
