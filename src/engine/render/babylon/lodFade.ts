/**
 * Dithered LOD crossfade on Babylon (ADR 0446 §4, `spikes/lod-crossfade/`): `MycoLodFadePlugin` discards a 4×4
 * screen-space ordered-dither share of a fading mesh's pixels, so two levels drawn together cover each pixel once.
 *
 * - **Where it goes:** on a material the first time a fade batch drawing it is made (`addLodFade`), after the graph
 *   plugin (200) and the probe blend (210), so shader graphs and hand-written shaders take part with no work from their
 *   authors. It only discards fragments: `vertexOffset`, keywords and properties are untouched.
 * - **Its define:** `MYCO_LOD_FADE` is set per mesh in `prepareDefines`, true only for fade-batch source meshes
 *   (`markFadeSource`), so one material compiles a fading effect only for fade batches and steady instances keep early
 *   depth testing.
 * - **What it reads:** a per-instance `mycoLodFade` float: an `InstancedMesh`'s instanced buffer (auto batches) or a
 *   second thin-instance buffer (thin batches), passed to the fragment shader.
 * - **The value** f (`visibility/select.ts`): |f| is the fade's progress t, rounded to 1/16. f ≥ 0 (outgoing or steady)
 *   keeps the pixels whose Bayer rank is at least 16t; f < 0 (incoming) keeps those below it, the exact complement.
 *   The rank is Babylon's 4x4 Bayer function (`bayerDitherFunctions`), inlined in both languages (see the GLSL note).
 *
 * Not public API (ADR 0010).
 */
import type { Material } from "@babylonjs/core/Materials/material.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRBaseMaterial } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import "@babylonjs/core/Meshes/instancedMesh.js"; // Mesh.registerInstancedBuffer
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // Mesh.thinInstanceSetBuffer
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";

/** The per-instance attribute (and instanced-buffer kind) holding each instance's fade value. */
export const LOD_FADE_ATTRIBUTE = "mycoLodFade";
/** The plugin's name on a material. */
const PLUGIN_NAME = "MycoLodFade";
/** After the graph plugin (200) and the probe blend (210). */
const PRIORITY = 220;

/** Fade-batch source meshes: the meshes whose effects get `MYCO_LOD_FADE`. */
const fadeSources = new WeakSet<AbstractMesh>();

class LodFadeDefines extends MaterialDefines {
  MYCO_LOD_FADE = false;
}

const GLSL_VERTEX_DEFINITIONS = `
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
const GLSL_FRAGMENT_DEFINITIONS = `
#ifdef MYCO_LOD_FADE
varying float vMycoLodFade;
// Babylon's 4x4 Bayer rank (Shaders/ShadersInclude/bayerDitherFunctions), inlined: an include directive in plugin-injected code
// isn't expanded, so the compiler saw the directive and the effect failed to build. Prefixed to stay clear of Babylon's.
float mycoBayer2(vec2 p) { return mod(2.0 * p.y + p.x + 1.0, 4.0); }
float mycoBayer4(vec2 p) { return 4.0 * mycoBayer2(mod(p, 2.0)) + mycoBayer2(floor(0.5 * mod(p, 4.0))); }
#endif
`;
const GLSL_FRAGMENT_BEGIN = `
#ifdef MYCO_LOD_FADE
{
  float mycoT = floor(abs(vMycoLodFade) * 16.0 + 0.5);
  float mycoRank = mycoBayer4(floor(gl_FragCoord.xy));
  if (vMycoLodFade < 0.0 ? mycoRank >= mycoT : mycoRank < mycoT) { discard; }
}
#endif
`;

const WGSL_VERTEX_DEFINITIONS = `
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
const WGSL_FRAGMENT_DEFINITIONS = `
#ifdef MYCO_LOD_FADE
varying vMycoLodFade: f32;
fn mycoBayer2(p: vec2f) -> f32 { return (2.0 * p.y + p.x + 1.0) % 4.0; }
fn mycoBayer4(p: vec2f) -> f32 { return 4.0 * mycoBayer2(p % 2.0) + mycoBayer2(floor(0.5 * (p % 4.0))); }
#endif
`;
const WGSL_FRAGMENT_BEGIN = `
#ifdef MYCO_LOD_FADE
{
  let mycoF = fragmentInputs.vMycoLodFade;
  let mycoT = floor(abs(mycoF) * 16.0 + 0.5);
  let mycoRank = mycoBayer4(floor(fragmentInputs.position.xy));
  if (select(mycoRank < mycoT, mycoRank >= mycoT, mycoF < 0.0)) { discard; }
}
#endif
`;

/** @internal The dithered LOD crossfade plugin (ADR 0446 §4). */
export class MycoLodFadePlugin extends MycoMaterialPlugin {
  constructor(material: Material) {
    super(material, PLUGIN_NAME, PRIORITY, new LodFadeDefines());
    this.register();
  }

  override getClassName(): string {
    return "MycoLodFadePlugin";
  }

  override prepareDefines(defines: LodFadeDefines, _scene: unknown, mesh: AbstractMesh): void {
    defines.MYCO_LOD_FADE = fadeSources.has(mesh);
  }

  override getAttributes(attributes: string[], _scene: unknown, mesh: AbstractMesh): void {
    if (fadeSources.has(mesh)) attributes.push(LOD_FADE_ATTRIBUTE);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    if (shaderType === "vertex") {
      return { CUSTOM_VERTEX_DEFINITIONS: wgsl ? WGSL_VERTEX_DEFINITIONS : GLSL_VERTEX_DEFINITIONS, CUSTOM_VERTEX_MAIN_END: wgsl ? WGSL_VERTEX_END : GLSL_VERTEX_END };
    }
    if (shaderType !== "fragment") return null;
    return { CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? WGSL_FRAGMENT_DEFINITIONS : GLSL_FRAGMENT_DEFINITIONS, CUSTOM_FRAGMENT_MAIN_BEGIN: wgsl ? WGSL_FRAGMENT_BEGIN : GLSL_FRAGMENT_BEGIN };
  }
}

/** The materials a crossfade can draw with: PBR (built-in, graph and shader materials, ADR 0106) and standard ones, or a multi-material of them. */
export function canFade(material: Material): boolean {
  if (material instanceof MultiMaterial) return material.subMaterials.every((m) => !m || canFade(m));
  return material instanceof PBRBaseMaterial || material instanceof StandardMaterial;
}

/** Give a material (each part of a multi-material) the fade plugin, once. */
export function addLodFade(material: Material): void {
  if (material instanceof MultiMaterial) {
    for (const m of material.subMaterials) if (m) addLodFade(m);
    return;
  }
  if (!canFade(material) || material.pluginManager?.getPlugin(PLUGIN_NAME)) return;
  new MycoLodFadePlugin(material);
}

/**
 * Make `mesh` a fade-batch source: its effects get `MYCO_LOD_FADE` and read `mycoLodFade` per instance, from an
 * instanced buffer (its `InstancedMesh`es' `instancedBuffers.mycoLodFade`) or, given `thin`, from that thin-instance
 * buffer (one float per instance, kept in step with the matrix buffer by the caller).
 */
export function markFadeSource(mesh: Mesh, thin?: Float32Array): void {
  fadeSources.add(mesh);
  if (thin) mesh.thinInstanceSetBuffer(LOD_FADE_ATTRIBUTE, thin, 1, false);
  else mesh.registerInstancedBuffer(LOD_FADE_ATTRIBUTE, 1);
}
