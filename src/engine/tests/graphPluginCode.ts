// Test helper: what a shader graph material's plugin hands Babylon (its code per named injection point,
// its uniform buffer, the languages it supports), read through Babylon's material plugin API, and the
// shader text Babylon makes from it (`graphShaders`, ADR 0225), from materials `createGraphMaterial`
// makes on a NullEngine of the asked language. Each call has an engine of its own: Babylon caches
// effects by defines per engine, and test graphs share a key.
import type { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { Scene } from "@babylonjs/core/scene.js";
import { createGraphMaterial } from "../render/babylon/graphMaterial";
import type { CompiledShaderGraph } from "../render/shaderGraph/compile";
import { nullEngine, shaderText, type ShaderText } from "./pbrShaderSource";

export type ShaderCode = { [point: string]: string };

/** A material made for `c` on a fresh engine of `language`, its shadow-depth material (graphs with a vertex offset), and how to dispose both. */
function graphMaterials(c: CompiledShaderGraph, language: ShaderLanguage): { main: PBRMaterial; shadow: PBRMaterial | null; dispose(): void } {
  const engine = nullEngine(language === ShaderLanguage.WGSL ? "wgsl" : "glsl");
  const scene = new Scene(engine);
  const main = createGraphMaterial(scene, "graph", c, {}, { time: 0, resolution: [1, 1] }, () => Promise.reject(new Error("no textures in tests"))).material;
  const shadow = (scene.materials.find((x) => x.name === "graph:shadow") as PBRMaterial | undefined) ?? null;
  return {
    main,
    shadow,
    dispose: () => {
      scene.dispose();
      engine.dispose();
    },
  };
}

/** The graph plugins of a material made for `c` (`main`) and of its shadow-depth material (`shadow`), on a WGSL or GLSL engine. Null where there's none. */
export function graphPlugins(c: CompiledShaderGraph, language: ShaderLanguage = ShaderLanguage.WGSL): { main: MaterialPluginBase | null; shadow: MaterialPluginBase | null } {
  const m = graphMaterials(c, language);
  try {
    return { main: m.main.pluginManager?.getPlugin("MycoGraph") ?? null, shadow: m.shadow?.pluginManager?.getPlugin("MycoGraph") ?? null };
  } finally {
    m.dispose();
  }
}

/** The code a graph material's plugin puts at Babylon's named points of its PBR `shaderType` shader (WGSL unless asked). */
export function graphCode(c: CompiledShaderGraph, shaderType: string, language: ShaderLanguage = ShaderLanguage.WGSL): ShaderCode {
  return graphPlugins(c, language).main!.getCustomCode(shaderType, language)!;
}

/** The shader text Babylon makes for a material made for `c` (`main`) and for its shadow-depth material (`shadow`, or null), WGSL unless asked. */
export async function graphShaders(c: CompiledShaderGraph, language: ShaderLanguage = ShaderLanguage.WGSL): Promise<{ main: ShaderText; shadow: ShaderText | null }> {
  const m = graphMaterials(c, language);
  try {
    return { main: await shaderText(m.main), shadow: m.shadow ? await shaderText(m.shadow) : null };
  } finally {
    m.dispose();
  }
}
