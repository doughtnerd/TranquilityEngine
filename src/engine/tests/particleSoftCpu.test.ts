// ADR 0126: soft particles on CPU emitters (mesh draws with a depth-fade plugin), height fog on particle
// draws, and the height-fog hook for ShaderMaterials. On Babylon's NullEngine.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heightFogOn, heightFogShader, setHeightFog, useHeightFog } from "../render/babylon/heightFog";
import { BabylonParticles } from "../render/babylon/particles";
import { MycoSoftParticlePlugin } from "../render/babylon/softParticles";
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
      particlePreview: () => null,
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
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
    const parts = player.warm(effect, "w", at, camera)!;
    expect(parts.systems).toHaveLength(1); // the hard one
    const [soft, rocks] = parts.meshes;
    expect([soft!.hasThinInstances, rocks!.hasThinInstances]).toEqual([false, true]);
    expect(softPlugin(soft!.material)?.softness).toBe(0.5);
    expect(softPlugin(rocks!.material)?.softness).toBe(1);
    parts.dispose();
  });

  it("fades a copy of a shared material asset, leaving the asset alone", () => {
    const shared = new PBRMaterial("fx", scene);
    material = shared;
    const parts = player.warm(particleEffectJSON({ emitters: [emitter("Lit", { material: "materials/fx.material.json", softness: 2 })] }), "w", at, camera)!;
    const used = parts.meshes[0]!.material!;
    expect(used).not.toBe(shared);
    expect(softPlugin(used)?.softness).toBe(2);
    expect(softPlugin(shared)).toBeNull();
    parts.dispose();
    expect(scene.materials.includes(used)).toBe(false); // the copy goes with the draw
    expect(scene.materials.includes(shared)).toBe(true);
  });

  it("moves billboards to mesh quads while the scene has height fog (their material fogs)", () => {
    expect(heightFogOn(scene)).toBe(false);
    setHeightFog(scene, FOG_ON);
    expect(heightFogOn(scene)).toBe(true);
    const parts = player.warm(particleEffectJSON({ emitters: [emitter("Dots", {})] }), "w", at, camera)!;
    expect(parts.systems).toHaveLength(0);
    // (After earlier tests disposed their engines: the plugin is registered again.)
    const mat = parts.meshes[0]!.material!;
    expect(mat.pluginManager?.getPlugin("MycoHeightFog")).toBeTruthy();
    parts.dispose();
  });

  it("splices height fog into standard materials before Babylon's own fog", () => {
    // Babylon collects a plugin's injection points inside its base constructor, before fields are set.
    const m = new StandardMaterial("s", scene);
    const points = (m.pluginManager as unknown as { _codeInjectionPoints: { fragment?: Record<string, unknown> } })._codeInjectionPoints;
    expect(points.fragment?.CUSTOM_FRAGMENT_BEFORE_FOG).toBeTruthy();
    const pbr = new PBRMaterial("p2", scene);
    const pp = (pbr.pluginManager as unknown as { _codeInjectionPoints: { fragment?: Record<string, unknown> } })._codeInjectionPoints;
    expect(pp.fragment?.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toBeTruthy();
  });

  it("emits the fade code in both shading languages", () => {
    const m = new PBRMaterial("p", scene);
    const plugin = new MycoSoftParticlePlugin(m, 1, { map: () => null });
    expect(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain("finalColor");
    expect(plugin.getCustomCode("fragment", ShaderLanguage.GLSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain("mycoSoftDepth");
    expect(plugin.getCustomCode("vertex", ShaderLanguage.WGSL)).toBeNull();
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
