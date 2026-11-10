// Generates the Sound Lab's test clips into ../audio (mono, 16-bit PCM, 48 kHz). Deterministic: the noise
// burst uses a seeded generator, so a rerun rewrites byte-identical files.
//
//   node samples/sound-lab/tools/makeTones.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 48000;
const TAU = Math.PI * 2;
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "audio");

function wav(samples) {
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
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const make = (seconds, fn) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => fn(i / RATE, i));
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

const noise = rng(1);
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
};

mkdirSync(out, { recursive: true });
for (const [name, samples] of Object.entries(clips)) {
  const file = wav(samples);
  writeFileSync(join(out, name), file);
  console.log(`${name}  ${file.length} bytes`);
}
