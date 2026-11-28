/**
 * The World's sky asset (ADR 0112): which `*.sky.json` its Environment uses, and that asset's settings.
 * Core, because the renderer's sky and the Sky plugin's `Sky` component (ADR 0135) both read them.
 */
import type { World } from "../core/World";
import { Assets } from "../scene/Assets";
import { Environment } from "../render/components";
import { defaultSky, isSkyPath, parseSky, type SkySettings } from "./skyFormat";
import { normalizeAssetPath } from "../scene/assetPath";

/** @internal The sky asset path of the World's first active Environment, or "" when it has no sky. */
export function worldSkyPath(world: World): string {
  const env = world._componentsOfType(Environment).find((e) => e.isActiveAndEnabled);
  const path = env ? normalizeAssetPath(env.map) : "";
  return isSkyPath(path) ? path : "";
}

/** A sky asset's settings as saved, parsed once per JSON object (`Assets.json` caches it); defaults if missing. */
const parsed = new WeakMap<object, SkySettings>();
/**
 * The default sky read for a missing, unreadable or non-object asset: one object, so readers that compare what they
 * read (the `Sky` component copies the asset again only when it changes) see no change until the asset arrives.
 */
let fallback: SkySettings | null = null;
const missing = (): SkySettings => (fallback ??= defaultSky());
/** @internal The settings are shared: copy them (`cloneSky`) before changing them. */
export function readSkyAsset(path: string): SkySettings {
  if (!path || !Assets.has(path)) return missing();
  let raw: unknown;
  try {
    raw = Assets.json(path);
  } catch {
    return missing();
  }
  if (!raw || typeof raw !== "object") return missing();
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
