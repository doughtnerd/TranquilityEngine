/**
 * Sends camera shake impulses from where its node is (ADR 0435), like Cinemachine's Impulse Source: cameras with a
 * `CameraShake` within reach shake. An impulse starts from a script (`generateImpulse()`), from a clip or timeline
 * (key `fire` false → true) or on its own (`trigger`: on start, on an interval, on a collision or trigger contact).
 */
import { Component } from "../../../engine/core/Component";
import { Vector3, type Vec3Input } from "../../../engine/core/math";
import { component, field } from "../../../engine/core/registry";
import { ShakeImpulses } from "./buffers";
import { SHAKE_IMPULSE_PRESETS, type ShakeImpulsePreset } from "./presets";

export type ShakeImpulseTrigger = "script" | "onStart" | "interval" | "collision" | "trigger";

@component("engine.ShakeImpulseSource")
export class ShakeImpulseSource extends Component {
  @field(String, { choices: [...SHAKE_IMPULSE_PRESETS], description: "The impulse's shape: recoil (a kick that eases back), bump (one smooth push), explosion (a hard hit decaying through noise), rumble (a sustained noisy shake)." })
  preset: ShakeImpulsePreset = "bump";
  @field(Number, { description: "Strength. 1 moves the view about 0.25 world units." })
  force = 1;
  @field(Vector3, { description: "The impulse's main axis (normalised when used)." })
  direction = new Vector3(0, -1, 0);
  @field(Number, { description: "Seconds. 0: the preset's own duration." })
  duration = 0;
  @field(String, { choices: ["script", "onStart", "interval", "collision", "trigger"], animatable: false, description: "What sends an impulse besides generateImpulse() and fire: nothing, starting, every interval, a collision (faster than minImpactSpeed) or a trigger contact. Collisions and triggers need the Physics plugin." })
  trigger: ShakeImpulseTrigger = "script";
  @field(Number, { description: "Seconds between impulses, for the interval trigger." })
  interval = 1;
  @field(Number, { description: "Collision trigger: slower contacts send nothing; faster ones scale the force with the impact speed (up to 4×)." })
  minImpactSpeed = 1;
  @field(Number, { description: "Full strength within this distance (world units)." })
  radius = 0;
  @field(Number, { description: "Beyond the radius the strength falls to zero over this distance." })
  dissipationDistance = 100;
  @field(Number, { description: "World units a second the impulse travels outward. 0: it reaches every camera at once." })
  propagationSpeed = 0;
  @field(String, { description: "The channel it sends on. Empty: every camera hears it." })
  channel = "";
  @field(Boolean, { description: "Key it in a clip or timeline: each change from off to on sends one impulse." })
  fire = false;

  /** @internal `fire` when the Sources system last looked. */
  _lastFire = false;
  /** @internal Whether `onStart` has sent its impulse. */
  _startSent = false;
  /** @internal Collision trigger: its body's velocity when the Sources system last looked (before a contact stops it). */
  _lastVelocity: number[] = [0, 0, 0];
  /** @internal Seconds since the last interval impulse. */
  _sinceInterval = 0;

  /**
   * Send an impulse now from the node's position. A number scales `force`; a vector replaces direction × force.
   */
  generateImpulse(force?: number | Vec3Input): void {
    this._world._buffer(ShakeImpulses).push(this._impulse(force)); // into its own World's buffer, whichever World is current
  }

  /** @internal The impulse `generateImpulse(force)` sends. */
  _impulse(force?: number | Vec3Input): Parameters<typeof ShakeImpulses.push>[0] {
    let velocity: Vector3;
    if (force === undefined || typeof force === "number") {
      const d = this.direction;
      const len = Math.hypot(d.x, d.y, d.z);
      const k = (this.force * (force ?? 1)) / (len || 1);
      velocity = len > 0 ? new Vector3(d.x * k, d.y * k, d.z * k) : new Vector3(0, -k, 0);
    } else {
      velocity = Vector3.from(force);
    }
    const e = this.node.entity, m = this._world.worldMatrix(e), o = e * 16;
    return {
      position: [m[o + 12]!, m[o + 13]!, m[o + 14]!],
      velocity,
      preset: this.preset,
      duration: this.duration > 0 ? this.duration : undefined,
      radius: this.radius,
      dissipationDistance: this.dissipationDistance,
      propagationSpeed: this.propagationSpeed,
      channel: this.channel,
    };
  }
}
