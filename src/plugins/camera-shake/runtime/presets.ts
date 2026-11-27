/**
 * Camera shake presets (ADR 0436), as data in one format so custom presets later are the same shapes in an asset.
 *
 * - An impulse shape is an envelope over normalised time (a core `Curve`, 0..1 → 0..1) times a signal that mixes the
 *   impulse's direction (`noise` 0) with six-channel noise (`noise` 1), with its default duration.
 * - A noise profile is a few octaves of smooth noise, each a frequency (Hz) with per-axis position (world units) and
 *   rotation (degrees) amplitudes, for continuous shake (Cinemachine-style handheld or 6D noise).
 *
 * At force 1 an impulse moves the view up to `IMPULSE_POSITION` world units and turns it up to `IMPULSE_ROTATION`
 * degrees.
 */
import type { Curve } from "../../../engine/core/curve";

/** The impulse shape presets, as Unity's Cinemachine names them. */
export const SHAKE_IMPULSE_PRESETS = ["recoil", "bump", "explosion", "rumble"] as const;
export type ShakeImpulsePreset = (typeof SHAKE_IMPULSE_PRESETS)[number];

/** The continuous noise presets. */
export const CAMERA_NOISE_PRESETS = ["none", "handheldSubtle", "handheld", "handheldWild", "shake6D"] as const;
export type CameraNoisePreset = (typeof CAMERA_NOISE_PRESETS)[number];

/** World units the view moves at force 1. */
export const IMPULSE_POSITION = 0.25;
/** Degrees the view turns at force 1. */
export const IMPULSE_ROTATION = 1.5;

export interface ImpulseShape {
  /** Strength over normalised time 0..1. */
  readonly envelope: Curve;
  /** Seconds, when the source or call doesn't give one. */
  readonly duration: number;
  /** 0: along the direction only; 1: six-channel noise only; between, a mix. */
  readonly noise: number;
  /** The noise's frequency in Hz. */
  readonly frequency: number;
}

export const IMPULSE_SHAPES: Readonly<Record<ShakeImpulsePreset, ImpulseShape>> = {
  /** An instant kick that eases back: a gun's recoil, a punch landing. */
  recoil: { envelope: [[0, 0, "easeOut"], [0.08, 1, "smooth"], [1, 0]], duration: 0.2, noise: 0, frequency: 0 },
  /** One smooth push and back: a landing, a door slam, a hit taken. */
  bump: { envelope: [[0, 0, "smooth"], [0.35, 1, "smooth"], [1, 0]], duration: 0.3, noise: 0.15, frequency: 12 },
  /** A hard hit that decays through noise on every axis. */
  explosion: { envelope: [[0, 0, "easeOut"], [0.04, 1, "easeOut"], [1, 0]], duration: 1, noise: 0.85, frequency: 18 },
  /** A sustained noisy shake that fades in and out: an earthquake, an engine, a rockslide. */
  rumble: { envelope: [[0, 0, "smooth"], [0.2, 1], [0.8, 1, "smooth"], [1, 0]], duration: 2, noise: 1, frequency: 10 },
};

export interface NoiseOctave {
  /** Hz. */
  readonly frequency: number;
  /** World units, per axis (camera space). */
  readonly position: readonly [number, number, number];
  /** Degrees, per axis (pitch X, yaw Y, roll Z). */
  readonly rotation: readonly [number, number, number];
}

export const NOISE_PROFILES: Readonly<Record<CameraNoisePreset, readonly NoiseOctave[]>> = {
  none: [],
  /** A steady hand: a slow drift you feel more than see. */
  handheldSubtle: [
    { frequency: 0.25, position: [0, 0, 0], rotation: [0.35, 0.35, 0.1] },
    { frequency: 0.9, position: [0, 0, 0], rotation: [0.1, 0.1, 0.04] },
  ],
  /** A person holding the camera. */
  handheld: [
    { frequency: 0.3, position: [0.01, 0.01, 0], rotation: [0.8, 0.8, 0.25] },
    { frequency: 1.1, position: [0.005, 0.005, 0], rotation: [0.25, 0.25, 0.08] },
  ],
  /** A person running with the camera. */
  handheldWild: [
    { frequency: 0.6, position: [0.04, 0.04, 0.01], rotation: [2.5, 2.5, 0.8] },
    { frequency: 2.2, position: [0.015, 0.015, 0], rotation: [0.8, 0.8, 0.3] },
    { frequency: 6, position: [0.005, 0.005, 0], rotation: [0.2, 0.2, 0.1] },
  ],
  /** Fast shake on all six axes: a vehicle, machinery, a constant tremor. */
  shake6D: [
    { frequency: 8, position: [0.04, 0.04, 0.04], rotation: [0.6, 0.6, 0.6] },
    { frequency: 17, position: [0.02, 0.02, 0.02], rotation: [0.3, 0.3, 0.3] },
  ],
};
