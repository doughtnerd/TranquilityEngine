/**
 * Height fog on the Babylon backend (ADR 0110, 0071's open question): fog that is thick near the
 * ground and thins with height, added after Babylon's distance fog in every PBR material (built-in,
 * physical, shader graph, sprites, water). Exponential height fog: density `d · e^(−falloff · (y − base))`,
 * integrated along the view ray from the camera to the pixel, so looking down into a valley fogs more
 * than looking across it, and the amount is `1 − e^(−integral)`.
 *
 * The plugin is registered for every PBR material once this module loads; it compiles in only where the
 * scene has height fog (`setHeightFog`) and the mesh takes fog (`applyFog`, a material's `"fog": false`).
 * Turning it on or off recompiles lit materials once, like distance fog; its values are uniforms.
 *
 * The plugin also goes on standard materials (the unlit particle material, ADR 0126). Custom
 * `ShaderMaterial`s (kernel particle draws) fog through the hook at the end of this file:
 * `heightFogShader` for the code and `useHeightFog` to keep a material's define and uniforms in step.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { EngineStore } from "@babylonjs/core/Engines/engineStore.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { RegisterMaterialPlugin } from "@babylonjs/core/Materials/materialPluginManager.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";

/** A scene's height fog: off, or its values (colour linear). */
export interface HeightFogState {
  on: boolean;
  density: number;
  base: number;
  falloff: number;
  color: [number, number, number];
}

const states = new WeakMap<Scene, HeightFogState>();

/**
 * @internal Set a scene's height fog (the renderer's `syncFog`). Turning it on or off marks the scene's
 * materials dirty so they compile it in or out; changing values only updates uniforms.
 */
export function setHeightFog(scene: Scene, next: HeightFogState): void {
  let s = states.get(scene);
  if (!s) states.set(scene, (s = { on: false, density: 0, base: 0, falloff: 0, color: [1, 1, 1] }));
  const toggled = s.on !== next.on;
  s.on = next.on;
  s.density = next.density;
  s.base = next.base;
  s.falloff = next.falloff;
  s.color[0] = next.color[0];
  s.color[1] = next.color[1];
  s.color[2] = next.color[2];
  if (toggled) {
    scene.markAllMaterialsAsDirty(16); // Material.MiscDirtyFlag
    for (const m of shaderUsers.get(scene) ?? []) syncDefine(m, s.on);
  }
}

/** Whether the scene has height fog on (custom draws compile it in only then). */
export function heightFogOn(scene: Scene): boolean {
  return !!states.get(scene)?.on;
}

/**
 * @internal The fog amount the shader computes, 0–1, for tests: from the eye at height `eyeY` to a point
 * `distance` metres away at height `pointY`.
 */
export function heightFogAmount(s: Pick<HeightFogState, "density" | "base" | "falloff">, eyeY: number, pointY: number, distance: number): number {
  const f = Math.max(1e-4, s.falloff);
  const dy = pointY - eyeY;
  const k = Math.abs(f * dy) > 1e-4 ? (1 - Math.exp(-f * dy)) / (f * dy) : 1;
  const integral = Math.max(0, s.density) * Math.exp(-f * (eyeY - s.base)) * distance * k;
  return Math.min(1, Math.max(0, 1 - Math.exp(-integral)));
}

const WGSL_FN = /* wgsl */ `
#ifdef MYCO_HEIGHT_FOG
fn mycoHeightFogAmount(p: vec3f, eye: vec3f) -> f32 {
  let f = max(1e-4, uniforms.mycoHeightFog.z);
  let dy = p.y - eye.y;
  let fd = f * dy;
  var k = 1.0;
  if (abs(fd) > 1e-4) { k = (1.0 - exp(-fd)) / fd; }
  let integral = max(0.0, uniforms.mycoHeightFog.x) * exp(-f * (eye.y - uniforms.mycoHeightFog.y)) * distance(p, eye) * k;
  return clamp(1.0 - exp(-integral), 0.0, 1.0);
}
#endif
`;

const GLSL_FN = /* glsl */ `
#ifdef MYCO_HEIGHT_FOG
float mycoHeightFogAmount(vec3 p, vec3 eye) {
  float f = max(1e-4, mycoHeightFog.z);
  float dy = p.y - eye.y;
  float fd = f * dy;
  float k = abs(fd) > 1e-4 ? (1.0 - exp(-fd)) / fd : 1.0;
  float integral = max(0.0, mycoHeightFog.x) * exp(-f * (eye.y - mycoHeightFog.y)) * distance(p, eye) * k;
  return clamp(1.0 - exp(-integral), 0.0, 1.0);
}
#endif
`;

class HeightFogDefines extends MaterialDefines {
  MYCO_HEIGHT_FOG = false;
}

/** @internal Height fog on one PBR or standard material. */
export class MycoHeightFogPlugin extends MaterialPluginBase {
  constructor(material: PBRMaterial | StandardMaterial) {
    super(material, "MycoHeightFog", 220, new HeightFogDefines(), true, true);
  }

  /**
   * Standard materials fog `color` before Babylon's own fog; PBR ones `finalColor` at the end. Read from the
   * material, not a field: Babylon asks for the code's injection points inside the base constructor.
   */
  private get standard(): boolean {
    return this._material instanceof StandardMaterial;
  }

  override getClassName(): string {
    return "MycoHeightFogPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.WGSL || shaderLanguage === ShaderLanguage.GLSL;
  }

  override prepareDefines(defines: HeightFogDefines, scene: Scene, mesh: AbstractMesh): void {
    defines.MYCO_HEIGHT_FOG = !!states.get(scene)?.on && mesh.applyFog;
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: "mycoHeightFog", size: 4, type: "vec4" },
        { name: "mycoHeightFogColor", size: 4, type: "vec4" },
      ],
      fragment: "",
    };
  }

  override bindForSubMesh(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = states.get(scene);
    if (!s?.on) return;
    ubo.updateFloat4("mycoHeightFog", s.density, s.base, s.falloff, 1);
    ubo.updateFloat4("mycoHeightFogColor", s.color[0], s.color[1], s.color[2], 1);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    if (this.standard) {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? WGSL_FN : GLSL_FN,
        CUSTOM_FRAGMENT_BEFORE_FOG: wgsl
          ? "#ifdef MYCO_HEIGHT_FOG\ncolor = vec4f(mix(color.rgb, uniforms.mycoHeightFogColor.rgb, mycoHeightFogAmount(fragmentInputs.vPositionW, scene.vEyePosition.xyz)), color.a);\n#endif\n"
          : "#ifdef MYCO_HEIGHT_FOG\ncolor.rgb = mix(color.rgb, mycoHeightFogColor.rgb, mycoHeightFogAmount(vPositionW, vEyePosition.xyz));\n#endif\n",
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? WGSL_FN : GLSL_FN,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: wgsl
        ? "#ifdef MYCO_HEIGHT_FOG\nfinalColor = vec4f(mix(finalColor.rgb, uniforms.mycoHeightFogColor.rgb, mycoHeightFogAmount(fragmentInputs.vPositionW, scene.vEyePosition.xyz)), finalColor.a);\n#endif\n"
        : "#ifdef MYCO_HEIGHT_FOG\nfinalColor = vec4(mix(finalColor.rgb, mycoHeightFogColor.rgb, mycoHeightFogAmount(vPositionW, vEyePosition.xyz)), finalColor.a);\n#endif\n",
    };
  }
}

// Every PBR material made after this module loads carries the plugin (dormant until a scene has height fog).
const registerHeightFog = (): void =>
  RegisterMaterialPlugin("MycoHeightFog", (material: Material) => (material instanceof PBRMaterial || material instanceof StandardMaterial ? new MycoHeightFogPlugin(material) : null));
registerHeightFog();
// Babylon drops every registered plugin when its last engine is disposed (a World closing, a preview, a
// test): register again after it does, or engines made later would have no height fog.
EngineStore.OnEnginesDisposedObservable.add(registerHeightFog);

// --- the hook for custom shaders (ADR 0126) -----------------------------------------------------------------

/** ShaderMaterials using height fog, per scene, so turning it on or off recompiles them. */
const shaderUsers = new WeakMap<Scene, Set<ShaderMaterial>>();
const DEFINE = "#define MYCO_HEIGHT_FOG";

function syncDefine(m: ShaderMaterial, on: boolean): void {
  const defines = m.options.defines;
  const i = defines.indexOf(DEFINE);
  if (on && i < 0) defines.push(DEFINE);
  else if (!on && i >= 0) defines.splice(i, 1);
  else return;
  m.markDirty(true);
}

/**
 * Height fog code for a custom shader's fragment stage. Declare `decl` at the top level (it declares the
 * two uniforms `mycoHeightFog` and `mycoHeightFogColor`, vec4s, and `mycoApplyHeightFog`) and call
 * `mycoApplyHeightFog(color.rgb, worldPos, eye)` (returns the fogged rgb), or read the amount with
 * `mycoHeightFogFactor(worldPos, eye)` (additive draws fade towards black instead of the fog colour). Without the scene's height
 * fog the define is off and the function returns its colour. Pair with `useHeightFog`.
 */
export function heightFogShader(language: "wgsl" | "glsl"): { decl: string; uniforms: string[] } {
  const decl =
    language === "wgsl"
      ? `uniform mycoHeightFog : vec4<f32>;
uniform mycoHeightFogColor : vec4<f32>;
${WGSL_FN}
fn mycoHeightFogFactor(p: vec3f, eye: vec3f) -> f32 {
#ifdef MYCO_HEIGHT_FOG
  return mycoHeightFogAmount(p, eye);
#else
  return 0.0;
#endif
}
fn mycoApplyHeightFog(c: vec3f, p: vec3f, eye: vec3f) -> vec3f {
#ifdef MYCO_HEIGHT_FOG
  return mix(c, uniforms.mycoHeightFogColor.rgb, mycoHeightFogAmount(p, eye));
#else
  return c;
#endif
}
`
      : `uniform vec4 mycoHeightFog;
uniform vec4 mycoHeightFogColor;
${GLSL_FN}
float mycoHeightFogFactor(vec3 p, vec3 eye) {
#ifdef MYCO_HEIGHT_FOG
  return mycoHeightFogAmount(p, eye);
#else
  return 0.0;
#endif
}
vec3 mycoApplyHeightFog(vec3 c, vec3 p, vec3 eye) {
#ifdef MYCO_HEIGHT_FOG
  return mix(c, mycoHeightFogColor.rgb, mycoHeightFogAmount(p, eye));
#else
  return c;
#endif
}
`;
  return { decl, uniforms: ["mycoHeightFog", "mycoHeightFogColor"] };
}

/**
 * Keep a ShaderMaterial (whose fragment uses `heightFogShader` and lists its uniforms) in step with
 * the scene's height fog: the define follows the scene, the uniforms are set each time it binds.
 * Returns a function that stops (also done when the material is disposed).
 */
export function useHeightFog(material: ShaderMaterial, scene: Scene): () => void {
  let set = shaderUsers.get(scene);
  if (!set) shaderUsers.set(scene, (set = new Set()));
  set.add(material);
  syncDefine(material, heightFogOn(scene));
  const bound = material.onBindObservable.add(() => {
    const s = states.get(scene);
    const effect = material.getEffect();
    if (!s?.on || !effect) return;
    effect.setFloat4("mycoHeightFog", s.density, s.base, s.falloff, 1);
    effect.setFloat4("mycoHeightFogColor", s.color[0], s.color[1], s.color[2], 1);
  });
  const stop = (): void => {
    set!.delete(material);
    material.onBindObservable.remove(bound);
  };
  material.onDisposeObservable.addOnce(stop);
  return stop;
}
