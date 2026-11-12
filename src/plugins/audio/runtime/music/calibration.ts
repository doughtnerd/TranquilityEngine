/**
 * Calibration and rhythm mode (ADR 0166 api-and-models §1.3, §1.5; architecture §4.6; ADR 0167 §2, R18, R19).
 *
 * Owners: **Q2** (skeleton); **Rh2** (W9) filled `fromTaps`, `getCalibration`/`setCalibration` with persistence through
 * `Storage` (namespace `settings`, key `audio.calibration.<sinkId or "default">`) and `isCalibrationStale` (true after a
 * device change until a new calibration is set; the value is kept); **Rh1** (W8) filled `audioLatency` and
 * `rhythmModeSetting` (the numeric `latencyHint`, the read-back, the `reliable` rule and the mode rebuild are in
 * `core/context.ts`; the hold of beat callbacks through a recovery in `music/background.ts`).
 */
import { Storage } from "../../../../engine/platform/Storage";
import { mixer } from "../../../../engine/audio/mixer";
import type { AudioLatency, CalibrationApi, CalibrationResult } from "../../../../engine/audio/musicTypes";
import { audioBackend } from "../backend";

/** `CALIBRATION_WARMUP` (S11): taps dropped from the front of a run. */
export const CALIBRATION_WARMUP = 4;
/** `CALIBRATION_STEADY_MAD_MS` (S11): a spread above this (ms) is unsteady and gives zero confidence. */
export const CALIBRATION_STEADY_MAD_MS = 40;
/** Full confidence needs this many usable taps (S11). */
const FULL_CONFIDENCE_TAPS = 16;
/** `steady` needs at least this many usable taps. */
const MIN_STEADY_TAPS = 8;

const median = (sorted: readonly number[]): number => {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

/**
 * `Calibration.fromTaps(offsets, { warmup })`: `offsets` are raw `MusicPositionAt.offset` values (seconds). Non-finite
 * values (a missed or failed tap) are dropped first, then the first `warmup` (default 4) of the rest; `offset` is the
 * median of what remains and `spread` their MAD (unscaled, seconds). A plain median is as good as any trimming on the
 * spike's simulated taps (S5), so there is none. `confidence = clamp01(1 - spread / 0.040) x min(1, used / 16)`; `steady`
 * is spread <= 40 ms and used >= 8. `discarded = offsets.length - used`. With nothing left, `offset` and `spread` are 0,
 * `confidence` 0 and `steady` false (too few taps never throw). A `warmup` that is not a finite number >= 0 is the default.
 */
export function fromTaps(offsets: readonly number[], options?: { warmup?: number }): CalibrationResult {
  const w = options?.warmup;
  const warmup = typeof w === "number" && Number.isFinite(w) && w >= 0 ? Math.floor(w) : CALIBRATION_WARMUP;
  const taps = offsets.filter((x) => typeof x === "number" && Number.isFinite(x)).slice(warmup);
  const used = taps.length;
  const discarded = offsets.length - used;
  if (used === 0) return { offset: 0, spread: 0, confidence: 0, used: 0, discarded, steady: false };
  const offset = median([...taps].sort((x, y) => x - y));
  const spread = median(taps.map((x) => Math.abs(x - offset)).sort((x, y) => x - y));
  const limit = CALIBRATION_STEADY_MAD_MS / 1000;
  const confidence = Math.min(1, Math.max(0, 1 - spread / limit)) * Math.min(1, used / FULL_CONFIDENCE_TAPS);
  return { offset, spread, confidence, used, discarded, steady: spread <= limit && used >= MIN_STEADY_TAPS };
}

/** The public `Calibration` namespace (§1.5), exported from `myco`. */
export const Calibration: CalibrationApi = { fromTaps };

/** Storage namespace and key prefix for the persisted offset (§1.5). */
const NAMESPACE = "settings";
const KEY_PREFIX = "audio.calibration.";

/** The storage key for an output device: `audio.calibration.<sinkId>`, `.default` for the default device ("" or unknown). */
export function calibrationKey(sinkId?: string | null): string {
  return KEY_PREFIX + (typeof sinkId === "string" && sinkId !== "" ? sinkId : "default");
}

let calibrationSeconds = 0;
let calibrationIsStale = false;
let currentKey = calibrationKey();
/** The newest persistence write or read, so a caller (and the tests) can wait for it. */
let pending: Promise<void> = Promise.resolve();
/** Bumped by every set and device switch, so a slower read cannot overwrite a newer value. */
let epoch = 0;

const readStored = async (key: string): Promise<number | undefined> => {
  try {
    const v = await Storage.load<{ seconds?: unknown }>(key, NAMESPACE);
    const x = v?.seconds;
    return typeof x === "number" && Number.isFinite(x) ? x : undefined;
  } catch {
    return undefined; // storage unavailable: the in-memory value stands
  }
};

const track = (p: Promise<void>): void => {
  pending = pending.then(() => p).catch(() => undefined);
};

/**
 * Wiring (Rh2): the audio system calls this once the context exists, with its `sinkId` ("" for the default or where
 * unsupported). Loads the stored offset for that device; none stored leaves the value as it is. Not stale.
 */
export function initCalibration(sinkId?: string | null): Promise<void> {
  currentKey = calibrationKey(sinkId);
  calibrationIsStale = false;
  const mine = ++epoch;
  const done = readStored(currentKey).then((v) => {
    if (mine === epoch && v !== undefined) calibrationSeconds = v;
  });
  track(done);
  return done;
}

/**
 * Wiring (Rh2): the audio system calls this on the context's device event (`devicechange`, `sinkchange`) with the sink it
 * now has. A different sink with a stored offset adopts it (that device was calibrated before, so not stale). Otherwise,
 * including the same sink under `devicechange` (the default sink can be another device behind the same key), the value
 * is kept and `calibrationStale` becomes true until `setCalibration`.
 */
export function calibrationDeviceChanged(sinkId?: string | null): Promise<void> {
  const key = calibrationKey(sinkId);
  const mine = ++epoch;
  const changed = key !== currentKey;
  currentKey = key;
  calibrationIsStale = true;
  if (!changed) return Promise.resolve();
  const done = readStored(key).then((v) => {
    if (mine !== epoch || v === undefined) return;
    calibrationSeconds = v;
    calibrationIsStale = false;
  });
  track(done);
  return done;
}

/** Resolves when the newest persistence read or write has finished. */
export function calibrationSettled(): Promise<void> {
  return pending;
}

/** Test seam: forget everything in memory (the stored value stays in `Storage`, as after a reload). */
export function resetCalibrationForTests(): void {
  calibrationSeconds = 0;
  calibrationIsStale = false;
  currentKey = calibrationKey();
  pending = Promise.resolve();
  epoch++;
}

/** `Audio.calibration` (seconds, default 0): subtracted from an input's offset (`judged = offset - calibration`). */
export function getCalibration(): number {
  return calibrationSeconds;
}

/** Set `Audio.calibration`; persists for the current output device and clears `calibrationStale`. A non-finite value is ignored. */
export function setCalibration(seconds: number): void {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return;
  calibrationSeconds = seconds;
  calibrationIsStale = false;
  epoch++;
  track(Storage.save(currentKey, { seconds }, NAMESPACE).catch(() => undefined));
}

/** `Audio.calibrationStale`: true after the context's device event until a new calibration is set. */
export function isCalibrationStale(): boolean {
  return calibrationIsStale;
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
