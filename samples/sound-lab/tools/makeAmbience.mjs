// Generates the spatial scene's ambisonic ambience: `audio/ambience-o1.wav`, a seamless 2.5 s loop in first-order
// AmbiX (4 channels, ACN order, SN3D) at 44.1 kHz, 16-bit PCM: 882 KB. Three layers, each encoded at its own direction
// with makeAmbisonic.mjs's encoder: wind from the left, a high chirp from front right, a low rumble from behind. The
// clip needs its sidecar (`ambience-o1.wav.meta.json`, `{"format":"myco.import@1","ambisonic":{}}`), which is committed.
//
//   node samples/sound-lab/tools/makeAmbience.mjs [--out FILE]
//
// Deterministic (a seeded generator), so a rerun writes the same bytes.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ambisonicWav, encodeTone } from "./makeAmbisonic.mjs";

const RATE = 44100;
const SECONDS = 2.5;
const FRAMES = Math.round(RATE * SECONDS);
const TAU = Math.PI * 2;

/** A small seeded generator (mulberry32), returning values in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

/** Noise through a one-pole low-pass at `hz`, run three times round the loop so the end meets the start. */
function loopedNoise(seed, hz) {
  const r = rng(seed);
  const white = Float32Array.from({ length: FRAMES }, () => r() * 2 - 1);
  const k = 1 - Math.exp((-TAU * hz) / RATE);
  const out = new Float32Array(FRAMES);
  let y = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < FRAMES; i++) {
      y += k * (white[i] - y);
      out[i] = y;
    }
  }
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  return out.map((s) => s / peak);
}

/** Wind: noise around 600 Hz, its level swelling twice a loop. */
const wind = loopedNoise(11, 600).map((s, i) => s * (0.55 + 0.45 * Math.sin((TAU * 2 * i) / FRAMES)) * 0.5);
/** Rumble: noise under 120 Hz, steady. */
const rumble = loopedNoise(23, 120).map((s) => s * 0.45);
/** Chirps: a 3.2 kHz sine with a fast decay, five a loop, a little apart in pitch. */
const chirp = new Float32Array(FRAMES);
for (let c = 0; c < 5; c++) {
  const start = Math.round(((c + 0.3) / 5) * FRAMES);
  const hz = 3200 + c * 140;
  for (let i = 0; i < 0.12 * RATE && start + i < FRAMES; i++) chirp[start + i] += 0.22 * Math.sin((TAU * hz * i) / RATE) * Math.exp((-i / RATE) * 40);
}

// Directions: degrees, 0 in front and positive to the left seen from above; elevation positive up.
const layers = [encodeTone(wind, 90, 10, 1), encodeTone(chirp, -50, 20, 1), encodeTone(rumble, 180, 0, 1)];
const planar = layers[0].map((_, ch) => Float32Array.from({ length: FRAMES }, (_, i) => layers[0][ch][i] + layers[1][ch][i] + layers[2][ch][i]));

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(dirname(fileURLToPath(import.meta.url)), "..", "audio", "ambience-o1.wav");
const wav = ambisonicWav(planar, RATE);
writeFileSync(out, wav);
console.log(`${out}: ${wav.length} bytes, 4 channels, ${RATE} Hz, ${SECONDS} s`);
