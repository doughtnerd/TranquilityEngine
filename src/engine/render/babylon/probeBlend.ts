/**
 * Blending between reflection probes (ADR 0110). Babylon's PBR material reflects one cube map; a
 * mesh near the face of its probe's box also samples its neighbour's and mixes the two radiances by
 * the primary's share. The second sample reuses Babylon's own helpers (`computeCubicCoords` and
 * `computeCubicLocalCoords` for box projection, `sampleReflectionTexture` for the roughness LOD), so it
 * matches the first. Diffuse ambient (the spherical harmonics) stays the primary probe's.
 *
 * The plugin goes on the renderer's probe copies of built-in materials only (`probeMaterial` in
 * `BabylonRenderer.ts`); each copy has fixed textures and weight (rounded to `BLEND_STEPS`), so it is a
 * uniform per material, not per mesh.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { BlendBox } from "../probeBoxes";

/** What a probe copy blends towards. */
export interface ProbeBlendState {
  texture: BaseTexture | null;
  /** The primary's share, 0–1. */
  weight: number;
  /** The neighbour's intensity over the primary's (both scale the same sample). */
  intensityRatio: number;
  /** The neighbour's box when it box-projects, else null. */
  box: BlendBox | null;
}

/** The point after Babylon computes the primary probe's reflection (unique in pbr.fragment, both languages). */
const ANCHOR = "!#define CUSTOM_REFLECTION\\s*#endif\\s*#endif";

const WGSL = /* wgsl */ `#define CUSTOM_REFLECTION
#endif
#endif
#if defined(MYCO_PROBE_BLEND) && defined(REFLECTION) && defined(REFLECTIONMAP_3D)
{
  var mycoCoords: vec3f;
  if (uniforms.mycoBlendBoxSize.w > 0.5) {
    mycoCoords = computeCubicLocalCoords(vec4f(fragmentInputs.vPositionW, 1.0), normalW, scene.vEyePosition.xyz, uniforms.reflectionMatrix, uniforms.mycoBlendBoxSize.xyz, uniforms.mycoBlendBoxPos.xyz);
  } else {
    mycoCoords = computeCubicCoords(vec4f(fragmentInputs.vPositionW, 1.0), normalW, scene.vEyePosition.xyz, uniforms.reflectionMatrix);
  }
#ifdef REFLECTIONMAP_OPPOSITEZ
  mycoCoords.z *= -1.0;
#endif
  let mycoRadiance = sampleReflectionTexture(alphaG, uniforms.vReflectionMicrosurfaceInfos, uniforms.vReflectionInfos, uniforms.vReflectionColor
#if defined(LODINREFLECTIONALPHA) && !defined(REFLECTIONMAP_SKYBOX)
    , NdotVUnclamped
#endif
#ifdef LINEARSPECULARREFLECTION
    , roughness
#endif
    , mycoBlendSampler, mycoBlendSamplerSampler, mycoCoords
#ifndef LODBASEDMICROSFURACE
    , reflectionLowSampler, reflectionLowSamplerSampler, reflectionHighSampler, reflectionHighSamplerSampler
#endif
#ifdef REALTIME_FILTERING
    , uniforms.vReflectionFilteringInfo
#endif
  );
  reflectionOut.environmentRadiance = mix(mycoRadiance * uniforms.mycoBlend.y, reflectionOut.environmentRadiance, uniforms.mycoBlend.x);
}
#endif
`;

const GLSL = /* glsl */ `#define CUSTOM_REFLECTION
#endif
#endif
#if defined(MYCO_PROBE_BLEND) && defined(REFLECTION) && defined(REFLECTIONMAP_3D)
{
  vec3 mycoCoords;
  if (mycoBlendBoxSize.w > 0.5) {
    mycoCoords = computeCubicLocalCoords(vec4(vPositionW, 1.0), normalW, vEyePosition.xyz, reflectionMatrix, mycoBlendBoxSize.xyz, mycoBlendBoxPos.xyz);
  } else {
    mycoCoords = computeCubicCoords(vec4(vPositionW, 1.0), normalW, vEyePosition.xyz, reflectionMatrix);
  }
#ifdef REFLECTIONMAP_OPPOSITEZ
  mycoCoords.z *= -1.0;
#endif
  vec4 mycoRadiance = vec4(0.0);
  sampleReflectionTexture(alphaG, vReflectionMicrosurfaceInfos, vReflectionInfos, vReflectionColor
#if defined(LODINREFLECTIONALPHA) && !defined(REFLECTIONMAP_SKYBOX)
    , NdotVUnclamped
#endif
#ifdef LINEARSPECULARREFLECTION
    , roughness
#endif
    , mycoBlendSampler, mycoCoords
#ifndef LODBASEDMICROSFURACE
    , reflectionSamplerLow, reflectionSamplerHigh
#endif
#ifdef REALTIME_FILTERING
    , vReflectionFilteringInfo
#endif
    , mycoRadiance
  );
  reflectionOut.environmentRadiance = mix(mycoRadiance * mycoBlend.y, reflectionOut.environmentRadiance, mycoBlend.x);
}
#endif
`;

class ProbeBlendDefines extends MaterialDefines {
  MYCO_PROBE_BLEND = false;
}

/** @internal The plugin on a probe copy that blends towards a neighbour's cube map. */
export class MycoProbeBlendPlugin extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    readonly state: ProbeBlendState,
  ) {
    super(material, "MycoProbeBlend", 210, new ProbeBlendDefines(), false);
    (this._pluginManager as unknown as { _addPlugin(p: MaterialPluginBase): boolean })._addPlugin(this);
    this._enable(true);
  }

  override getClassName(): string {
    return "MycoProbeBlendPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.WGSL || shaderLanguage === ShaderLanguage.GLSL;
  }

  override isReadyForSubMesh(): boolean {
    return !this.state.texture || this.state.texture.isReady();
  }

  override prepareDefines(defines: ProbeBlendDefines): void {
    defines.MYCO_PROBE_BLEND = !!this.state.texture && this.state.weight < 1;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("mycoBlendSampler");
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: "mycoBlend", size: 4, type: "vec4" },
        { name: "mycoBlendBoxSize", size: 4, type: "vec4" },
        { name: "mycoBlendBoxPos", size: 4, type: "vec4" },
      ],
      fragment: "",
    };
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state;
    ubo.updateFloat4("mycoBlend", s.weight, s.intensityRatio, 0, 0);
    const b = s.box;
    ubo.updateFloat4("mycoBlendBoxSize", b?.size.x ?? 0, b?.size.y ?? 0, b?.size.z ?? 0, b ? 1 : 0);
    ubo.updateFloat4("mycoBlendBoxPos", b?.center.x ?? 0, b?.center.y ?? 0, b?.center.z ?? 0, 0);
    if (s.texture) ubo.setTexture("mycoBlendSampler", s.texture);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl
        ? "#ifdef MYCO_PROBE_BLEND\nvar mycoBlendSamplerSampler: sampler;\nvar mycoBlendSampler: texture_cube<f32>;\n#endif\n"
        : "#ifdef MYCO_PROBE_BLEND\nuniform samplerCube mycoBlendSampler;\n#endif\n",
      [ANCHOR]: wgsl ? WGSL : GLSL,
    };
  }
}
