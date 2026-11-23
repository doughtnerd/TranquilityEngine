// Audio and visual offsets per output device, per user (ADR 0341, 0349). The audio offset is what the engine's
// `Audio.calibration` holds (seconds, applied to input judging); the visual offset shifts drawn playheads and beats
// to match what is heard. Both are kept per device under the user's preferences, so every screen and every project
// shares them, and the audio offset is handed to the Studio's runtime while it runs.
import { clampOffset } from "./calibrationModel";

export interface DeviceOffsets {
  /** ms the output lags; tapping late means a positive offset. */
  readonly audio: number;
  /** ms the screen lags. */
  readonly visual: number;
}

/** What the preference holds: offsets by device id ("default" for the system's output). */
export type OffsetStore = Readonly<Record<string, DeviceOffsets>>;

export const NO_OFFSETS: DeviceOffsets = { audio: 0, visual: 0 };

/** The system's output device, which the Studio plays through. */
export const DEFAULT_DEVICE = "default";

/** A device's offsets (zero when it has none; bad stored values read as zero). */
export function offsetsFor(store: unknown, device: string): DeviceOffsets {
  const entry = store !== null && typeof store === "object" ? (store as Record<string, unknown>)[device] : undefined;
  if (!entry || typeof entry !== "object") return NO_OFFSETS;
  const e = entry as Record<string, unknown>;
  return { audio: clampOffset(e.audio), visual: clampOffset(e.visual) };
}

/** Whether `device` has been calibrated (any offset stored for it). */
export const isCalibrated = (store: unknown, device: string): boolean => store !== null && typeof store === "object" && device in (store as object);

/** The store with `device`'s `kind` offset set (clamped to ±300 ms). */
export function withOffset(store: unknown, device: string, kind: keyof DeviceOffsets, ms: number): OffsetStore {
  const base: Record<string, DeviceOffsets> = store !== null && typeof store === "object" ? { ...(store as Record<string, DeviceOffsets>) } : {};
  base[device] = { ...offsetsFor(store, device), [kind]: clampOffset(ms) };
  return base;
}
