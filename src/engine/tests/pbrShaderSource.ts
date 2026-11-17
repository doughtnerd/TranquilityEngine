// Test support (ADR 0225): the shader text Babylon makes for a material, and NullEngines that make
// WGSL or GLSL materials. Render tests assert on this text, not on a plugin's `getCustomCode` keys,
// so they see a plugin's code where Babylon puts it, after every other plugin's, and never spell a
// pattern of `render/babylon/pbrInjection.ts` (ADR 0222) themselves.
//
// Nothing here models Babylon. `shaderText` draws the material's real path, `isReadyForSubMesh`, which
// builds an Effect, and reads the Effect's public `vertexSourceCode` / `fragmentSourceCode`. On a
// NullEngine that text is what Babylon's own shader processing produces before a GPU back end would
// take over: `ShaderProcessor.Process` expands the includes, the material's `processCodeAfterIncludes`
// hands the expanded source to `MaterialPluginManager._injectCustomCode` (named `CUSTOM_*` points,
// "!"-prefixed regular expressions, the plugins' uniform declarations), and with no platform processor
// the `#if` blocks are left unevaluated, so every branch's code is still in the text.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import type { PbrLanguage } from "../render/babylon/pbrInjection";

/**
 * A NullEngine that says it is WebGPU, so the PBR and standard materials made on it are WGSL (Babylon
 * picks a material's language from `engine.isWebGPU`). Nothing is drawn, so nothing else differs.
 */
class WgslNullEngine extends NullEngine {
  constructor() {
    super();
    this._isWebGPU = true;
  }
}

/** A NullEngine whose materials are made in `language` (a plain NullEngine's are GLSL). */
export function nullEngine(language: PbrLanguage): NullEngine {
  return language === "wgsl" ? new WgslNullEngine() : new NullEngine();
}

/** What Babylon compiles for one material on one mesh. */
export interface ShaderText {
  /** The vertex shader: includes expanded, every plugin's code in place, `#if` blocks unevaluated. */
  vertex: string;
  /** The fragment shader, likewise. */
  fragment: string;
  /** The defines Babylon compiled it with, one `#define NAME` per line. */
  defines: string;
}

/**
 * The shader text Babylon makes when `material` draws `mesh` (a unit box in the material's scene when
 * left out, disposed after). Waits, a few milliseconds at a time, until the material is ready (shader
 * sources load asynchronously, plugins wait for their textures), and throws if it never is.
 */
export async function shaderText(material: Material, mesh?: AbstractMesh): Promise<ShaderText> {
  const target = mesh ?? CreateBox(`${material.name}:shaderText`, { size: 1 }, material.getScene());
  const before = target.material;
  target.material = material;
  try {
    const subMesh = target.subMeshes[0];
    for (let tries = 0; !material.isReadyForSubMesh(target, subMesh); tries++) {
      if (tries >= 200) throw new Error(`material "${material.name}" never became ready`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const effect = subMesh.effect;
    if (!effect) throw new Error(`material "${material.name}" is ready with no effect`);
    return { vertex: effect.vertexSourceCode, fragment: effect.fragmentSourceCode, defines: effect.defines };
  } finally {
    if (mesh) target.material = before;
    else target.dispose();
  }
}
