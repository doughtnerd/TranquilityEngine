/**
 * Shakes a camera's view (ADR 0436): put it on a camera node. It hears the impulses `ShakeImpulseSource`s, scripts and
 * systems send (`ShakeImpulses`) that reach it, adds its own continuous noise, and moves only the drawn view (through
 * `CameraViewOffset`): the camera's Transform, the audio listener and camera rays keep the node's pose. Like
 * Cinemachine's Impulse Listener with Basic Multi-Channel Perlin noise.
 */
import { Component } from "../../../engine/core/Component";
import { Vector3 } from "../../../engine/core/math";
import { component, field } from "../../../engine/core/registry";
import { CAMERA_NOISE_PRESETS, IMPULSE_SHAPES, SHAKE_IMPULSE_PRESETS, type CameraNoisePreset, type ShakeImpulsePreset } from "./presets";

/** A shake on one camera from `shake()`: no position, no falloff. @internal */
export interface LocalShake {
  readonly preset: ShakeImpulsePreset;
  readonly strength: number;
  readonly duration: number;
  /** When it started, on the clock the camera's `timeMode` names. */
  readonly start: number;
}

@component("engine.CameraShake")
export class CameraShake extends Component {
  @field(String, { choices: [...CAMERA_NOISE_PRESETS], description: "Continuous shake: none, a hand holding the camera (subtle, normal, wild), or fast shake on all six axes." })
  noise: CameraNoisePreset = "none";
  @field(Number, { description: "Scales the continuous noise's strength. Key it to fade a shake in and out." })
  amplitudeGain = 1;
  @field(Number, { description: "Scales the continuous noise's speed." })
  frequencyGain = 1;
  @field(Number, { description: "Scales every impulse this camera hears; 0 mutes them." })
  impulseGain = 1;
  @field([String], { description: "The channels it hears. Empty: every channel." })
  channels: string[] = [];
  @field(Vector3, { description: "Weights the shake's movement per axis, in the camera's space." })
  positionScale = new Vector3(1, 1, 1);
  @field(Vector3, { description: "Weights the shake's turning per axis (pitch X, yaw Y, roll Z)." })
  rotationScale = new Vector3(1, 1, 1);
  @field(Boolean, { description: "On: an impulse's direction is read in the camera's space (down is the screen's down). Off: in the world's." })
  useCameraSpace = true;
  @field(Boolean, { description: "Measures the distance to impulses in X and Y only (2D games)." })
  use2DDistance = false;
  @field(String, { choices: ["scaled", "unscaled"], description: "scaled: shake stops while the game is paused (time scale 0); unscaled: it doesn't." })
  timeMode: "scaled" | "unscaled" = "scaled";
  @field(Number, { description: "The noise seed. 0: one derived from the node, so recorded runs replay the same shake." })
  seed = 0;

  /** @internal This frame's shake: position x, y, z, rotation x, y, z (camera space). */
  _offset: number[] = [0, 0, 0, 0, 0, 0];
  /** @internal Shakes from `shake()` still running. */
  _local: LocalShake[] = [];

  /** This frame's shake movement, in the camera's space (world units). */
  get offsetPosition(): Vector3 {
    return new Vector3(this._offset[0]!, this._offset[1]!, this._offset[2]!);
  }

  /** This frame's shake turn, in degrees (pitch X, yaw Y, roll Z). */
  get offsetRotation(): Vector3 {
    return new Vector3(this._offset[3]!, this._offset[4]!, this._offset[5]!);
  }

  /**
   * Shake this camera only, now, with no position or falloff: screen shake for a hit taken, a UI moment. `strength`
   * 1 moves the view about 0.25 world units; `duration` defaults to the preset's.
   */
  shake(preset: ShakeImpulsePreset = "bump", strength = 1, duration?: number): void {
    if (!SHAKE_IMPULSE_PRESETS.includes(preset)) throw new Error(`CameraShake.shake: unknown preset "${preset}" (${SHAKE_IMPULSE_PRESETS.join(", ")}).`);
    const t = this._world.time;
    this._local.push({ preset, strength, duration: duration ?? IMPULSE_SHAPES[preset].duration, start: this.timeMode === "unscaled" ? t.realtimeSinceStartup : t.time });
  }
}
