#!/usr/bin/env node
/**
 * makeLoudness (ADR 0172, task E2/LSb): writes the M5b listening section's two reference clips
 * (`docs/design/0171-audio-mix/listening-notes/m5b.md`):
 *
 * - `audio/loudness-reference.wav`: the EBU Tech 3341 case 1 signal, a 1 kHz sine at -23 dBFS (peak) on both channels,
 *   48 kHz stereo 16-bit, 2 s (96,000 frames, exactly 2,000 cycles, so it loops with no seam). Played at unity on a bus at
 *   unity it reads **-22.99 LUFS** on master (the synthesised golden `golden/loudness/t1-48000.json` measures -22.993; the
 *   standard's tolerance is +/- 0.1 LU).
 * - `audio/loudness-hot.wav`: the same sine at -0.5 dBFS, 2 s once, the "hot bus" signal: its true peak (-0.5 dBTP) is over
 *   the default targets' -1 dBTP ceiling.
 *
 * Deterministic, so a rerun is byte-identical: `node samples/sound-lab/tools/makeLoudness.mjs`
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RATE = 48000;
const FRAMES = 2 * RATE;

function sineStereo(peakDbfs) {
  const amp = 10 ** (peakDbfs / 20);
  const data = FRAMES * 2 * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < FRAMES; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * 1000 * i) / RATE) * 32767);
    b.writeInt16LE(v, 44 + i * 4);
    b.writeInt16LE(v, 44 + i * 4 + 2);
  }
  return b;
}

const dir = (name) => fileURLToPath(new URL(`../audio/${name}`, import.meta.url));
writeFileSync(dir("loudness-reference.wav"), sineStereo(-23));
writeFileSync(dir("loudness-hot.wav"), sineStereo(-0.5));
