// ADR 0166 M4-0, task Z3 (api-and-models §9 "Golden (Node, real wasm)", §10 row Z3: "native equals wasm"). The in-voice
// goldens are rendered twice: natively by `native/audio/crates/audio-core/tests/in_voice_goldens.rs` (which also nulls
// each scene against the offline reference of architecture §4.4 and writes the fixture), and here by the real committed
// wasm on the loopback host (`testing.ts`). Both must give the same bits.
//
// **The fixture** (`golden/m4-<scene>.json`, written by the Rust test with `UPDATE_GOLDENS=1`; this file never writes
// it) carries everything the wasm side needs to replay the scene with no knowledge of it:
// - `preset`: the four init values that differ from `LOOPBACK_PRESET` (`maxLogical`, `maxMixed`, `maxBuses`,
//   `limiterLookaheadMs`); every other preset field is `LOOPBACK_PRESET`'s (none of them changes the output).
// - `clips`: mono f32 clips at 48 kHz, each built from integers so both sides make the same bits (`clipSamples`).
// - `steps`, in order: `{ send, count }` is one BATCH whose records are the hex bytes `send` (record heads included,
//   no envelope and no batch header; `count` records), sent at the current frame (`firstFrame` = the host's `frame`,
//   as `audioGolden.test.ts`' `Stage.send` does); `{ run }` renders that many quanta into the output.
// - `frames`: the output length; `fnv1a64`: FNV-1a 64 over the left channel's f32 bytes (little-endian) then the
//   right's, as 16 lowercase hex digits (`fnv1a64`, the digest of `audio-dsp/tests/bed_identity.rs`); `splits`: the
//   core's cumulative `splitQuanta` and `voiceSplits` after the last step; `null`: the native null result against the
//   offline reference (informational here: the Rust test asserts it).
//
// Digest rule as `audioGolden.test.ts`: exact bits, no tolerance. WebAssembly's f32 arithmetic is IEEE-754 without
// fused multiply-add and the core's transcendentals are `libm` on both sides, so native and wasm agree bit for bit.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost } from "../testing";
import type { CorePreset } from "../worklet/coreDriver";

const GOLDEN_DIR = fileURLToPath(new URL("./", import.meta.url));

/** A mono f32 clip at 48 kHz built from integers (identical bits on both sides). */
export interface M4Clip {
  readonly id: number;
  readonly frames: number;
  /**
   * `"dc"`: every sample `value` (a value exact in f32). `"lcg"`: `state = (state × 1,664,525 + 1,013,904,223) mod 2³²`
   * from `seed`, advanced once before each sample; the sample is `amp × ((state >>> 8) / 2²⁴ − 0.5)` (`amp` a power of
   * two, so every step is exact in f32).
   */
  readonly fill: "dc" | "lcg";
  readonly value?: number;
  readonly seed?: number;
  readonly amp?: number;
}

/** One step of a scene: a BATCH (record bytes in hex, `count` records) at the current frame, or `run` quanta. */
export type M4Step = { readonly send: string; readonly count: number } | { readonly run: number };

/** A fixture as the Rust test writes it (`golden/m4-<scene>.json`). */
export interface M4Fixture {
  readonly scene: string;
  /** What the scene shows, in a sentence. */
  readonly about: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number };
  readonly clips: readonly M4Clip[];
  readonly steps: readonly M4Step[];
  readonly frames: number;
  readonly fnv1a64: string;
  readonly splits: { readonly splitQuanta: number; readonly voiceSplits: number };
  /** The native null against the offline reference: the largest error and the bound it is held to (absent for a scene with no curve reference). */
  readonly null?: { readonly maxError: number; readonly tolerance: number };
}

/**
 * The row's list (api-and-models §10 Z3): exact fade start, the power-complementary crossfade, stamped STOP, the shaped
 * gain SET_PARAMS and two class G records in one quantum (class G); each class S record at sample 50, the low-pass ramp,
 * direction with sends and the bus move (class S, Z2c's scenes); a stamped SET_VOICE_FX (D7: applies at once).
 */
export const M4_CASES = [
  "m4-fade-start",
  "m4-fade-scurve-phase",
  "m4-crossfade-equal-power",
  "m4-stop-stamped",
  "m4-gain-shaped",
  "m4-two-class-g",
  "m4-s-pitch",
  "m4-s-lowpass",
  "m4-s-lowpass-ramp",
  "m4-s-direction",
  "m4-s-direction-sends",
  "m4-s-bus",
  "m4-s-paused",
  "m4-s-seek",
  "m4-s-loop",
  "m4-s-voice-fx",
] as const;

/** Reads `golden/<name>.json`, or `undefined` when the Rust test hasn't written it. */
export function readFixture(name: string): M4Fixture | undefined {
  const path = `${GOLDEN_DIR}${name}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as M4Fixture) : undefined;
}

/** FNV-1a 64 (offset basis 0xcbf29ce484222325, prime 0x100000001b3) over `left`'s bytes then `right`'s, as 16 lowercase hex digits. */
export function fnv1a64(left: Float32Array, right: Float32Array): string {
  void left;
  void right;
  throw new Error("L-Z3a: fnv1a64");
}

/** A fixture clip's samples (see `M4Clip`). */
export function clipSamples(clip: M4Clip): Float32Array {
  void clip;
  throw new Error("L-Z3a: clipSamples");
}

/** `LOOPBACK_PRESET` with the fixture's four values. */
export function presetOf(fixture: M4Fixture): CorePreset {
  void fixture;
  void LOOPBACK_PRESET;
  throw new Error("L-Z3a: presetOf");
}

/** Builds a loopback host with `presetOf(fixture)`, loads the clips (CLIP_BEGIN + CLIP_CHUNKs, format 0), plays the steps; returns the output and the host. */
export async function renderFixture(fixture: M4Fixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array; readonly host: LoopbackHost }> {
  void fixture;
  void createLoopbackHost;
  throw new Error("L-Z3a: renderFixture");
}

describe("in-voice goldens: native equals wasm (Z3)", () => {
  it.skip("fnv1a64: the empty input is the offset basis, and one f32 1.0 hashes as its four bytes", () => {
    // L-Z3a
  });

  it.skip("clipSamples: dc and lcg clips are built exactly", () => {
    // L-Z3a
  });

  it.skip.each(M4_CASES)("%s: the wasm output equals the native fixture's digest and split counts", async (name) => {
    // L-Z3a: a missing fixture skips the case until the Rust test writes it (the lead's glue makes it a failure).
    void name;
  });

  it.skip("golden/ holds no m4-*.json outside the cases", () => {
    // L-Z3a
    void readdirSync;
    void expect;
  });
});
