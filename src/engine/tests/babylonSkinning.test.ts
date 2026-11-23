// ADR 0370 "Rendering" (T16): the Animation plugin's skinning render feature on Babylon (NullEngine, so the kernel's
// CPU executor): a SkinnedMeshRenderer becomes a Babylon mesh that casts shadows, is reported drawn (picking, outlines),
// and goes on release. Through the feature's registration, as the renderer loads it.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import type { World } from "../core/World";
import { _registeredRenderFeatures } from "../render/renderFeatures";
import type { BabylonFeature, BabylonFeatureHost } from "../render/babylon/feature";
import { SkinnedMeshRenderer } from "../../plugins/animation/runtime";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

describe("the skinning render feature on Babylon", () => {
  it("draws a SkinnedMeshRenderer on Babylon (NullEngine), casts its shadow, reports it drawn and releases it", async () => {
    const engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "s.scene.json": { format: "myco.scene@1", nodes: [] } }) });
    engines.push(engine);
    await SceneManager.load("s.scene.json");
    const w = engine.world as unknown as World;
    const reg = _registeredRenderFeatures().find((f) => f.spec.name === "skinning")!;
    const factory = (await reg.load()) as unknown as (host: BabylonFeatureHost) => BabylonFeature;
    const scene = new Scene(new NullEngine());
    const feature = factory({ scene, materials: { slotMaterials: () => () => null } } as unknown as BabylonFeatureHost);
    const r = GameObject.create("Crate").addComponent(SkinnedMeshRenderer);
    r.mesh = "builtin:cube"; // no skin: its rest pose, skinned by the kernel all the same
    feature.sync(w, { view: null, viewCamera: null, ready: true, probeMeshes: [] });
    const casters: AbstractMesh[] = [];
    feature.casters!(casters);
    expect(casters).toHaveLength(1);
    expect(scene.meshes).toContain(casters[0]);
    const drawn = [...feature.drawn!()];
    expect(drawn.map((d) => [d.component, d.shape?.kind])).toEqual([[r, "meshes"]]);
    expect(feature.describe!(casters[0])?.node).toBe(r.node);
    expect(feature.loaded!()).toBe(true);
    r.castShadows = false;
    const none: AbstractMesh[] = [];
    feature.casters!(none);
    expect(none).toHaveLength(0);
    feature.release!(r);
    expect(scene.meshes).not.toContain(casters[0]);
    feature.dispose();
  });
});
