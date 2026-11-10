// Generates the Sound Lab's test clips into ../audio (mono, 16-bit PCM, 48 kHz unless a clip says otherwise).
// Deterministic: the noise uses seeded generators, so a rerun rewrites byte-identical files. The clips after the
// burst serve the listening pass (docs/design/0157-audio-core/listening-pass.md).
//
//   node samples/sound-lab/tools/makeTones.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 48000;
const TAU = Math.PI * 2;
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "audio");

/** `loop` = [startFrame, endFrame] (inclusive end, as a WAV `smpl` loop wants it) adds a `smpl` chunk with one forward loop. */
function wav(samples, rate = RATE, loop) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  if (!loop) return Buffer.concat([h, data]);
  const smpl = Buffer.alloc(8 + 60);
  smpl.write("smpl", 0);
  smpl.writeUInt32LE(60, 4);
  smpl.writeUInt32LE(Math.round(1e9 / rate), 8 + 8); // sample period, ns
  smpl.writeUInt32LE(60, 8 + 12); // MIDI unity note
  smpl.writeUInt32LE(1, 8 + 28); // one loop
  smpl.writeUInt32LE(loop[0], 8 + 44); // start (cue id 0, type 0: forward)
  smpl.writeUInt32LE(loop[1], 8 + 48); // end, inclusive
  h.writeUInt32LE(36 + data.length + smpl.length, 4);
  return Buffer.concat([h, data, smpl]);
}
const make = (seconds, fn, rate = RATE) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => fn(i / rate, i));
/** Seeded noise in -1..1 (mulberry32). */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}
/** A band-limited sawtooth: the harmonics of `hz` below `top` Hz and below the rate's Nyquist. */
function saw(hz, t, top, rate) {
  let s = 0;
  for (let k = 1; k * hz < Math.min(top, rate / 2); k++) s += Math.sin(TAU * k * hz * t) / k;
  return (2 / Math.PI) * s;
}

const noise = rng(1);
const noise2 = rng(2);
let lp = 0;
const clips = {
  // Whole numbers of cycles in the clip, so both loops repeat without a click.
  "music-loop.wav": make(1, (t) => 0.22 * (Math.sin(TAU * 220 * t) + Math.sin(TAU * 330 * t) + Math.sin(TAU * 440 * t))),
  "hum-loop.wav": make(0.5, (t) => 0.5 * Math.sin(TAU * 600 * t)),
  // A short pitched beep with a quick fade in and out.
  "beep.wav": make(0.25, (t) => 0.6 * Math.sin(TAU * 880 * t) * Math.min(1, t / 0.005, (0.25 - t) / 0.02)),
  // A 3 ms click.
  "click.wav": make(0.05, (t) => (t < 0.003 ? 0.9 * Math.sin(TAU * 2000 * t) * (1 - t / 0.003) : 0)),
  // A loud decaying noise burst, to push the SFX compressor.
  "burst.wav": make(0.3, (t) => 0.95 * noise() * Math.exp(-t / 0.08)),
  // Listening pass: a band-limited 220 Hz sawtooth (harmonics up to 20 kHz) with 10 ms fades, bright enough that
  // pitching it up folds partials past Nyquist audibly (the 4-point resampler's accepted aliasing).
  "bright.wav": make(1, (t) => 0.3 * saw(220, t, 20000, RATE) * Math.min(1, t / 0.01, (1 - t) / 0.01)),
  // Listening pass: a near-full-scale 220 Hz sine with a 1 ms attack; eight stacked at once go about 18 dB over.
  "loud.wav": make(1, (t) => 0.98 * Math.sin(TAU * 220 * t) * Math.min(1, t / 0.001, (1 - t) / 0.01)),
  // Listening pass: broadband noise (white, gently low-passed) for HRTF; a loop seam in noise is inaudible.
  "noise-loop.wav": make(1, () => {
    lp = 0.6 * lp + 0.4 * noise2();
    return 0.45 * lp;
  }),
};

// Listening pass: a melody in a 24 kHz file that streams (its import settings say so). Eight half-second notes
// rising, so a seek, a gap or a repeat shows where it lands; each note starts and ends at zero, so the loop is clean.
const NOTES = [262, 294, 330, 392, 440, 523, 587, 659];
const melody = make(
  4,
  (t) => {
    const n = Math.min(NOTES.length - 1, Math.floor(t / 0.5));
    const u = t - n * 0.5;
    const env = Math.min(1, u / 0.005, Math.max(0, 0.5 - u) / 0.03) * Math.exp(-u * 3);
    return 0.5 * env * saw(NOTES[n], t, 6000, 24000);
  },
  24000,
);

mkdirSync(out, { recursive: true });
const files = [...Object.entries(clips).map(([name, samples]) => [name, wav(samples)]), ["melody-loop.wav", wav(melody, 24000)]];
for (const [name, file] of files) {
  writeFileSync(join(out, name), file);
  console.log(`${name}  ${file.length} bytes`);
}

// --- Events page (ADR 0158 §8): clips for ../audio/events, played by its *.audioevent.json files -------------------------
// Footsteps on four surfaces (three variants each), engine loops at three RPMs with authored loop regions, an engine start,
// an engine-off tail, a one-clip engine with its own run-up and spin-down, and three music layers that share one 4 s loop.
// All synthesised from seeded noise and sines: no recordings, nothing to license.
const ev = {};
/** One-pole low-pass and high-pass. */
function lpf(x, hz, rate = RATE) {
  const a = 1 - Math.exp((-TAU * hz) / rate);
  let y = 0;
  return x.map((v) => (y += a * (v - y)));
}
const hpf = (x, hz, rate = RATE) => {
  const l = lpf(x, hz, rate);
  return x.map((v, i) => v - l[i]);
};
const noiseOf = (r, n) => Float32Array.from({ length: n }, r);
/** Scale to `peak`, then fade the last 5 ms to zero. */
function finish(x, peak, rate = RATE) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  const fade = Math.round(0.005 * rate);
  return x.map((v, i) => (v / (m || 1)) * peak * Math.min(1, (x.length - 1 - i) / fade));
}

// Footsteps: each surface has its own character; the variants differ in seed, pitch and grain pattern.
function grass(i) {
  const swish = lpf(hpf(noiseOf(rng(100 + i), RATE * 0.25), 1200 + i * 300), 5200 - i * 500);
  return finish(make(0.25, (t, k) => swish[k] * Math.min(1, t / 0.012) * Math.exp(-t / (0.05 + 0.012 * i)) + 0.5 * Math.sin(TAU * (68 + 6 * i) * t) * Math.exp(-t / 0.04)), 0.6);
}
function gravel(i) {
  const r = rng(200 + i), n = RATE * 0.3;
  const x = new Float32Array(n);
  for (let g = 0; g < 18 + 3 * i; g++) {
    const at = Math.round(Math.abs(r()) ** 1.6 * 0.17 * RATE), amp = 0.3 + 0.7 * Math.abs(r()), tau = 0.0012 + 0.002 * Math.abs(r());
    const burst = hpf(noiseOf(r, 240), 2500 + 3000 * Math.abs(r()));
    for (let k = 0; k < 240 && at + k < n; k++) x[at + k] += amp * burst[k] * Math.exp(-k / RATE / tau);
  }
  const crunch = lpf(noiseOf(r, n), 1500);
  return finish(x.map((v, k) => v + 0.5 * crunch[k] * Math.exp(-k / RATE / 0.07) + 0.4 * Math.sin(TAU * (85 + 8 * i) * (k / RATE)) * Math.exp(-k / RATE / 0.035)), 0.6);
}
function wood(i) {
  const f = [182, 214, 197][i], click = hpf(noiseOf(rng(300 + i), RATE * 0.3), 1500);
  return finish(make(0.3, (t, k) => Math.sin(TAU * f * t) * Math.exp(-t / 0.055) + 0.5 * Math.sin(TAU * f * 2.4 * t) * Math.exp(-t / 0.03) + 0.3 * Math.sin(TAU * f * 3.9 * t) * Math.exp(-t / 0.02) + 0.6 * click[k] * Math.exp(-t / 0.003)), 0.7);
}
function metal(i) {
  const f = 420 + 45 * i, click = hpf(noiseOf(rng(400 + i), RATE * 0.35), 3000);
  const partials = [[1, 1, 0.12], [2.76, 0.6, 0.08], [5.4, 0.35, 0.05], [8.9, 0.2, 0.03]];
  return finish(make(0.35, (t, k) => partials.reduce((s, [ratio, a, tau]) => s + a * Math.sin(TAU * f * ratio * t) * Math.exp(-t / tau), 0) + 0.8 * click[k] * Math.exp(-t / 0.004) + 0.4 * Math.sin(TAU * 70 * t) * Math.exp(-t / 0.03)), 0.55);
}
for (const [surface, fn] of [["grass", grass], ["gravel", gravel], ["wood", wood], ["metal", metal]]) {
  for (let i = 0; i < 3; i++) ev[`step-${surface}-${i + 1}.wav`] = wav(fn(i));
}

// Engine, 24 kHz. `f` is the firing rate, the pulse; every other cylinder is a little off, so there are half-order
// components too. A loop's period is exactly 1 s with an even `f`, so the pulse and the half orders fit whole cycles.
const ER = 24000;
/** The waveform at phase `ph` (cycles); `cutoff` Hz is where the harmonics roll off. */
function enginePulse(ph, f, cutoff) {
  let s = 0;
  for (let k = 1; k * f < Math.min(cutoff * 3, ER / 2); k++) s += Math.sin(TAU * k * ph + 0.6 * k) / Math.pow(k, 1.05) / (1 + ((k * f) / cutoff) ** 2);
  for (let m = 1; m <= 7; m += 2) s += (0.28 * Math.sin(TAU * m * (ph / 2) + 1.3 * m)) / m;
  return s;
}
/** `fn(phaseCycles, t, i)` for each sample while the rate follows `fOf(t)`: the phase is the running integral. */
function sweep(seconds, fOf, fn) {
  let ph = 0;
  return make(seconds, (t, i) => {
    const v = fn(ph, t, i);
    ph += fOf(t) / ER;
    return v;
  }, ER);
}
/** A seamless noise loop of `n` samples: the last `x` samples fade into the first. */
function loopNoise(r, n, x) {
  const a = noiseOf(r, n + x);
  return Float32Array.from({ length: n }, (_, i) => (i < x ? a[i] * Math.sin((i / x) * (Math.PI / 2)) + a[n + i] * Math.cos((i / x) * (Math.PI / 2)) : a[i]));
}
/** One second of engine at firing rate `f` that repeats exactly. */
function enginePeriod(f, cutoff, noiseAmt, seed) {
  const air = lpf(loopNoise(rng(seed), ER, 2400), cutoff * 0.8, ER);
  return Float32Array.from({ length: ER }, (_, i) => enginePulse(f * (i / ER), f, cutoff) + noiseAmt * air[i] * (0.9 + 0.5 * Math.cos(TAU * f * (i / ER))));
}
// A loop clip: 0.15 s lead-in, a 1 s loop and 0.15 s of tail. The loop region is [0.15, 1.15] s, also written as a `smpl` loop.
const LEAD = 0.15;
function engineLoop(f, cutoff, noiseAmt, seed) {
  const p = enginePeriod(f, cutoff, noiseAmt, seed), total = LEAD * 2 + 1;
  const clip = make(total, (t, i) => p[i % ER] * Math.min(1, t / LEAD) * Math.min(1, (total - t) / LEAD), ER);
  return wav(finish(clip, 0.6, ER), ER, [Math.round(LEAD * ER), Math.round((LEAD + 1) * ER) - 1]);
}
ev["engine-idle.wav"] = engineLoop(30, 600, 0.5, 11);
ev["engine-mid.wav"] = engineLoop(60, 1300, 0.45, 12);
ev["engine-high.wav"] = engineLoop(110, 2600, 0.4, 13);
{
  // Start: a starter whine, then ragged firing that settles toward idle (30 Hz).
  const cough = lpf(noiseOf(rng(21), ER), 900, ER);
  const startRate = (t) => (t < 0.4 ? 5 + 20 * t : 13 + 17 * ((t - 0.4) / 0.5) ** 0.7);
  const start = sweep(0.9, startRate, (ph, t, i) => {
    const whine = t < 0.6 ? 0.25 * saw(70 + 150 * t, t, 3000, ER) * Math.min(1, t / 0.05) * Math.min(1, (0.6 - t) / 0.15) : 0;
    const body = t < 0.35 ? 0 : enginePulse(ph, startRate(t), 500) * Math.min(1, (t - 0.35) / 0.3) * (1 + 0.4 * cough[i]);
    return whine + 0.8 * body;
  });
  ev["engine-start.wav"] = wav(finish(start, 0.6, ER), ER);
  // Off: the pulse slows from idle to a stop while the level falls, then a low thump.
  const offRate = (t) => 30 - 22.5 * t;
  const off = sweep(1.2, offRate, (ph, t) => enginePulse(ph, offRate(t), 500) * Math.exp(-t / 0.4) + (t > 0.85 ? 0.5 * Math.sin(TAU * 55 * (t - 0.85)) * Math.exp(-(t - 0.85) / 0.06) : 0));
  ev["engine-off.wav"] = wav(finish(off, 0.6, ER), ER);
  // One clip with everything: a 0.5 s run-up, a 1 s loop (region [0.5, 1.5] s) and a 1 s spin-down. The run-up covers a
  // whole number of cycles (8 to 40 Hz over 0.5 s is 12) and the tail starts at phase 0, so both join the loop without a seam.
  const up = sweep(0.5, (t) => 8 + 64 * t, (ph, t) => enginePulse(ph, 8 + 64 * t, 800) * Math.min(1, t / 0.15));
  const loop = Float32Array.from({ length: ER }, (_, i) => enginePulse(40 * (i / ER), 40, 800));
  const down = sweep(1, (t) => 40 - 36 * t, (ph, t) => enginePulse(ph, 40 - 36 * t, 800) * Math.exp(-t / 0.35));
  ev["engine-single.wav"] = wav(finish(Float32Array.from([...up, ...loop, ...down]), 0.6, ER), ER, [Math.round(0.5 * ER), Math.round(1.5 * ER) - 1]);
}

// Music layers: 120 bpm in A minor, 4 s (two bars), 24 kHz. The pad's partials are multiples of 0.25 Hz (whole cycles in 4 s);
// the pulse and the lead decay to silence within each note. The pad is always on; Intensity fades the pulse and the lead in.
const MR = 24000;
const q = (f) => Math.round(f * 4) / 4;
{
  const chord = [110, 131, 165, 196, 247].map(q);
  const pad = make(4, (t) => chord.reduce((s, f) => s + 0.12 * (Math.sin(TAU * f * t) + Math.sin(TAU * (f + 0.25) * t) + 0.3 * Math.sin(TAU * 2 * f * t)), 0) * (1 + 0.25 * Math.sin(TAU * 0.5 * t)), MR);
  ev["music-pad.wav"] = wav(finish(pad, 0.5, MR), MR);
  const hat = hpf(noiseOf(rng(31), 4 * MR), 6000, MR);
  const bass = [55, 55, 82.5, 55, 49, 49, 73.5, 49, 58.25, 58.25, 87.25, 58.25, 49, 49, 73.5, 65.5];
  const pulse = make(4, (t, i) => {
    const note = Math.floor(t / 0.25), u = t - note * 0.25;
    const b = 0.6 * Math.sin(TAU * bass[note] * u) * Math.min(1, u / 0.003) * Math.exp(-u / 0.1) * Math.min(1, (0.25 - u) / 0.005);
    const ub = t % 0.5; // a kick on every beat
    const kick = 0.9 * Math.sin(TAU * (45 * ub + (90 * (1 - Math.exp(-ub * 30))) / 30)) * Math.exp(-ub / 0.09);
    const uh = (t + 0.25) % 0.5; // a hat on the off-beats
    return b + kick + (uh < 0.25 ? 0.35 * hat[i] * Math.exp(-uh / 0.02) : 0);
  }, MR);
  ev["music-pulse.wav"] = wav(finish(pulse, 0.55, MR), MR);
  const arp = [440, 523, 659, 880, 659, 523, 440, 523, 392, 494, 587, 784, 587, 494, 392, 494];
  const lead = make(4, (t) => {
    const step = Math.floor(t / 0.125), u = t - step * 0.125;
    return saw(arp[step % 16] * (step >= 16 ? 1.5 : 1), t, 5000, MR) * Math.min(1, u / 0.002) * Math.exp(-u / 0.07) * Math.min(1, (0.125 - u) / 0.005);
  }, MR);
  ev["music-lead.wav"] = wav(finish(lead, 0.5, MR), MR);
}

const eventsOut = join(out, "events");
mkdirSync(eventsOut, { recursive: true });
for (const [name, file] of Object.entries(ev)) {
  writeFileSync(join(eventsOut, name), file);
  console.log(`events/${name}  ${file.length} bytes`);
}
