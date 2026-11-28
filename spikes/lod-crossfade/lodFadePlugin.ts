/**
 * MycoLodFadePlugin: screen-space dithered LOD crossfade for a PBRMaterial (feasibility spike).
 *
 * - `MYCO_LOD_FADE` is set per mesh in `prepareDefines(defines, scene, mesh)`: true only for meshes
 *   passed to `markFadeBatch` (the "fade batch" source mesh, whose instances all fade), so one
 *   material object compiles two effects (plain and fading).
 * - The per-instance float attribute `mycoLodFade` (an InstancedMesh's `registerInstancedBuffer`,
 *   or a thin-instance buffer) is passed to the fragment shader as a varying.
 * - Unity's convention: fade value f has |f| = transition progress t (0..1, quantised to 1/16) and a
 *   sign. f >= 0 is the outgoing / steady level: it keeps the pixels whose 4x4 Bayer rank is >= 16t.
 *   f < 0 is the incoming level: it keeps the pixels whose rank is < 16t. The two keep sets are exact
 *   complements for every t, so a pixel is covered once. (An incoming level at t = 0 is not drawn.)
 *
 * Priority 220: after the graph plugin (200) and the probe blend (210). Both languages in one
 * place; the WGSL is [U] (not executable in this headless WebGL2 environment).
 */
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MycoMaterialPlugin } from "../../src/engine/render/babylon/mycoMaterialPlugin";

const fadeMeshes = new WeakSet<AbstractMesh>();

/** Flag a (source / thin-instance) mesh as a fade batch and give it its per-instance fade buffer. */
export function markFadeBatch(mesh: Mesh, thinBuffer?: Float32Array): void {
  fadeMeshes.add(mesh);
  if (thinBuffer) mesh.thinInstanceSetBuffer("mycoLodFade", thinBuffer, 1, false);
  else mesh.registerInstancedBuffer("mycoLodFade", 1);
}

class FadeDefines extends MaterialDefines {
  MYCO_LOD_FADE = false;
}

// LOC-BEGIN glsl
const GLSL_VERTEX_DEFS = `
#ifdef MYCO_LOD_FADE
attribute float mycoLodFade;
varying float vMycoLodFade;
#endif
`;
const GLSL_VERTEX_END = `
#ifdef MYCO_LOD_FADE
vMycoLodFade = mycoLodFade;
#endif
`;
const GLSL_FRAGMENT_DEFS = `
#ifdef MYCO_LOD_FADE
varying float vMycoLodFade;
// 4x4 Bayer rank 0..15 of a pixel, from bit tricks (no array).
int mycoBayer4(vec2 fc) {
  ivec2 p = ivec2(fc) & 3;
  int x0 = p.x & 1, x1 = p.x >> 1, y0 = p.y & 1, y1 = p.y >> 1;
  return 4 * (((x0 ^ y0) << 1) | y0) + (((x1 ^ y1) << 1) | y1);
}
#endif
`;
const GLSL_FRAGMENT_BEGIN = `
#ifdef MYCO_LOD_FADE
{
  int mycoT = int(floor(abs(vMycoLodFade) * 16.0 + 0.5));
  int mycoRank = mycoBayer4(gl_FragCoord.xy);
  bool mycoKeep = vMycoLodFade < 0.0 ? mycoRank < mycoT : mycoRank >= mycoT;
  if (!mycoKeep) { discard; }
}
#endif
`;
// LOC-END glsl

// LOC-BEGIN wgsl
const WGSL_VERTEX_DEFS = `
#ifdef MYCO_LOD_FADE
attribute mycoLodFade: f32;
varying vMycoLodFade: f32;
#endif
`;
const WGSL_VERTEX_END = `
#ifdef MYCO_LOD_FADE
vertexOutputs.vMycoLodFade = vertexInputs.mycoLodFade;
#endif
`;
const WGSL_FRAGMENT_DEFS = `
#ifdef MYCO_LOD_FADE
varying vMycoLodFade: f32;
fn mycoBayer4(fc: vec2f) -> i32 {
  let p = vec2<i32>(fc) & vec2<i32>(3);
  let x0 = p.x & 1; let x1 = p.x >> 1u; let y0 = p.y & 1; let y1 = p.y >> 1u;
  return 4 * (((x0 ^ y0) << 1u) | y0) + (((x1 ^ y1) << 1u) | y1);
}
#endif
`;
const WGSL_FRAGMENT_BEGIN = `
#ifdef MYCO_LOD_FADE
{
  let mycoT = i32(floor(abs(fragmentInputs.vMycoLodFade) * 16.0 + 0.5));
  let mycoRank = mycoBayer4(fragmentInputs.position.xy);
  let mycoKeep = select(mycoRank >= mycoT, mycoRank < mycoT, fragmentInputs.vMycoLodFade < 0.0);
  if (!mycoKeep) { discard; }
}
#endif
`;
// LOC-END wgsl

export class MycoLodFadePlugin extends MycoMaterialPlugin {
  constructor(material: Material) {
    super(material, "MycoLodFade", 220, new FadeDefines());
    this.register();
  }

  override getClassName(): string {
    return "MycoLodFadePlugin";
  }

  override prepareDefines(defines: FadeDefines, _scene: unknown, mesh: AbstractMesh): void {
    defines.MYCO_LOD_FADE = fadeMeshes.has(mesh);
  }

  override getAttributes(attributes: string[], _scene: unknown, mesh: AbstractMesh): void {
    if (fadeMeshes.has(mesh)) attributes.push("mycoLodFade");
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    if (shaderType === "vertex") {
      return { CUSTOM_VERTEX_DEFINITIONS: wgsl ? WGSL_VERTEX_DEFS : GLSL_VERTEX_DEFS, CUSTOM_VERTEX_MAIN_END: wgsl ? WGSL_VERTEX_END : GLSL_VERTEX_END };
    }
    return { CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? WGSL_FRAGMENT_DEFS : GLSL_FRAGMENT_DEFS, CUSTOM_FRAGMENT_MAIN_BEGIN: wgsl ? WGSL_FRAGMENT_BEGIN : GLSL_FRAGMENT_BEGIN };
  }
}

// ---- stand-in for the graph plugin: a trivial vertex offset, priority 200 -----------------------------
class OffsetDefines extends MaterialDefines {
  MYCO_TEST_OFFSET = true;
}

export class MycoTestOffsetPlugin extends MycoMaterialPlugin {
  constructor(material: Material, readonly dx: number) {
    super(material, "MycoTestOffset", 200, new OffsetDefines());
    this.register();
  }
  override getClassName(): string {
    return "MycoTestOffsetPlugin";
  }
  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== "vertex") return null;
    return { CUSTOM_VERTEX_UPDATE_POSITION: `positionUpdated.x += ${this.dx.toFixed(3)};` };
  }
}
