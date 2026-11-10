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

function wav(samples, rate = RATE) {
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
  return Buffer.concat([h, data]);
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
