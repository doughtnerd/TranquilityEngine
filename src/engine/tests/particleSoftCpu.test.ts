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
import { nullEngine, shaderText } from "./pbrShaderSource";
import { runShader, vec, type Vec } from "./shaderMaths";
import { compileParticleGraph } from "../scene/particleCompile";
import { defaultParticleGraph } from "../scene/particleGraphFormat";
import { defaultEmitter, defaultShape, parseParticleEffect, type ParticleEmitterSettings, type ParticleRenderer, PARTICLES_FORMAT, type ParticleEffect } from "../scene/particles";

/** An effect as its `myco.particles@1` file's JSON object. */
const legacyJSON = (effect: ParticleEffect): Record<string, unknown> => ({ format: PARTICLES_FORMAT, ...effect });

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
    const back = parseParticleEffect(legacyJSON({ emitters: [emitter("A", { softness: 0.5 })] }));
    expect(back.effect.emitters[0].renderer.softness).toBe(0.5);
  });

  it("draws soft billboards as mesh quads with the fade, and hard ones through a Babylon particle system", () => {
    const effect = legacyJSON({ emitters: [emitter("Soft", { softness: 0.5 }), emitter("Hard", {}), emitter("Rocks", { mode: "mesh", softness: 1 })] });
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
    const parts = player.warm(legacyJSON({ emitters: [emitter("Lit", { material: "materials/fx.material.json", softness: 2 })] }), "w", at, camera)!;
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
    const parts = player.warm(legacyJSON({ emitters: [emitter("Dots", {})] }), "w", at, camera)!;
    expect(parts.systems).toHaveLength(0);
    // (After earlier tests disposed their engines: the plugin is registered again.)
    const mat = parts.meshes[0]!.material!;
    expect(mat.pluginManager?.getPlugin("MycoHeightFog")).toBeTruthy();
    parts.dispose();
  });

  it.each(["wgsl", "glsl"] as const)("compiles height fog into standard materials before Babylon's own fog, and into PBR ones (%s)", async (language) => {
    const engine = nullEngine(language);
    const fogScene = new Scene(engine);
    const wgsl = language === "wgsl";
    const standard = (await shaderText(new StandardMaterial("s", fogScene))).fragment;
    const fogged = standard.lastIndexOf(wgsl ? "mycoHeightFogAmount(fragmentInputs.vPositionW" : "mycoHeightFogAmount(vPositionW");
    expect(fogged).toBeGreaterThan(0);
    expect(standard.indexOf(wgsl ? "mix(uniforms.vFogColor,color.rgb,fog)" : "mix(vFogColor,color.rgb,fog)")).toBeGreaterThan(fogged);
    const pbr = (await shaderText(new PBRMaterial("p", fogScene))).fragment;
    expect(pbr).toContain(wgsl ? "finalColor = vec4f(mix(finalColor.rgb, uniforms.mycoHeightFogColor.rgb" : "finalColor = vec4(mix(finalColor.rgb, mycoHeightFogColor.rgb");
    fogScene.dispose();
    engine.dispose();
  });

  it.each(["wgsl", "glsl"] as const)("compiles the fade into the standard or PBR material it is on (%s)", async (language) => {
    const engine = nullEngine(language);
    const softScene = new Scene(engine);
    const wgsl = language === "wgsl";
    const standard = new StandardMaterial("s", softScene);
    new MycoSoftParticlePlugin(standard, 1, { map: () => null });
    const pbr = new PBRMaterial("p", softScene);
    new MycoSoftParticlePlugin(pbr, 1, { map: () => null });
    const plain = new PBRMaterial("plain", softScene);
    const [s, p, none] = await Promise.all([standard, pbr, plain].map((m) => shaderText(m)));
    expect(s.fragment).toMatch(wgsl ? /\bcolor = vec4f\(color\.rgb, color\.a \* mycoFade\)/ : /\bcolor\.a \*= mycoFade/);
    expect(p.fragment).toContain(wgsl ? "finalColor = vec4f(finalColor.rgb, finalColor.a * mycoFade)" : "finalColor.a *= mycoFade");
    for (const t of [s, p]) expect(t.defines).toContain("#define MYCO_SOFT_PARTICLES");
    expect(none.fragment).not.toContain("mycoFade");
    softScene.dispose();
    engine.dispose();
  });

  it("emits the fade code in both shading languages", () => {
    const m = new PBRMaterial("p", scene);
    const plugin = new MycoSoftParticlePlugin(m, 1, { map: () => null });
    expect(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain("finalColor");
    expect(plugin.getCustomCode("fragment", ShaderLanguage.GLSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain("mycoSoftDepth");
    expect(plugin.getCustomCode("vertex", ShaderLanguage.WGSL)).toBeNull();
  });

  it("fades over the softness in front of the scene's surfaces, the same in both shading languages", () => {
    const softness = 2;
    const plugin = new MycoSoftParticlePlugin(new PBRMaterial("p", scene), softness, { map: () => null });
    /** The alpha each language's fade code leaves on an opaque fragment `particleDepth` metres away, with the scene `sceneDepth` metres away there (0: nothing drawn). */
    const fade = (sceneDepth: number, particleDepth: number): number => {
      const depthTexel = () => vec(4, sceneDepth, 0, 0, 0);
      // The view looks down −z: a fragment at z = −d is d metres away.
      const view = (v: Vec) => vec(4, v.c[0]!, v.c[1]!, v.c[2]!, 1);
      const position = vec(3, 0, 0, -particleDepth);
      const soft = vec(4, softness, 64, 64, 1);
      const result = "finalColor.a";
      const glsl = runShader(plugin.getCustomCode("fragment", ShaderLanguage.GLSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR!, {
        defines: ["MYCO_SOFT_PARTICLES"],
        env: { finalColor: vec(4, 1), mycoSoft: soft, mycoSoftDepth: null, texture2D: depthTexel, gl_FragCoord: vec(4, 0), view, vPositionW: position },
        result,
      }) as number;
      const wgsl = runShader(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR!, {
        defines: ["MYCO_SOFT_PARTICLES"],
        env: { finalColor: vec(4, 1), uniforms: { mycoSoft: soft }, mycoSoftDepth: null, textureDimensions: () => vec(2, 64), textureLoad: depthTexel, fragmentInputs: { position: vec(4, 0), vPositionW: position }, scene: { view } },
        result,
      }) as number;
      expect(wgsl).toBeCloseTo(glsl, 9);
      return glsl;
    };
    expect(fade(10, 9)).toBeCloseTo(0.5);
    expect(fade(10, 7)).toBe(1);
    expect(fade(10, 10.5)).toBe(0);
    expect(fade(0, 50)).toBe(1); // nothing drawn behind
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
