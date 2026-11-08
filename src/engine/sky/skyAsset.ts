/**
 * The World's sky asset (ADR 0112): which `*.sky.json` its Environment uses, and that asset's settings.
 * Core, because the renderer's sky and the Sky plugin's `Sky` component (ADR 0135) both read them.
 */
import type { World } from "../core/World";
import { Assets } from "../scene/Assets";
import { Environment } from "../render/components";
import { defaultSky, isSkyPath, parseSky, type SkySettings } from "./skyFormat";

/** @internal The sky asset path of the World's first active Environment, or "" when it has no sky. */
export function worldSkyPath(world: World): string {
  const env = world._componentsOfType(Environment).find((e) => e.isActiveAndEnabled);
  const path = env?.map.replace(/^asset:/, "") ?? "";
  return isSkyPath(path) ? path : "";
}

/** A sky asset's settings as saved, parsed once per JSON object (`Assets.json` caches it); defaults if missing. */
const parsed = new WeakMap<object, SkySettings>();
/** @internal */
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

/**
 * @internal What the renderer's sky reads from the World's live sky control (the Sky plugin's `Sky`
 * component, ADR 0114, 0135): its settings, time of day and rebake requests.
 */
export interface LiveSky {
  readonly settings: SkySettings;
  readonly currentTime: number;
  readonly _rebakes: number;
}
