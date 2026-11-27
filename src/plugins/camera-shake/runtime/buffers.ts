/**
 * The `ShakeImpulses` buffer (ADR 0017, 0436): every camera shake impulse goes in here, whether a
 * `ShakeImpulseSource`, a script or a system made it. `cameraShake.Listen` takes this frame's records in `lateUpdate`
 * (after `lateUpdate()` scripts and `cameraShake.Sources`), so push from fixedUpdate, update, lateUpdate scripts or a
 * system ordered before it; the buffer clears at the end of the frame.
 */
import { defineBuffer } from "../../../engine/core/data";
import type { Vec3Input } from "../../../engine/core/math";
import type { ShakeImpulsePreset } from "./presets";

export interface ShakeImpulse {
  /** Where it starts, in world space. */
  readonly position: Vec3Input;
  /** Its direction times its force (force 1 moves the view about 0.25 world units). */
  readonly velocity: Vec3Input;
  /** Its shape. Default `"bump"`. */
  readonly preset?: ShakeImpulsePreset;
  /** Seconds; default the preset's. */
  readonly duration?: number;
  /** Full strength within this distance. Default 0. */
  readonly radius?: number;
  /** Beyond `radius` the strength falls to zero over this distance. Default 100. */
  readonly dissipationDistance?: number;
  /** World units a second it travels outward; 0 (default) reaches every listener at once. */
  readonly propagationSpeed?: number;
  /** The channel; `""` (default) is heard by every listener. */
  readonly channel?: string;
}

export const ShakeImpulses = defineBuffer<ShakeImpulse>("cameraShake.Impulses");
