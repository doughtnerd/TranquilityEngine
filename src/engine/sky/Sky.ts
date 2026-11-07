/**
 * The `Sky` component (ADR 0114): run-time control of the World's procedural sky — the sky asset
 * (`*.sky.json`, ADR 0112) its Environment uses. Put one anywhere in the World; the first active one
 * wins. Scripts set the time of day, run a day cycle, and change any layer through `settings`:
 *
 * ```ts
 * const sky = this.getComponent(Sky)!;
 * sky.timeOfDay = 18.5;            // jump to dusk
 * sky.daySpeed = 0.1;              // then an hour every 10 seconds of game time
 * sky.settings.clouds[0].coverage = 0.9;
 * ```
 *
 * A World whose Environment has a sky but no Sky component draws the asset as saved.
 */
import { Component } from "../core/Component";
import { Vector3 } from "../core/math";
import { component, field } from "../core/registry";
import { World } from "../core/World";
import { Assets } from "../scene/Assets";
import { Environment } from "../render/components";
import { cloneSky, defaultSky, isSkyPath, parseSky, type SkySettings } from "./skyFormat";
import { bodyDirections, skyLight } from "./skyMath";

const wrap24 = (h: number) => ((h % 24) + 24) % 24;

/** The sky asset path of the World's first active Environment, or "" when it has no sky. */
export function worldSkyPath(world: World): string {
  const env = world._componentsOfType(Environment).find((e) => e.isActiveAndEnabled);
  const path = env?.map.replace(/^asset:/, "") ?? "";
  return isSkyPath(path) ? path : "";
}

/** A sky asset's settings as saved, parsed once per JSON object (`Assets.json` caches it); defaults if missing. */
const parsed = new WeakMap<object, SkySettings>();
export function readSkyAsset(path: string): SkySettings {
  if (!path || !Assets.has(path)) return defaultSky();
  let raw: unknown;
  try {
    raw = Assets.json(path);
  } catch {
    return defaultSky();
  }
  if (!raw || typeof raw !== "object") return parseSky(raw, path).settings;
  let s = parsed.get(raw);
  if (!s) {
    const result = parseSky(raw, path);
    for (const p of result.problems) console.warn(`[myco] ${p.message}`);
    s = result.settings;
    parsed.set(raw, s);
  }
  return s;
}

@component("engine.Sky")
export class Sky extends Component {
  /**
   * The time of day in hours, 0–24, from which the day cycle runs; -1 keeps the sky asset's. Setting
   * it in play jumps the sky there.
   */
  @field(Number) timeOfDay = -1;
  /** Hours the sky advances per second of game time (0 = stopped; 0.1 = a day in 4 minutes). */
  @field(Number) daySpeed = 0;

  /** @internal */ _settings: SkySettings | null = null;
  /** @internal */ _settingsPath = "";
  /** @internal */ _rebakes = 0;
  private seenTime = Number.NaN;
  private seenSpeed = Number.NaN;
  private anchorTime = 0;
  private anchorHour = 0;

  /**
   * The sky's live settings: a copy of the World's sky asset that scripts change freely (the renderer
   * reads it each frame and rebakes lighting as needed). Assigning a new object replaces it. Reads the
   * asset again if the Environment's sky changes.
   */
  get settings(): SkySettings {
    const path = this._node ? worldSkyPath(this.world) : "";
    if (!this._settings || path !== this._settingsPath) {
      this._settings = cloneSky(readSkyAsset(path));
      this._settingsPath = path;
    }
    return this._settings;
  }

  set settings(value: SkySettings) {
    this._settings = value;
    this._settingsPath = this._node ? worldSkyPath(this.world) : "";
  }

  /** Throw away script changes to `settings`: the next read takes the asset as saved. */
  resetSettings(): void {
    this._settings = null;
  }

  /** The time of day now, 0–24: `timeOfDay` (or the asset's) advanced by `daySpeed` since it was set. */
  get currentTime(): number {
    const now = this._node ? this.world.time.time : 0;
    if (this.timeOfDay !== this.seenTime || this.daySpeed !== this.seenSpeed) {
      // Re-anchor: on a new time, start from it; on a new speed alone, carry on from where the sky is.
      const from = this.timeOfDay !== this.seenTime || Number.isNaN(this.seenSpeed) ? this.baseHour() : this.hourAt(now);
      this.seenTime = this.timeOfDay;
      this.seenSpeed = this.daySpeed;
      this.anchorTime = now;
      this.anchorHour = from;
    }
    return this.hourAt(now);
  }

  /** A unit vector towards the sun now. */
  get sunDirection(): Vector3 {
    const d = bodyDirections(this.settings, this.currentTime).sun;
    return new Vector3(d[0], d[1], d[2]);
  }

  /** A unit vector towards the moon now. */
  get moonDirection(): Vector3 {
    const d = bodyDirections(this.settings, this.currentTime).moon;
    return new Vector3(d[0], d[1], d[2]);
  }

  /** The light the sky casts now: the sun, or the moon at night, with its colour (linear) and intensity. */
  get light(): { body: "sun" | "moon"; direction: Vector3; color: [number, number, number]; intensity: number } {
    const l = skyLight(this.settings, this.currentTime);
    return { body: l.body, direction: new Vector3(l.direction[0], l.direction[1], l.direction[2]), color: l.color, intensity: l.intensity };
  }

  /** Rebake the sky's lighting cubemap on the next frame, whatever the rebake thresholds say. */
  rebake(): void {
    this._rebakes++;
  }

  private baseHour(): number {
    return wrap24(this.timeOfDay >= 0 ? this.timeOfDay : this.settings.sun.timeOfDay);
  }

  private hourAt(now: number): number {
    return wrap24(this.anchorHour + this.daySpeed * (now - this.anchorTime));
  }
}

/** The World's first active Sky, or null. */
export function worldSky(world: World): Sky | null {
  return world._componentsOfType(Sky).find((s) => s.isActiveAndEnabled) ?? null;
}
