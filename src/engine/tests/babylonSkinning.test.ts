// ADR 0370 "Rendering" (T16): the Animation plugin's skinning render feature on Babylon (NullEngine, so the kernel's
// CPU executor): a SkinnedMeshRenderer becomes a Babylon mesh that casts shadows, is reported drawn (picking, outlines),
// and goes on release. Through the feature's registration, as the renderer loads it.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import type { World } from "../core/World";
import { _registeredRenderFeatures } from "../render/renderFeatures";
import type { BabylonFeature, BabylonFeatureHost } from "../render/babylon/feature";
import { SkinnedMeshRenderer } from "../../plugins/animation/runtime";
import { _startWorldService } from "../core/worldServices";
import { Camera, LODGroup } from "../render/components";
import { VISIBILITY_SERVICE_ID, type VisibilityService } from "../render/visibility/service";
import { lodMemberTypes } from "../render/visibility/lodMember";
import { makeView } from "../render/visibility/views";
import type { VisibilityView } from "../render/visibility/types";
import { loadMeshes, type ModelMesh } from "../scene/models";
import { memoryLodCache, setLodHost } from "../scene/lod/cache";
import { generateLods } from "../scene/lod/generate";
import { DEFAULT_LOD_SETTINGS } from "../scene/lod/types";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";

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

/** A bumpy sphere as an OBJ (latitude-longitude grid with normals and UVs). */
function bumpyObj(rows = 16, columns = 24): string {
  const lines = ["o Rock"];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const theta = (r / rows) * Math.PI, phi = (c / columns) * 2 * Math.PI;
      const k = 1 + 0.08 * Math.sin(5 * theta) * Math.cos(3 * phi);
      const x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi);
      lines.push(`v ${(x * k * 0.5).toFixed(5)} ${(y * k * 0.5).toFixed(5)} ${(z * k * 0.5).toFixed(5)}`, `vn ${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`, `vt ${(c / columns).toFixed(5)} ${(1 - r / rows).toFixed(5)}`);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * (columns + 1) + c + 1;
      const [a, b, d, e] = [i, i + 1, i + columns + 1, i + columns + 2];
      const f = (...v: number[]) => `f ${v.map((x) => `${x}/${x}/${x}`).join(" ")}`;
      if (r > 0) lines.push(f(a, d, b));
      if (r < rows - 1) lines.push(f(b, d, e));
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("skinned LOD levels per view (ADR 0459 §6)", () => {
  const ROCK = "asset:models/rock.obj";
  let engine: Engine;
  let world: World;
  let rock: ModelMesh;
  let nullEngine: NullEngine;
  let scene: Scene;
  let feature: BabylonFeature;
  let service: VisibilityService;

  beforeEach(async () => {
    setLodHost({ generate: generateLods, cache: memoryLodCache() });
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "models/rock.obj": `data:text/plain;base64,${Buffer.from(bumpyObj()).toString("base64")}`,
        "models/rock.obj.meta.json": { format: "myco.import@1", lod: DEFAULT_LOD_SETTINGS },
      }),
    );
    engine = await Engine.create({ headless: true });
    engines.push(engine);
    await SceneManager.load("s.json");
    world = engine.world as unknown as World;
    [rock] = await loadMeshes(ROCK);
    nullEngine = new NullEngine();
    scene = new Scene(nullEngine);
    const reg = _registeredRenderFeatures().find((f) => f.spec.name === "skinning")!;
    const factory = (await reg.load()) as unknown as (host: BabylonFeatureHost) => BabylonFeature;
    feature = factory({ scene, materials: { slotMaterials: () => () => null } } as unknown as BabylonFeatureHost);
    const eye = GameObject.create("eye").addComponent(Camera);
    eye.projection = "perspective";
    eye.fieldOfView = 90;
    service = (await _startWorldService(world, VISIBILITY_SERVICE_ID)) as VisibilityService;
  });
  afterEach(() => {
    feature.dispose();
    scene.dispose();
    nullEngine.dispose();
    setLodHost(null);
    Assets.clearSources();
  });

  /** A group of size 1 with heights 0.5 / 0.2 / 0.05 (h = 1 / (2 z) for the 90 degree camera: level 1 at z = 2, 2 at z = 4, culled past 10). */
  const skinned = (name: string, z: number): SkinnedMeshRenderer => {
    const node = GameObject.create(name);
    node.transform!.position.set(0, 0, z);
    const g = node.addComponent(LODGroup);
    g.levels = [0.5, 0.2, 0.05];
    g.size = 1;
    return GameObject.create(`${name}-mesh`, { parent: node }).addComponent(SkinnedMeshRenderer, { mesh: ROCK });
  };
  const viewAt = (key: string, z: number): VisibilityView =>
    makeView({ key, kind: "camera", position: [0, 0, z], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], projection: "perspective", fovY: Math.PI / 2, orthoHalfHeight: 0, near: 0.1, far: 1000, widthPx: 1080, heightPx: 1080, persistent: true, occlusion: false });
  const frame = () => {
    engine.step(1 / 60);
    feature.sync(world, { view: null, viewCamera: null, ready: true, probeMeshes: [] });
  };
  const listOf = (drawing: ReturnType<NonNullable<BabylonFeature["prepareViews"]>>, i: number) => {
    const out: AbstractMesh[] = [];
    drawing!.meshes(i, out);
    return out;
  };
  const triangles = (list: readonly AbstractMesh[]) => list.map((m) => (m as Mesh).getTotalIndices() / 3);
  const tris = (level: number) => rock.lods!.levels[level].triangles;

  it("registers SkinnedMeshRenderer as an LOD member of the visibility stage", () => {
    expect(lodMemberTypes()).toContain(SkinnedMeshRenderer);
    const r = skinned("who", 3);
    expect(r.lodMeshes()).toEqual([rock]);
    expect([r.occlusion, r.castShadows]).toEqual(["auto", true]);
  });

  it("draws the level each view's result gives, as meshes sharing the skinned vertex buffers", () => {
    const r = skinned("hero", 6);
    frame();
    const near = viewAt("a/camera", 0), far = viewAt("b/camera", -4); // z 6: h 0.083 (level 2) from the first, 0.05 (2) from the second
    const closer = viewAt("c/camera", 5.5); // half a unit away: h 1 (level 0)
    const views = [near, far, closer].map((v) => ({ camera: null, visibility: v, result: service.select(v) }));
    const drawing = feature.prepareViews!(views, service.main)!;
    expect(drawing).not.toBeNull();
    expect(triangles(listOf(drawing, 2))).toEqual([tris(0)]);
    expect(triangles(listOf(drawing, 0))).toEqual([tris(2)]);
    const lod0 = listOf(drawing, 2)[0] as Mesh, lod2 = listOf(drawing, 0)[0] as Mesh;
    expect(lod0).not.toBe(lod2);
    for (const kind of ["position", "normal", "uv"]) expect(lod2.getVertexBuffer(kind)).toBe(lod0.getVertexBuffer(kind));
    expect(lod2.getTotalVertices()).toBe(lod0.getTotalVertices());
    // Every mesh the views draw is enabled and owned; the level nobody draws is disabled.
    expect([lod0, lod2].map((m) => m.isEnabled(false))).toEqual([true, true]);
    expect(drawing.owns(lod0) && drawing.owns(lod2)).toBe(true);
    expect([...feature.drawn!()].map((d) => d.component)).toEqual([r]);
    expect(feature.describe!(lod2)?.node).toBe(r.node);
  });

  it("leaves LOD-culled renderers out of the view and casts at the main view's caster level", () => {
    const r = skinned("speck", 30); // h 0.017: culled below 0.05
    frame();
    const view = viewAt("a/camera", 0);
    const result = service.select(view);
    const drawing = feature.prepareViews!([{ camera: null, visibility: view, result }], service.main)!;
    expect(listOf(drawing, 0)).toEqual([]);
    expect([...feature.drawn!()]).toEqual([]);
    const casters: AbstractMesh[] = [];
    feature.casters!(casters);
    // A culled group still casts, at its coarsest level, within the shadow distance.
    expect(triangles(casters)).toEqual([tris(2)]);
    r.castShadows = false;
    frame();
    const again = feature.prepareViews!([{ camera: null, visibility: view, result: service.select(view) }], service.main)!;
    expect(again).not.toBeNull();
    const none: AbstractMesh[] = [];
    feature.casters!(none);
    expect(none).toEqual([]);
  });

  it("draws level 0 alone, as always, without a visibility stage's result", () => {
    skinned("plain", 6);
    frame();
    const view = viewAt("a/camera", 0);
    expect(feature.prepareViews!([{ camera: null, visibility: view, result: null }], null)).toBeNull();
    const meshes = [...feature.drawn!()].flatMap((d) => (d.shape?.kind === "meshes" ? d.shape.meshes : []));
    expect(triangles(meshes as AbstractMesh[])).toEqual([tris(0)]);
  });
});
