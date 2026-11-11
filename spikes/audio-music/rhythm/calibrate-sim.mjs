// Monte-Carlo of the tap-to-beat estimator: true offset O ms, tap noise sd (human ~ 15-25 ms), 10% early/late outliers,
// first taps discarded, estimate = median vs mean vs MAD-trimmed median. Reports p50/p95 abs error over 5000 trials per N.
let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const med = (a) => { const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
function trial(N, O, sd, outl) {
  const x = [];
  for (let i = 0; i < N + 4; i++) { let e = O + gauss() * sd * (i < 4 ? 2 : 1); if (rnd() < outl) e += (rnd() < 0.5 ? -1 : 1) * (150 + rnd() * 250); x.push(e); }
  const t = x.slice(4); // drop first 4 taps (settling in)
  const m = med(t), mad = med(t.map((v) => Math.abs(v - m))) * 1.4826 || 1;
  const kept = t.filter((v) => Math.abs(v - m) <= 2.5 * mad);
  return { mean: t.reduce((a, b) => a + b) / t.length, median: m, trimmed: med(kept) };
}
console.log("N taps | sd | outl | abs error ms p50/p95: mean | median | MAD-trimmed median");
for (const sd of [15, 25]) for (const outl of [0, 0.1]) for (const N of [8, 16, 32, 64]) {
  const err = { mean: [], median: [], trimmed: [] };
  for (let k = 0; k < 5000; k++) { const r = trial(N, 40, sd, outl); for (const key in err) err[key].push(Math.abs(r[key] - 40)); }
  const f = (a) => `${q(a, .5).toFixed(1)}/${q(a, .95).toFixed(1)}`;
  console.log(`${String(N).padStart(3)} | ${sd} | ${outl} | ${f(err.mean)} | ${f(err.median)} | ${f(err.trimmed)}`);
}
