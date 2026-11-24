/**
 * Which 2D draws are lit (ADR 0399), renderer-neutral: a 2D component's `material` field names a sprite material asset
 * (shader `"sprite-lit"` or `"sprite-unlit"`), or is empty for the default, Sprite Lit. Material assets are JSON, read
 * synchronously through `Assets`; one that can't be read, or whose shader isn't a sprite shader, draws with the default
 * and is reported once by the caller (`spriteMaterialProblem`).
 */
import { Assets } from "../../scene/Assets";
import { isSpriteShader, parseMaterial } from "../../scene/material";
import type { QuadLighting } from "../quadBatches";

/** Whether a 2D draw with `material` ("" for the default) is lit by 2D lights. */
export function spriteMaterialLit(material: string): boolean {
  if (!material) return true;
  const shader = spriteShaderOf(material);
  return shader !== "sprite-unlit";
}

/** Why `material` can't be a 2D draw's material, or null when it can (empty, or a sprite material asset). */
export function spriteMaterialProblem(material: string): string | null {
  if (!material) return null;
  const shader = spriteShaderOf(material);
  if (shader === null) return `material "${material}" can't be read; drawing with the default Sprite Lit material.`;
  if (!isSpriteShader(shader)) return `material "${material}" has shader "${shader}", which 2D draws don't take (use "sprite-lit" or "sprite-unlit"); drawing with the default Sprite Lit material.`;
  return null;
}

/** Each read material file's shader, by its raw value (a changed file is a new value), so a draw doesn't parse it every frame. */
const shaders = new WeakMap<object, string>();

function spriteShaderOf(material: string): string | null {
  const path = material.replace(/^asset:/, "");
  try {
    if (!Assets.has(path)) return null;
    const raw = Assets.get(path);
    if (typeof raw !== "object" || raw === null) return parseMaterial(raw).settings.shader;
    let shader = shaders.get(raw);
    if (shader === undefined) shaders.set(raw, (shader = parseMaterial(raw).settings.shader));
    return shader;
  } catch {
    return null;
  }
}

/**
 * A 2D draw's lighting for `QuadBatch.setLighting` (ADR 0399): lit on `sortingLayer` with `image`'s normal and mask maps
 * (its sidecar's secondary textures, ADR 0408), or null when its `material` is Sprite Unlit. The quad-batch host still
 * draws it unlit while its layer has no 2D light.
 */
export function quadLighting(material: string, sortingLayer: string, image: string): QuadLighting | null {
  if (!spriteMaterialLit(material)) return null;
  const path = image.replace(/^asset:/, "");
  let normalMap: string | null = null, maskMap: string | null = null, normalMapGreenDown = false;
  if (path && Assets.has(path)) {
    const s = Assets.importSettings(path);
    normalMap = s.secondaryTextures.normalMap || null;
    maskMap = s.secondaryTextures.maskMap || null;
    normalMapGreenDown = s.normalMapGreen === "down";
  }
  return { sortingLayer, normalMap, maskMap, normalMapGreenDown };
}
