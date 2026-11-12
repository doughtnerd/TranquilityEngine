#!/usr/bin/env node
/**
 * music-tempo (ADR 0166 task SM1): prints the tempo of a music clip, to fill a segment's tempo map by hand.
 *
 *   node tools/music-tempo.mjs <file.wav|.ogg> --bars <n> [--beats-per-bar 4]   bpm from the clip's length and a bar count
 *   node tools/music-tempo.mjs <file.wav|.ogg> --hints                          the tempo the file's own metadata says
 *   node tools/music-tempo.mjs --seconds <s> --bars <n> [--beats-per-bar 4]     bpm from numbers alone (no file)
 *
 * Output is one JSON line on stdout: `{ "bpm": 120, "source": "length" | "acid" | "ogg-bpm", "seconds": 8, "bars": 4, ... }`.
 * Errors go to stderr with exit code 1.
 *
 * Why its own readers: `src/plugins/audio/editor/music/importHints.ts` is TypeScript with an extensionless import
 * (`../../runtime/loopPointsReader`), which plain Node cannot load, and the tool must run without the Vite pipeline.
 * So this file carries the two small readers it needs (a RIFF walk for `fmt `, `data` and `acid`; an Ogg
 * comment scan for a `BPM=` tag), matching importHints' rules: pure, total, never throw on garbage input.
 *
 * Skeleton by the SM1 lead; bodies tagged `L-SM1a` are filled by leaf L-SM1a (tests: `music-tempo.test.mjs`,
 * run with `node --test tools/music-tempo.test.mjs`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * bpm = beats / minutes = bars * beatsPerBar * 60 / seconds. Returns a finite number > 0, or `null` when
 * `seconds`, `bars` or `beatsPerBar` is not a finite number > 0. No rounding here.
 * @param {number} seconds clip length in seconds
 * @param {number} bars whole bars the clip holds
 * @param {number} [beatsPerBar] metre numerator, default 4
 * @returns {number | null}
 */
export function bpmFromLength(seconds, bars, beatsPerBar = 4) {
  if (!isPositiveFinite(seconds) || !isPositiveFinite(bars) || !isPositiveFinite(beatsPerBar)) return null;
  const bpm = (bars * beatsPerBar * 60) / seconds;
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

function isPositiveFinite(x) {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function ascii4(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function u16le(bytes, at) {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32le(bytes, at) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000;
}

function f32le(bytes, at) {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getFloat32(0, true);
}

function isWave(bytes) {
  return bytes.length >= 12 && ascii4(bytes, 0) === "RIFF" && ascii4(bytes, 8) === "WAVE";
}

function isOgg(bytes) {
  return bytes.length >= 4 && ascii4(bytes, 0) === "OggS";
}

/**
 * Lists the chunks after the RIFF/WAVE header. A chunk whose declared size runs past the end of the file is listed
 * with `truncated: true` and `available` = the bytes present, and ends the walk. Sizes are even-padded.
 */
function riffChunks(bytes) {
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = ascii4(bytes, pos);
    const size = u32le(bytes, pos + 4);
    const start = pos + 8;
    const available = bytes.length - start;
    const truncated = size > available;
    chunks.push({ id, start, size, truncated, available: truncated ? available : size });
    if (truncated) break;
    pos = start + size + (size % 2);
  }
  return chunks;
}

/**
 * Reads a RIFF/WAVE file's length: frames = `data` byte length / `fmt ` blockAlign, seconds = frames / sampleRate.
 * Walks chunks (even-padded); a `data` chunk running past the end of the file counts only the bytes present.
 * Returns `null` on anything that is not WAVE with a usable `fmt ` (rate > 0, blockAlign > 0) and `data`.
 * Never throws.
 * @param {Uint8Array} bytes
 * @returns {{ rate: number, frames: number, seconds: number } | null}
 */
export function readWavLength(bytes) {
  try {
    if (!isWave(bytes)) return null;
    let fmt;
    let dataBytes;
    for (const c of riffChunks(bytes)) {
      if (c.id === "fmt " && fmt === undefined) {
        if (c.truncated || c.size < 14) return null;
        const rate = u32le(bytes, c.start + 4);
        const blockAlign = u16le(bytes, c.start + 12);
        if (!(rate > 0) || !(blockAlign > 0)) return null;
        fmt = { rate, blockAlign };
      } else if (c.id === "data" && dataBytes === undefined) {
        dataBytes = c.available;
      }
    }
    if (fmt === undefined || dataBytes === undefined) return null;
    const frames = Math.floor(dataBytes / fmt.blockAlign);
    return { rate: fmt.rate, frames, seconds: frames / fmt.rate };
  } catch {
    return null;
  }
}

/**
 * Reads the tempo a file's own metadata states: a WAV `acid` chunk (tempo is a float32 at body offset 20; the chunk
 * is 24 bytes: type u32, rootNote u16, unknown u16, unknown f32, numBeats u32, meterDenominator u16,
 * meterNumerator u16, tempo f32) or an Ogg (Vorbis, Opus, FLAC) comment `BPM=<float>` (case-insensitive key; scan the
 * first 64 KiB of the file as latin1/utf8 text for the key). WAV `acid` wins when both could apply (they cannot in
 * one file; the rule is only for clarity). Returns `{ bpm, source: "acid" | "ogg-bpm", beats? }` with bpm finite
 * and > 0, or `null` when there is no hint. Never throws.
 * @param {Uint8Array} bytes
 * @returns {{ bpm: number, source: "acid" | "ogg-bpm", beats?: number } | null}
 */
export function readTempoHint(bytes) {
  try {
    if (isWave(bytes)) {
      const acid = riffChunks(bytes).find((c) => c.id === "acid" && !c.truncated);
      if (acid !== undefined && acid.size >= 24) {
        const tempo = f32le(bytes, acid.start + 20);
        if (Number.isFinite(tempo) && tempo > 0) {
          const beats = u32le(bytes, acid.start + 12);
          return beats > 0 ? { bpm: tempo, source: "acid", beats } : { bpm: tempo, source: "acid" };
        }
      }
    }
    const text = Buffer.from(bytes.subarray(0, 65536)).toString("latin1");
    for (const m of text.matchAll(/(?<![A-Za-z0-9])BPM=([0-9]+(?:\.[0-9]+)?)/gi)) {
      const bpm = Number(m[1]);
      if (Number.isFinite(bpm) && bpm > 0) return { bpm, source: "ogg-bpm" };
    }
  } catch {
    // fall through: garbage input has no hint
  }
  return null;
}

/**
 * Parses argv (without node and script): the first non-flag argument is the file; flags `--bars <n>`,
 * `--beats-per-bar <n>` (default 4), `--seconds <s>`, `--hints`. Returns
 * `{ file?, bars?, beatsPerBar, seconds?, hints }` or `{ error: string }` for an unknown flag, a missing or
 * non-numeric value, or no usable mode (a mode is: file + bars, file + hints, or seconds + bars).
 * @param {string[]} argv
 * @returns {{ file?: string, bars?: number, beatsPerBar: number, seconds?: number, hints: boolean } | { error: string }}
 */
export function parseArgs(argv) {
  const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  const out = { beatsPerBar: 4, hints: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hints") {
      out.hints = true;
    } else if (arg === "--bars" || arg === "--beats-per-bar" || arg === "--seconds") {
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) return { error: `${arg} needs a value` };
      if (!NUMBER.test(raw)) return { error: `${arg} needs a number, got "${raw}"` };
      const value = Number(raw);
      if (arg === "--bars") out.bars = value;
      else if (arg === "--seconds") out.seconds = value;
      else out.beatsPerBar = value;
      i++;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag ${arg}` };
    } else if (out.file === undefined) {
      out.file = arg;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }
  if (out.bars !== undefined && !(Number.isInteger(out.bars) && out.bars > 0)) {
    return { error: "--bars must be a whole number above 0" };
  }
  const hasFile = out.file !== undefined;
  const hasBars = out.bars !== undefined;
  const hasSeconds = out.seconds !== undefined;
  if (hasFile && hasSeconds) return { error: "give a file or --seconds, not both" };
  if (out.hints) {
    if (!hasFile || hasBars || hasSeconds) return { error: "--hints takes a file and nothing else" };
    return out;
  }
  if (hasBars && (hasFile || hasSeconds)) return out;
  if (hasSeconds) return { error: "--seconds needs --bars" };
  return { error: "no usable mode: <file> --bars <n>, <file> --hints, or --seconds <s> --bars <n>" };
}

/**
 * Runs one invocation and returns the result object the CLI prints (see the header), or `{ error: string }`.
 * Reads the file with `readFileSync` when `args.file` is set. `--hints` with no hint in the file is an error
 * ("no tempo hint in <file>"). File + bars: `source: "length"`, with `seconds`, `bars`, `beatsPerBar`, `bpm`
 * rounded to 3 decimals. Only WAV lengths are read here; an Ogg file with `--bars` is an error telling the user to
 * pass `--seconds` (an Ogg's length needs a page walk the tool does not carry).
 * @param {ReturnType<typeof parseArgs>} args
 * @returns {object}
 */
export function run(args) {
  if ("error" in args) return { error: args.error };
  const { file, bars, beatsPerBar, seconds, hints } = args;
  try {
    if (hints) {
      const hint = readTempoHint(readFileSync(file));
      if (hint === null) return { error: `no tempo hint in ${file}` };
      const out = { bpm: round3(hint.bpm), source: hint.source };
      if (hint.beats !== undefined) out.beats = hint.beats;
      return out;
    }
    let clipSeconds = seconds;
    if (file !== undefined) {
      const bytes = readFileSync(file);
      const wav = readWavLength(bytes);
      if (wav === null) {
        return {
          error: isOgg(bytes)
            ? "an Ogg file's length is not read here: pass --seconds <s> with --bars and no file"
            : `not a readable WAV file: ${file}`,
        };
      }
      clipSeconds = wav.seconds;
    }
    const bpm = bpmFromLength(clipSeconds, bars, beatsPerBar);
    if (bpm === null) return { error: "cannot compute bpm: seconds, bars and beats per bar must be above 0" };
    return { bpm: round3(bpm), source: "length", seconds: clipSeconds, bars, beatsPerBar };
  } catch (err) {
    return { error: `cannot read ${file ?? "input"}: ${err.message}` };
  }
}

/** CLI entry: prints `run(parseArgs(argv))` as one JSON line, or the error to stderr with exit code 1. */
export function main(argv) {
  const result = run(parseArgs(argv));
  if ("error" in result) {
    process.stderr.write(`music-tempo: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
