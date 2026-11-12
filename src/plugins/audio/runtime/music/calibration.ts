/**
 * Calibration and rhythm mode (ADR 0166 api-and-models §1.3, §1.5; architecture §4.6; ADR 0167 §2, R18, R19).
 *
 * Owners: **Q2** (skeleton); **Rh2** (W9) fills `fromTaps`, `getCalibration`/`setCalibration` with persistence through
 * `Storage` (namespace `settings`, key `audio.calibration.<sinkId or "default">`) and `isCalibrationStale` (true after a
 * device change until a new calibration is set; the value is kept); **Rh1** (W8) filled `audioLatency` and
 * `rhythmModeSetting` (the numeric `latencyHint`, the read-back, the `reliable` rule and the mode rebuild are in
 * `core/context.ts`; the hold of beat callbacks through a recovery in `music/background.ts`).
 */
import { mixer } from "../../../../engine/audio/mixer";
import type { AudioLatency, CalibrationApi, CalibrationResult } from "../../../../engine/audio/musicTypes";
import { audioBackend } from "../backend";

/**
 * Rh2: `Calibration.fromTaps(offsets, { warmup })`: `offsets` are raw `MusicPositionAt.offset` values (seconds). The
 * first `warmup` (default 4) and non-finite values are dropped; `offset` is the median of the rest, `spread` their MAD;
 * `confidence = clamp01(1 - spread / 0.040) x min(1, used / 16)`; `steady` is spread <= 40 ms and used >= 8.
 */
export function fromTaps(offsets: readonly number[], options?: { warmup?: number }): CalibrationResult {
  void options;
  return { offset: 0, spread: 0, confidence: 0, used: 0, discarded: offsets.length, steady: false }; // STUB(Rh2)
}

/** The public `Calibration` namespace (§1.5), exported from `myco`. */
export const Calibration: CalibrationApi = { fromTaps };

let calibrationSeconds = 0;

/** Rh2: `Audio.calibration` (seconds, default 0): subtracted from an input's offset (`judged = offset - calibration`). */
export function getCalibration(): number {
  return calibrationSeconds; // STUB(Rh2): the stored value for the current output device
}

/** Rh2: set `Audio.calibration`; persists per output device and clears `calibrationStale`. A non-finite value is ignored. */
export function setCalibration(seconds: number): void {
  if (typeof seconds === "number" && Number.isFinite(seconds)) calibrationSeconds = seconds; // STUB(Rh2): persistence, staleness
}

/** Rh2: `Audio.calibrationStale`: true after the context's device event until a new calibration is set. */
export function isCalibrationStale(): boolean {
  return false; // STUB(Rh2)
}

/** A latency figure in seconds: finite and not negative, else 0. */
const seconds = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/**
 * Rh1: `Audio.latency` (seconds, read-only; a new object per read): the context's `baseLatency` and `outputLatency` as
 * read back (`core/context.ts` `AudioHost.latency`, through the backend's `latency()`), the core's limiter look-ahead,
 * their total, and `reliable`. `reliable` needs the backend's own verdict (the core's: `outputLatency` live, architecture
 * §4.6) **and** 0 < output < 0.5 (S13), so a constant 0 or an absurd value is never reliable. Each part is sanitised (a
 * non-finite or negative figure reads 0) and `total` is their sum. A backend without `latency()` (the Babylon fallback
 * reports none): zeros, not reliable. Rhythm mode promises no absolute latency (§1.5): this is what the browser gave.
 */
export function audioLatency(): AudioLatency {
  const l = audioBackend().latency?.();
  if (!l) return { base: 0, output: 0, limiter: 0, total: 0, reliable: false };
  const base = seconds(l.base);
  const output = seconds(l.output);
  const limiter = seconds(l.limiter);
  return { base, output, limiter, total: base + output + limiter, reliable: l.reliable === true && output > 0 && output < 0.5 };
}

/**
 * Rh1: `Audio.rhythmMode` (read-only): the project setting `audio.rhythmMode`, as the running mixer has it. The core
 * builds its context with `latencyHint: 0` while it is true, and a change rebuilds the context (`core/context.ts`
 * `AudioHost.reconfigure`); music recovery re-entry is stamped in both modes, and in rhythm mode beat callbacks are held
 * through a recovery (`music/background.ts` `updateBeatHolds`). It reports the setting even on a backend without rhythm
 * support (`MusicBackendCaps.rhythm` false: the Babylon fallback warns, B3).
 */
export function rhythmModeSetting(): boolean {
  return mixer.audioSettings.rhythmMode === true;
}
