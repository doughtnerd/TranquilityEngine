/**
 * Which 2D draws are lit (ADR 0399), renderer-neutral: a 2D component's `material` field names a sprite material asset
 * (shader `"sprite-lit"` or `"sprite-unlit"`, or a shader graph with a sprite target, ADR 0415), or is empty for the
 * default, Sprite Lit. Material and graph assets are JSON, read synchronously through `Assets`; one that can't be read,
 * or whose shader isn't a sprite shader, draws with the default and is reported once by the backend's 2D materials
 * (`spriteMaterialProblem`, ADR 0418), which make the lit decision from these.
 */
import { Assets } from "../../scene/Assets";
import { isSpriteShader, materialGraph, parseMaterial } from "../../scene/material";
import { isShaderGraphPath, isSpriteGraphTarget, parseShaderGraph, type ShaderGraphTarget } from "../../scene/shaderGraph";
import { normalizeAssetPath } from "../../scene/assetPath";

/** Whether a 2D draw with `material` ("" for the default) is lit by 2D lights. */
export function spriteMaterialLit(material: string): boolean {
  if (!material) return true;
  const shader = spriteShaderOf(material);
  return shader !== "sprite-unlit" && shader !== "graph:sprite-unlit";
}

/** Why `material` can't be a 2D draw's material, or null when it can (empty, or a sprite material asset). */
export function spriteMaterialProblem(material: string): string | null {
  if (!material) return null;
  const shader = spriteShaderOf(material);
  if (shader === null) return `material "${material}" can't be read; drawing with the default Sprite Lit material.`;
  if (shader.startsWith("graph:")) {
    const target = shader.slice(6);
    if (target === "?") return `material "${material}"'s shader graph can't be read; drawing with the default Sprite Lit material.`;
    return isSpriteGraphTarget(target as ShaderGraphTarget) ? null : `material "${material}"'s shader graph has target "${target}", which 2D draws don't take (use a sprite target); drawing with the default Sprite Lit material.`;
  }
  if (!isSpriteShader(shader)) return `material "${material}" has shader "${shader}", which 2D draws don't take (use "sprite-lit" or "sprite-unlit"); drawing with the default Sprite Lit material.`;
  return null;
}

/** Whether a 2D draw's `material` is shaded by a sprite shader graph (ADR 0415): the backend builds it from the graph. */
export function spriteMaterialGraph(material: string): boolean {
  const shader = material ? spriteShaderOf(material) : null;
  return !!shader?.startsWith("graph:sprite-");
}

/** Each read material file's shader, by its raw value (a changed file is a new value), so a draw doesn't parse it every frame. */
const shaders = new WeakMap<object, string>();

/** A material's shader, or `graph:<target>` for one shaded by (or that is) a shader graph (`graph:?` when it can't be read). */
function spriteShaderOf(material: string): string | null {
  const path = normalizeAssetPath(material);
  try {
    if (!Assets.has(path)) return null;
    if (isShaderGraphPath(path)) return `graph:${graphTargetOf(path)}`;
    const raw = Assets.get(path);
    if (typeof raw !== "object" || raw === null) return parseMaterial(raw).settings.shader;
    let shader = shaders.get(raw);
    if (shader === undefined) {
      const settings = parseMaterial(raw).settings;
      const graph = materialGraph(settings);
      shaders.set(raw, (shader = graph && isShaderGraphPath(graph) ? `graph:${graphTargetOf(normalizeAssetPath(graph))}` : settings.shader));
    }
    return shader;
  } catch {
    return null;
  }
}

/** A shader graph asset's target, or "?" when it can't be read (cached by its raw value, as shaders are). */
function graphTargetOf(path: string): string {
  if (!Assets.has(path)) return "?";
  const raw = Assets.get(path);
  if (typeof raw !== "object" || raw === null) return "?";
  let target = shaders.get(raw);
  if (target === undefined) shaders.set(raw, (target = parseShaderGraph(raw).graph.target));
  return target;
}
