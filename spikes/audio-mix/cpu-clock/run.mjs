// S2 timed run: audio-thread CPU estimators vs a known synthetic load inside a real-time AudioContext (Chromium).
// node run.mjs            full: 5 runs x 5 levels x (200 warm + 1500) quanta, ~2.5 min on an idle machine
// RUNS=2 QUANTA=300 node run.mjs   smoke
// Truth = a spinning worker's performance.now() in a SAB (isolated page). Estimators compared per window of W quanta.
import { chromium } from '/home/user/TranquilityEngine/node_modules/playwright-core/index.mjs';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = +(process.env.RUNS || 5), QUANTA = +(process.env.QUANTA || 1500), WARM = 200;
const LEVELS = [0, 0.1, 0.3, 0.6, 1.15]; // 1.15 = deliberate overload (underrun detection)
const WINDOWS = [6, 24, 96, 384]; // 6 = one STATUS block (16 ms at 48 kHz)
const exe = process.env.E2E_CHROMIUM || ['/opt/pw-browsers/chromium'].find(existsSync);
const pct = (s, p) => s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1];
const stats = (arr) => { const s = Float64Array.from(arr).sort(); return s.length ? { p50: pct(s, 0.5), p99: pct(s, 0.99), p999: pct(s, 0.999), max: s[s.length - 1] } : { p50: NaN, p99: NaN, p999: NaN, max: NaN }; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };

const files = { '/processor.js': 'processor.js', '/spin-truth.js': 'spin-truth.js', '/spin-count.js': 'spin-count.js' };
const srv = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const f = files[req.url];
  if (f) { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(join(here, f))); return; }
  res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>cpu-clock</body>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

async function oneRun() {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await pg.goto(`http://127.0.0.1:${srv.address().port}/`);
  const r = await pg.evaluate(async ({ WARM, QUANTA, LEVELS }) => {
    const sabT = new SharedArrayBuffer(8), sabC = new SharedArrayBuffer(8);
    const ws = [];
    for (const [url, sab] of [['/spin-truth.js', sabT], ['/spin-count.js', sabC]]) {
      const w = new Worker(url); await new Promise((res) => { w.onmessage = res; w.postMessage(sab); }); ws.push(w);
    }
    while (new Float64Array(sabT)[0] === 0 || new Float64Array(sabC)[0] === 0) await new Promise((r) => setTimeout(r, 5));
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('/processor.js');
    const stats = [];
    const snap = () => stats.push(ctx.playbackStats ? ctx.playbackStats.toJSON() : null);
    const node = new AudioWorkletNode(ctx, 'load', { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { sabTruth: sabT, sabCount: sabC, levels: LEVELS, warm: WARM, quanta: QUANTA, calMs: 300 } });
    node.connect(ctx.destination);
    const t0 = ctx.currentTime;
    const res = await new Promise((resolve, reject) => {
      node.port.onmessage = (e) => { if (e.data.boundary) snap(); else resolve(e.data); };
      node.onprocessorerror = () => reject(new Error('processorerror'));
    });
    snap();
    if (res.error) throw new Error(res.error);
    ws.forEach((w) => w.terminate());
    await ctx.close();
    return { res, playbackStats: stats, state: 'ok', sampleRate: ctx.sampleRate };
  }, { WARM, QUANTA, LEVELS });
  await pg.close();
  return r;
}

const all = [];
for (let i = 0; i < RUNS; i++) {
  const t = Date.now(); const r = await oneRun(); all.push(r);
  console.error(`run ${i + 1}/${RUNS}: ${((Date.now() - t) / 1000).toFixed(1)} s, calErr ${r.res.calErrPct.toFixed(2)} %, unitUs ${r.res.unitUs.map((x) => x.toFixed(2))}`);
}
await browser.close(); srv.close();

// Analysis ---------------------------------------------------------------------------------------------
const Q = all[0].res.quantumUs, PL = WARM + QUANTA;
const methods = ['a_dateNow', 'b1_counter', 'b1r_counter', 'c_model', 'c_fit'];
const out = { runs: RUNS, quanta: QUANTA, warm: WARM, quantumUs: Q, readCostNs: all[0].res.readCostNs, truthStepUs: all.map((r) => r.res.truthStepUs), calErrPct: all.map((r) => r.res.calErrPct), unitUsCold: all[0].res.unitUs, levels: {} };
const base = (li) => li * PL + WARM;
function windows(li, W, fn) { const v = []; for (let s = 0; s + W <= QUANTA; s += W) { let a = 0; for (let q = 0; q < W; q++) a += fn(base(li) + s + q); v.push(a); } return v; }
function fits(rec, li) { // per-section least squares through the origin on the last 100 warm quanta of this level
  const f = [0, 0, 0];
  for (let s = 0; s < 3; s++) { let xy = 0, xx = 0; for (let q = WARM - 100; q < WARM; q++) { const j = li * PL + q; const x = rec.units[j * 3 + s]; xy += x * rec.strue[j * 3 + s]; xx += x * x; } f[s] = xx ? xy / xx : 0; }
  return f;
}
for (let li = 0; li < LEVELS.length; li++) {
  const L = out.levels[LEVELS[li]] = { truthMeanPermille: 0, totalsCheck: [], W: {}, sections: {} };
  const summ = (per) => ({ p50: med(per.map((x) => x.abs.p50)), p99: med(per.map((x) => x.abs.p99)), p999: med(per.map((x) => x.abs.p999)), max: med(per.map((x) => x.abs.max)), bias: med(per.map((x) => x.bias)) });
  for (const W of WINDOWS) {
    const per = Object.fromEntries(methods.map((m) => [m, []]));
    for (const r of all) {
      const rec = r.res.rec, upt = r.res.usPerTick;
      let sd = 0, sc = 0; for (let q = 0; q < QUANTA; q++) { sd += rec.dnow[base(li) + q] * 1000; sc += rec.cnt[base(li) + q]; }
      const uptR = sc ? sd / sc : upt; // ticks recalibrated against Date.now over the level (a sliding-window analogue)
      const cf = fits(rec, li);
      const tr = windows(li, W, (j) => rec.truth[j]);
      const est = { a_dateNow: windows(li, W, (j) => rec.dnow[j] * 1000), b1_counter: windows(li, W, (j) => rec.cnt[j] * upt), b1r_counter: windows(li, W, (j) => rec.cnt[j] * uptR), c_model: windows(li, W, (j) => rec.model[j]), c_fit: windows(li, W, (j) => rec.units[j * 3] * cf[0] + rec.units[j * 3 + 1] * cf[1] + rec.units[j * 3 + 2] * cf[2]) };
      for (const m of methods) per[m].push({ abs: stats(tr.map((t, k) => Math.abs(est[m][k] - t) / (W * Q) * 1000)), bias: tr.reduce((a, t, k) => a + (est[m][k] - t) / (W * Q) * 1000, 0) / tr.length });
      if (W === 6) { L.truthMeanPermille += tr.reduce((a, t) => a + t, 0) / tr.length / (W * Q) * 1000 / RUNS; }
      if (W === 6) { let st = 0; for (let q = 0; q < QUANTA; q++) st += rec.truth[base(li) + q]; L.totalsCheck.push((sd - st) / (QUANTA * Q) * 1000); }
    }
    L.W[W] = Object.fromEntries(methods.map((m) => [m, summ(per[m])]));
  }
  for (let s = 0; s < 3; s++) {
    const W = 24, sm = ['a_dateNow', 'b1r_counter', 'c_model', 'c_fit'], per = Object.fromEntries(sm.map((m) => [m, []]));
    for (const r of all) {
      const rec = r.res.rec, ut = r.res.unitUs[s], cf = fits(rec, li)[s];
      let sd = 0, sc = 0; for (let q = 0; q < QUANTA; q++) { sd += rec.dnow[base(li) + q] * 1000; sc += rec.cnt[base(li) + q]; }
      const uptR = sc ? sd / sc : r.res.usPerTick;
      const tr = windows(li, W, (j) => rec.strue[j * 3 + s]);
      const est = { a_dateNow: windows(li, W, (j) => rec.sdn[j * 3 + s] * 1000), b1r_counter: windows(li, W, (j) => rec.scnt[j * 3 + s] * uptR), c_model: windows(li, W, (j) => rec.units[j * 3 + s] * ut), c_fit: windows(li, W, (j) => rec.units[j * 3 + s] * cf) };
      for (const m of sm) per[m].push({ abs: stats(tr.map((t, k) => Math.abs(est[m][k] - t) / (W * Q) * 1000)), bias: 0 });
    }
    L.sections[['voices', 'buses', 'spatial'][s]] = Object.fromEntries(sm.map((m) => [m, summ(per[m])]));
  }
}
out.playbackStatsLastRun = all[all.length - 1].playbackStats;
writeFileSync(join(here, 'results.json'), JSON.stringify(out, null, 1));
const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
for (const W of [6, 96]) {
  console.log(`\nabs error of the load estimate, permille of a quantum, window W=${W} quanta (${(W * Q / 1000).toFixed(0)} ms), median over ${RUNS} runs`);
  console.log('level(truth)   method        p50    p99   p99.9    max   bias');
  for (const l of LEVELS) for (const m of methods) { const e = out.levels[l].W[W][m]; console.log(`${(l * 100).toFixed(0).padStart(4)}% (${f(out.levels[l].truthMeanPermille).padStart(6)})  ${m.padEnd(12)} ${f(e.p50).padStart(6)} ${f(e.p99).padStart(6)} ${f(e.p999).padStart(6)} ${f(e.max).padStart(6)} ${f(e.bias).padStart(6)}`); }
}
console.log('\ntruth validated against Date.now level totals: (sum Date.now - sum spinner)/level time, permille, per run:'); for (const l of LEVELS) console.log(`${(l * 100).toFixed(0)}%`.padStart(5), out.levels[l].totalsCheck.map(f).join(' '));
console.log('\nDate.now p50 abs error (permille) vs window W (quanta):'); for (const l of LEVELS) console.log(`${(l * 100).toFixed(0)}%`.padStart(5), WINDOWS.map((W) => `W${W}:${f(out.levels[l].W[W].a_dateNow.p50)}`).join('  '));
console.log('\nsections at W=24, abs error permille of a quantum p50/p99 (a, counter-recal, model-cold, model-fit):');
for (const l of LEVELS.slice(1, 4)) for (const s of ['voices', 'buses', 'spatial']) { const e = out.levels[l].sections[s]; console.log(`${(l * 100).toFixed(0)}% ${s.padEnd(8)} ` + ['a_dateNow', 'b1r_counter', 'c_model', 'c_fit'].map((m) => `${m} ${f(e[m].p50)}/${f(e[m].p99)}`).join('  ')); }
console.log('\nclock read cost ns:', JSON.stringify(out.readCostNs), ' truth clock step us:', out.truthStepUs.map(f).join(' '), ' counter cal error % (vs truth clock):', out.calErrPct.map((x) => x.toFixed(2)).join(' '));
console.log('playbackStats (last run, at level boundaries; level 1.15 is last): ', JSON.stringify(out.playbackStatsLastRun.map((s) => s && { ev: s.underrunEvents, dur: +s.underrunDuration.toFixed(3) })));
