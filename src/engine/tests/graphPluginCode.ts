// Test helper: what a shader graph material's plugin hands Babylon (its code per injection point, its
// uniform buffer, the languages it supports), read through Babylon's material plugin API from materials
// `createGraphMaterial` makes on a NullEngine. WGSL materials need an engine that says it's WebGPU.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { Scene } from "@babylonjs/core/scene.js";
import { createGraphMaterial } from "../render/babylon/graphMaterial";
import type { CompiledShaderGraph } from "../render/shaderGraph/compile";

export type ShaderCode = { [point: string]: string };

/** The graph plugins of a material made for `c` (`main`) and of its shadow-depth material (`shadow`, for graphs with a vertex offset), on a WGSL or GLSL engine. Null where there's none. */
export function graphPlugins(c: CompiledShaderGraph, language: ShaderLanguage = ShaderLanguage.WGSL): { main: MaterialPluginBase | null; shadow: MaterialPluginBase | null } {
  const engine = new NullEngine();
  if (language === ShaderLanguage.WGSL) (engine as unknown as { _isWebGPU: boolean })._isWebGPU = true;
  const scene = new Scene(engine);
  try {
    const m = createGraphMaterial(scene, "graph", c, {}, { time: 0, resolution: [1, 1] }, () => Promise.reject(new Error("no textures in tests")));
    const shadow = scene.materials.find((x) => x.name === "graph:shadow");
    return { main: m.material.pluginManager?.getPlugin("MycoGraph") ?? null, shadow: shadow?.pluginManager?.getPlugin("MycoGraph") ?? null };
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

/** The code a graph material's plugin puts in Babylon's PBR `shaderType` shader (WGSL unless asked). */
export function graphCode(c: CompiledShaderGraph, shaderType: string, language: ShaderLanguage = ShaderLanguage.WGSL): ShaderCode {
  return graphPlugins(c, language).main!.getCustomCode(shaderType, language)!;
}

/** The code a regular-expression injection point whose pattern starts with `start` gets (`!` included). */
export const codeAt = (code: ShaderCode, start: string): string | undefined => Object.entries(code).find(([k]) => k.startsWith(start))?.[1];
