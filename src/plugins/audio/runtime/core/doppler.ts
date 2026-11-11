// Doppler on main (ADR 0162; api-and-models §3.2 "Velocity estimate", architecture §3.6). Runs for both backends, after
// attenuation and before zones and occlusion, over a `SpatialVoiceView` (never the core's voice table); it hands each
// voice's clamped factor back through `view.setDopplerRate` (the core folds it into the pitch it sends, the Babylon
// fallback into `playbackRate`, decoded clips only, §8).
//
// Per-voice velocity `(p - prev) / dt` with `dt` from game time (zero while `Time.scale` is 0: no estimate that frame),
// one-pole 60 ms; a step faster than `audio.doppler.maxSpeed` is a teleport (velocity 0 for 3 frames,
// `dopplerTeleports`); `dt` above 0.25 s resets every velocity (hidden tab, debugger: `dopplerGuardTrips`); the
// listener's velocity the same way into `ListenerFrame.vel*` unless it has an override (`AudioListener.setVelocity`),
// and a listener teleport or reset sets `frame.cut` (B5 snaps LISTENER); the factor is OpenAL's
// f = (c - L*vl) / (c - L*vs), velocities projected on the source -> listener axis and capped at c / L, clamped 0.5..2
// (`dopplerClamps`), L = `dopplerLevel` (one-shots default 0: listener motion only when > 0), c = `audio.speedOfSound`;
// a voice's own `setVelocity` bypasses the estimate.
import type { Vec3Like } from "../../../../engine/core/math";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { SpatialViewFlag, type ListenerFrame, type SpatialVoiceView } from "./spatial";

/** @internal §3.6: the factor's clamp. */
export const DOPPLER_MIN_FACTOR = 0.5;
export const DOPPLER_MAX_FACTOR = 2;
/** A factor changing by less than this is not handed back again (the core retimes and sends SET_PARAMS per change). */
const FACTOR_EPSILON = 1e-4;

/**
 * @internal The OpenAL factor (api-and-models §3.2): `c` the speed of sound, `level` the source's `dopplerLevel`,
 * `vl` and `vs` the listener's and source's velocities projected on the source -> listener axis (positive: toward the
 * listener for the source, away from the source for the listener, as OpenAL's `SL`). Each projection is capped at
 * `c / level` (OpenAL), the result clamped 0.5..2. `clamped` reports whether the clamp or a cap acted.
 */
export function dopplerFactor(c: number, level: number, vl: number, vs: number): { factor: number; clamped: boolean } {
  if (!(level > 0) || !(c > 0)) return { factor: 1, clamped: false };
  const cap = c / level;
  const l = Math.min(vl, cap);
  const s = Math.min(vs, cap);
  const den = c - level * s;
  const raw = den > 0 ? (c - level * l) / den : Infinity;
  const factor = Math.min(DOPPLER_MAX_FACTOR, Math.max(DOPPLER_MIN_FACTOR, raw));
  return { factor, clamped: factor !== raw || l !== vl || s !== vs };
}
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

  /** Per slot: the position last frame, the voice generation it belongs to, frames left holding velocity 0. */
  private readonly prevX: Float32Array;
  private readonly prevY: Float32Array;
  private readonly prevZ: Float32Array;
  private readonly hasPrev: Uint8Array;
  private readonly gens: Int32Array;
  private readonly hold: Uint8Array;
  /** The listener's history. */
  private lPrevX = 0;
  private lPrevY = 0;
  private lPrevZ = 0;
  private lHasPrev = false;
  private lHold = 0;
  private lNode: unknown = null;
  private lWorldKey = 0;

  constructor(readonly capacity: number) {
    this.factor = new Float32Array(capacity).fill(1);
    this.hasOverride = new Uint8Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velY = new Float32Array(capacity);
    this.velZ = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.prevZ = new Float32Array(capacity);
    this.hasPrev = new Uint8Array(capacity);
    this.gens = new Int32Array(capacity).fill(-1);
    this.hold = new Uint8Array(capacity);
  }

  /**
   * The frame step (D3): the listener's velocity into `frame.vel*` (and `frame.cut` on a teleport or reset), each spatial
   * voice's velocity, then its factor, handed back through `view.setDopplerRate` when it changed.
   */
  run(frame: ListenerFrame, view: SpatialVoiceView, settings: Pick<AudioSettings, "doppler" | "speedOfSound">): void {
    const dt = frame.dt;
    const maxSpeed = settings.doppler.maxSpeed;
    const c = settings.speedOfSound;
    const reset = dt > DOPPLER_RESET_DT_SECONDS;
    if (reset) this.counters.dopplerGuardTrips++;
    const alpha = dt > 0 ? 1 - Math.exp(-dt / DOPPLER_SMOOTHING_SECONDS) : 0;
    // The listener.
    if (frame.world === null || frame.node === null) {
      this.lHasPrev = false;
      frame.velX = frame.velY = frame.velZ = 0;
    } else {
      const jumped = this.lHasPrev && (frame.node !== this.lNode || frame.worldKey !== this.lWorldKey);
      this.lNode = frame.node;
      this.lWorldKey = frame.worldKey;
      if (reset || jumped) {
        this.lHasPrev = false;
        this.lHold = 0;
        frame.velX = frame.velY = frame.velZ = 0;
        if (reset) frame.cut = true;
      }
      if (this.lHasPrev && dt > 0) {
        const rx = (frame.posX - this.lPrevX) / dt;
        const ry = (frame.posY - this.lPrevY) / dt;
        const rz = (frame.posZ - this.lPrevZ) / dt;
        if (Math.hypot(rx, ry, rz) > maxSpeed) {
          this.counters.dopplerTeleports++;
          this.lHold = DOPPLER_TELEPORT_HOLD_FRAMES;
          frame.velX = frame.velY = frame.velZ = 0;
          frame.cut = true;
        } else if (this.lHold > 0) {
          this.lHold--;
          frame.velX = frame.velY = frame.velZ = 0;
        } else {
          frame.velX += (rx - frame.velX) * alpha;
          frame.velY += (ry - frame.velY) * alpha;
          frame.velZ += (rz - frame.velZ) * alpha;
        }
      }
      if (dt > 0 || !this.lHasPrev) {
        this.lPrevX = frame.posX;
        this.lPrevY = frame.posY;
        this.lPrevZ = frame.posZ;
        this.lHasPrev = true;
      }
      if (frame.hasOverride) {
        frame.velX = frame.overrideX;
        frame.velY = frame.overrideY;
        frame.velZ = frame.overrideZ;
      }
    }
    // The voices.
    const hasListener = frame.world !== null && frame.node !== null;
    for (let k = 0; k < view.count; k++) {
      const i = view.slots[k]!;
      const gen = view.gen[i]!;
      if (this.gens[i] !== gen) {
        this.gens[i] = gen;
        this.hasPrev[i] = 0;
        this.hold[i] = 0;
        if (!this.hasOverride[i]) this.velX[i] = this.velY[i] = this.velZ[i] = 0;
      }
      if (!(view.viewFlags[i]! & SpatialViewFlag.SPATIAL) || !hasListener || view.world[i] !== frame.worldKey) {
        this.hasPrev[i] = 0;
        this.give(view, i, 1);
        continue;
      }
      const px = view.posX[i]!;
      const py = view.posY[i]!;
      const pz = view.posZ[i]!;
      if (!this.hasOverride[i]) {
        if (reset) {
          this.hasPrev[i] = 0;
          this.hold[i] = 0;
          this.velX[i] = this.velY[i] = this.velZ[i] = 0;
        }
        if (this.hasPrev[i] && dt > 0) {
          const rx = (px - this.prevX[i]!) / dt;
          const ry = (py - this.prevY[i]!) / dt;
          const rz = (pz - this.prevZ[i]!) / dt;
          if (Math.hypot(rx, ry, rz) > maxSpeed) {
            this.counters.dopplerTeleports++;
            this.hold[i] = DOPPLER_TELEPORT_HOLD_FRAMES;
            this.velX[i] = this.velY[i] = this.velZ[i] = 0;
          } else if (this.hold[i]! > 0) {
            this.hold[i]!--;
            this.velX[i] = this.velY[i] = this.velZ[i] = 0;
          } else {
            this.velX[i] += (rx - this.velX[i]!) * alpha;
            this.velY[i] += (ry - this.velY[i]!) * alpha;
            this.velZ[i] += (rz - this.velZ[i]!) * alpha;
          }
        }
      }
      if (dt > 0 || !this.hasPrev[i]) {
        this.prevX[i] = px;
        this.prevY[i] = py;
        this.prevZ[i] = pz;
        this.hasPrev[i] = 1;
      }
      const level = view.dopplerLevel[i]!;
      if (!(level > 0)) {
        this.give(view, i, 1);
        continue;
      }
      // Source -> listener axis.
      const ax = frame.posX - px;
      const ay = frame.posY - py;
      const az = frame.posZ - pz;
      const len = Math.hypot(ax, ay, az);
      if (!(len > 0)) {
        this.give(view, i, 1);
        continue;
      }
      const vs = (this.velX[i]! * ax + this.velY[i]! * ay + this.velZ[i]! * az) / len;
      const vl = (frame.velX * ax + frame.velY * ay + frame.velZ * az) / len;
      const r = dopplerFactor(c, level, vl, vs);
      if (r.clamped) this.counters.dopplerClamps++;
      this.give(view, i, r.factor);
    }
  }

  /** Hands slot `i`'s factor back when it moved by more than the epsilon (or returned to exactly 1). */
  private give(view: SpatialVoiceView, i: number, f: number): void {
    const last = this.factor[i]!;
    if (f === last || (f !== 1 && Math.abs(f - last) < FACTOR_EPSILON)) return;
    this.factor[i] = f;
    view.setDopplerRate(i, f);
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
    this.hasPrev[i] = 0;
    this.hold[i] = 0;
    this.gens[i] = -1;
    this.hasOverride[i] = 0;
    this.velX[i] = 0;
    this.velY[i] = 0;
    this.velZ[i] = 0;
  }
}
