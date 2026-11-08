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
 *
 * Part of the Sky plugin's runtime half (ADR 0135): registered for the plugin when it activates.
 */
import { Component } from "../../../engine/core/Component";
import { Vector3 } from "../../../engine/core/math";
import { component, field } from "../../../engine/core/registry";
import type { World } from "../../../engine/core/World";
import { readSkyAsset, worldSkyPath } from "../../../engine/sky/skyAsset";
import { cloneSky, type SkySettings } from "../../../engine/sky/skyFormat";
import { bodyDirections, skyLight } from "../../../engine/sky/skyMath";

const wrap24 = (h: number) => ((h % 24) + 24) % 24;

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
  private _source: SkySettings | null = null;
  private seenTime = Number.NaN;
  private seenSpeed = Number.NaN;
  private seenAssetTime = Number.NaN;
  private anchorTime = 0;
  private anchorHour = 0;

  /**
   * The sky's live settings: a copy of the World's sky asset that scripts change freely (the renderer
   * reads it each frame and rebakes lighting as needed). Assigning a new object replaces it. Reads the
   * asset again if the Environment's sky changes.
   */
  get settings(): SkySettings {
    const path = this._node ? worldSkyPath(this._world) : "";
    // A new sky, or the asset itself changed (edited in the editor's Sky panel): copy it again.
    const source = path ? readSkyAsset(path) : null;
    if (!this._settings || path !== this._settingsPath || (source && this._source && source !== this._source)) {
      this._settings = cloneSky(source ?? readSkyAsset(""));
      this._settingsPath = path;
      this._source = source;
    }
    return this._settings;
  }

  set settings(value: SkySettings) {
    this._settings = value;
    this._settingsPath = this._node ? worldSkyPath(this._world) : "";
    this._source = this._settingsPath ? readSkyAsset(this._settingsPath) : null;
  }

  /** Throw away script changes to `settings`: the next read takes the asset as saved. */
  resetSettings(): void {
    this._settings = null;
  }

  /** The time of day now, 0–24: `timeOfDay` (or the asset's) advanced by `daySpeed` since it was set. */
  get currentTime(): number {
    const now = this._node ? this._world.time.time : 0;
    // Following the asset's time (timeOfDay -1): a new asset time (another sky, an edit) restarts from it.
    const assetTime = this.timeOfDay < 0 ? this.settings.sun.timeOfDay : Number.NaN;
    const newAsset = this.timeOfDay < 0 && assetTime !== this.seenAssetTime;
    if (this.timeOfDay !== this.seenTime || this.daySpeed !== this.seenSpeed || newAsset) {
      // Re-anchor: on a new time, start from it; on a new speed alone, carry on from where the sky is.
      const from = this.timeOfDay !== this.seenTime || newAsset || Number.isNaN(this.seenSpeed) ? this.baseHour() : this.hourAt(now);
      this.seenAssetTime = assetTime;
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

/** @internal The World's first active Sky, or null (the sky render feature's live sky). */
export function worldSky(world: World): Sky | null {
  return world._componentsOfType(Sky).find((s) => s.isActiveAndEnabled) ?? null;
}
