/**
 * Soft particles for CPU emitters (ADR 0126, amending 0096): a material plugin that fades a fragment's
 * alpha by `(sceneDepth − fragmentDepth) / softness`, so particle quads don't cut hard lines where they
 * cross geometry. The depth is the shared scene depth (ADR 0109) through 0096's `SceneDepth`, bound
 * for the camera drawing. It goes on the unlit particle material (`StandardMaterial`) and on per-draw
 * copies of material assets (`PBRMaterial`), never on a shared material.
 *
 * Both texture formats hold linear view depth (|z|, 0 where nothing was drawn); the fragment's own view
 * depth is |(view · worldPos).z|.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";

/** Where the scene's depth comes from (`SceneDepth` in `gpuParticles.ts`). */
export interface DepthSource {
  map(camera?: Camera | null): BaseTexture | null;
}

class SoftDefines extends MaterialDefines {
  MYCO_SOFT_PARTICLES = false;
}

/** @internal Soft particles on one (unshared) standard or PBR material. */
export class MycoSoftParticlePlugin extends MaterialPluginBase {
  private readonly pbr: boolean;
  constructor(
    material: StandardMaterial | PBRMaterial,
    /** Metres over which particles fade in front of surfaces. */
    public softness: number,
    private readonly depth: DepthSource,
  ) {
    super(material, "MycoSoftParticles", 230, new SoftDefines(), true, true);
    this.pbr = material instanceof PBRMaterial;
  }

  override getClassName(): string {
    return "MycoSoftParticlePlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.WGSL || shaderLanguage === ShaderLanguage.GLSL;
  }

  override prepareDefines(defines: SoftDefines): void {
    defines.MYCO_SOFT_PARTICLES = this.softness > 0;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("mycoSoftDepth");
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return { ubo: [{ name: "mycoSoft", size: 4, type: "vec4" }], fragment: "" };
  }

  override bindForSubMesh(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    // The camera drawing now: each camera has its own depth (ADR 0109).
    const map = this.depth.map(scene.activeCamera);
    if (!map) {
      ubo.updateFloat4("mycoSoft", 0, 1, 1, 0);
      return;
    }
    const size = map.getSize();
    ubo.updateFloat4("mycoSoft", this.softness, size.width, size.height, 1);
    ubo.setTexture("mycoSoftDepth", map);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    const c = this.pbr ? "finalColor" : "color";
    return wgsl
      ? {
          CUSTOM_FRAGMENT_DEFINITIONS: "#ifdef MYCO_SOFT_PARTICLES\nvar mycoSoftDepth: texture_2d<f32>;\nvar mycoSoftDepthSampler: sampler;\n#endif\n",
          CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `#ifdef MYCO_SOFT_PARTICLES
if (uniforms.mycoSoft.w > 0.5) {
  let mycoDims = vec2f(textureDimensions(mycoSoftDepth));
  let mycoPx = vec2i(clamp(fragmentInputs.position.xy, vec2f(0.0), mycoDims - 1.0));
  var mycoScene = abs(textureLoad(mycoSoftDepth, mycoPx, 0).r);
  if (mycoScene == 0.0) { mycoScene = 1e9; }
  let mycoMine = abs((scene.view * vec4f(fragmentInputs.vPositionW, 1.0)).z);
  let mycoFade = clamp((mycoScene - mycoMine) / max(uniforms.mycoSoft.x, 0.0001), 0.0, 1.0);
#ifdef PREMULTIPLYALPHA
  ${c} = ${c} * mycoFade;
#else
  ${c} = vec4f(${c}.rgb, ${c}.a * mycoFade);
#endif
}
#endif
`,
        }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: "#ifdef MYCO_SOFT_PARTICLES\nuniform sampler2D mycoSoftDepth;\n#endif\n",
          CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `#ifdef MYCO_SOFT_PARTICLES
if (mycoSoft.w > 0.5) {
  float mycoScene = abs(texture2D(mycoSoftDepth, gl_FragCoord.xy / mycoSoft.yz).r);
  if (mycoScene == 0.0) { mycoScene = 1e9; }
  float mycoMine = abs((view * vec4(vPositionW, 1.0)).z);
  float mycoFade = clamp((mycoScene - mycoMine) / max(mycoSoft.x, 0.0001), 0.0, 1.0);
#ifdef PREMULTIPLYALPHA
  ${c} *= mycoFade;
#else
  ${c}.a *= mycoFade;
#endif
}
#endif
`,
        };
  }
}

/** The soft fade the shader computes, for tests: 0–1 from the two view depths (scene 0: nothing drawn). */
export function softFade(sceneDepth: number, particleDepth: number, softness: number): number {
  const scene = Math.abs(sceneDepth) || 1e9;
  return Math.min(1, Math.max(0, (scene - Math.abs(particleDepth)) / Math.max(softness, 1e-4)));
}
