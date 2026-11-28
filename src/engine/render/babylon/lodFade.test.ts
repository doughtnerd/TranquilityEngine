// ADR 0459 §4: the dithered LOD crossfade plugin on Babylon's NullEngine, through `addLodFade`, `markFadeSource` and
// `canFade`: one material compiles the fade variant only for fade-batch source meshes (the define is per mesh), the
// plugin goes on once and after the graph plugin, and only materials that can take it are faded.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLodFade, canFade, LOD_FADE_ATTRIBUTE, markFadeSource, MycoLodFadePlugin } from "./lodFade";

describe("the LOD crossfade plugin (ADR 0459 §4)", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  /** Prepare `mesh`'s first submesh with its material, as a draw does; its defines and effect after. */
  function prepare(mesh: Mesh, instanced: boolean): { fade: boolean; effect: Effect | null } {
    const sub = mesh.subMeshes[0];
    mesh.material!.isReadyForSubMesh(mesh, sub, instanced);
    const defines = sub.materialDefines as unknown as { MYCO_LOD_FADE?: boolean } | null;
    return { fade: !!defines?.MYCO_LOD_FADE, effect: sub.effect };
  }

  it("sets MYCO_LOD_FADE per mesh: one material, a fading effect for fade-batch sources only", () => {
    const material = new PBRMaterial("m", scene);
    addLodFade(material);
    const steady = CreateBox("steady", {}, scene);
    const faded = CreateBox("faded", {}, scene);
    steady.material = faded.material = material;
    steady.createInstance("s1");
    markFadeSource(faded);
    const instance = faded.createInstance("f1");
    instance.instancedBuffers[LOD_FADE_ATTRIBUTE] = -0.25;
    const a = prepare(steady, true);
    const b = prepare(faded, true);
    expect(a.fade).toBe(false);
    expect(b.fade).toBe(true);
    expect(a.effect).not.toBe(b.effect);
    expect(b.effect!.defines).toContain("#define MYCO_LOD_FADE");
    expect(a.effect!.defines).not.toContain("MYCO_LOD_FADE");
    // A thin-instance source with its fade buffer fades too.
    const thin = CreateBox("thin", {}, scene);
    thin.material = material;
    thin.thinInstanceSetBuffer("matrix", new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 16, false);
    const values = new Float32Array([0.5]);
    markFadeSource(thin, values);
    expect(prepare(thin, true).fade).toBe(true);
    expect(thin.getVertexBuffer(LOD_FADE_ATTRIBUTE)?.getData()).toBe(values);
  });

  it("goes on a material once, after the graph plugin (200) and the probe blend (210)", () => {
    const material = new PBRMaterial("m", scene);
    addLodFade(material);
    const plugin = material.pluginManager!.getPlugin("MycoLodFade") as MycoLodFadePlugin;
    expect(plugin).toBeInstanceOf(MycoLodFadePlugin);
    addLodFade(material);
    expect(material.pluginManager!.getPlugin("MycoLodFade")).toBe(plugin);
    expect(plugin.priority).toBe(220);
  });

  it("discards with an inlined 4×4 Bayer rank in both languages (no #include: injected code isn't expanded), the incoming side keeping ranks below 16t", () => {
    const plugin = new MycoLodFadePlugin(new PBRMaterial("m", scene));
    for (const language of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const fragment = plugin.getCustomCode("fragment", language)!;
      // Babylon doesn't expand includes in plugin-injected code: one reached the GLSL compiler and no fade effect built.
      for (const code of Object.values(fragment)) expect(code).not.toContain("#include");
      expect(fragment.CUSTOM_FRAGMENT_DEFINITIONS).toContain("mycoBayer4(");
      expect(fragment.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain("mycoBayer4(floor(");
      expect(fragment.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain("discard");
      expect(plugin.getCustomCode("vertex", language)!.CUSTOM_VERTEX_DEFINITIONS).toContain("mycoLodFade");
      expect(plugin.isCompatible(language)).toBe(true);
    }
  });

  it("fades PBR and standard materials and multi-materials of them, not raw shader materials", () => {
    const pbr = new PBRMaterial("p", scene);
    const std = new StandardMaterial("s", scene);
    const raw = new ShaderMaterial("r", scene, { vertexSource: "", fragmentSource: "" });
    const multi = new MultiMaterial("mm", scene);
    multi.subMaterials = [pbr, std];
    expect([canFade(pbr), canFade(std), canFade(multi), canFade(raw)]).toEqual([true, true, true, false]);
    multi.subMaterials.push(raw);
    expect(canFade(multi)).toBe(false);
    const both = new MultiMaterial("both", scene);
    both.subMaterials = [new PBRMaterial("a", scene), new StandardMaterial("b", scene)];
    addLodFade(both);
    for (const m of both.subMaterials) expect(m!.pluginManager?.getPlugin("MycoLodFade")).toBeInstanceOf(MycoLodFadePlugin);
    addLodFade(raw); // ignored
    expect(raw.pluginManager?.getPlugin("MycoLodFade") ?? null).toBeNull();
  });
});
