/**
 * Calibration and rhythm mode (ADR 0166 api-and-models §1.3, §1.5; architecture §4.6; ADR 0167 §2, R18, R19).
 *
 * Owners: **Q2** (skeleton); **Rh2** (W9) fills `fromTaps`, `getCalibration`/`setCalibration` with persistence through
 * `Storage` (namespace `settings`, key `audio.calibration.<sinkId or "default">`) and `isCalibrationStale` (true after a
 * device change until a new calibration is set; the value is kept); **Rh1** (W8) owns `audioLatency` and
 * `rhythmModeSetting` (the numeric `latencyHint`, the read-back and the `reliable` rule are in `core/context.ts` and
 * the backend's `latency()`).
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

const NO_LATENCY: AudioLatency = Object.freeze({ base: 0, output: 0, limiter: 0, total: 0, reliable: false });

/**
 * Rh1: `Audio.latency` (seconds, read-only): the context's `baseLatency` and `outputLatency`, the core's limiter
 * look-ahead, their total, and `reliable` (0 < output < 0.5, not exactly 0; S13). A backend without `latency()`: zeros,
 * not reliable.
 */
export function audioLatency(): AudioLatency {
  return audioBackend().latency?.() ?? NO_LATENCY; // Q2 delegation; Rh1 owns and tests it
}

/** Rh1: `Audio.rhythmMode`: the project setting `audio.rhythmMode` (read-only). */
export function rhythmModeSetting(): boolean {
  return mixer.audioSettings.rhythmMode === true; // Q2 delegation; Rh1 owns and tests it
}
