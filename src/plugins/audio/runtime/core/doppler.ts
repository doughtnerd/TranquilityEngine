// Doppler on main (ADR 0162; api-and-models §3.2 "Velocity estimate", architecture §3.6). Runs for both backends, after
// attenuation and before zones and occlusion, over a `SpatialVoiceView` (never the core's voice table); it hands each
// voice's clamped factor back through `view.setDopplerRate` (the core folds it into the pitch it sends, the Babylon
// fallback into `playbackRate`, decoded clips only, §8).
//
// D3 fills this file: per-voice velocity `(p - prev) / dt` with `dt` from game time (zero while `Time.scale` is 0),
// one-pole 60 ms; a step faster than `audio.doppler.maxSpeed` is a teleport (velocity 0 for 3 frames,
// `dopplerTeleports`); `dt` above 0.25 s resets every velocity (hidden tab, debugger); the listener's velocity the same
// way into `ListenerFrame.vel*` unless it has an override (`AudioListener.setVelocity`); the factor
// f = (c - L·vl) / (c - L·vs) along the source-listener axis, clamped 0.5..2 (`dopplerClamps`), L = `dopplerLevel`,
// c = `audio.speedOfSound`; a voice's own `setVelocity` bypasses the estimate.
//
// K4 (the skeleton): no velocity is estimated and every factor stays 1, so nothing is handed back.
import type { Vec3Like } from "../../../../engine/core/math";
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { ListenerFrame, SpatialVoiceView } from "./spatial";

/** @internal §3.6: the factor's clamp. */
export const DOPPLER_MIN_FACTOR = 0.5;
export const DOPPLER_MAX_FACTOR = 2;
/** @internal §3.2: the velocity smoothing's time constant, seconds. */
export const DOPPLER_SMOOTHING_SECONDS = 0.06;
/** @internal §3.2: a frame step longer than this resets every velocity (hidden tab, debugger). */
export const DOPPLER_RESET_DT_SECONDS = 0.25;
/** @internal §3.2: frames a teleported voice holds velocity 0. */
export const DOPPLER_TELEPORT_HOLD_FRAMES = 3;

/** @internal The Doppler pass's counters for `Audio.debug()` (C24). */
export interface DopplerCounters {
  dopplerClamps: number;
  dopplerTeleports: number;
  dopplerGuardTrips: number;
}

/** @internal The Doppler pass over one backend's voices (constructed by the backend, run by the audio system). */
export class DopplerPass {
  readonly counters: DopplerCounters = { dopplerClamps: 0, dopplerTeleports: 0, dopplerGuardTrips: 0 };
  /** Per slot: the factor last handed back (1 none). */
  readonly factor: Float32Array;
  /** Per slot: 1 while the voice's velocity comes from `setVelocity`, not the estimate. */
  readonly hasOverride: Uint8Array;
  /** Per slot: the velocity, world units per second (the estimate, or the override). */
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  readonly velZ: Float32Array;

  constructor(readonly capacity: number) {
    this.factor = new Float32Array(capacity).fill(1);
    this.hasOverride = new Uint8Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velY = new Float32Array(capacity);
    this.velZ = new Float32Array(capacity);
  }

  /**
   * The frame step (D3): listener and source velocities from `frame` and `view`, then each spatial voice's factor, handed
   * back through `view.setDopplerRate` when it changed. K4: nothing (every factor is 1).
   */
  run(frame: ListenerFrame, view: SpatialVoiceView, settings: Pick<AudioSettings, "doppler" | "speedOfSound">): void {
    void frame;
    void view;
    void settings;
  }

  /** §1.2 read-only `velocity` and `AudioVoice.setVelocity` (K0): slot `i`'s velocity from physics (bypasses the estimate), or null to estimate again. */
  setVelocity(i: number, v: Vec3Like | null): void {
    if (i < 0 || i >= this.capacity) return;
    this.hasOverride[i] = v ? 1 : 0;
    this.velX[i] = v ? v.x : 0;
    this.velY[i] = v ? v.y : 0;
    this.velZ[i] = v ? v.z : 0;
  }

  /** Slot `i` was freed: its history goes. */
  forget(i: number): void {
    if (i < 0 || i >= this.capacity) return;
    this.factor[i] = 1;
    this.hasOverride[i] = 0;
    this.velX[i] = 0;
    this.velY[i] = 0;
    this.velZ[i] = 0;
  }
}
