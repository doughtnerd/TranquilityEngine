#!/usr/bin/env node
/**
 * makeClick (ADR 0166 task Rh3): writes `audio/music/click-track.wav`, the calibration page's click track. One bar of 4/4
 * at 120 bpm (2 s, 22.05 kHz mono 16-bit PCM, the encoding of the other music stems): a click on every beat, beat 1 higher
 * and louder. Each click starts on its beat's first sample, so the grid and the sound agree. Deterministic.
 *
 *   node samples/sound-lab/tools/makeClick.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RATE = 22050;
const BEAT = 0.5;
const out = new Float32Array(4 * BEAT * RATE);
for (let beat = 0; beat < 4; beat++) {
  const hz = beat === 0 ? 1500 : 1000;
  const amp = beat === 0 ? 0.9 : 0.6;
  const start = Math.round(beat * BEAT * RATE);
  for (let i = 0; i < 0.04 * RATE; i++) {
    const t = i / RATE;
    out[start + i] += amp * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.008) * Math.min(1, i / 8);
  }
}
const data = out.length * 2;
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
for (let i = 0; i < out.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i])) * 32767), 44 + i * 2);
writeFileSync(fileURLToPath(new URL("../audio/music/click-track.wav", import.meta.url)), b);
