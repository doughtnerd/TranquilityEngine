#!/usr/bin/env node
/**
 * makeVoice (ADR 0172, task Sa2): writes `audio/mixer/voice-loop.wav`, the dialogue stand-in of the Mixer page
 * (`scenes/mixer.scene.json`): a 4 s loop (48 kHz mono 16-bit, 192,000 frames) of speech-like phrases, additive
 * harmonics of a gliding 110-170 Hz pitch shaped by two moving formants, in syllables of 0.12 to 0.2 s with short gaps
 * and a long pause at the end of the loop. It is made for a level detector: the level swings between about -20 dBFS RMS
 * inside a syllable and silence between phrases, so a level rule (`mode: "level"`, RMS, -30 dBFS) closes and releases on
 * the phrase, which a steady tone would never show. The loop starts and ends in silence, so it has no seam.
 *
 * Deterministic (a seeded generator), so a rerun is byte-identical: `node samples/sound-lab/tools/makeVoice.mjs`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RATE = 48000;
const SECONDS = 4;
const FRAMES = RATE * SECONDS;

let state = 0x9e3779b9;
const rand = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 0x100000000;
};

/** (start s, length s) of each syllable: three phrases of 3, 2 and 3 syllables, then 1.1 s of quiet. */
const syllables = [];
let t = 0.08;
for (const count of [3, 2, 3]) {
  for (let i = 0; i < count; i++) {
    const len = 0.12 + rand() * 0.08;
    syllables.push([t, len]);
    t += len + 0.04 + rand() * 0.03;
  }
  t += 0.22;
}

const out = new Float32Array(FRAMES);
for (const [start, len] of syllables) {
  const f0a = 110 + rand() * 60;
  const f0b = f0a * (0.85 + rand() * 0.3);
  const f1 = 450 + rand() * 450; // first formant
  const f2 = 1100 + rand() * 1300; // second formant
  const first = Math.floor(start * RATE);
  const n = Math.floor(len * RATE);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f0 = f0a + (f0b - f0a) * u;
    phase += (2 * Math.PI * f0) / RATE;
    const env = Math.sin(Math.PI * u) ** 0.6; // a rounded syllable, quick on, quick off
    let v = 0;
    for (let h = 1; h * f0 < 4000; h++) {
      const f = h * f0;
      const g = 1 / h + 2.2 * Math.exp(-(((f - f1) / 160) ** 2)) + 1.4 * Math.exp(-(((f - f2) / 260) ** 2));
      v += g * Math.sin(h * phase);
    }
    out[first + i] += env * v;
  }
}

// Scale to a -4 dBFS peak: inside a syllable that is about -17 dBFS RMS, well over a -30 dBFS threshold.
let peak = 0;
for (const v of out) peak = Math.max(peak, Math.abs(v));
const gain = 10 ** (-4 / 20) / peak;

const data = FRAMES * 2;
const b = Buffer.alloc(44 + data);
b.write("RIFF", 0);
b.writeUInt32LE(36 + data, 4);
b.write("WAVEfmt ", 8);
b.writeUInt32LE(16, 16);
b.writeUInt16LE(1, 20);
b.writeUInt16LE(1, 22);
b.writeUInt32LE(RATE, 24);
b.writeUInt32LE(RATE * 2, 28);
b.writeUInt16LE(2, 32);
b.writeUInt16LE(16, 34);
b.write("data", 36);
b.writeUInt32LE(data, 40);
for (let i = 0; i < FRAMES; i++) b.writeInt16LE(Math.round(out[i] * gain * 32767), 44 + i * 2);

const dir = fileURLToPath(new URL("../audio/mixer/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}voice-loop.wav`, b);
console.log(`voice-loop.wav: ${syllables.length} syllables, peak -4 dBFS`);
