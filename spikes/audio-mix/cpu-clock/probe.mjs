// Probe: what AudioWorkletGlobalScope exposes, isolated vs plain, and AudioContext extras. Usage: node probe.mjs
import { chromium } from '/home/user/TranquilityEngine/node_modules/playwright-core/index.mjs';
import http from 'node:http';
import { existsSync } from 'node:fs';
const exe = process.env.E2E_CHROMIUM || ['/opt/pw-browsers/chromium'].concat([]).find(existsSync);
const WORKLET = `
class P extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.dn = []; this.first = true; }
  process() {
    // Date.now resolution: gather distinct step sizes over many quanta by spinning briefly
    if (this.n++ === 50) {
      const t0 = Date.now(); let t = t0, steps = [];
      const end = t0 + 12; let prev = t0;
      while ((t = Date.now()) < end) { if (t !== prev) { steps.push(t - prev); prev = t; } }
      const g = globalThis;
      const has = (k) => { try { return typeof g[k] !== 'undefined'; } catch { return 'throws'; } };
      let atomicsWait = 'n/a';
      try { atomicsWait = typeof Atomics !== 'undefined' && (new Int32Array(new SharedArrayBuffer(4)), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0)); } catch (e) { atomicsWait = 'throws: ' + e.message; }
      let nowTypes = {}; for (const k of ['performance','Date','Atomics','SharedArrayBuffer','currentTime','currentFrame','sampleRate','crossOriginIsolated','setTimeout','queueMicrotask','WebAssembly','console','Worker','MessagePort','TextDecoder','navigator','self']) nowTypes[k] = has(k);
      let dnRes = steps.length ? { distinctSteps: [...new Set(steps)], n: steps.length } : { note: 'no tick seen in 12 ms' };
      let hr = null; try { const a = Date.now(); const b = Date.now(); hr = { fractional: !Number.isInteger(a) }; } catch {}
      this.port.postMessage({ nowTypes, atomicsWait, dnRes, hr, crossOriginIsolated: g.crossOriginIsolated, sab: typeof SharedArrayBuffer, globals: Object.getOwnPropertyNames(g).filter(k => /perf|time|now|clock|frame|rate|Atomics|Shared/i.test(k)) });
    }
    return true;
  }
}
registerProcessor('p', P);
`;
async function run(isolated) {
  const srv = http.createServer((req, res) => {
    if (isolated) { res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); }
    if (req.url === '/w.js') { res.setHeader('content-type', 'text/javascript'); res.end(WORKLET); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>probe</body>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage();
  await pg.goto(`http://127.0.0.1:${srv.address().port}/`);
  const out = await pg.evaluate(async () => {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('/w.js');
    const n = new AudioWorkletNode(ctx, 'p'); n.connect(ctx.destination);
    await ctx.resume();
    const msg = await Promise.race([new Promise((r) => (n.port.onmessage = (e) => r(e.data))), new Promise((r) => setTimeout(() => r('timeout (ctx state ' + ctx.state + ', t=' + ctx.currentTime + ')'), 5000))]);
    const proto = AudioContext.prototype;
    return { ua: navigator.userAgent, state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency, crossOriginIsolated, msg,
      renderCapacityInProto: 'renderCapacity' in proto, playoutStatsInProto: 'playoutStats' in proto, getOutputTimestamp: typeof ctx.getOutputTimestamp,
      perfNowRes: (() => { let m = 1e9, p = performance.now(); for (let i = 0; i < 2e5; i++) { const q = performance.now(); if (q > p) { m = Math.min(m, q - p); p = q; } } return m; })() };
  });
  await b.close(); srv.close();
  return out;
}
for (const iso of [false, true]) console.log(iso ? 'ISOLATED' : 'PLAIN', JSON.stringify(await run(iso), null, 1));
