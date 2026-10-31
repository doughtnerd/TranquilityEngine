import { World } from "./World";

/** Frame timing for the active world (ADR 0011). */
export class Time {
  /** Scaled seconds since the last frame (0 while paused). */
  static get deltaTime(): number { return World.require().time.deltaTime; }
  /** Real seconds since the last frame, clamped to `maxFrameTime`. */
  static get unscaledDeltaTime(): number { return World.require().time.unscaledDeltaTime; }
  /** Seconds per fixed step (default 1/60). */
  static get fixedDeltaTime(): number { return World.require().time.fixedDeltaTime; }
  static set fixedDeltaTime(value: number) { World.require().time.fixedDeltaTime = value; }
  /** Scaled seconds since the world started. */
  static get time(): number { return World.require().time.time; }
  static get fixedTime(): number { return World.require().time.fixedTime; }
  /** 0..1 progress between fixed steps. */
  static get fixedAlpha(): number { return World.require().time.fixedAlpha; }
  /** 1 = normal speed, 0 = paused (fixed steps stop; update keeps running with deltaTime 0). */
  static get timeScale(): number { return World.require().time.timeScale; }
  static set timeScale(value: number) { World.require().time.timeScale = Math.max(0, value); }
  static get frameCount(): number { return World.require().time.frameCount; }
  static get realtimeSinceStartup(): number { return World.require().time.realtimeSinceStartup; }
}
