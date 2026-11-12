#!/usr/bin/env node
/**
 * makeMusic (ADR 0166, task SM2): writes the sound-lab music scene's clips, `samples/sound-lab/audio/music/*.wav`.
 *
 *   node tools/makeMusic.mjs [--out DIR]      write the clips (default: samples/sound-lab/audio/music)
 *   node tools/makeMusic.mjs --check          exit 1 if the files in the default folder differ from what this would write
 *   node tools/makeMusic.mjs --list           print the clips: name, seconds, bytes
 *
 * Everything is synthesised from sines, saws and seeded noise, so there is no licence and a rerun is byte-identical.
 * One tempo (120 bpm, 4/4, a bar is 2 s) for every clip, so any segment can follow any other on the grid. Mono, 16-bit
 * PCM at 22.05 kHz, the same encoding as the `music-{pad,pulse,lead}.wav` stems SM1 kept in `audio/events/` (mono 16-bit
 * WAV: a decoded clip needs no codec, and a few seconds of it is small). The stems of one segment are exactly the same
 * length, as a segment needs (`docs/guide/interactive-music.md`, "Tracks and stems").
 *
 * The clips, and the segment each one is a stem of (the events in `samples/sound-lab/audio/music/*.audioevent.json`):
 *   explore-pad, explore-arp      explore, 2 bars, a forever loop (the whole clip wraps)
 *   combat-drums, combat-bass     combat, 2 bars, broadband drums so a crossfade curve is audible
 *   calm-pad, calm-bells          calm, 2 bars
 *   bridge-riser                  the bridge between calm and combat, 1 bar (a noise riser)
 *   stinger-hit                   the stinger, 2 beats
 *   loop-body                     loop-exit: 3 bars. Bars 1-2 are the loop region; bar 3 is its tail (a crash and the
 *                                 chord ringing out) which rings over the next pass, and plays out when the loop is left.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RATE = 22050;
export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
const TAU = Math.PI * 2;

/** The default output folder, `samples/sound-lab/audio/music` of this checkout. */
export const DEFAULT_OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../samples/sound-lab/audio/music");

// --- small synthesis kit ------------------------------------------------------------------------------------------

/** A seeded generator (mulberry32), values in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const frames = (seconds) => Math.round(seconds * RATE);

/** A silent buffer of `bars` bars. */
const buffer = (seconds) => new Float32Array(frames(seconds));

/**
 * Adds a sample at `i`; with `wrap` it goes round the end of the buffer (a looping clip's decaying notes ring over its
 * start, so the loop has no seam), without it a sample past the end is dropped.
 */
function put(buf, i, v, wrap) {
  if (i >= buf.length) {
    if (!wrap) return;
    i %= buf.length;
  }
  buf[i] += v;
}

/**
 * A pitched note: `harmonics` (amplitude per partial, the first is the fundamental) with an attack and an exponential
 * decay of time constant `decay`, held `hold` seconds then released over `release` seconds.
 */
function note(buf, at, hz, { hold = BEAT, attack = 0.005, decay = 0.4, release = 0.1, amp = 0.3, harmonics = [1], detune = 0, wrap = false }) {
  const start = frames(at);
  const length = frames(hold + release);
  for (let i = 0; i < length; i++) {
    const t = i / RATE;
    let env = Math.exp(-t / decay) * Math.min(1, t / attack);
    if (t > hold) env *= Math.max(0, 1 - (t - hold) / release);
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const a = harmonics[h];
      if (a === 0) continue;
      s += a * Math.sin(TAU * hz * (h + 1) * t);
      if (detune) s += a * Math.sin(TAU * hz * (1 + detune) * (h + 1) * t);
    }
    put(buf, start + i, s * env * amp, wrap);
  }
}

const SAW = [1, 0.5, 0.33, 0.25, 0.2, 0.16];
const SOFT = [1, 0.25, 0.08];

/** A burst of noise through a one-pole high-pass at `hp` Hz (`lp` Hz low-pass if set), decaying with constant `decay`. */
function noiseHit(buf, at, seconds, { amp = 0.3, hp = 4000, lp = 0, decay = 0.05, seed = 1, wrap = false }) {
  const r = rng(seed);
  const start = frames(at);
  const kHp = Math.exp((-TAU * hp) / RATE);
  const kLp = lp ? 1 - Math.exp((-TAU * lp) / RATE) : 1;
  let low = 0;
  let smooth = 0;
  for (let i = 0; i < frames(seconds); i++) {
    const x = r() * 2 - 1;
    low = kHp * low + (1 - kHp) * x;
    smooth += kLp * (x - low - smooth);
    put(buf, start + i, smooth * Math.exp(-i / RATE / decay) * amp, wrap);
  }
}

/** A kick: a sine sweeping from `from` to `to` Hz with a quick decay. */
function kick(buf, at, { amp = 0.8, from = 150, to = 48, wrap = false } = {}) {
  const start = frames(at);
  let phase = 0;
  for (let i = 0; i < frames(0.35); i++) {
    const t = i / RATE;
    phase += (TAU * (to + (from - to) * Math.exp(-t / 0.03))) / RATE;
    put(buf, start + i, Math.sin(phase) * Math.exp(-t / 0.11) * amp, wrap);
  }
}

/** Scales a buffer so its largest sample is `peak`. */
function normalize(buf, peak) {
  let max = 0;
  for (const s of buf) max = Math.max(max, Math.abs(s));
  const g = max > 0 ? peak / max : 0;
  return buf.map((s) => s * g);
}

/** A short fade at the ends of a non-looping clip, so it starts and ends at zero. */
function edges(buf, inSeconds, outSeconds) {
  const a = frames(inSeconds);
  const b = frames(outSeconds);
  for (let i = 0; i < a && i < buf.length; i++) buf[i] *= i / a;
  for (let i = 0; i < b && i < buf.length; i++) buf[buf.length - 1 - i] *= i / b;
  return buf;
}

// --- the clips ----------------------------------------------------------------------------------------------------

/** Explore: a soft pad on Am then F, and an eighth-note pluck arpeggio. 2 bars, wraps. */
function explorePad() {
  const b = buffer(2 * BAR);
  const chords = [[57, 60, 64], [53, 57, 60]];
  chords.forEach((chord, bar) => {
    for (const n of chord) note(b, bar * BAR, midi(n), { hold: BAR, attack: 0.5, decay: 9, release: 0.6, amp: 0.2, harmonics: SOFT, detune: 0.004, wrap: true });
  });
  return normalize(b, 0.5);
}

function exploreArp() {
  const b = buffer(2 * BAR);
  const steps = [69, 72, 76, 72, 79, 76, 72, 76, 65, 69, 72, 69, 77, 72, 69, 72];
  steps.forEach((n, i) => note(b, i * (BEAT / 2), midi(n), { hold: 0.05, attack: 0.003, decay: 0.16, release: 0.15, amp: 0.3, harmonics: [1, 0.35, 0.12], wrap: true }));
  return normalize(b, 0.55);
}

/** Combat: kick on 1 and 3, a noise snare on 2 and 4, eighth-note hats; and a driving saw bass. */
function combatDrums() {
  const b = buffer(2 * BAR);
  for (let beat = 0; beat < 8; beat++) {
    const at = beat * BEAT;
    if (beat % 2 === 0) kick(b, at, { wrap: true });
    else {
      noiseHit(b, at, 0.25, { amp: 0.6, hp: 1200, decay: 0.07, seed: 100 + beat, wrap: true });
      note(b, at, 190, { hold: 0.02, decay: 0.05, release: 0.05, amp: 0.4, wrap: true });
    }
    for (let h = 0; h < 2; h++) noiseHit(b, at + h * (BEAT / 2), 0.08, { amp: h === 0 ? 0.28 : 0.2, hp: 6000, decay: 0.02, seed: 200 + beat * 2 + h, wrap: true });
  }
  return normalize(b, 0.7);
}

function combatBass() {
  const b = buffer(2 * BAR);
  const roots = [33, 33, 36, 33, 33, 40, 36, 33, 29, 29, 33, 29, 29, 36, 33, 29];
  roots.forEach((n, i) => note(b, i * (BEAT / 2), midi(n), { hold: 0.18, attack: 0.004, decay: 0.3, release: 0.06, amp: 0.3, harmonics: SAW, wrap: true }));
  return normalize(b, 0.6);
}

/** Calm: a slow Fmaj7 then C pad, and sparse bells. */
function calmPad() {
  const b = buffer(2 * BAR);
  const chords = [[53, 57, 60, 64], [48, 55, 60, 64]];
  chords.forEach((chord, bar) => {
    for (const n of chord) note(b, bar * BAR, midi(n), { hold: BAR, attack: 0.8, decay: 12, release: 0.8, amp: 0.18, harmonics: [1, 0.12], detune: 0.003, wrap: true });
  });
  return normalize(b, 0.5);
}

function calmBells() {
  const b = buffer(2 * BAR);
  const hits = [[0, 76], [2.5, 72], [4, 79], [6, 74], [7, 71]];
  for (const [beat, n] of hits) {
    const hz = midi(n);
    note(b, beat * BEAT, hz, { hold: 0, attack: 0.002, decay: 0.9, release: 1.2, amp: 0.3, wrap: true });
    note(b, beat * BEAT, hz * 2.76, { hold: 0, attack: 0.002, decay: 0.25, release: 0.5, amp: 0.1, wrap: true });
  }
  return normalize(b, 0.5);
}

/** The bridge: one bar of rising noise and a rising tone, ending on a short breath. Not a loop. */
function bridgeRiser() {
  const b = buffer(BAR);
  const r = rng(7);
  let low = 0;
  let phase = 0;
  for (let i = 0; i < b.length; i++) {
    const p = i / b.length;
    const hz = 300 * Math.pow(20, p);
    const k = Math.exp((-TAU * hz) / RATE);
    const x = r() * 2 - 1;
    low = k * low + (1 - k) * x;
    phase += (TAU * (220 * Math.pow(5, p))) / RATE;
    b[i] = ((x - low) * 0.5 + Math.sin(phase) * 0.4) * Math.pow(p, 1.6);
  }
  return edges(normalize(b, 0.7), 0.005, 0.04);
}

/** The stinger: a bright Am chord, a noise splash and a thump, 2 beats. */
function stingerHit() {
  const b = buffer(2 * BEAT);
  for (const n of [57, 60, 64, 69, 76]) note(b, 0, midi(n), { hold: 0.2, attack: 0.002, decay: 0.45, release: 0.4, amp: 0.2, harmonics: SAW });
  noiseHit(b, 0, 0.5, { amp: 0.5, hp: 2500, decay: 0.12, seed: 31 });
  kick(b, 0, { amp: 0.6 });
  return edges(normalize(b, 0.8), 0.001, 0.05);
}

/**
 * The loop-exit segment: 3 bars, a forever loop over bars 1-2 with bar 3 as its tail. The body is a pulsing bass, an
 * arpeggio and a kick; the tail is a crash and an Am chord, rung out. Not wrapped: the engine overlays the tail on the next
 * pass (`tailBeats: 4`), so the body must not already contain what rings from the pass before.
 */
function loopBody() {
  const b = buffer(3 * BAR);
  const bass = [33, 33, 33, 36, 33, 33, 40, 36, 29, 29, 29, 33, 29, 29, 36, 33];
  bass.forEach((n, i) => note(b, i * (BEAT / 2), midi(n), { hold: 0.2, attack: 0.004, decay: 0.3, release: 0.08, amp: 0.3, harmonics: SAW }));
  const arp = [69, 76, 72, 76, 65, 72, 69, 72];
  arp.forEach((n, i) => note(b, i * BEAT, midi(n), { hold: 0.1, attack: 0.003, decay: 0.35, release: 0.2, amp: 0.25, harmonics: [1, 0.4, 0.15] }));
  for (let beat = 0; beat < 8; beat += 2) kick(b, beat * BEAT, { amp: 0.6 });
  for (let h = 0; h < 16; h++) noiseHit(b, h * (BEAT / 2), 0.06, { amp: 0.14, hp: 6500, decay: 0.015, seed: 400 + h });
  // The tail, from the loop end (bar 3): a crash and the closing chord.
  noiseHit(b, 2 * BAR, BAR, { amp: 0.6, hp: 3000, decay: 0.5, seed: 77 });
  for (const n of [45, 57, 60, 64, 69]) note(b, 2 * BAR, midi(n), { hold: 0.3, attack: 0.004, decay: 0.7, release: 0.8, amp: 0.2, harmonics: SOFT, detune: 0.003 });
  kick(b, 2 * BAR, { amp: 0.6 });
  return edges(normalize(b, 0.8), 0, 0.1);
}

/**
 * Every clip: file name, how many bars it holds and the samples. `loop` clips wrap (their first and last samples meet);
 * `tail` marks a clip whose last bar is a tail, so the loop region is the bars before it.
 */
export const CLIPS = [
  { name: "explore-pad", bars: 2, loop: true, make: explorePad },
  { name: "explore-arp", bars: 2, loop: true, make: exploreArp },
  { name: "combat-drums", bars: 2, loop: true, make: combatDrums },
  { name: "combat-bass", bars: 2, loop: true, make: combatBass },
  { name: "calm-pad", bars: 2, loop: true, make: calmPad },
  { name: "calm-bells", bars: 2, loop: true, make: calmBells },
  { name: "bridge-riser", bars: 1, loop: false, make: bridgeRiser },
  { name: "stinger-hit", bars: 0.5, loop: false, make: stingerHit },
  { name: "loop-body", bars: 3, loop: false, tail: true, make: loopBody },
];

// --- WAV ----------------------------------------------------------------------------------------------------------

/** Mono 16-bit PCM WAV bytes of float samples (clamped to [-1, 1]). */
export function wavBytes(samples, rate = RATE) {
  const data = samples.length * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return out;
}

/** The samples of a clip by name, as float32. */
export function render(name) {
  const clip = CLIPS.find((c) => c.name === name);
  if (!clip) throw new Error(`no clip named ${name}`);
  return clip.make();
}

/** Every clip as `{ file, bytes }`. */
export function renderAll() {
  return CLIPS.map((c) => ({ file: `${c.name}.wav`, bytes: wavBytes(c.make()) }));
}

/** Writes every clip into `dir`; returns what it wrote. */
export function writeAll(dir = DEFAULT_OUT) {
  mkdirSync(dir, { recursive: true });
  const files = renderAll();
  for (const f of files) writeFileSync(join(dir, f.file), f.bytes);
  return files;
}

/** Files of the default folder that differ from a fresh render (missing counts). */
export function checkAll(dir = DEFAULT_OUT) {
  return renderAll()
    .filter((f) => !existsSync(join(dir, f.file)) || !readFileSync(join(dir, f.file)).equals(f.bytes))
    .map((f) => f.file);
}

function main(argv) {
  if (argv.includes("--list")) {
    for (const f of renderAll()) console.log(`${f.file}\t${((f.bytes.length - 44) / 2 / RATE).toFixed(3)} s\t${f.bytes.length} bytes`);
    return 0;
  }
  if (argv.includes("--check")) {
    const bad = checkAll();
    if (bad.length) console.error(`out of date: ${bad.join(", ")} (run node tools/makeMusic.mjs)`);
    return bad.length ? 1 : 0;
  }
  const at = argv.indexOf("--out");
  if (at >= 0 && !argv[at + 1]) {
    console.error("--out needs a folder");
    return 1;
  }
  const files = writeAll(at >= 0 ? resolve(argv[at + 1]) : DEFAULT_OUT);
  console.log(`wrote ${files.length} clips, ${files.reduce((n, f) => n + f.bytes.length, 0)} bytes`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
