#!/usr/bin/env node
/**
 * makeDrums (ADR 0172, task LS0): writes `audio/drum-loop.wav`, the M5-0 listening section's broadband, percussive test
 * material (`docs/design/0171-audio-mix/listening-notes/m5-0.md`). A sine hides a post-fader mute, a dip or a duck, and a
 * steady tone gives no instant to land a stamp on; this is one bar of 4/4 at 120 bpm (2 s, 48 kHz mono 16-bit PCM): a kick
 * on beats 1 and 3, a noise snare on 2 and 4, and a noise hat on every eighth note. Every hit starts on its grid sample and
 * has died away before the bar ends, so it loops with no seam. Seeded noise, so a rerun is byte-identical.
 *
 *   node samples/sound-lab/tools/makeDrums.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RATE = 48000;
const BEAT = 0.5;
const out = new Float32Array(4 * BEAT * RATE);

let seed = 0x5eed1234;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};

const add = (startSec, lengthSec, gen) => {
  const start = Math.round(startSec * RATE);
  const n = Math.round(lengthSec * RATE);
  for (let i = 0; i < n && start + i < out.length; i++) out[start + i] += gen(i / RATE, i);
};

for (let beat = 0; beat < 4; beat++) {
  const t0 = beat * BEAT;
  if (beat % 2 === 0) {
    // Kick: a sine sweeping 130 Hz down to 48 Hz with a 0.12 s decay, plus a short click for the attack.
    let phase = 0;
    add(t0, 0.35, (t, i) => {
      phase += (2 * Math.PI * (48 + 82 * Math.exp(-t / 0.03))) / RATE;
      return 0.8 * Math.sin(phase) * Math.exp(-t / 0.12) + (i < 96 ? 0.3 * noise() * (1 - i / 96) : 0);
    });
  } else {
    // Snare: broadband noise with a 0.09 s decay and a 190 Hz body.
    add(t0, 0.3, (t) => 0.55 * noise() * Math.exp(-t / 0.09) + 0.25 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05));
  }
}
// Hat: first-difference noise (a gentle high-pass), 0.03 s decay, on every eighth.
for (let eighth = 0; eighth < 8; eighth++) {
  let prev = 0;
  add(eighth * BEAT * 0.5, 0.08, (t) => {
    const n = noise();
    const d = n - prev;
    prev = n;
    return 0.22 * d * Math.exp(-t / 0.03);
  });
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
for (let i = 0; i < out.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i] * 0.6)) * 32767), 44 + i * 2);
writeFileSync(fileURLToPath(new URL("../audio/drum-loop.wav", import.meta.url)), b);
