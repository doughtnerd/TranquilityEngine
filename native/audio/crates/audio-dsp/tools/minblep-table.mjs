#!/usr/bin/env node
// Writes `src/gen/minblep_table.rs`: the generators' `high` quality band-limiting tables (D67, owner: "Make it a
// setting"). Run from this crate's directory: `node tools/minblep-table.mjs`. No dependencies.
//
// The kernel: a Kaiser-windowed sinc (cut-off FC of the rate, Kaiser BETA, ZERO_CROSSINGS each side), designed at Q
// points a sample, made minimum phase by the real cepstrum (so the band-limiting has almost no latency), then shifted
// right by a fraction of a sample so its centroid is a whole number of samples, DELAY. The oscillator reads its naive
// waveform DELAY samples late through the same ring the residuals go into, so both residuals return to 0 inside the
// table and the step's jump falls on a whole tap (exact whatever the rounding of the phase).
//
// The tables, PHASES + 1 rows of TAPS taps, row j at s = k + j / PHASES samples after the discontinuity (tap k):
// - STEP[j][k] = S(s) − [k ≥ DELAY], S the band-limited unit step: a unit jump's residual;
// - RAMP[j][k] = ∫S(s) − max(0, s − DELAY): the residual of a unit change of slope per sample (a corner), less the
//   integration's constant tail error taken out with a band-limited step so it too ends at 0.
// The oscillator interpolates linearly between rows j and j + 1.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ZERO_CROSSINGS = 8;
const TAPS = 2 * ZERO_CROSSINGS;
const PHASES = 32;
const FC = 0.4;
const BETA = 6;
const Q = 64;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-17 * sum) break;
  }
  return sum;
}

/** In-place iterative radix-2 FFT of (re, im); `inverse` scales by 1/n. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k);
        const wi = Math.sin(a * k);
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - xr;
        im[i + k + len / 2] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

/** The minimum-phase version of `h` (same magnitude response), by folding its real cepstrum. */
function minimumPhase(h) {
  let nfft = 1;
  while (nfft < 16 * h.length) nfft <<= 1;
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  re.set(h);
  fft(re, im, false);
  for (let i = 0; i < nfft; i++) {
    re[i] = Math.log(Math.max(Math.hypot(re[i], im[i]), 1e-14));
    im[i] = 0;
  }
  fft(re, im, true);
  for (let i = 0; i < nfft; i++) {
    const w = i === 0 || i === nfft / 2 ? 1 : i < nfft / 2 ? 2 : 0;
    re[i] *= w;
    im[i] = 0;
  }
  fft(re, im, false);
  for (let i = 0; i < nfft; i++) {
    const m = Math.exp(re[i]);
    [re[i], im[i]] = [m * Math.cos(im[i]), m * Math.sin(im[i])];
  }
  fft(re, im, true);
  return Array.from(re.subarray(0, h.length));
}

/** Linear interpolation of (xs, ys) at x, held at `left` / `right` outside. */
function interp(x, xs, ys, left, right) {
  if (x <= xs[0]) return left ?? ys[0];
  if (x >= xs[xs.length - 1]) return right ?? ys[ys.length - 1];
  const step = xs[1] - xs[0];
  const i = Math.min(Math.floor((x - xs[0]) / step), xs.length - 2);
  const f = (x - xs[i]) / step;
  return ys[i] + f * (ys[i + 1] - ys[i]);
}

const n = 2 * ZERO_CROSSINGS * Q + 1;
let h = [];
for (let i = 0; i < n; i++) {
  const t = (i - ZERO_CROSSINGS * Q) / Q;
  const x = 2 * FC * t;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  const r = (2 * i) / (n - 1) - 1;
  h.push(2 * FC * sinc * (besselI0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(BETA)));
}
let sum = h.reduce((a, b) => a + b, 0);
h = minimumPhase(h.map((v) => v / sum));
sum = h.reduce((a, b) => a + b, 0);
h = h.map((v) => v / sum);
const tt = h.map((_, i) => i / Q);
const centroid = h.reduce((a, v, i) => a + v * tt[i], 0);
const DELAY = Math.ceil(centroid);
const shift = DELAY - centroid;
const stepAt = [];
let acc = 0;
for (const v of h) stepAt.push((acc += v));
const S = (s) => interp(s - shift, tt, stepAt, 0, 1);
const fine = [];
for (let s = 0; s <= TAPS + 2; s += 1 / Q) fine.push(s);
const ramp = [0];
for (let i = 1; i < fine.length; i++) ramp.push(ramp[i - 1] + (S(fine[i]) + S(fine[i - 1])) / (2 * Q));
const R = (s) => interp(s, fine, ramp);

const step = [];
const corner = [];
for (let j = 0; j <= PHASES; j++) {
  const rs = [];
  const rr = [];
  for (let k = 0; k < TAPS; k++) {
    const s = k + j / PHASES;
    rs.push(S(s) - (k >= DELAY ? 1 : 0));
    rr.push(R(s) - Math.max(0, s - DELAY));
  }
  step.push(rs);
  corner.push(rr);
}
const tail = corner.reduce((a, row) => a + row[TAPS - 1], 0) / corner.length;
for (let j = 0; j <= PHASES; j++) for (let k = 0; k < TAPS; k++) corner[j][k] -= tail * S(k + j / PHASES);

const f32 = (v) => {
  const x = Math.fround(v);
  return Object.is(x, -0) || x === 0 ? "0.0" : x.toExponential(8).replace("e+0", "e0").replace("e+", "e");
};
const rows = (t) => t.map((row) => `    [${row.map(f32).join(", ")}],`).join("\n");
const out = `// Generated by \`node tools/minblep-table.mjs\` (audio-dsp): do not edit. The generators' \`high\` quality tables (D67): a
// ${TAPS}-tap minimum-phase band-limited step from a Kaiser-windowed sinc (cut-off ${FC} of the rate, beta ${BETA}), its centroid shifted
// to ${DELAY} samples; ${PHASES + 1} rows of the step's and the ramp's residuals (see the script).

/// Taps of a residual (samples after the discontinuity).
pub const TAPS: usize = ${TAPS};
/// Rows between two taps (the residual's fractional position, read with linear interpolation).
pub const PHASES: usize = ${PHASES};
/// Samples the naive waveform is read late (the kernel's centroid).
pub const DELAY: usize = ${DELAY};

/// A unit jump's residual: \`STEP[j][k]\` at \`k + j / PHASES\` samples after the jump.
#[rustfmt::skip]
pub static STEP: [[f32; TAPS]; PHASES + 1] = [
${rows(step)}
];

/// A unit change of slope per sample's residual (a corner): \`RAMP[j][k]\` at \`k + j / PHASES\` samples after it.
#[rustfmt::skip]
pub static RAMP: [[f32; TAPS]; PHASES + 1] = [
${rows(corner)}
];
`;
writeFileSync(fileURLToPath(new URL("../src/gen/minblep_table.rs", import.meta.url)), out);
console.log(`minblep_table.rs: ${TAPS} taps, ${PHASES + 1} rows, delay ${DELAY} (centroid ${centroid.toFixed(3)}), step tail ${Math.max(...step.map((r) => Math.abs(r[TAPS - 1]))).toExponential(1)}`);
