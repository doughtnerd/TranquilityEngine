// ADR 0446 §3: the mesh feature applies levels per view. Each view draws the drawable of the level its visibility
// result gives (none when hidden or LOD-culled), casters follow the main view's caster levels, thin batches draw
// through per-pass sources, level drawables are pooled and empty batches kept a while; without a visibility stage
// nothing changes. On Babylon's NullEngine, with a model whose levels come from the real import pipeline.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Scene as BabylonScene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _startWorldService } from "../../core/worldServices";
import { Assets, Engine, GameObject, Material, SceneManager } from "../../index";
import { loadMeshes, type ModelMesh } from "../../scene/models";
import { memoryLodCache, setLodHost } from "../../scene/lod/cache";
import { generateLods } from "../../scene/lod/generate";
import { DEFAULT_LOD_SETTINGS } from "../../scene/lod/types";
import { Camera, LODGroup, MeshRenderer } from "../components";
import { VISIBILITY_SERVICE_ID, type VisibilityService } from "../visibility/service";
import { cameraView, makeView } from "../visibility/views";
import type { VisibilityView } from "../visibility/types";
import type { FeatureView } from "./feature";
import { BabylonMaterialLibrary } from "./materialLibrary";
import { BabylonMeshes, POOL_SECONDS } from "./meshes";
import { BATCH_RETAIN_SECONDS } from "./meshBatches";

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

const ROCK = "asset:models/rock.obj";
const THIN = "asset:materials/thin.material.json";

describe("levels per view in the mesh feature (ADR 0446 §3)", () => {
  let engine: Engine;
  let nullEngine: NullEngine;
  let scene: BabylonScene;
  let lib: BabylonMaterialLibrary;
  let feature: BabylonMeshes;
  let rock: ModelMesh;

  beforeEach(async () => {
    setLodHost({ generate: generateLods, cache: memoryLodCache() });
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "models/rock.obj": `data:text/plain;base64,${Buffer.from(bumpyObj()).toString("base64")}`,
        "models/rock.obj.meta.json": { format: "myco.import@1", lod: DEFAULT_LOD_SETTINGS },
        "materials/thin.material.json": { format: "myco.material@1", color: "#00ff00", instancing: "thin" },
      }),
    );
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    [rock] = await loadMeshes(ROCK);
    nullEngine = new NullEngine();
    scene = new BabylonScene(nullEngine);
    lib = new BabylonMaterialLibrary(scene, { editorPicking: () => false });
    feature = new BabylonMeshes({ scene, materials: lib, probes: { any: false, lookup: () => null } });
  });
  afterEach(() => {
    Material._resetShared();
    feature.dispose();
    lib.dispose();
    scene.dispose();
    nullEngine.dispose();
    engine.dispose();
    setLodHost(null);
    Assets.clearSources();
  });

  /** A camera at the origin looking along +Z with a 90° field of view (h = size / (2·d)). */
  const eye = (): Camera => {
    const c = GameObject.create("eye").addComponent(Camera);
    c.projection = "perspective";
    c.fieldOfView = 90;
    return c;
  };
  /** A group of size 1 with heights 0.5 / 0.2 / 0.05 at z (level 1 at z = 2, level 2 at z = 4, culled past 10). */
  const group = (name: string, z: number, material?: string): { group: LODGroup; renderer: MeshRenderer } => {
    const node = GameObject.create(name);
    node.transform!.position.set(0, 0, z);
    const g = node.addComponent(LODGroup);
    g.levels = [0.5, 0.2, 0.05];
    g.size = 1;
    const renderer = GameObject.create(`${name}-mesh`, { parent: node }).addBehavior(MeshRenderer, { mesh: ROCK, ...(material ? { material } : {}) });
    return { group: g, renderer };
  };
  const service = async () => (await _startWorldService(engine.world, VISIBILITY_SERVICE_ID)) as VisibilityService;
  /** A view at z looking along +Z (as `eye`), 1080 pixels high. */
  const viewAt = (key: string, z: number): VisibilityView =>
    makeView({ key, kind: "camera", position: [0, 0, z], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], projection: "perspective", fovY: Math.PI / 2, orthoHalfHeight: 0, near: 0.1, far: 1000, widthPx: 1080, heightPx: 1080, persistent: true, occlusion: false });
  const featureView = (s: VisibilityService, view: VisibilityView): FeatureView => ({ camera: null, visibility: view, result: s.select(view) });
  const frame = (dt = 1 / 60) => {
    engine.step(dt);
    feature.sync(engine.world);
  };
  /** What view i drew: each Babylon mesh's triangle count (an instance's is its source's). */
  const drawnTriangles = (list: readonly AbstractMesh[]) => list.map((m) => ((m instanceof InstancedMesh ? m.sourceMesh : (m as Mesh)).getTotalIndices() / 3));
  const listOf = (drawing: ReturnType<BabylonMeshes["prepareViews"]>, i: number) => {
    const out: AbstractMesh[] = [];
    drawing!.meshes(i, out);
    return out;
  };
  const tris = (level: number) => rock.lods!.levels[level].triangles;

  it("draws as always (LOD0, no per-view lists) without a visibility stage", () => {
    eye();
    const r = GameObject.create("plain").addBehavior(MeshRenderer, { mesh: ROCK });
    r.node.transform!.position.set(0, 0, 4);
    frame();
    const view = viewAt("x/camera", 0);
    expect(feature.prepareViews([{ camera: null, visibility: view, result: null }], null)).toBeNull();
    const shape = [...feature.drawn()][0].shape;
    expect(shape?.kind === "meshes" && drawnTriangles(shape.meshes)).toEqual([tris(0)]);
    expect(feature.diagnostics()).toBeUndefined();
  });

  it("gives each view the drawable of the level its result chose, and nothing hidden or LOD-culled", async () => {
    const camera = eye();
    const { renderer } = group("rock", 4);
    const s = await service();
    frame();
    const main = featureView(s, cameraView(camera, 1080, 1080));
    const close = featureView(s, viewAt("close/camera", 3.5)); // d = 0.5: level 0
    const behind = featureView(s, viewAt("back/camera", 8)); // the rock is behind it
    const far = featureView(s, viewAt("far/camera", -20)); // d = 24: LOD-culled
    expect(main.result).toBe(s.main);
    const drawing = feature.prepareViews([main, close, behind, far], s.main)!;
    expect(drawing).not.toBeNull();
    expect(drawnTriangles(listOf(drawing, 0))).toEqual([tris(2)]);
    expect(drawnTriangles(listOf(drawing, 1))).toEqual([tris(0)]);
    expect(listOf(drawing, 2)).toEqual([]);
    expect(listOf(drawing, 3)).toEqual([]);
    // Every mesh it listed is its own (left out of the scene's list), enabled; the editor tools see the first view's.
    for (const m of [...listOf(drawing, 0), ...listOf(drawing, 1)]) {
      expect(drawing.owns(m)).toBe(true);
      expect(m.isEnabled()).toBe(true);
    }
    const shown = [...feature.drawn()].find((d) => d.component === renderer)!.shape;
    expect(shown?.kind === "meshes" && shown.meshes).toEqual(listOf(drawing, 0));
    // Casters follow the main view's level; the casters hook reports them.
    const casters: AbstractMesh[] = [];
    feature.casters(casters);
    expect(drawnTriangles(casters)).toEqual([tris(2)]);
    expect(feature.diagnostics()).toEqual({ lod: { groups: 1, perLevel: [0, 0, 1], culled: 0, fading: 0 } });
  });

  it("casts a LOD-culled group's shadow at its coarsest level within the shadow distance, and none without castShadows", async () => {
    const camera = eye();
    const { renderer } = group("rock", 14); // h ≈ 0.036: culled, 14 m away
    const s = await service();
    frame();
    const main = featureView(s, cameraView(camera, 1080, 1080));
    const drawing = feature.prepareViews([main], s.main)!;
    expect(listOf(drawing, 0)).toEqual([]);
    const casters: AbstractMesh[] = [];
    feature.casters(casters);
    expect(drawnTriangles(casters)).toEqual([tris(2)]); // the group's last level (three heights)
    renderer.castShadows = false;
    frame();
    feature.prepareViews([featureView(s, cameraView(camera, 1080, 1080))], s.main);
    casters.length = 0;
    feature.casters(casters);
    expect(casters).toEqual([]);
  });

  it("keeps a level's drawable a second after the views stop drawing it, and its empty batch a few seconds more", async () => {
    const camera = eye();
    const { group: g } = group("rock", 4);
    const s = await service();
    const prepare = () => feature.prepareViews([featureView(s, cameraView(camera, 1080, 1080))], s.main)!;
    frame();
    const [level2] = listOf(prepare(), 0) as InstancedMesh[];
    const source2 = level2.sourceMesh;
    g.node.transform!.position.set(0, 0, 2); // level 1 now
    frame();
    const [level1] = listOf(prepare(), 0) as InstancedMesh[];
    expect(drawnTriangles([level1])).toEqual([tris(1)]);
    expect(level2.isDisposed()).toBe(false); // pooled, disabled
    expect(level2.isEnabled()).toBe(false);
    // Back within the second: the same Babylon instance draws again.
    g.node.transform!.position.set(0, 0, 4);
    frame(0.5);
    expect(listOf(prepare(), 0)).toEqual([level2]);
    // Away for over a second: the drawable goes, its batch stays a few seconds, then goes too.
    g.node.transform!.position.set(0, 0, 2);
    frame();
    prepare();
    frame(POOL_SECONDS + 0.1);
    prepare();
    expect(level2.isDisposed()).toBe(true);
    expect(source2.isDisposed()).toBe(false);
    frame(BATCH_RETAIN_SECONDS + 0.1);
    prepare();
    expect(source2.isDisposed()).toBe(true);
  });

  it("splits batches per level, every level's source on the model mesh's shared vertex buffers", async () => {
    const camera = eye();
    group("a", 4);
    group("b", 2);
    const s = await service();
    frame();
    const list = listOf(feature.prepareViews([featureView(s, cameraView(camera, 1080, 1080))], s.main)!, 0) as InstancedMesh[];
    expect(drawnTriangles(list).sort((x, y) => x - y)).toEqual([tris(2), tris(1)].sort((x, y) => x - y));
    const [a, b] = list.map((m) => m.sourceMesh);
    expect(a).not.toBe(b);
    expect(a.getVertexBuffer(VertexBuffer.PositionKind)).toBe(b.getVertexBuffer(VertexBuffer.PositionKind));
    expect(a.getVertexBuffer(VertexBuffer.NormalKind)).toBe(b.getVertexBuffer(VertexBuffer.NormalKind));
    expect(a.geometry).not.toBe(b.geometry);
  });

  it("draws thin batches through a source per view and one for the casters, each with only its instances", async () => {
    const camera = eye();
    group("a", 4, THIN);
    group("b", 4.5, THIN);
    group("c", 2, THIN);
    const s = await service();
    frame();
    const main = featureView(s, cameraView(camera, 1080, 1080));
    const close = featureView(s, viewAt("close/camera", 1)); // a and b at level 0 or 1, c too close to tell apart
    const drawing = feature.prepareViews([main, close], s.main)!;
    const counts = (list: readonly AbstractMesh[]) => list.map((m) => [(m as Mesh).getTotalIndices() / 3, (m as Mesh).thinInstanceCount]).sort((x, y) => x[0] - y[0]);
    expect(counts(listOf(drawing, 0))).toEqual([[tris(2), 2], [tris(1), 1]].sort((x, y) => x[0] - y[0]));
    for (const m of listOf(drawing, 0)) expect(drawing.owns(m)).toBe(true);
    const mainSources = new Set(listOf(drawing, 0));
    for (const m of listOf(drawing, 1)) expect(mainSources.has(m)).toBe(false); // the other view has sources of its own
    const casters: AbstractMesh[] = [];
    feature.casters(casters);
    expect(counts(casters)).toEqual(counts(listOf(drawing, 0)));
    for (const m of casters) expect(mainSources.has(m)).toBe(false);
  });
});
