// Procedural WAV sound effects for King of Pirates (mono, 16-bit, 22.05 kHz). Each returns a Buffer.
import { SAMPLE_RATE as R, encodeWav, rng } from "./lib.mjs";

const TAU = Math.PI * 2;
const samples = (seconds, fn) => Float32Array.from({ length: Math.round(seconds * R) }, (_, i) => fn(i / R, i));
const env = (t, attack, decay) => Math.min(1, t / attack) * Math.exp(-t / decay);

/** One-pole low-pass over noise from `next`, cutoff in Hz (sweepable through fn). */
function lowpass(cutoff) {
  let y = 0;
  return (x, c = cutoff) => {
    const a = 1 - Math.exp((-TAU * c) / R);
    y += a * (x - y);
    return y;
  };
}
function highpass(cutoff) {
  const lp = lowpass(cutoff);
  return (x) => x - lp(x);
}
const normalize = (arr, peak = 0.9) => {
  const m = arr.reduce((a, v) => Math.max(a, Math.abs(v)), 0) || 1;
  return arr.map((v) => (v / m) * peak);
};
/** Makes a seamless loop: the last `fade` seconds fade into the start's lead-in. */
function loopable(gen, seconds, fade = 0.5) {
  const n = Math.round(seconds * R);
  const f = Math.round(fade * R);
  const raw = gen(seconds + fade);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i];
  for (let i = 0; i < f; i++) {
    const t = i / f;
    out[i] = raw[i] * t + raw[n + i] * (1 - t);
  }
  return out;
}

function cannon() {
  const r = rng(101);
  const lp = lowpass(900);
  const lp2 = lowpass(200);
  return normalize(
    samples(1.1, (t) => {
      const noise = r() * 2 - 1;
      const boom = lp(noise, 2500 * Math.exp(-t * 9) + 150) * 1.6 * env(t, 0.002, 0.18);
      const thump = Math.sin(TAU * (45 + 90 * Math.exp(-t * 14)) * t) * env(t, 0.004, 0.25);
      const rumble = lp2(noise) * 2.5 * env(t, 0.02, 0.45);
      const crack = noise * env(t, 0.0005, 0.012) * 0.8;
      return boom + thump * 1.2 + rumble + crack;
    }),
    0.95,
  );
}

function splash() {
  const r = rng(102);
  const bp = lowpass(3000);
  const hp = highpass(500);
  const bubbles = Array.from({ length: 14 }, () => ({ t0: 0.05 + r() * 0.5, f: 500 + r() * 900, a: 0.1 + r() * 0.2 }));
  return normalize(
    samples(0.9, (t) => {
      const noise = r() * 2 - 1;
      const swell = hp(bp(noise, 600 + 3500 * Math.exp(-t * 6))) * env(t, 0.015, 0.2);
      let drops = 0;
      for (const b of bubbles) if (t > b.t0) drops += Math.sin(TAU * b.f * (1 + (t - b.t0) * 6) * (t - b.t0)) * Math.exp(-(t - b.t0) * 35) * b.a;
      return swell * 1.4 + drops;
    }),
    0.85,
  );
}

function crunch() {
  const r = rng(103);
  const lp = lowpass(2200);
  const hits = Array.from({ length: 9 }, (_, i) => ({ t0: i === 0 ? 0 : 0.02 + r() * 0.28, a: i === 0 ? 1 : 0.2 + r() * 0.5, f: 90 + r() * 140 }));
  return normalize(
    samples(0.6, (t) => {
      let s = 0;
      for (const h of hits) {
        const u = t - h.t0;
        if (u < 0) continue;
        s += (lp(r() * 2 - 1, 3500) * 0.8 + Math.sin(TAU * h.f * u) * 0.7) * Math.exp(-u / 0.035) * h.a;
      }
      return s;
    }),
    0.9,
  );
}

function thunder() {
  const r = rng(104);
  const lp = lowpass(180);
  const lp2 = lowpass(60);
  const bursts = Array.from({ length: 7 }, (_, i) => ({ t0: 0.15 + i * 0.28 + r() * 0.2, a: 0.4 + r() * 0.6, d: 0.4 + r() * 0.5 }));
  return normalize(
    samples(3.6, (t) => {
      const noise = r() * 2 - 1;
      let e = env(t, 0.05, 1.1) * 0.5;
      for (const b of bursts) if (t > b.t0) e += Math.exp(-(t - b.t0) / b.d) * b.a * 0.5;
      const crack = noise * env(t, 0.001, 0.03);
      return (lp(noise, 300 * Math.exp(-t * 0.6) + 80) * 3 + lp2(noise) * 4) * e + crack * 0.5;
    }),
    0.95,
  );
}

function rain() {
  return normalize(
    loopable(
      (sec) => {
        const r = rng(105);
        const hp = highpass(1800);
        const lp = lowpass(9000);
        const drops = Array.from({ length: Math.round(sec * 90) }, () => ({ t0: r() * sec, f: 2500 + r() * 3000, a: 0.1 + r() * 0.3 }));
        const arr = samples(sec, (t) => lp(hp(r() * 2 - 1)) * 0.5);
        for (const d of drops) {
          const i0 = Math.floor(d.t0 * R);
          for (let k = 0; k < 220 && i0 + k < arr.length; k++) arr[i0 + k] += Math.sin(TAU * d.f * (k / R)) * Math.exp(-k / 40) * d.a;
        }
        return arr;
      },
      4,
      0.5,
    ),
    0.6,
  );
}

function ocean() {
  const dur = 8;
  return normalize(
    loopable(
      (sec) => {
        const r = rng(106);
        const lp = lowpass(500);
        const lp2 = lowpass(1800);
        // wave swells: sine periods that divide the 8 s loop, so the envelope repeats exactly
        return samples(sec, (t) => {
          const swell = 0.5 + 0.5 * Math.sin(TAU * (t / dur) * 1 - 1) * 0.6 + 0.3 * Math.sin(TAU * (t / dur) * 3 + 0.7) + 0.2 * Math.sin(TAU * (t / dur) * 5 + 2);
          const n = r() * 2 - 1;
          return lp(n, 250 + 600 * swell) * 2 * swell + lp2(n) * 0.35 * swell * swell + Math.sin(TAU * 55 * t) * 0.03;
        });
      },
      dur,
      0.75,
    ),
    0.55,
  );
}

const note = (t, f, t0, d, a = 1) => (t < t0 ? 0 : Math.sin(TAU * f * (t - t0)) * 0.7 * a * env(t - t0, 0.005, d) + Math.sin(TAU * f * 2 * (t - t0)) * 0.2 * a * env(t - t0, 0.005, d * 0.6));

function pickup() {
  const fs = [659.25, 830.61, 987.77, 1318.5];
  return normalize(samples(0.7, (t) => fs.reduce((s, f, i) => s + note(t, f, i * 0.07, 0.18), 0)), 0.8);
}

function flagCapture() {
  const seq = [[392, 0], [523.25, 0.14], [659.25, 0.28], [783.99, 0.42], [1046.5, 0.62]];
  return normalize(
    samples(1.5, (t) => {
      let s = seq.reduce((a, [f, t0], i) => a + note(t, f, t0, i === 4 ? 0.5 : 0.16), 0);
      s += note(t, 261.63, 0.62, 0.6, 0.6) + note(t, 329.63, 0.62, 0.6, 0.5); // held chord under the last note
      return s;
    }),
    0.85,
  );
}

function uiClick() {
  const r = rng(107);
  return normalize(samples(0.06, (t) => (Math.sin(TAU * 1800 * t) * 0.7 + (r() * 2 - 1) * 0.3) * env(t, 0.0008, 0.008)), 0.6);
}

export function makeAudio() {
  const clips = {
    "cannon_fire.wav": cannon(),
    "cannonball_splash.wav": splash(),
    "wood_crunch.wav": crunch(),
    "thunder.wav": thunder(),
    "rain_loop.wav": rain(),
    "ocean_loop.wav": ocean(),
    "powerup_pickup.wav": pickup(),
    "flag_capture.wav": flagCapture(),
    "ui_click.wav": uiClick(),
  };
  return Object.fromEntries(Object.entries(clips).map(([k, v]) => [k, encodeWav(v)]));
}
