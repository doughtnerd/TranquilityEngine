// K1 (M4c): turn the confirming run's raw data into the beat clock's recorded jitter trace fixture.
//
//   node extract-trace.mjs [results/raw-60s-1794422585250-0.json] [out.json]
//
// The raw run (`run.mjs --raw 1`) saved, per display frame, the rAF time `p` and the heard frame from Chromium's
// `getOutputTimestamp` (`hot`), plus every quantum's render frame against a spinning wall clock (`qf`, `qt`). This keeps
// what the engine's ClockMap reads (p, hot) and the truth: the frame actually heard at p, from the same sliding +-4 s
// fit `run.mjs` uses (`analyse`), with its constant K. The scenario (stamped start, tempo change, stamped bar
// transition, 8 asap seeks learned from STATUS, 3 hitches) is kept as the times main learned each change.
//
// Encoding (integers, to keep the file small): p in 5 us steps (the rAF clock's resolution here) as deltas from p0;
// hot in 1/100 frame as deltas from hot0; truth as (true heard frame - hot) in 1/100 frame.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? join(here, 'results/raw-60s-1794422585250-0.json');
const out = process.argv[3] ?? join(here, '../../../src/plugins/audio/runtime/music/testing/traces/s3-interactive-60s.json');
const R = JSON.parse(readFileSync(src, 'utf8'));
const WINDOW_S = 4;

// --- the truth fit, as run.mjs `analyse` (sliding window over the quantum stamps)
{ const keep = R.qt.map((t, i) => (t > 0 ? i : -1)).filter((i) => i >= 0); R.qf = keep.map((i) => R.qf[i]); R.qt = keep.map((i) => R.qt[i]); }
const { sr, D } = R, E = (p) => R.timeOrigin + p;
const n = R.qf.length, mf = R.qf.reduce((a, b) => a + b, 0) / n, mt = R.qt.reduce((a, b) => a + b, 0) / n;
let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (R.qf[i] - mf) * (R.qt[i] - mt); sxx += (R.qf[i] - mf) ** 2; }
const b = sxy / sxx, a = mt - b * mf;
const gF = (t) => (t - a) / b;
const f0 = R.qf[0], pf = [0], pt = [0], pff = [0], pft = [0];
for (let i = 0; i < n; i++) { const x = R.qf[i] - f0, y = R.qt[i] - R.qt[0]; pf.push(pf[i] + x); pt.push(pt[i] + y); pff.push(pff[i] + x * x); pft.push(pft[i] + x * y); }
const halfFrames = WINDOW_S * sr;
const lowerBound = (v) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (R.qf[m] < v) lo = m + 1; else hi = m; } return lo; };
const local = (f) => {
  const i0 = lowerBound(f - halfFrames), i1 = lowerBound(f + halfFrames), m = i1 - i0;
  const sx = pf[i1] - pf[i0], sy = pt[i1] - pt[i0], sxx2 = pff[i1] - pff[i0], sxy2 = pft[i1] - pft[i0];
  const s = (m * sxy2 - sx * sy) / (m * sxx2 - sx * sx), c = (sy - s * sx) / m;
  return [s, c];
};
const Etime = (f) => { const [s, c] = local(f); return R.qt[0] + c + s * (f - f0); };
const frameAtE = (t) => { let f = gF(t); for (let k = 0; k < 3; k++) { const [s, c] = local(f); f = f0 + (t - R.qt[0] - c) / s; } return f; };
const warmEnd = R.frames.p[0] + 1500;
const idx = []; for (let i = 0; i < R.frames.p.length; i++) if (R.frames.p[i] >= warmEnd && Number.isFinite(R.frames.hot[i])) idx.push(i);
const sortedMedian = (xs) => { const s = Float64Array.from(xs).sort(); return s[Math.max(1, Math.ceil(0.5 * s.length)) - 1]; };
const K = sortedMedian(idx.map((i) => E(R.frames.p[i]) - Etime(R.frames.hot[i])));
const trueHF = (p) => frameAtE(E(p) - K);

// --- encode
const P = R.frames.p, H = R.frames.hot;
const p0 = P[0], hot0 = H[0];
const dp = [], dh = [], truth = [];
let pq = 0, hq = 0;
for (let i = 0; i < P.length; i++) {
  const pi = Math.round((P[i] - p0) / 0.005), hi = Math.round((H[i] - hot0) * 100);
  dp.push(pi - pq); dh.push(hi - hq); pq = pi; hq = hi;
  truth.push(Math.round((trueHF(P[i]) - (hot0 + hi / 100)) * 100));
}
const at = (name) => R.log.filter((l) => l[0] === name);
const known = new Map();
for (const [, p, x] of at('start-stamped')) known.set(x.id, p);
for (const [, p, x] of at('transition-stamped-at-bar')) known.set(x.id, p);
for (const [, p, x] of at('asap-confirmed')) known.set(x.id, p);
const fixture = {
  about: 'Recorded jitter trace (ADR 0166 S3 confirming run, headless Chromium null sink, interactive latency, idle machine). Made by spikes/audio-music/beat-clock/extract-trace.mjs; see its header for the encoding.',
  source: 'spikes/audio-music/beat-clock/results/raw-60s-1794422585250-0.json',
  sr, limiterFrames: D, tempoBeat: R.tempoBeat, K_ms: K, windowS: WINDOW_S,
  p0, hot0, dp, dh, truth,
  epochs: R.epochs.map((e) => ({ id: e.id, S: e.S, bpm0: e.bpm0, knownAt: known.get(e.id) })),
  hitches: R.hitches.map((h) => ({ p: h.startEpoch - R.timeOrigin, ms: h.ms })),
  rendered: R.rendered,
};
writeFileSync(out, JSON.stringify(fixture));
console.log(`wrote ${out}: ${P.length} frames, K ${K.toFixed(3)} ms`);
