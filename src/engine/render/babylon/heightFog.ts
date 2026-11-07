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
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
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
  if (toggled) scene.markAllMaterialsAsDirty(16); // Material.MiscDirtyFlag
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

/** @internal Height fog on one PBR material. */
export class MycoHeightFogPlugin extends MaterialPluginBase {
  constructor(material: PBRMaterial) {
    super(material, "MycoHeightFog", 220, new HeightFogDefines(), true, true);
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
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? WGSL_FN : GLSL_FN,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: wgsl
        ? "#ifdef MYCO_HEIGHT_FOG\nfinalColor = vec4f(mix(finalColor.rgb, uniforms.mycoHeightFogColor.rgb, mycoHeightFogAmount(fragmentInputs.vPositionW, scene.vEyePosition.xyz)), finalColor.a);\n#endif\n"
        : "#ifdef MYCO_HEIGHT_FOG\nfinalColor = vec4(mix(finalColor.rgb, mycoHeightFogColor.rgb, mycoHeightFogAmount(vPositionW, vEyePosition.xyz)), finalColor.a);\n#endif\n",
    };
  }
}

// Every PBR material made after this module loads carries the plugin (dormant until a scene has height fog).
RegisterMaterialPlugin("MycoHeightFog", (material: Material) => (material instanceof PBRMaterial ? new MycoHeightFogPlugin(material) : null));
