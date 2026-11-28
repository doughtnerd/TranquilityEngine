// ADR 0075 stage 8, 0128: what the Babylon editor viewport draws (grid, outlines, overlay, camera, light
// and particle system icons), through its adapter interface, on NullEngine with a fake renderer context
// (real Babylon scenes and a real utility layer).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Engine, GameObject, Light, SceneManager } from "../index";
import { ParticleSystem } from "../render/components";
import type { BabylonEditorContext, EditorDrawn } from "../render/babylon/editorContext";
import { PICK_ORDER } from "../render/babylon/feature";
import { EDITOR_LAYER_MASK } from "../render/babylon/editorContext";
import { BabylonEditorViewport } from "../render/babylon/editorViewport";
import type { EditorOverlay } from "../render/editorViewport";

describe("Babylon editor viewport drawing (ADR 0075 stage 8, 0128)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let layer: UtilityLayerRenderer;
  let view: Camera;
  let cameras: Camera[];
  let drawn: EditorDrawn[];
  let vp: BabylonEditorViewport;
  let world: World;

  const make = (editor: boolean) => {
    const ctx = {
      scene,
      overlay: layer,
      canvasSize: () => ({ width: 800, height: 600 }),
      settings: world.settings,
      editor,
      world: () => World.require(),
      viewCameras: () => cameras,
      babylonCamera: () => null,
      drawn: () => drawn,
      renderer: { setClearColor() {}, ui: () => null, bakeReflectionProbe: async () => new ArrayBuffer(0) },
    } as unknown as BabylonEditorContext;
    vp = new BabylonEditorViewport(ctx);
  };

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true, project: { display: { width: 800, height: 600 } } });
    await SceneManager.load("s.json");
    world = World.require();
    babylon = new NullEngine();
    scene = new Scene(babylon);
    layer = new UtilityLayerRenderer(scene);
    drawn = [];
    const node = GameObject.create("view");
    node.transform!.position.set(0, 0, -10); // looking along +Z (ADR 0164)
    view = node.addBehavior(Camera, { projection: "orthographic", orthographicSize: 5 });
    cameras = [view];
    make(true);
  });

  afterEach(() => {
    vp.dispose();
    layer.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const editNode = (name: string, pos: [number, number, number] = [0, 0, 0]) => {
    const n = GameObject.create(name);
    n.transform!.position.set(...pos);
    world.setEditMode(n.entity, true);
    return n;
  };
  const step = () => {
    engine.step(1 / 60);
    vp.sync(world);
  };
  const named = (s: Scene, name: string) => s.meshes.filter((m) => m.name === name);
  const colorsOf = (m: Mesh) => Array.from(m.getVerticesData(VertexBuffer.ColorKind)!);
  /** What the overlay scene draws, read from its meshes as Babylon gets them: visible meshes named `prefix`… */
  const shown = (prefix: string) => layer.utilityLayerScene.meshes.filter((m) => m.name.startsWith(prefix) && m.isVisible);
  /** …and how many indices each draws (a batch draws only the part of its buffers in use). */
  const indices = (prefix: string) => shown(prefix).reduce((n, m) => n + (m.subMeshes[0]?.indexCount ?? 0), 0);
  /** Selection outlines shown: one mesh each, a sprite's loop or a mesh's box. */
  const outlines = () => shown("myco.editor.outline").length + shown("myco.editor.boxOutline").length;
  /** Overlay line segments shown: the lines batch and each segment group, two indices a segment. */
  const segments = () => (indices("myco.editor.overlayLines") + indices("myco.editor.segments.")) / 2;
  /** Overlay handles shown: six indices (two triangles) a handle. */
  const handles = () => indices("myco.editor.handles") / 6;
  /** The light wireframes drawn: each segment's two ends, from the overlay's line mesh. */
  const lightWires = (): number[][][] => {
    const wires = shown("myco.editor.lightWires")[0] as Mesh | undefined;
    const p = wires?.getVerticesData(VertexBuffer.PositionKind) ?? [];
    return Array.from({ length: indices("myco.editor.lightWires") / 2 }, (_, i) => [[p[i * 6], p[i * 6 + 1], p[i * 6 + 2]], [p[i * 6 + 3], p[i * 6 + 4], p[i * 6 + 5]]]);
  };

  it("draws a grid and axes in the main scene, not the overlay scene", () => {
    expect(named(scene, "myco.editor.grid")).toHaveLength(1);
    expect(named(scene, "myco.editor.axes")).toHaveLength(1);
    expect(named(scene, "myco.editor.grid")[0].layerMask).toBe(EDITOR_LAYER_MASK);
    expect(named(layer.utilityLayerScene, "myco.editor.grid")).toHaveLength(0);
    expect(vp.grid()).toEqual({ cellSize: 1, visible: true, divisions: 40 });
  });

  it("has no grid on a game's surface", () => {
    vp.dispose();
    make(false);
    expect(vp.grid()).toBeNull();
    expect(named(scene, "myco.editor.axes")).toHaveLength(0);
  });

  it("changes the grid's cell, visibility and plane", () => {
    vp.setGrid("xz", 0.5, false);
    expect(vp.grid()).toEqual({ cellSize: 0.5, visible: false, divisions: 80 });
    const grid = named(scene, "myco.editor.grid");
    expect(grid).toHaveLength(1); // the old one is gone
    expect(grid[0].isVisible).toBe(false);
    vp.setGrid("xz", 0.5, true);
    expect(grid[0].isVisible).toBe(true);
    vp.setGrid("xy", 0.5, true);
    expect(named(scene, "myco.editor.grid")[0].rotation.x).toBeCloseTo(Math.PI / 2);
    vp.setGrid("xy", 2, true); // rebuilt: the plane stays
    expect(named(scene, "myco.editor.grid")[0].rotation.x).toBeCloseTo(Math.PI / 2);
    expect(vp.grid()!.divisions).toBe(20); // about 40 m across
    vp.setGrid("xy", -1, true); // nonsense falls back to 1 m
    expect(vp.grid()!.cellSize).toBe(1);
    vp.setGrid("xy", 0.01, true);
    expect(vp.grid()!.divisions).toBe(400); // at most
    vp.setGrid("xy", 100, true);
    expect(vp.grid()!.divisions).toBe(10); // at least
  });

  it("colours the grid in linear light, with centre lines in the centre colour", () => {
    vp.setColors({ background: 0, grid: 0xffffff, gridCenter: 0x808080, outline: 0xff0000, cameraGizmo: 0 });
    const colors = colorsOf(named(scene, "myco.editor.grid")[0] as Mesh);
    expect(colors.slice(0, 3)).toEqual([1, 1, 1]); // white stays white
    // The centre line (index 20 of 41) is mid grey: 0x80 = 0.502 in sRGB = 0.2159 linear.
    expect(colors[20 * 16]).toBeCloseTo(0.2159, 3);
  });

  it("outlines selected sprites and meshes, and hides them when not shown or deselected", () => {
    const spriteNode = GameObject.create("sprite");
    const sprite = MeshBuilder.CreatePlane("q", { size: 1 }, scene);
    drawn.push({ component: { node: spriteNode } as never, shape: { kind: "quad", mesh: sprite }, order: 0 });
    const meshNode = GameObject.create("mesh");
    const box = MeshBuilder.CreateBox("b", { size: 2 }, scene);
    box.position.set(1, 2, 3);
    drawn.push({ component: { node: meshNode } as never, shape: { kind: "meshes", meshes: [box] }, order: PICK_ORDER.depthTested });
    vp.setSelection([spriteNode, meshNode], true);
    step();
    expect(outlines()).toBe(2);
    const outline = named(layer.utilityLayerScene, "myco.editor.boxOutline")[0];
    expect(outline.position.x).toBeCloseTo(1);
    expect(outline.scaling.x).toBeCloseTo(2);
    vp.setSelection([spriteNode, meshNode], false);
    step();
    expect(outlines()).toBe(0);
    vp.setSelection([spriteNode, meshNode], true);
    step();
    expect(outlines()).toBe(2);
    vp.setSelection([], true);
    step();
    expect(outlines()).toBe(0);
  });

  it("outlines descendants of a selected node", () => {
    const parent = GameObject.create("p");
    const child = GameObject.create("c");
    child.setParent(parent);
    drawn.push({ component: { node: child } as never, shape: { kind: "meshes", meshes: [MeshBuilder.CreateBox("b", { size: 1 }, scene)] }, order: PICK_ORDER.depthTested });
    step();
    expect(outlines()).toBe(0);
    vp.setSelection([parent], true);
    step();
    expect(outlines()).toBe(1);
  });

  it("draws the live selection outline and overlay on a game's surface, but no gizmos", () => {
    vp.dispose();
    make(false);
    const node = GameObject.create("s");
    editNode("cam").addBehavior(Camera);
    drawn.push({ component: { node } as never, shape: { kind: "quad", mesh: MeshBuilder.CreatePlane("q", { size: 1 }, scene) }, order: 0 });
    vp.setSelection([node], true);
    vp.setOverlay(() => ({ lines: [{ points: [[0, 0, 0], [1, 0, 0]], closed: false, color: 0xff0000 }], handles: [] }));
    step();
    expect(outlines()).toBe(1);
    expect(segments()).toBe(1);
    expect(vp.pick(400, 300)).toEqual([node]); // the sprite, and no camera icon
    expect(named(layer.utilityLayerScene, "myco.editor.cameraGizmo")).toHaveLength(0);
  });

  const overlay = (): EditorOverlay => ({
    lines: [
      { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], color: 0xff0000, closed: false }, // 2 segments
      { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], color: 0x00ff00, closed: true }, // 3 segments
    ],
    handles: [
      { id: "a", position: [0, 0, 0], color: 0xffffff },
      { id: "b", position: [2, 0, 0], color: 0xffff00 },
    ],
    segments: [{ positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]), color: 0x0000ff }], // 2 segments
  });

  it("uploads overlay lines again only when they change, and only the part in use", () => {
    let points: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
    vp.setOverlay(() => ({ lines: [{ points, closed: false, color: 0xff0000 }], handles: [] }));
    step();
    step(); // the buffers exist now: later frames update them
    const mesh = named(layer.utilityLayerScene, "myco.editor.overlayLines")[0] as Mesh;
    const uploads: number[] = [];
    const update = mesh.updateVerticesData.bind(mesh);
    mesh.updateVerticesData = ((kind: string, data: Float32Array, ...rest: never[]) => {
      if (kind === VertexBuffer.PositionKind) uploads.push(data.length);
      return update(kind, data, ...rest);
    }) as typeof mesh.updateVerticesData;
    step();
    step();
    expect(uploads).toEqual([]); // the same lines: nothing to send
    points = [[0, 0, 0], [2, 0, 0], [1, 1, 0]];
    step();
    expect(uploads).toEqual([4 * 3]); // 2 segments, 4 vertices, not the whole buffer
    expect(mesh.subMeshes[0].indexCount).toBe(4);
    points = [[0, 0, 0], [2, 0, 0]];
    step();
    expect(uploads).toEqual([12, 2 * 3]); // fewer vertices: the count changed, so it uploads
    expect(mesh.subMeshes[0].indexCount).toBe(2);
  });

  it("draws overlay lines, handles and segment groups, and clears them", () => {
    const o = overlay();
    vp.setOverlay(() => o);
    step();
    expect([segments(), handles()]).toEqual([2 + 3 + 2, 2]);
    vp.setOverlay(() => ({ lines: [], handles: [] }));
    step();
    expect([segments(), handles()]).toEqual([0, 0]);
    expect(named(layer.utilityLayerScene, "myco.editor.segments.0")).toHaveLength(0);
  });

  it("keeps a segment group's buffer while its array is unchanged", () => {
    const o = overlay();
    vp.setOverlay(() => o);
    step();
    const geometry = named(layer.utilityLayerScene, "myco.editor.segments.0")[0].geometry;
    step();
    expect(named(layer.utilityLayerScene, "myco.editor.segments.0")[0].geometry).toBe(geometry);
  });

  it("finds overlay handles on the canvas", () => {
    const o = overlay();
    vp.setOverlay(() => o);
    step();
    const handles = vp.overlayHandles();
    expect(handles.map((h) => h.id)).toEqual(["a", "b"]);
    // Orthographic, 5 half-height, 800x600: 60 px per unit, origin at the canvas centre.
    expect(handles[0].x).toBeCloseTo(400);
    expect(handles[0].y).toBeCloseTo(300);
    expect(handles[1].x).toBeCloseTo(520);
  });

  it("sizes handles at nine pixels on screen", () => {
    const o = overlay();
    vp.setOverlay(() => o);
    step();
    const p = named(layer.utilityLayerScene, "myco.editor.handles")[0].getVerticesData(VertexBuffer.PositionKind)!;
    expect(p[3] - p[0]).toBeCloseTo(9 / 60, 4); // 9 px at 60 px per unit
  });

  it("gives each camera in the edited scene an icon and a frustum, and none to the view camera", () => {
    const c1 = editNode("cam1", [0, 0, 5]);
    c1.addBehavior(Camera, { projection: "perspective" });
    const c2 = editNode("cam2", [3, 0, 5]);
    c2.addBehavior(Camera);
    step();
    expect(vp.pick(400, 300)).toEqual([c1]); // each icon picks its camera
    expect(vp.pick(580, 300)).toEqual([c2]);
    const wires = named(layer.utilityLayerScene, "myco.editor.cameraWires")[0];
    expect(wires.isVisible).toBe(true);
    expect(wires.subMeshes[0].indexCount).toBe(2 * 24); // 12 segments each
    c2.setActive(false);
    step();
    expect(named(layer.utilityLayerScene, "myco.editor.cameraWires")[0].subMeshes[0].indexCount).toBe(24);
    expect(vp.pick(580, 300)).toEqual([]);
    GameObject.destroy(c1);
    step();
    expect(vp.pick(400, 300)).toEqual([]);
    expect(named(layer.utilityLayerScene, "myco.editor.cameraGizmo")).toHaveLength(2 - 1); // c1's icon is gone, c2's kept
  });

  it("draws a selected camera's frustum in the selection colour", () => {
    const c = editNode("cam", [0, 0, 5]);
    c.addBehavior(Camera);
    vp.setColors({ background: 0, grid: 0, gridCenter: 0, outline: 0xff0000, cameraGizmo: 0x00ff00 });
    step();
    const wires = named(layer.utilityLayerScene, "myco.editor.cameraWires")[0] as Mesh;
    expect(colorsOf(wires).slice(0, 4)).toEqual([0, 1, 0, 0.85].map((v) => expect.closeTo(v, 5)));
    vp.setSelection([c], true);
    step();
    expect(colorsOf(wires).slice(0, 4)).toEqual([1, 0, 0, 0.85].map((v) => expect.closeTo(v, 5)));
  });

  it("shows light icons and wireframes by type", () => {
    editNode("sun", [0, 0, 0]).addBehavior(Light, { type: "directional" });
    editNode("spot", [2, 0, 0]).addBehavior(Light, { type: "spot" });
    const point = editNode("point", [-2, 0, 0]);
    point.addBehavior(Light, { type: "point", range: 3 });
    editNode("amb", [0, 2, 0]).addBehavior(Light, { type: "ambient" });
    step();
    // Directional: 1 + 4 * 2 = 9. Spot: 4 + 32 = 36. Point (unselected) and ambient: none.
    expect(lightWires().length).toBe(9 + 36);
    expect(vp.lightIcons()).toHaveLength(4);
    vp.setSelection([point], true);
    step();
    expect(lightWires().length).toBe(9 + 36 + 96);
    point.setActive(false);
    step();
    expect(vp.lightIcons()).toHaveLength(3);
    expect(lightWires().length).toBe(9 + 36);
  });

  it("draws a directional light's rays along its +Z axis (ADR 0164)", () => {
    editNode("sun", [1, 2, 3]).addBehavior(Light, { type: "directional" });
    step();
    const segs = lightWires();
    expect(segs).toHaveLength(9);
    expect(segs[0]).toEqual([[1, 2, 3], [1, 2, 5]].map((p) => p.map((v) => expect.closeTo(v, 5)))); // the main ray, 2 m long
  });

  it("draws a spot light's cone out to its range", () => {
    editNode("spot", [1, 2, 3]).addBehavior(Light, { type: "spot", range: 4, spotAngle: 90 });
    step();
    const segs = lightWires();
    expect(segs).toHaveLength(4 + 32);
    const [, tip] = segs[0];
    expect(tip[0]).toBeCloseTo(1 + 4); // tan(45°) × 4 to the side
    expect(tip[2]).toBeCloseTo(3 + 4);
  });

  it("finds camera and light icons under a canvas point", () => {
    const cam = editNode("cam", [0, 0, 5]);
    cam.addBehavior(Camera);
    const lamp = editNode("lamp", [2, 0, 5]);
    lamp.addBehavior(Light, { type: "point" });
    step();
    expect(vp.pick(400, 300).map((n) => n.entity)).toEqual([cam.entity]);
    expect(vp.pick(520, 305).map((n) => n.entity)).toEqual([lamp.entity]);
    expect(vp.pick(100, 100)).toEqual([]);
  });

  it("shows a pickable icon for each particle system and drops it with the node", () => {
    editNode("cam", [0, 0, 5]).addBehavior(Camera);
    const fx = editNode("fx", [2, 0, 5]);
    fx.addBehavior(ParticleSystem);
    step();
    expect(vp.pick(100, 100)).toEqual([]);
    expect(vp.pick(520, 305).map((n) => n.entity)).toEqual([fx.entity]);
    fx.setActive(false);
    step();
    expect(vp.pick(520, 305)).toEqual([]);
    GameObject.destroy(fx);
    step();
    expect(named(layer.utilityLayerScene, "myco.editor.particleGizmo")).toHaveLength(0);
  });

  it("keeps icons a constant size on screen", () => {
    editNode("cam", [0, 0, 5]).addBehavior(Camera);
    step();
    const icon = named(layer.utilityLayerScene, "myco.editor.cameraGizmo")[0];
    expect(icon.scaling.x).toBeCloseTo(0.065 * 10); // a fraction of the view's 10 units
  });

  it("uses no image processing in the overlay scene (colours go out as given)", () => {
    expect(layer.utilityLayerScene.imageProcessingConfiguration.isEnabled).toBe(false);
  });

  it("disposes everything it made", () => {
    editNode("cam").addBehavior(Camera);
    vp.setOverlay(() => overlay());
    step();
    vp.dispose();
    expect(scene.meshes.filter((m) => m.name.startsWith("myco.editor"))).toHaveLength(0);
    expect(layer.utilityLayerScene.meshes.filter((m) => m.name.startsWith("myco.editor"))).toHaveLength(0);
    vp.sync(world); // harmless after dispose
  });
});
