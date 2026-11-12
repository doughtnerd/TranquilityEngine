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
  // L-SM1a
  throw new Error("L-SM1a: not implemented");
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
  // L-SM1a
  throw new Error("L-SM1a: not implemented");
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
  // L-SM1a
  throw new Error("L-SM1a: not implemented");
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
  // L-SM1a
  throw new Error("L-SM1a: not implemented");
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
  // L-SM1a
  void readFileSync;
  throw new Error("L-SM1a: not implemented");
}

/** CLI entry: prints `run(parseArgs(argv))` as one JSON line, or the error to stderr with exit code 1. */
export function main(argv) {
  // L-SM1a
  throw new Error("L-SM1a: not implemented");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
