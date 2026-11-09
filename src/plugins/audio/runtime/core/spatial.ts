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
  /** Unit vector from the listener to the source in listener space: -Z is ahead, +X right, +Y up. Zero if coincident. */
  direction: Vec3;
  /** Distance from the listener to the source, in the world units of the inputs. */
  distance: number;
}

/**
 * The direction of a source as the listener hears it, and the distance. The listener's frame is forward (-Z), up
 * (+Y) and right (+X, forward x up). `forward` need not be unit length, and `up` need not be perpendicular to it:
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
  const rightRaw = f === null ? [0, 0, 0] as const : cross(f, up);
  const rightLength = length(rightRaw);
  if (f === null || rightLength === 0) {
    return { direction: [0, 0, 0], distance };
  }

  const right = scale(rightRaw, 1 / rightLength);
  const localUp = cross(right, f); // unit: right and forward are orthonormal
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
