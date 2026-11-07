// ADR 0126: soft particles on CPU emitters (mesh draws with a depth-fade plugin), height fog on particle
// draws, and the height-fog hook for ShaderMaterials. On Babylon's NullEngine.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heightFogOn, heightFogShader, setHeightFog, useHeightFog } from "../render/babylon/heightFog";
import type { InstanceDraw, QuadDraw } from "../render/babylon/particleMeshes";
import { BabylonParticles } from "../render/babylon/particles";
import { MycoSoftParticlePlugin, softFade } from "../render/babylon/softParticles";
import { compileParticleGraph } from "../scene/particleCompile";
import { defaultParticleGraph } from "../scene/particleGraphFormat";
import { defaultEmitter, defaultShape, particleEffectJSON, parseParticleEffect, type ParticleEmitterSettings, type ParticleRenderer } from "../scene/particles";

const emitter = (name: string, r: Partial<ParticleRenderer>): ParticleEmitterSettings => {
  const e = defaultEmitter(name);
  return { ...e, startLife: 10, startSpeed: 0, startSize: 2, shape: { ...defaultShape(), radius: 0, angle: 0 }, behaviors: [], renderer: { ...e.renderer, ...r } };
};

const softPlugin = (m: Material | null): MycoSoftParticlePlugin | null => (m?.pluginManager?.getPlugin("MycoSoftParticles") as MycoSoftParticlePlugin | null) ?? null;
const FOG_ON = { on: true, density: 0.1, base: 0, falloff: 0.2, color: [0.5, 0.6, 0.7] as [number, number, number] };

describe("soft CPU particles and particle height fog (ADR 0126)", () => {
  let babylon: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  let player: BabylonParticles;
  let material: Material | null;
  const at = { x: 0, y: 0, z: 0 };

  beforeEach(() => {
    babylon = new NullEngine();
    scene = new Scene(babylon);
    camera = new TargetCamera("camera", new Vector3(0, 0, -10), scene);
    camera.setTarget(Vector3.Zero());
    material = null;
    player = new BabylonParticles({
      scene,
      editor: false,
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      selected: () => true,
      texture: () => Promise.reject(new Error("no textures")),
      tierScale: () => 1,
      material: () => material,
    });
  });
  afterEach(() => {
    player.dispose();
    scene.dispose();
    babylon.dispose();
  });

  it("carries softness from the graph to the CPU model and through the effect format", () => {
    const g = defaultParticleGraph();
    g.systems[0].output.settings.softness = 0.75;
    expect(compileParticleGraph(g).effect.emitters[0].renderer.softness).toBe(0.75);
    const back = parseParticleEffect(particleEffectJSON({ emitters: [emitter("A", { softness: 0.5 })] }));
    expect(back.effect.emitters[0].renderer.softness).toBe(0.5);
  });

  it("draws soft billboards as mesh quads with the fade, and hard ones through a Babylon particle system", () => {
    const effect = particleEffectJSON({ emitters: [emitter("Soft", { softness: 0.5 }), emitter("Hard", {}), emitter("Rocks", { mode: "mesh", softness: 1 })] });
    const draws = player.warmDraws(effect, "w", at, () => camera)!;
    expect(draws.map((d) => d.kind)).toEqual(["quads", "system", "instances"]);
    expect(softPlugin((draws[0] as QuadDraw).mesh.material)?.softness).toBe(0.5);
    expect(softPlugin((draws[2] as InstanceDraw).mesh.material)?.softness).toBe(1);
    for (const d of draws) d.dispose();
  });

  it("fades a copy of a shared material asset, leaving the asset alone", () => {
    const shared = new PBRMaterial("fx", scene);
    material = shared;
    const draws = player.warmDraws(particleEffectJSON({ emitters: [emitter("Lit", { material: "materials/fx.material.json", softness: 2 })] }), "w", at, () => camera)!;
    const used = (draws[0] as QuadDraw).mesh.material!;
    expect(used).not.toBe(shared);
    expect(softPlugin(used)?.softness).toBe(2);
    expect(softPlugin(shared)).toBeNull();
    draws[0].dispose();
    expect(scene.materials.includes(used)).toBe(false); // the copy goes with the draw
    expect(scene.materials.includes(shared)).toBe(true);
  });

  it("moves billboards to mesh quads while the scene has height fog (their material fogs)", () => {
    expect(heightFogOn(scene)).toBe(false);
    setHeightFog(scene, FOG_ON);
    expect(heightFogOn(scene)).toBe(true);
    const draws = player.warmDraws(particleEffectJSON({ emitters: [emitter("Dots", {})] }), "w", at, () => camera)!;
    expect(draws[0].kind).toBe("quads");
    // (After earlier tests disposed their engines: the plugin is registered again.)
    const mat = (draws[0] as QuadDraw).mesh.material!;
    expect(mat.pluginManager?.getPlugin("MycoHeightFog")).toBeTruthy();
    draws[0].dispose();
  });

  it("emits the fade code in both shading languages", () => {
    const m = new PBRMaterial("p", scene);
    const plugin = new MycoSoftParticlePlugin(m, 1, { map: () => null });
    expect(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain("finalColor");
    expect(plugin.getCustomCode("fragment", ShaderLanguage.GLSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain("mycoSoftDepth");
    expect(plugin.getCustomCode("vertex", ShaderLanguage.WGSL)).toBeNull();
  });

  it("fades over the softness in front of the scene's surfaces", () => {
    expect(softFade(10, 9, 2)).toBeCloseTo(0.5);
    expect(softFade(10, 7, 2)).toBe(1);
    expect(softFade(10, 10.5, 2)).toBe(0);
    expect(softFade(0, 50, 2)).toBe(1); // nothing drawn behind
  });

  it("keeps a ShaderMaterial's height-fog define in step with the scene", () => {
    const fog = heightFogShader("glsl");
    expect(fog.decl).toContain("mycoApplyHeightFog");
    expect(heightFogShader("wgsl").decl).toContain("fn mycoHeightFogFactor");
    const m = new ShaderMaterial("custom", scene, { vertexSource: "void main(){}", fragmentSource: `${fog.decl}void main(){}` }, { uniforms: fog.uniforms, defines: [] });
    useHeightFog(m, scene);
    expect(m.options.defines).not.toContain("#define MYCO_HEIGHT_FOG");
    setHeightFog(scene, FOG_ON);
    expect(m.options.defines).toContain("#define MYCO_HEIGHT_FOG");
    setHeightFog(scene, { ...FOG_ON, on: false });
    expect(m.options.defines).not.toContain("#define MYCO_HEIGHT_FOG");
  });
});
