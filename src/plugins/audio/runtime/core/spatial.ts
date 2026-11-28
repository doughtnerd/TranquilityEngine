// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/distance_effect.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/distance_effect.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/cone_effect.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/cone_effect.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) 2010 Google Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
//
// 1.  Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
// 2.  Redistributions in binary form must reproduce the above copyright
//     notice, this list of conditions and the following disclaimer in the
//     documentation and/or other materials provided with the distribution.
// 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
//     its contributors may be used to endorse or promote products derived
//     from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
// THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Distance (ADR 0157 A1.5) and cone attenuation, on the main thread. The models follow the OpenAL 1.1 specification,
// as Blink's do. All math is double precision, as upstream's; Blink's gfx points are float, so results differ from
// Blink's by float rounding only. Upstream's ClampTo(v, lo, hi) returns lo when v <= lo, hi when v >= hi and v
// otherwise (NaN passes through), as in the audio-dsp port.
//
// ADR 0162 (K4) appends, at the end of this file, the listener frame and voice view main's M3 passes share. That part
// is not ported: it is Myco Engine's own code.

import type { GameObject } from "../../../../engine/scene/GameObject";
import type { World } from "../../../../engine/core/World";
import type { Vec3Like } from "../../../../engine/core/math";
import { DEFAULT_SEND_CURVE, type SendCurve } from "../backend";
import { evalCurve, type Curve } from "../../../../engine/core/curve";
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { DopplerPass } from "./doppler";
import type { OcclusionPass } from "./occlusion";
import type { ZoneManager } from "./zones";

/** A 3D vector or point: [x, y, z]. */
export type Vec3 = readonly [number, number, number];

/** The distance models (upstream `DistanceEffect::ModelType`), named as the AudioSource `rolloff` values are. */
export type DistanceModel = "linear" | "inverse" | "exponential";

// Upstream's ClampTo with the WTF semantics described above. The two-argument form (no maximum) takes
// std::numeric_limits<double>::max() as the maximum.
function clampTo(value: number, min: number, max: number = Number.MAX_VALUE): number {
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

/**
 * Scalar gain for a distance, from a model and its parameters (upstream `DistanceEffect`). Defaults are upstream's:
 * inverse model, refDistance 1, maxDistance 10000, rolloffFactor 1.
 */
export class DistanceEffect {
  model: DistanceModel = "inverse";
  refDistance = 1.0;
  maxDistance = 10000.0;
  rolloffFactor = 1.0;

  /** Gain at `distance` metres under the current model (upstream `DistanceEffect::Gain`). */
  gain(distance: number): number {
    switch (this.model) {
      case "linear":
        return this.linearGain(distance);
      case "inverse":
        return this.inverseGain(distance);
      case "exponential":
        return this.exponentialGain(distance);
    }
  }

  private linearGain(distance: number): number {
    // Clamp refDistance and distance according to the spec.
    const dref = Math.min(this.refDistance, this.maxDistance);
    const dmax = Math.max(this.refDistance, this.maxDistance);
    distance = clampTo(distance, dref, dmax);

    // Upstream returns the unclamped rolloff here, so a rolloff above 1 gives 1 - rolloff (it can be negative).
    if (dref === dmax) {
      return 1 - this.rolloffFactor;
    }

    // A gain that decreases linearly from refDistance to maxDistance. The gain is 1 at refDistance.
    return 1.0 - (clampTo(this.rolloffFactor, 0.0, 1.0) * (distance - dref)) / (dmax - dref);
  }

  private inverseGain(distance: number): number {
    if (this.refDistance === 0) {
      return 0;
    }

    // Clamp distance according to spec (no upper bound: maxDistance does not limit this model).
    distance = clampTo(distance, this.refDistance);

    return this.refDistance / (this.refDistance + clampTo(this.rolloffFactor, 0.0) * (distance - this.refDistance));
  }

  private exponentialGain(distance: number): number {
    if (this.refDistance === 0) {
      return 0;
    }

    // Clamp distance according to spec (no upper bound).
    distance = clampTo(distance, this.refDistance);

    return Math.pow(distance / this.refDistance, -clampTo(this.rolloffFactor, 0.0));
  }
}

/**
 * Cone attenuation from the source's orientation (upstream `ConeEffect`). Angles are whole angles in degrees, as the
 * AudioSource fields will be; the half angles are taken from their absolute values. Defaults are upstream's: both
 * angles 360 (no cone) and an outer gain of 0.
 */
export class ConeEffect {
  innerAngle = 360.0;
  outerAngle = 360.0;
  outerGain = 0.0;

  /**
   * Gain for a listener at `listenerPosition` hearing a source at `sourcePosition` that faces `sourceOrientation`
   * (its length does not matter; a zero vector means no cone). Upstream `ConeEffect::Gain`.
   *
   * Upstream takes the angle from `gfx::AngleBetweenVectorsInDegrees`, which is not staged here; this port takes
   * the arccosine of the clamped normalised dot product, the same angle. A listener exactly at the source has no
   * direction, so its angle is taken as 0 (inside the inner cone); upstream gives NaN there.
   */
  gain(sourcePosition: Vec3, sourceOrientation: Vec3, listenerPosition: Vec3): number {
    if (isZero(sourceOrientation) || (this.innerAngle === 360.0 && this.outerAngle === 360.0)) {
      return 1.0; // no cone specified: unity gain
    }

    // Source-listener vector
    const toListener = sub(listenerPosition, sourcePosition);

    // Angle between the source orientation vector and the source-listener vector
    const angle = angleBetweenDegrees(toListener, sourceOrientation);
    const absAngle = Math.abs(angle);

    // Divide by 2.0 here since the API is the entire angle (not half-angle)
    const absInnerAngle = Math.abs(this.innerAngle) / 2.0;
    const absOuterAngle = Math.abs(this.outerAngle) / 2.0;

    if (absAngle <= absInnerAngle) {
      // No attenuation
      return 1.0;
    }
    if (absAngle >= absOuterAngle) {
      // Max attenuation
      return this.outerGain;
    }
    // Between inner and outer cones: inner -> outer, x goes from 0 -> 1
    const x = (absAngle - absInnerAngle) / (absOuterAngle - absInnerAngle);
    return 1.0 - x + this.outerGain * x;
  }
}

/** A source's position in listener space (see `listenerSpaceDirection`). */
export interface ListenerSpace {
  /**
   * Unit vector from the listener to the source in listener space, which is right-handed like the native HRTF and Web
   * Audio (ADR 0164): -Z is ahead, +X right, +Y up. Zero if coincident.
   */
  direction: Vec3;
  /** Distance from the listener to the source, in the world units of the inputs. */
  distance: number;
}

/**
 * The direction of a source as the listener hears it, and the distance. Inputs are engine world space (left-handed,
 * ADR 0164); the listener's frame is forward (listener-space -Z), up (+Y) and right (+X, up × forward as in the engine's
 * left-handed world). `forward` need not be unit length, and `up` need not be perpendicular to it:
 * the frame is orthonormalised from `forward` and `up`. A degenerate frame (zero forward, or forward parallel to up)
 * gives a zero direction with the true distance.
 */
export function listenerSpaceDirection(source: Vec3, listener: Vec3, forward: Vec3, up: Vec3): ListenerSpace {
  const offset = sub(source, listener);
  const distance = length(offset);
  if (distance === 0) {
    return { direction: [0, 0, 0], distance: 0 };
  }

  const f = length(forward) === 0 ? null : scale(forward, 1 / length(forward));
  const rightRaw = f === null ? [0, 0, 0] as const : cross(up, f); // left-handed: right = up × forward
  const rightLength = length(rightRaw);
  if (f === null || rightLength === 0) {
    return { direction: [0, 0, 0], distance };
  }

  const right = scale(rightRaw, 1 / rightLength);
  const localUp = cross(f, right); // unit: right and forward are orthonormal
  const n = scale(offset, 1 / distance);
  return { direction: [dot(n, right), dot(n, localUp), -dot(n, f)], distance };
}

// --- vector helpers (double precision) ---

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

function isZero(a: Vec3): boolean {
  return a[0] === 0 && a[1] === 0 && a[2] === 0;
}

/** Angle in degrees between two vectors, from the clamped normalised dot product. */
function angleBetweenDegrees(a: Vec3, b: Vec3): number {
  const la = length(a);
  const lb = length(b);
  if (la === 0 || lb === 0) {
    return 0;
  }
  const cos = clampTo(dot(a, b) / (la * lb), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

// --- ADR 0162 (K4): the frame main's M3 passes share (not ported; Myco Engine's own code) --------------------------
//
// The audio system (`audioSystem.ts`) runs the M3 passes in one order for both backends (api-and-models §6,
// architecture §1): attenuation, Doppler, zones, occlusion, audibility × smoothed occlusion, selection, panner pick,
// fx staging, listener. Occlusion and Doppler run on main whatever the backend and read the voices only through a
// `SpatialVoiceView`, never the core's voice table; their results go back through the view (the core routes them into
// `voiceFx` and the dry gain, the Babylon fallback into volume and `playbackRate`, §8). Everything here is
// preallocated; a frame allocates nothing.

/**
 * @internal The listener as this frame's passes see it (R14, S19): the World holding the active listener (only it casts
 * rays, plans zones and sends LISTENER), the listener's node (excluded from rays), its pose, its velocity and the frame's
 * game-time step. The audio system fills it once per frame (`set`) before any pass runs.
 */
export class ListenerFrame {
  /** The World with the view, or null before the first frame. */
  world: World | null = null;
  /** That World's key on the core (0: none). Voices of other Worlds keep their last occlusion values (R14). */
  worldKey = 0;
  /** The listener's node (the first enabled `AudioListener`, else the main camera's), or null without one. */
  node: GameObject | null = null;
  posX = 0;
  posY = 0;
  posZ = 0;
  /** Unit forward (the node's +Z) and up (+Y), world space. */
  fwdX = 0;
  fwdY = 0;
  fwdZ = 1;
  upX = 0;
  upY = 1;
  upZ = 0;
  /**
   * The listener's velocity, world units per second (§3.2): written by the Doppler pass (D3) from the pose history, or
   * taken from the override below; 0 until D3. `AudioListener.velocity` reads it back.
   */
  velX = 0;
  velY = 0;
  velZ = 0;
  /** §1.4 `AudioListener.setVelocity`: a physics-driven velocity, used instead of the estimate while `hasOverride`. */
  hasOverride = false;
  overrideX = 0;
  overrideY = 0;
  overrideZ = 0;
  /** Game-time seconds since the previous frame (0 while `Time.scale` is 0). */
  dt = 0;
  /** A camera cut this frame (the listener jumped): LISTENER snaps (C4) and Doppler resets its history (§3.2). D3 and B5 set and read it. */
  cut = false;
  /** Frames since the audio system started (the passes' clock for ages and dwell). */
  frame = 0;

  /** The frame's listener (once per frame, before the passes). A null `pose` keeps the last pose. */
  set(world: World | null, worldKey: number, node: GameObject | null, pose: { position: Vec3Like; forward: Vec3Like; up: Vec3Like } | null, dt: number): void {
    this.world = world;
    this.worldKey = worldKey;
    this.node = node;
    if (pose) {
      this.posX = pose.position.x;
      this.posY = pose.position.y;
      this.posZ = pose.position.z;
      this.fwdX = pose.forward.x;
      this.fwdY = pose.forward.y;
      this.fwdZ = pose.forward.z;
      this.upX = pose.up.x;
      this.upY = pose.up.y;
      this.upZ = pose.up.z;
    }
    this.dt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.cut = false; // a cut is a per-frame event: the Doppler pass (D3) sets it after this, the listener stage (B5) reads it
    this.frame++;
  }

  /** §1.4: `setVelocity(v)` (a physics-driven velocity, or zero across a cut); null goes back to the estimate. */
  setOverride(v: Vec3Like | null): void {
    this.hasOverride = v !== null;
    this.overrideX = v ? v.x : 0;
    this.overrideY = v ? v.y : 0;
    this.overrideZ = v ? v.z : 0;
  }
}

/** @internal `SpatialVoiceView.viewFlags` bits, computed per listed slot each frame by the view. */
export const SpatialViewFlag = {
  /** Positioned (has a world position and attenuation). */
  SPATIAL: 1 << 0,
  /** Mixed (heard) this frame; otherwise virtual. */
  MIXED: 1 << 1,
  /** Walls may muffle it (§1.2 `occlusion`: a positioned, non-ambisonic voice with occlusion on). */
  OCCLUSION: 1 << 2,
  /** An ambisonic clip: no position, occlusion or Doppler; zones use the listener's weights. */
  AMBISONIC: 1 << 3,
  /** It may send to zones (`reverbSend` > 0). */
  SENDS: 1 << 4,
} as const;

/**
 * @internal What main's backend-agnostic passes (Doppler, zones, occlusion) read of the voices, and how they hand back
 * their results. Arrays are indexed by slot, `capacity` long; only the `count` slots in `slots` are live this frame
 * (refreshed by `SpatialPassHost.collectSpatialVoices` before the passes run). A slot whose `gen` changed holds a new
 * voice: per-slot pass state restarts (a voice's first occlusion result applies at once). The core implements it over
 * its voice table (`coreBackend.ts`); the Babylon fallback over its own voices (F1).
 */
export interface SpatialVoiceView {
  readonly capacity: number;
  /** This frame's live voices on the backend (every kind: spatial, flat, ambisonic), `count` valid. */
  readonly slots: Uint16Array;
  readonly count: number;
  /** Per slot: changes when the slot holds a new voice. */
  readonly gen: ArrayLike<number>;
  /** Per slot: `SpatialViewFlag` bits. */
  readonly viewFlags: ArrayLike<number>;
  /** Per slot: the voice's World key (R14: only the listener World's voices are cast and planned). */
  readonly world: ArrayLike<number>;
  /** Per slot: world position (spatial voices). */
  readonly posX: ArrayLike<number>;
  readonly posY: ArrayLike<number>;
  readonly posZ: ArrayLike<number>;
  /** Per slot: attenuation distances (the send curve's x axis, §1.1). */
  readonly minDist: ArrayLike<number>;
  readonly maxDist: ArrayLike<number>;
  /** Per slot: the voice's own volume (a send's level, [ARCH §3.3]). */
  readonly volume: ArrayLike<number>;
  /** Per slot: audibility before occlusion (occlusion's ranking, [ARCH §3.2]); 0 for a forced-virtual voice. */
  readonly audibility0: ArrayLike<number>;
  /** Per slot: §1.2 `dopplerLevel` 0..5. */
  readonly dopplerLevel: ArrayLike<number>;
  /** Per slot: §1.2 `reverbSend` 0..2. */
  readonly reverbSend: ArrayLike<number>;
  /** Per slot: the send curve's index in `curves`. */
  readonly sendCurve: ArrayLike<number>;
  /** The interned send curves (index 0 is `DEFAULT_SEND_CURVE`). */
  readonly curves: SendCurveTable;
  /** Main's smoothed occlusion for slot `i`: `gain` dry (1 open), `lpHz` the cutoff it asks for (≥ 20000 off). */
  setOcclusion(i: number, gain: number, lpHz: number): void;
  /** Main's clamped Doppler factor for slot `i` (1 none). */
  setDopplerRate(i: number, factor: number): void;
}

/** @internal Distinct send curves a session interns before new ones fall back to the default (C5 warns once). */
export const MAX_SEND_CURVES = 1024;

const curveKey = (c: SendCurve): string => c.map((p) => `${p[0]},${p[1]}`).join(";");

/** @internal Interned send curves (§1.1 `SendCurve`): voices hold an index; index 0 is `DEFAULT_SEND_CURVE`. */
export class SendCurveTable {
  /** Index → curve. Grows only when a play brings a curve not seen before; bounded by `MAX_SEND_CURVES`. */
  readonly list: SendCurve[] = [DEFAULT_SEND_CURVE];
  private readonly keys = new Map<string, number>([[curveKey(DEFAULT_SEND_CURVE), 0]]);

  /** The index of `curve` (equal curves share one), or 0 for `undefined`, an empty curve or a full table. */
  intern(curve: SendCurve | undefined): number {
    if (!curve || !Array.isArray(curve) || curve.length === 0) return 0;
    const key = curveKey(curve);
    const known = this.keys.get(key);
    if (known !== undefined) return known;
    if (this.list.length >= MAX_SEND_CURVES) return 0;
    const index = this.list.length;
    this.list.push(curve.map((p) => [p[0], p[1]] as [number, number]));
    this.keys.set(key, index);
    return index;
  }

  /** Curve `index` (the default for an unknown index). */
  get(index: number): SendCurve {
    return this.list[index] ?? DEFAULT_SEND_CURVE;
  }
}

/**
 * @internal What the audio system needs of a backend to run main's backend-agnostic passes on it (both backends): the
 * view and the passes, which the backend constructs (the core in `coreBackend.ts`; the Babylon fallback in F1).
 */
export interface SpatialPassHost {
  readonly spatialVoices: SpatialVoiceView;
  readonly doppler: DopplerPass;
  readonly occlusion: OcclusionPass;
  /**
   * ADR 0264: the reverb zone pass. The core's plans and sends zones (`zones.ts`); the Babylon fallback's is inert and
   * warns once when the World has an enabled zone (F2: no insertion point for a convolver).
   */
  readonly zones: ZonePass;
  /** Refreshes `spatialVoices` for this frame (its slot list and flags). Runs after attenuation, before Doppler. */
  collectSpatialVoices(): void;
  /**
   * ADR 0264 (D3, `AudioSource.velocity`): voice `id`'s velocity in world units per second (the Doppler pass's estimate,
   * or `setVelocity`'s value) into `out`; false when the voice is gone.
   */
  velocityOf(id: number, out: Vec3Like): boolean;
}

/** @internal ADR 0264: a reverb zone pass, run once per frame after Doppler (`SpatialPassHost.zones`). */
export interface ZonePass {
  run(frame: ListenerFrame, view: SpatialVoiceView, settings: Pick<AudioSettings, "zones" | "buses">): void;
}

/**
 * @internal The core backend's frame, split at the passes so the whole M3 order is written once: these stages are the
 * contract between the core and the frame step (`audioFrame.ts` `runAudioFrame`, ADR 0270), their only caller.
 */
export interface StagedFrameHost extends SpatialPassHost {
  readonly zones: ZoneManager;
  /** Frame start (clock, mirror, ended voices, clip events, replay, unlock) and attenuation: gain, direction, `audibility0`. */
  frameAttenuate(dt: number): void;
  /** Audibility = `audibility0` × `occGain`, then selection (SET_MIXED; a promote re-sends the voice's fx). */
  frameSelect(): void;
  /** The panner kind per voice (`pannerPick.ts`). */
  framePickPanners(): void;
  /** Per-voice fx changes past their thresholds (`voiceFx.ts`: SET_PARAMS lpHz, SET_VOICE_FX). */
  frameStageFx(): void;
  /** LISTENER when the rotation moved (`listener.ts`). */
  frameStageListener(frame: ListenerFrame): void;
  /** Idle check, the table's queued commands, and the frame's BATCH. */
  frameCommit(): void;
}

/** @internal Whether `b` runs main's passes (`SpatialPassHost`). */
export const isSpatialPassHost = (b: unknown): b is SpatialPassHost =>
  b !== null && typeof b === "object" && typeof (b as Partial<SpatialPassHost>).collectSpatialVoices === "function";

/** @internal Whether `b` splits its frame at the passes (`StagedFrameHost`: the core backend). */
export const isStagedFrameHost = (b: unknown): b is StagedFrameHost =>
  isSpatialPassHost(b) && typeof (b as Partial<StagedFrameHost>).frameAttenuate === "function";

// --- ADR 0347: attenuation curves and upright boxes (Myco Engine's own code) ----------------------------------------
//
// A playlist's attenuation (`engine/audio/attenuation`) is four curves over distance in metres: volume (dB), low-pass
// (Hz), reverb send (dB) and spread (degrees). The playlist runtime evaluates them here per frame for each spatial plan
// and hands the results to its voices through their own parameters: volume as a gain factor of the voice's volume,
// low-pass through the voice's filter, reverb send through the voice's send level. The voice itself plays with
// `CURVE_DRIVEN_ATTENUATION`, so the distance law above adds nothing on top of the curves.

/**
 * @internal The distance law a curve-driven voice plays with: the inverse law with its reference distance at the
 * format's farthest distance, so the law's gain is exactly 1 at any distance a scene has (both backends clamp the
 * distance up to the reference). The curves' volume reaches the voice as its volume.
 */
export const CURVE_DRIVEN_ATTENUATION = Object.freeze({ minDistance: 100000, maxDistance: 100000, rolloff: "inverse" as const });

/** @internal The distance law of a voice that names none (ADR 0162's default distances and law): inverse, 1 m to 100 m. */
export const DEFAULT_ROLLOFF_ATTENUATION = Object.freeze({ minDistance: 1, maxDistance: 100, rolloff: "inverse" as const });

/** @internal The send curve a curve-driven voice plays with: flat 1, so the `reverbSend` curve alone shapes its send. */
export const FLAT_SEND_CURVE: SendCurve = [[0, 1], [1, 1]];

/** The attenuation curves as the runtime reads them (the parsed `Attenuation`'s `curves`). */
export interface AttenuationCurveSet {
  readonly volume?: Curve;
  readonly lowpass?: Curve;
  readonly reverbSend?: Curve;
  readonly spread?: Curve;
}

/** What an attenuation gives at one distance. A missing curve gives its neutral value. */
export interface AttenuationAt {
  /** dB, 0 without a volume curve. */
  volumeDb: number;
  /** Hz, `LOWPASS_OFF_HZ` without a low-pass curve. */
  lowpassHz: number;
  /** dB added to the voice's reverb send, 0 without a curve. */
  reverbSendDb: number;
  /** Degrees 0..360, or -1 without a spread curve (the voice's own spread stays). */
  spreadDeg: number;
}

/** A cutoff at or above this is "no low-pass". */
export const LOWPASS_OFF_HZ = 24000;

/** The curves of `curves` at `distance` metres into `out` (no allocation). Beyond the last key a curve holds. */
export function evalAttenuation(curves: AttenuationCurveSet, distance: number, out: AttenuationAt): AttenuationAt {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  out.volumeDb = curves.volume && curves.volume.length > 0 ? evalCurve(curves.volume, d) : 0;
  out.lowpassHz = curves.lowpass && curves.lowpass.length > 0 ? evalCurve(curves.lowpass, d) : LOWPASS_OFF_HZ;
  out.reverbSendDb = curves.reverbSend && curves.reverbSend.length > 0 ? evalCurve(curves.reverbSend, d) : 0;
  out.spreadDeg = curves.spread && curves.spread.length > 0 ? Math.min(360, Math.max(0, evalCurve(curves.spread, d))) : -1;
  return out;
}

/**
 * ADR 0347: an edge audio zone heard from outside spreads its sound by distance: `min(180°, 40° + 600°/max(3 m, d))`
 * (wide up close, narrowing to 40° far away).
 */
export function audioZoneEdgeSpread(distance: number): number {
  const d = Number.isFinite(distance) ? Math.max(3, distance) : 3;
  return Math.min(180, 40 + 600 / d);
}

/**
 * An upright box (ADR 0347 audio zones, test-scene obstacles): a rectangle turned by `yaw` about the vertical, with a
 * vertical extent. World space (x right, y up, z forward); `yaw` turns the box's +z toward +x (clockwise seen from
 * above, as every turn, ADR 0164).
 */
export class UprightBox {
  cx = 0;
  cz = 0;
  halfWidth = 5;
  halfDepth = 5;
  bottom = 0;
  top = 10;
  private cos = 1;
  private sin = 0;

  /** Sets the box: centre (x, z), size, yaw in degrees and the vertical extent. */
  set(cx: number, cz: number, width: number, depth: number, yawDeg: number, bottom: number, top: number): this {
    this.cx = cx;
    this.cz = cz;
    this.halfWidth = Math.max(0, width) / 2;
    this.halfDepth = Math.max(0, depth) / 2;
    const r = (yawDeg * Math.PI) / 180;
    this.cos = Math.cos(r);
    this.sin = Math.sin(r);
    this.bottom = Math.min(bottom, top);
    this.top = Math.max(bottom, top);
    return this;
  }

  /** `(x, z)` in the box's frame: local x along its width, local z along its depth. */
  private localX(x: number, z: number): number { return (x - this.cx) * this.cos - (z - this.cz) * this.sin; }
  private localZ(x: number, z: number): number { return (x - this.cx) * this.sin + (z - this.cz) * this.cos; }

  /** The world point `(lx, lz)` of the box's frame (local x along the width, z along the depth) into `out.x`/`out.z`. */
  toWorld(lx: number, lz: number, out: { x: number; z: number }): void {
    out.x = this.cx + lx * this.cos + lz * this.sin;
    out.z = this.cz - lx * this.sin + lz * this.cos;
  }

  /** Whether the point is inside (edges included). */
  contains(x: number, y: number, z: number): boolean {
    return y >= this.bottom && y <= this.top && Math.abs(this.localX(x, z)) <= this.halfWidth && Math.abs(this.localZ(x, z)) <= this.halfDepth;
  }

  /** The box's nearest point to `(x, y, z)` into `out` (the point itself when inside); returns the distance to it. */
  nearest(x: number, y: number, z: number, out: { x: number; y: number; z: number }): number {
    const lx = Math.min(this.halfWidth, Math.max(-this.halfWidth, this.localX(x, z)));
    const lz = Math.min(this.halfDepth, Math.max(-this.halfDepth, this.localZ(x, z)));
    out.x = this.cx + lx * this.cos + lz * this.sin;
    out.z = this.cz - lx * this.sin + lz * this.cos;
    out.y = Math.min(this.top, Math.max(this.bottom, y));
    return Math.hypot(x - out.x, y - out.y, z - out.z);
  }

  /**
   * How deep inside the point is, seen from above: 0 at (or outside) the edge, 1 at the centre line, as
   * `min(halfWidth − |lx|, halfDepth − |lz|) / min(halfWidth, halfDepth)`. The vertical extent is not part of it.
   */
  depth(x: number, z: number): number {
    const m = Math.min(this.halfWidth, this.halfDepth);
    if (!(m > 0)) return 0;
    const inner = Math.min(this.halfWidth - Math.abs(this.localX(x, z)), this.halfDepth - Math.abs(this.localZ(x, z)));
    return Math.min(1, Math.max(0, inner / m));
  }
}
