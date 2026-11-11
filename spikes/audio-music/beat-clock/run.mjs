// Beat-clock spike runner. Usage: node run.mjs [--runs 5] [--seconds 60] [--out results/run.json] [--keys 1]
// Each run: a fresh Chromium page, a real AudioContext (null sink, see README), the engine's ClockMap, a 60 Hz rAF loop.
import { chromium } from '/home/user/TranquilityEngine/node_modules/playwright-core/index.mjs';
import ts from '/home/user/TranquilityEngine/node_modules/typescript/lib/typescript.js';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = +arg('runs', 5), SECONDS = +arg('seconds', 60), KEYS = +arg('keys', 1);
const WINDOW_S = +arg('window', 4); // sliding-window fit half-width in seconds for the truth line (0 = one global fit per run)
const RAW = arg('raw', '0') === '1', FROM = arg('from', '');
const HINT = arg('hint', 'interactive'); // AudioContext latencyHint: 'interactive' | 'playback' | seconds (0 = the smallest the platform allows, the rhythm-mode setting)
const latencyHint = Number.isFinite(+HINT) ? +HINT : HINT;
const OUT = arg('out', join(here, 'results', `run-${SECONDS}s-${Date.now()}.json`));
const LIMITER_FRAMES = 66; // limiterLatencyFrames(44100, 1.5 ms), limiterLatency.ts:15-17 (the preset default)

// ---------- statistics
const pct = (s, p) => s.length ? s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1] : NaN;
const sorted = (a) => Float64Array.from(a).sort();
const median = (a) => pct(sorted(a), 0.5);
const std = (a) => { if (a.length < 2) return NaN; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const dist = (a) => { const s = sorted(a); return { n: a.length, min: s[0] ?? NaN, p01: pct(s, 0.01), p50: pct(s, 0.5), p99: pct(s, 0.99), p999: pct(s, 0.999), max: s[s.length - 1] ?? NaN }; };
const slope = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; } return sxy / sxx; };
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');

// ---------- the page server (COOP/COEP for SharedArrayBuffer)
function transpiled(file) {
  const src = readFileSync(join(ROOT, 'src/plugins/audio/runtime/core', file), 'utf8');
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from\s+["']\.\/lookahead["']/g, 'from "/ts/lookahead.js"');
}
const files = {
  '/ts/clock.js': ['text/javascript', transpiled('clock.ts')],
  '/ts/lookahead.js': ['text/javascript', transpiled('lookahead.ts')],
  '/tempo.js': ['text/javascript', readFileSync(join(here, 'harness/tempo.js'))],
  '/processor.js': ['text/javascript', readFileSync(join(here, 'harness/processor.js'))],
  '/clock.js': ['text/javascript', readFileSync(join(here, 'harness/clock.js'))],
  '/page.js': ['text/javascript', readFileSync(join(here, 'harness/page.js'))],
  '/': ['text/html', '<!doctype html><html><body>beat clock<script type="module" src="/page.js"></script></body></html>'],
};

// ---------- analysis of one run
function analyse(R) {
  { const keep = R.qt.map((t, i) => (t > 0 ? i : -1)).filter((i) => i >= 0); R.qf = keep.map((i) => R.qf[i]); R.qt = keep.map((i) => R.qt[i]); }
  const { sr, D } = R, E = (p) => R.timeOrigin + p;
  // truth: the audio clock as the worklet saw it, vs a wall clock (spinner), least squares over every quantum
  const n = R.qf.length, mf = R.qf.reduce((a, b) => a + b, 0) / n, mt = R.qt.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (R.qf[i] - mf) * (R.qt[i] - mt); sxx += (R.qf[i] - mf) ** 2; }
  const b = sxy / sxx, a = mt - b * mf;                       // ms per frame (global fit)
  const gE = (f) => a + b * f, gF = (t) => (t - a) / b;
  // Sliding fit: the audio clock vs the wall clock is not one straight line over 60 s on a VM (the global fit's
  // residual is ms-sized), so the truth line is refit over +-WINDOW_S around each frame (prefix sums).
  const f0 = R.qf[0], pf = [0], pt = [0], pff = [0], pft = [0];
  for (let i = 0; i < n; i++) { const x = R.qf[i] - f0, y = R.qt[i] - R.qt[0]; pf.push(pf[i] + x); pt.push(pt[i] + y); pff.push(pff[i] + x * x); pft.push(pft[i] + x * y); }
  const halfFrames = WINDOW_S * sr;
  const lowerBound = (v) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (R.qf[m] < v) lo = m + 1; else hi = m; } return lo; };
  const local = (f) => { // returns [slope, intercept] of qt = s*(qf-f0) + c near frame f
    const i0 = lowerBound(f - halfFrames), i1 = lowerBound(f + halfFrames);
    const m = i1 - i0; if (WINDOW_S <= 0 || m < 50) return [b, a + b * f0 - R.qt[0] + R.qt[0] - b * 0, null];
    const sx = pf[i1] - pf[i0], sy = pt[i1] - pt[i0], sxx2 = pff[i1] - pff[i0], sxy2 = pft[i1] - pft[i0];
    const s = (m * sxy2 - sx * sy) / (m * sxx2 - sx * sx), c = (sy - s * sx) / m;
    return [s, c, true];
  };
  const Etime = (f) => { if (WINDOW_S <= 0) return gE(f); const [s, c] = local(f); return R.qt[0] + c + s * (f - f0); };
  const frameAtE = (t) => { if (WINDOW_S <= 0) return gF(t); let f = gF(t); for (let k = 0; k < 3; k++) { const [s, c] = local(f); f = f0 + (t - R.qt[0] - c) / s; } return f; };
  const fitResid = R.qf.map((f, i) => R.qt[i] - gE(f));
  const slideResid = R.qf.map((f, i) => R.qt[i] - Etime(f));
  const out = { sr, D, baseLatency: R.baseLatency, outputLatency: R.outputLatency, fit: { msPerFrame: b, nominalMsPerFrame: 1000 / sr, ppm: (b * sr / 1000 - 1) * 1e6, residual_ms: dist(fitResid.map(Math.abs)), sliding_residual_ms: dist(slideResid.map(Math.abs)), window_s: WINDOW_S } };
  // frames
  const warmEnd = R.frames.p[0] + 1500;
  const idx = []; for (let i = 0; i < R.frames.p.length; i++) if (R.frames.p[i] >= warmEnd && Number.isFinite(R.frames.hot[i])) idx.push(i);
  const dts = []; for (let k = 1; k < R.frameP.length; k++) dts.push(R.frameP[k] - R.frameP[k - 1]);
  const delta = median(dts);
  out.frame = { intervalMs: delta, hz: 1000 / delta, long_frames_over_25ms: dts.filter((d) => d > 25).length, dts: dist(dts) };
  const K = median(idx.map((i) => E(R.frames.p[i]) - Etime(R.frames.hot[i])));
  out.K_ms = K; // heard = render-clock time + K (constant; includes the context's output path as Chromium reports it) [U]
  const hz = R.hitches.map((h) => [h.startEpoch - 50, h.startEpoch + h.ms + 1000]);
  const inHitch = (tE) => hz.some(([s, e]) => tE >= s && tE <= e);
  const trueHF = (p) => frameAtE(E(p) - K);
  const est = { ClockMap: R.frames.hcm, 'getOutputTimestamp (raw, per frame)': R.frames.hot, 'currentTime (raw, no latency comp.)': R.frames.hct };
  out.clock = {};
  const steady = idx.filter((i) => !inHitch(E(R.frames.p[i])));
  for (const [name, arr] of Object.entries(est)) {
    const e = (i) => ((arr[i] - trueHF(R.frames.p[i])) / sr) * 1000;
    const off = median(steady.map(e));
    const dev = steady.map((i) => e(i) - off);
    const jit = []; for (let k = 1; k < steady.length; k++) if (steady[k] === steady[k - 1] + 1) jit.push(e(steady[k]) - e(steady[k - 1]));
    out.clock[name] = {
      median_offset_ms: off, abs_dev_ms: dist(dev.map(Math.abs)), frame_to_frame_jitter_std_ms: std(jit), frame_to_frame_abs_p99_ms: dist(jit.map(Math.abs)).p99,
      drift_ms_per_min: slope(steady.map((i) => R.frames.p[i] / 60000), steady.map(e)),
    };
  }
  // ClockMap: monotonic? (Audio.time must not go backwards between frames)
  let back = 0, backMax = 0; for (let k = 1; k < idx.length; k++) { const d = R.frames.at[idx[k]] - R.frames.at[idx[k - 1]]; if (d < 0) { back++; backMax = Math.min(backMax, d); } }
  out.clock.ClockMap.backwards_steps = back; out.clock.ClockMap.worst_backwards_ms = backMax * 1000;
  out.clock.ClockMap.reanchors = R.cm.reanchors; out.clock.ClockMap.rejected = R.cm.rejected;
  // hitches: error of each estimator in the 12 frames after the long frame, and frames to settle within 1 ms of its steady offset
  out.hitch = R.hitches.map((h) => {
    const rec = {};
    const after = []; for (let i = 0; i < R.frames.p.length; i++) if (E(R.frames.p[i]) >= h.startEpoch + h.ms - 5) { after.push(i); if (after.length === 14) break; }
    for (const [name, arr] of Object.entries(est)) {
      const off = out.clock[name].median_offset_ms;
      const errs = after.map((i) => ((arr[i] - trueHF(R.frames.p[i])) / sr) * 1000 - off);
      let settle = errs.findIndex((x, k) => errs.slice(k).every((y) => Math.abs(y) < 1)); if (settle < 0) settle = '>14';
      rec[name] = { first_frame_err_ms: errs[0], worst_err_ms: errs.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0), frames_to_settle_1ms: settle };
    }
    return { hitch_ms: h.ms, ...rec };
  });

  // ---- beats
  const rendered = new Map(R.rendered.map(([id, nb, f]) => [id + ':' + nb, f]));
  const heardE = (f) => Etime(f + D) + K;
  const pE = R.frameP.map(E);
  const frameIndexAt = (tE) => { let lo = 0, hi = pE.length - 1; if (tE < pE[0]) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pE[m] <= tE) lo = m; else hi = m - 1; } return lo; };
  const pIndex = new Map(R.frameP.map((p, i) => [p, i]));
  const firstFrameOf = (id) => R.rendered.find(([i, nb]) => i === id && nb === 0)?.[2];
  const switchE = R.epochs.slice(1).map((e) => firstFrameOf(e.id)).filter((x) => x != null).map(heardE);
  const tailE = pE[pE.length - 1] - delta;
  const tempoWin = (id, nb) => id === R.epochs[0].id && nb >= R.tempoBeat - 2 && nb <= R.tempoBeat + 3;
  const bucketOf = (id, nb, tE) => (inHitch(tE) ? 'hitch' : switchE.some((s) => Math.abs(tE - s) < 1000) ? 'transition' : tempoWin(id, nb) ? 'tempo' : 'steady');
  out.beats = { rendered: rendered.size };
  for (const [design, list] of Object.entries(R.fired)) {
    const count = new Map(); for (const f of list) count.set(f.id + ':' + f.n, (count.get(f.id + ':' + f.n) || 0) + 1);
    const res = { fired: list.length, missed: 0, doubled: 0, phantom: 0 };
    const buckets = {};
    const bk = (k) => (buckets[k] ??= { offsets: {}, errs: [], leads: [], early: 0, late: 0, inwin: 0, n: 0 });
    for (const [key, f] of rendered) {
      const c = count.get(key) || 0; const [id, nb] = key.split(':').map(Number);
      const tE = heardE(f); if (tE > tailE) continue; // heard after the last frame: the run ended first
      const bucket = bucketOf(id, nb, tE);
      if (c === 0) { res.missed++; (res.missed_keys ??= []).push(key + '@' + ((heardE(f) - E(R.frameP[0])) / 1000).toFixed(2) + 's'); (res['missed_' + bucket] = (res['missed_' + bucket] || 0) + 1); continue; }
      if (c > 1) res.doubled++;
      const fe = list.find((x) => x.id === id && x.n === nb);
      const iFire = pIndex.get(fe.p), iIdeal = frameIndexAt(tE);
      const off = iFire - iIdeal; const lead = tE - E(fe.p);
      const B = bk(bucket); B.n++; B.offsets[off] = (B.offsets[off] || 0) + 1; B.leads.push(lead);
      const e = lead < 0 ? lead : lead > delta ? lead - delta : 0; B.errs.push(Math.abs(e)); if (lead < 0) B.late++; else if (lead > delta) B.early++; else B.inwin++;
    }
    for (const [key, c] of count) if (!rendered.has(key)) { res.phantom += c; (res.phantom_keys ??= []).push(key); const [id, nb] = key.split(':').map(Number); res.phantom_by_epoch = res.phantom_by_epoch || {}; res.phantom_by_epoch[id] = (res.phantom_by_epoch[id] || 0) + c; }
    res.buckets = Object.fromEntries(Object.entries(buckets).map(([k, B]) => [k, { n: B.n, frame_offset_hist: B.offsets, miss_window_err_ms: dist(B.errs), early: B.early, late: B.late, in_window: B.inwin, lead_ms: dist(B.leads), lead_std_ms: std(B.leads) }]));
    out.beats[design] = res;
  }
  // worklet-side facts
  out.core = { late_stamped_commands: R.late, statusCount: R.statusCount, status_period_ms: (R.qf.length * 128 / sr * 1000) / R.statusCount * 1, quanta: R.qf.length, switch_frames: { stampedS: R.epochs[1]?.S } };
  // arrival lead of design B's messages (render -> main): how long before the beat is HEARD does main learn of it
  for (const k of ['imm', 'status']) out.core['arrival_lead_ms_' + k] = dist(R.arrive[k].filter((r) => !inHitch(heardE(r.frame))).map((r) => heardE(r.frame) - E(r.arr)));
  // ---- input events (rhythm mode)
  const inpOut = {};
  for (const kind of ['synthetic', 'cdp']) {
    const list = R.inputs.filter((x) => x.kind === kind && x.ts >= warmEnd && !inHitch(E(x.ts)));
    if (!list.length) continue;
    const truth = (x) => (frameAtE(E(x.ts) - K) - D) / sr;
    const ev = (field) => dist(list.map((x) => Math.abs((x[field] - truth(x)) * 1000)));
    inpOut[kind] = { n: list.length, handler_delay_ms: dist(list.map((x) => x.now - x.ts)), 'ClockMap offset applied to event.timeStamp': ev('mapped'), 'Audio.time as of last frame': ev('stale'), 'raw getOutputTimestamp at the event': ev('raw') };
  }
  out.input = inpOut;
  return out;
}

// ---------- run
async function once(browser, port, i) {
  const pg = await browser.newPage();
  pg.on('console', (m) => console.error('[page]', m.text()));
  pg.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await pg.goto(`http://127.0.0.1:${port}/`);
  await pg.waitForFunction(() => window.__run);
  if (!(await pg.evaluate(() => self.crossOriginIsolated))) throw new Error('not cross-origin isolated');
  await pg.bringToFront();
  const hitches = [[0.1, 100], [0.2, 200], [0.35, 300]];
  const p = pg.evaluate((o) => window.__run(o), { durationS: SECONDS, limiterFrames: LIMITER_FRAMES, hitches, seed: 1234 + i, inputEvents: true, latencyHint });
  let live = true; p.finally(() => (live = false)).catch(() => {});
  if (KEYS) { await new Promise((r) => setTimeout(r, 2500)); while (live) { await pg.keyboard.press('a').catch(() => {}); await new Promise((r) => setTimeout(r, 400 + Math.random() * 100)); } }
  const raw = await p;
  await pg.close();
  if (RAW) { mkdirSync(join(here, 'results'), { recursive: true }); writeFileSync(join(here, 'results', `raw-${SECONDS}s-${Date.now()}-${i}.json`), JSON.stringify(raw)); }
  return analyse(raw);
}

let runs = [];
if (FROM) { runs = FROM.split(',').map((f) => analyse(JSON.parse(readFileSync(f, 'utf8')))); } else {
const exe = process.env.E2E_CHROMIUM || ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find(existsSync);
const srv = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const f = files[req.url.split('?')[0]]; if (!f) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', f[0]); res.end(f[1]);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const flags = (process.env.CHROMIUM_FLAGS || '--autoplay-policy=no-user-gesture-required').split(' ').filter(Boolean);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...flags] });
try {
  for (let i = 0; i < RUNS; i++) { const t = Date.now(); runs.push(await once(browser, port, i)); console.error(`run ${i + 1}/${RUNS} done in ${((Date.now() - t) / 1000).toFixed(0)} s`); }
} finally { await browser.close(); srv.close(); }

}
// ---------- report
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ seconds: SECONDS, runs }, null, 1));
const med = (f) => median(runs.map(f).filter(Number.isFinite));
const L = [];
L.push(`# beat-clock results: ${RUNS} runs x ${SECONDS} s, latencyHint ${HINT} (baseLatency ${f3(med((r) => r.baseLatency))} s, outputLatency ${f3(med((r) => r.outputLatency))} s), sr ${runs[0].sr}, limiter D = ${runs[0].D} frames, frame interval ${f3(med((r) => r.frame.intervalMs))} ms (${f3(med((r) => r.frame.hz))} Hz)`);
L.push(`\ntruth line: ${WINDOW_S > 0 ? `sliding fit +-${WINDOW_S} s` : 'one global fit'}; sliding-fit residual p99 ${f3(med((r) => r.fit.sliding_residual_ms.p99))} ms;`);
L.push(`\nrender-clock fit: ${f3(med((r) => r.fit.ppm))} ppm vs nominal, residual p99 ${f3(med((r) => r.fit.residual_ms.p99))} ms; K (heard minus render clock) median ${f3(med((r) => r.K_ms))} ms; STATUS period ${f3(med((r) => r.core.status_period_ms))} ms\n`);
L.push('## Q2 clock error vs the audio clock (ms; offset removed; steady frames; per run then median over runs)');
L.push('| estimator | const offset ms | p50 | p99 | p99.9 | max | f2f jitter std | f2f |d| p99 | drift ms/min |'); L.push('|---|---|---|---|---|---|---|---|---|');
for (const name of Object.keys(runs[0].clock)) {
  const g = (f) => f3(med((r) => f(r.clock[name])));
  L.push(`| ${name} | ${g((c) => c.median_offset_ms)} | ${g((c) => c.abs_dev_ms.p50)} | ${g((c) => c.abs_dev_ms.p99)} | ${g((c) => c.abs_dev_ms.p999)} | ${g((c) => c.abs_dev_ms.max)} | ${g((c) => c.frame_to_frame_jitter_std_ms)} | ${g((c) => c.frame_to_frame_abs_p99_ms)} | ${g((c) => c.drift_ms_per_min)} |`);
}
L.push(`\nClockMap backwards steps per run: ${runs.map((r) => r.clock.ClockMap.backwards_steps).join(', ')}; reanchors: ${runs.map((r) => r.clock.ClockMap.reanchors).join(', ')}; rejected: ${runs.map((r) => r.clock.ClockMap.rejected).join(', ')}`);
L.push('\n## Q2 hitches (error in the first frame after the long frame / worst in 14 frames / frames to settle within 1 ms; median over runs)');
L.push('| hitch | estimator | first ms | worst ms | settle frames |'); L.push('|---|---|---|---|---|');
for (let h = 0; h < runs[0].hitch.length; h++) for (const name of Object.keys(runs[0].clock)) {
  const g = (f) => f3(med((r) => f(r.hitch[h][name])));
  L.push(`| ${runs[0].hitch[h].hitch_ms} ms | ${name} | ${g((x) => x.first_frame_err_ms)} | ${g((x) => x.worst_err_ms)} | ${g((x) => (typeof x.frames_to_settle_1ms === 'number' ? x.frames_to_settle_1ms : 15))} |`);
}
L.push('\n## Q1 beat callbacks: error vs the ideal frame (|distance| of the callback frame start from the "window" (0, frame interval] before the beat is heard; ms)');
L.push('| design | bucket | beats/run | in-window | early | late | off=0 | off=-1 | off=+1 | other | |err| p50 | p99 | p99.9 | max | lead std |'); L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const design of Object.keys(runs[0].beats).filter((k) => k !== 'rendered')) for (const bucket of ['steady', 'tempo', 'transition', 'hitch']) {
  const bs = runs.map((r) => r.beats[design].buckets[bucket]).filter(Boolean); if (!bs.length) continue;
  const sum = (f) => bs.reduce((a, b) => a + f(b), 0) / runs.length;
  const h = (o) => sum((b) => b.frame_offset_hist[o] || 0);
  const other = sum((b) => Object.entries(b.frame_offset_hist).filter(([k]) => !['0', '-1', '1'].includes(k)).reduce((a, [, v]) => a + v, 0));
  const pooled = dist(bs.flatMap((b) => []));
  const m = (f) => f3(median(bs.map(f)));
  L.push(`| ${design} | ${bucket} | ${f3(sum((b) => b.n))} | ${f3(sum((b) => b.in_window))} | ${f3(sum((b) => b.early))} | ${f3(sum((b) => b.late))} | ${f3(h(0))} | ${f3(h(-1))} | ${f3(h(1))} | ${f3(other)} | ${m((b) => b.miss_window_err_ms.p50)} | ${m((b) => b.miss_window_err_ms.p99)} | ${m((b) => b.miss_window_err_ms.p999)} | ${m((b) => b.miss_window_err_ms.max)} | ${m((b) => b.lead_std_ms)} |`);
}
L.push('\n(counts are means per run; "early" = callback ran more than one frame before the beat was heard, "late" = after it was heard)');
L.push('\n## Q1 missed / doubled / phantom beats per run (per run; epochs: tempo change 120 -> 90 BPM, one stamped bar transition, 8 asap seeks)');
L.push('| design | fired | missed | doubled | phantom (fired, never rendered) | missed in transition | missed in hitch |'); L.push('|---|---|---|---|---|---|---|');
for (const design of Object.keys(runs[0].beats).filter((k) => k !== 'rendered')) {
  const s = (f) => runs.map((r) => f(r.beats[design])).join(' / ');
  L.push(`| ${design} | ${s((b) => b.fired)} | ${s((b) => b.missed)} | ${s((b) => b.doubled)} | ${s((b) => b.phantom)} | ${s((b) => b.missed_transition || 0)} | ${s((b) => b.missed_hitch || 0)} |`);
}
L.push(`\nkeys (run 1, design A) missed: ${JSON.stringify(runs[0].beats.A.missed_keys ?? [])} phantom: ${JSON.stringify(runs[0].beats.A.phantom_keys ?? [])}`);
L.push(`\nrendered beats per run: ${runs.map((r) => r.beats.rendered).join(', ')}; stamped commands that arrived late: ${runs.map((r) => r.core.late_stamped_commands).join(', ')}`);
L.push('\n## Q1 arrival lead of design B messages (ms the beat is still in the future when main learns of it; negative = already heard)');
L.push('| channel | p50 | p1 | min |'); L.push('|---|---|---|---|');
for (const k of ['imm', 'status']) { const g = (f) => f3(med((r) => f(r.core['arrival_lead_ms_' + k]))); L.push(`| ${k === 'imm' ? 'immediate port message' : 'in STATUS (every 6 quanta)'} | ${g((x) => x.p50)} | ${g((x) => x.p01)} | ${g((x) => x.min)} |`); }
L.push('\n## Q5 input mapping error vs the audio clock (ms, abs; median over runs)');
L.push('| events | mapping | n/run | p50 | p99 | p99.9 | max |'); L.push('|---|---|---|---|---|---|---|');
for (const kind of ['synthetic', 'cdp']) {
  const have = runs.filter((r) => r.input[kind]); if (!have.length) continue;
  for (const m of ['ClockMap offset applied to event.timeStamp', 'Audio.time as of last frame', 'raw getOutputTimestamp at the event']) {
    const g = (f) => f3(median(have.map((r) => f(r.input[kind][m]))));
    L.push(`| ${kind} | ${m} | ${f3(median(have.map((r) => r.input[kind].handler_delay_ms.n)))} | ${g((x) => x.p50)} | ${g((x) => x.p99)} | ${g((x) => x.p999)} | ${g((x) => x.max)} |`);
  }
  L.push(`| ${kind} | handler delay (now - event.timeStamp) | | ${f3(median(have.map((r) => r.input[kind].handler_delay_ms.p50)))} | ${f3(median(have.map((r) => r.input[kind].handler_delay_ms.p99)))} | | ${f3(median(have.map((r) => r.input[kind].handler_delay_ms.max)))} |`);
}
const text = L.join('\n') + '\n';
writeFileSync(OUT.replace(/\.json$/, '.md'), text);
console.log(text);
