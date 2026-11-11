// ADR 0128: the editor viewport's Babylon adapter (`BabylonEditorTools`) behind a `ViewportHandle`, on
// NullEngine with a fake renderer context (real Babylon scenes, meshes and utility layer), and the
// Babylon renderer's diagnostics snapshot.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Engine, GameObject, Material, SceneManager } from "../index";
import { MeshRenderer, SpriteRenderer } from "../render/components";
import { BabylonRenderer, loadPluginFeatures, type PluginFeature } from "../render/babylon/BabylonRenderer";
import type { BabylonEditorContext, BabylonEditorRendererHooks, EditorMesh } from "../render/babylon/editorContext";
import { BabylonEditorTools } from "../render/babylon/editorTools";
import { ViewportHandle } from "../render/editorViewport";
import { FakeRenderPolicyPort } from "../render/fakeViewport";
import type { UICoreLike } from "../ui/uiCoreTypes";

const COLORS = { background: 0x112233, grid: 0x445566, gridCenter: 0x778899, outline: 0xff8800, cameraGizmo: 0x00ff00 };

describe("the editor viewport's Babylon adapter (ADR 0128)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let layer: UtilityLayerRenderer;
  let cameras: Camera[];
  let meshes: EditorMesh[];
  let hooks: { [K in keyof BabylonEditorRendererHooks]: Mock<BabylonEditorRendererHooks[K]> };
  let tools: BabylonEditorTools | null;
  let loaded: boolean;

  const make = (editor = true) => {
    const ctx = {
      scene,
      overlay: layer,
      canvas: { clientWidth: 800, clientHeight: 600 },
      settings: World.require().settings,
      editor,
      world: () => World.require(),
      viewCameras: () => cameras,
      babylonCamera: () => null,
      sprites: () => [],
      meshes: () => meshes,
      texts: () => [],
      renderer: hooks,
    } as unknown as BabylonEditorContext;
    tools = new BabylonEditorTools(ctx);
    return new ViewportHandle(() => (loaded ? tools : null), new FakeRenderPolicyPort());
  };

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true, project: { display: { width: 800, height: 600 } } });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    layer = new UtilityLayerRenderer(scene);
    meshes = [];
    loaded = true;
    hooks = {
      setClearColor: vi.fn(),
      cameraPreviewDrawn: vi.fn(() => true),
      spriteSize: vi.fn(() => [3, 4] as [number, number]),
      ui: vi.fn(() => null),
      bakeReflectionProbe: vi.fn(async () => new Uint8Array([1, 2]).buffer),
    };
    const cam = GameObject.create("cam");
    cam.transform!.position.set(0, 0, 10);
    cameras = [cam.addBehavior(Camera, { projection: "orthographic", orthographicSize: 5 })];
  });

  afterEach(() => {
    tools?.dispose();
    layer.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const box = (name: string, pos: [number, number, number]) => {
    const node = GameObject.create(name);
    const mesh = MeshBuilder.CreateBox(name, { size: 2 }, scene);
    mesh.freezeWorldMatrix(Matrix.Translation(...pos));
    meshes.push({ component: { node } as never, meshes: [mesh as Mesh] });
    return node;
  };

  it("hands the editor's state to the tools once they load: grid, colours, selection and previews", () => {
    loaded = false;
    const viewport = make();
    const node = box("b", [0, 0, 0]);
    viewport.setGrid({ cellSize: 2, visible: false });
    viewport.setColors(COLORS);
    viewport.setSelection([node]);
    expect(viewport.ready).toBe(false);
    expect(viewport.grid()).toBeNull(); // nothing yet
    expect(hooks.setClearColor).not.toHaveBeenCalled();

    loaded = true;
    expect(viewport.grid()).toEqual({ plane: "xz", cellSize: 2, visible: false, divisions: expect.any(Number) });
    expect(viewport.ready).toBe(true);
    expect(hooks.setClearColor).toHaveBeenCalledWith(0x112233);
    expect(tools!.overlays.isOutlined(node)).toBe(true);

    viewport.pick(400, 300); // a later query doesn't replay again
    expect(hooks.setClearColor).toHaveBeenCalledTimes(1);
  });

  it("keeps a game surface's background: colours apply to editor Worlds only", () => {
    const viewport = make(false);
    viewport.setColors(COLORS);
    expect(hooks.setClearColor).not.toHaveBeenCalled();
  });

  it("picks, casts rays and projects through the view camera, in engine types", () => {
    const viewport = make();
    const near = box("near", [0, 0, 2]);
    const far = box("far", [0, 0, -2]);
    expect(viewport.pick(400, 300)).toEqual([near, far]);
    const ray = viewport.rayAt(400, 300)!;
    expect(ray.direction[2]).toBeCloseTo(-1);
    expect(viewport.worldToCanvas([0, 0, 0])).toEqual([expect.closeTo(400), expect.closeTo(300)]);
    expect(viewport.pointOnPlane(400, 300, [0, 0, 1], [0, 0, 1])).toEqual([expect.closeTo(0), expect.closeTo(0), 1]);
    expect(viewport.meshBounds(near)).toEqual({ min: [-1, -1, 1], max: [1, 1, 3] });
    const bounds = viewport.screenBounds(World.require().root).find((b) => b.node === near)!;
    expect(bounds.rect.left).toBeLessThan(400);
    expect(bounds.rect.right).toBeGreaterThan(400);
  });

  it("finds overlay handles on the canvas and picks the nearest", () => {
    const viewport = make();
    viewport.setOverlay(() => ({ lines: [], handles: [{ id: "a", position: [0, 0, 0], color: 0xffffff }, { id: "b", position: [1, 0, 0], color: 0xffffff }] }));
    tools!.sync(World.require());
    const handles = viewport.overlayHandles();
    expect(handles.map((h) => h.id)).toEqual(["a", "b"]);
    expect(viewport.pickOverlayHandle(handles[1].x + 3, handles[1].y)).toBe("b");
    expect(viewport.pickOverlayHandle(handles[1].x + 30, handles[1].y)).toBeNull();
    expect(viewport.drawn()).toMatchObject({ handles: 2, cameraPreview: true });
  });

  it("forwards renderer-level features: sprite sizes, probe bakes and the UI", async () => {
    const viewport = make();
    const node = GameObject.create("s");
    node.addBehavior(SpriteRenderer, {});
    expect(viewport.spriteSize(node)).toEqual([3, 4]);
    expect(viewport.spriteSize(GameObject.create("plain"))).toBeNull();
    expect(new Uint8Array(await viewport.bakeReflectionProbe({} as never))).toEqual(new Uint8Array([1, 2]));
    expect(viewport.pickUI(1, 2)).toEqual([]);
    const element = {} as never;
    const ui: Pick<UICoreLike, "pickAll" | "pickCanvases" | "cornersOf"> = {
      pickAll: vi.fn(() => [element]),
      pickCanvases: vi.fn(() => []),
      cornersOf: () => ({ space: "world", points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], size: [100, 100] }) as never,
    };
    hooks.ui.mockReturnValue(ui);
    expect(viewport.pickUI(400, 300)).toEqual([element]);
    expect(ui.pickAll).toHaveBeenCalledWith(400, 300, expect.objectContaining({ direction: [expect.any(Number), expect.any(Number), expect.closeTo(-1)] }));
    const box = viewport.uiElementBox(element)!;
    expect(box.points[0]).toEqual([expect.closeTo(400), expect.closeTo(300)]);
    expect(box.size).toEqual([100, 100]);
  });
});

describe("the Babylon renderer's diagnostics (ADR 0128)", () => {
  let nullEngine: NullEngine;
  let renderer: BabylonRenderer;
  let world: World;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    world = World.require();
    nullEngine = new NullEngine();
    const Ctor = BabylonRenderer as unknown as new (engine: NullEngine, settings: unknown, plugged: PluginFeature[]) => BabylonRenderer;
    // The Meshes plugin's feature (ADR 0140), registered by Vitest's setup file's plugin activation.
    const meshes = (await loadPluginFeatures()).filter((p) => p.registration.spec.name === "meshes");
    expect(meshes).toHaveLength(1);
    renderer = new Ctor(nullEngine, world.settings, meshes);
  });
  afterEach(() => {
    Material._resetShared();
    renderer.dispose();
    nullEngine.dispose();
  });

  it("reports the nodes drawn, with their materials in engine terms", () => {
    const shown = GameObject.create("shown");
    shown.addBehavior(MeshRenderer, { mesh: "builtin:cube" });
    const hidden = GameObject.create("hidden");
    hidden.addBehavior(MeshRenderer, { mesh: "builtin:cube" }).enabled = false;
    renderer.syncMeshes(world); // the full sync needs a GPU for the environment map
    const d = renderer.diagnostics();
    expect(d.drawn.meshes.map((m) => m.node)).toEqual([shown]);
    expect(d.drawn.meshes[0].materials).toEqual([{ unlit: false, clearcoat: 0, transmission: 0 }]);
    expect(d.cameras).toEqual([]); // no World claimed, no frame drawn
    expect(d.post.composedCameras).toBe(0);
    expect(d.stats.geometries).toBeGreaterThan(0);
  });

  it("loads the editor tools once, and they are the viewport adapter", async () => {
    const tools = await renderer.loadEditorTools();
    expect(tools).toBeInstanceOf(BabylonEditorTools);
    expect(renderer.editorTools()).toBe(tools);
    expect(await renderer.loadEditorTools()).toBe(tools);
  });
});
