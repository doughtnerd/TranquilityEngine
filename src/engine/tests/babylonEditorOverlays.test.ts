// ADR 0075 stage 8: the Babylon backend's editor helpers (grid, outlines, overlay, camera and light
// gizmos), on NullEngine with a fake renderer context (real Babylon scenes and a real utility layer).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Engine, GameObject, Light, SceneManager } from "../index";
import type { BabylonEditorContext, EditorMesh, EditorSprite } from "../render/babylon/editorContext";
import { EDITOR_LAYER_MASK } from "../render/babylon/editorContext";
import { BabylonEditorOverlays, gridDivisions, lightSegments } from "../render/babylon/editorOverlays";
import type { EditorOverlay } from "../render/RenderSurface";

describe("Babylon editor overlays (ADR 0075 stage 8)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let layer: UtilityLayerRenderer;
  let view: Camera;
  let cameras: Camera[];
  let sprites: EditorSprite[];
  let meshes: EditorMesh[];
  let overlays: BabylonEditorOverlays;
  let world: World;

  const make = (editor: boolean) => {
    const ctx = {
      scene,
      overlay: layer,
      canvas: { clientWidth: 800, clientHeight: 600 },
      settings: world.settings,
      editor,
      world: () => World.require(),
      viewCameras: () => cameras,
      babylonCamera: () => null,
      sprites: () => sprites,
      meshes: () => meshes,
      texts: () => [],
    } as unknown as BabylonEditorContext;
    overlays = new BabylonEditorOverlays(ctx);
  };

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true, project: { display: { width: 800, height: 600 } } });
    await SceneManager.load("s.json");
    world = World.require();
    babylon = new NullEngine();
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    layer = new UtilityLayerRenderer(scene);
    sprites = [];
    meshes = [];
    const node = GameObject.create("view");
    node.transform!.position.set(0, 0, 10);
    view = node.addBehavior(Camera, { projection: "orthographic", orthographicSize: 5 });
    cameras = [view];
    make(true);
  });

  afterEach(() => {
    overlays.dispose();
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
    overlays.sync(world);
  };
  const named = (s: Scene, name: string) => s.meshes.filter((m) => m.name === name);
  const colorsOf = (m: Mesh) => Array.from(m.getVerticesData(VertexBuffer.ColorKind)!);

  it("draws a grid and axes in the main scene, not the overlay scene", () => {
    expect(named(scene, "myco.editor.grid")).toHaveLength(1);
    expect(named(scene, "myco.editor.axes")).toHaveLength(1);
    expect(named(scene, "myco.editor.grid")[0].layerMask).toBe(EDITOR_LAYER_MASK);
    expect(named(layer.utilityLayerScene, "myco.editor.grid")).toHaveLength(0);
    expect(overlays.editorGrid()).toEqual({ cellSize: 1, visible: true, divisions: 40 });
  });

  it("has no grid on a game's surface", () => {
    overlays.dispose();
    make(false);
    expect(overlays.editorGrid()).toBeNull();
    expect(named(scene, "myco.editor.axes")).toHaveLength(0);
  });

  it("changes the grid's cell, visibility and plane", () => {
    overlays.setEditorGrid(0.5, false);
    expect(overlays.editorGrid()).toEqual({ cellSize: 0.5, visible: false, divisions: 80 });
    const grid = named(scene, "myco.editor.grid");
    expect(grid).toHaveLength(1); // the old one is gone
    expect(grid[0].isVisible).toBe(false);
    overlays.setEditorGrid(0.5, true);
    expect(grid[0].isVisible).toBe(true);
    overlays.setEditorGridPlane("xy");
    expect(named(scene, "myco.editor.grid")[0].rotation.x).toBeCloseTo(Math.PI / 2);
    overlays.setEditorGrid(2, true); // rebuilt: the plane stays
    expect(named(scene, "myco.editor.grid")[0].rotation.x).toBeCloseTo(Math.PI / 2);
    expect(overlays.editorGrid()!.divisions).toBe(gridDivisions(2));
    overlays.setEditorGrid(-1, true); // nonsense falls back to 1 m
    expect(overlays.editorGrid()!.cellSize).toBe(1);
    expect(gridDivisions(0.01)).toBe(400);
    expect(gridDivisions(100)).toBe(10);
  });

  it("colours the grid in linear light, with centre lines in the centre colour", () => {
    overlays.setEditorColors({ background: 0, grid: 0xffffff, gridCenter: 0x808080, outline: 0xff0000, cameraGizmo: 0 });
    const colors = colorsOf(named(scene, "myco.editor.grid")[0] as Mesh);
    expect(colors.slice(0, 3)).toEqual([1, 1, 1]); // white stays white
    // The centre line (index 20 of 41) is mid grey: 0x80 = 0.502 in sRGB = 0.2159 linear.
    expect(colors[20 * 16]).toBeCloseTo(0.2159, 3);
  });

  it("outlines selected sprites and meshes, and hides them when not shown or deselected", () => {
    const spriteNode = GameObject.create("sprite");
    const sprite = MeshBuilder.CreatePlane("q", { size: 1 }, scene);
    sprites.push({ component: { node: spriteNode } as never, mesh: sprite, size: [1, 1], order: 0 });
    const meshNode = GameObject.create("mesh");
    const box = MeshBuilder.CreateBox("b", { size: 2 }, scene);
    box.position.set(1, 2, 3);
    meshes.push({ component: { node: meshNode } as never, meshes: [box] });
    overlays.setSelectionOutline([spriteNode, meshNode]);
    step();
    expect(overlays.editorDrawingShown().outlines).toBe(2);
    const outline = named(layer.utilityLayerScene, "myco.editor.boxOutline")[0];
    expect(outline.position.x).toBeCloseTo(1);
    expect(outline.scaling.x).toBeCloseTo(2);
    expect(overlays.isOutlined(spriteNode)).toBe(true);
    overlays.setSelectionOutlineShown(false);
    step();
    expect(overlays.editorDrawingShown().outlines).toBe(0);
    overlays.setSelectionOutlineShown(true);
    step();
    expect(overlays.editorDrawingShown().outlines).toBe(2);
    overlays.setSelectionOutline([]);
    step();
    expect(overlays.editorDrawingShown().outlines).toBe(0);
  });

  it("outlines descendants of a selected node", () => {
    const parent = GameObject.create("p");
    const child = GameObject.create("c");
    child.setParent(parent);
    expect(overlays.isOutlined(child)).toBe(false);
    overlays.setSelectionOutline([parent]);
    expect(overlays.isOutlined(child)).toBe(true);
  });

  it("draws the live selection outline and overlay on a game's surface, but no gizmos", () => {
    overlays.dispose();
    make(false);
    const node = GameObject.create("s");
    editNode("cam").addBehavior(Camera);
    sprites.push({ component: { node } as never, mesh: MeshBuilder.CreatePlane("q", { size: 1 }, scene), size: [1, 1], order: 0 });
    overlays.setSelectionOutline([node]);
    overlays.setOverlayProvider(() => ({ lines: [{ points: [[0, 0, 0], [1, 0, 0]], closed: false, color: 0xff0000 }], handles: [] }));
    step();
    const shown = overlays.editorDrawingShown();
    expect(shown.outlines).toBe(1);
    expect(shown.segments).toBe(1);
    expect(overlays.cameraGizmoCount()).toBe(0);
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

  it("draws overlay lines, handles and segment groups, and clears them", () => {
    const o = overlay();
    overlays.setOverlayProvider(() => o);
    step();
    expect(overlays.editorDrawingShown()).toMatchObject({ segments: 2 + 3 + 2, handles: 2 });
    overlays.setOverlayProvider(() => ({ lines: [], handles: [] }));
    step();
    expect(overlays.editorDrawingShown()).toMatchObject({ segments: 0, handles: 0 });
    expect(named(layer.utilityLayerScene, "myco.editor.segments.0")).toHaveLength(0);
  });

  it("keeps a segment group's buffer while its array is unchanged", () => {
    const o = overlay();
    overlays.setOverlayProvider(() => o);
    step();
    const geometry = named(layer.utilityLayerScene, "myco.editor.segments.0")[0].geometry;
    step();
    expect(named(layer.utilityLayerScene, "myco.editor.segments.0")[0].geometry).toBe(geometry);
  });

  it("finds overlay handles on the canvas and picks the nearest within a radius", () => {
    const o = overlay();
    overlays.setOverlayProvider(() => o);
    step();
    const handles = overlays.overlayHandlesOnCanvas(world);
    expect(handles.map((h) => h.id)).toEqual(["a", "b"]);
    // Orthographic, 5 half-height, 800x600: 60 px per unit, origin at the canvas centre.
    expect(handles[0].x).toBeCloseTo(400);
    expect(handles[0].y).toBeCloseTo(300);
    expect(handles[1].x).toBeCloseTo(520);
    expect(overlays.pickOverlayHandle(world, 405, 303)).toBe("a");
    expect(overlays.pickOverlayHandle(world, 515, 300)).toBe("b");
    expect(overlays.pickOverlayHandle(world, 460, 300)).toBeNull();
    expect(overlays.pickOverlayHandle(world, 460, 300, 80)).not.toBeNull();
  });

  it("sizes handles at nine pixels on screen", () => {
    const o = overlay();
    overlays.setOverlayProvider(() => o);
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
    expect(overlays.cameraGizmoCount()).toBe(2);
    const wires = named(layer.utilityLayerScene, "myco.editor.cameraWires")[0];
    expect(wires.isVisible).toBe(true);
    expect(wires.subMeshes[0].indexCount).toBe(2 * 24); // 12 segments each
    c2.setActive(false);
    step();
    expect(named(layer.utilityLayerScene, "myco.editor.cameraWires")[0].subMeshes[0].indexCount).toBe(24);
    GameObject.destroy(c1);
    step();
    expect(overlays.cameraGizmoCount()).toBe(1);
  });

  it("draws a selected camera's frustum in the selection colour", () => {
    const c = editNode("cam", [0, 0, 5]);
    c.addBehavior(Camera);
    overlays.setEditorColors({ background: 0, grid: 0, gridCenter: 0, outline: 0xff0000, cameraGizmo: 0x00ff00 });
    step();
    const wires = named(layer.utilityLayerScene, "myco.editor.cameraWires")[0] as Mesh;
    expect(colorsOf(wires).slice(0, 4)).toEqual([0, 1, 0, 0.85].map((v) => expect.closeTo(v, 5)));
    overlays.setSelectionOutline([c]);
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
    expect(overlays.lightWireCount()).toBe(9 + 36);
    expect(overlays.lightIconsOnCanvas(world)).toHaveLength(4);
    overlays.setSelectionOutline([point]);
    step();
    expect(overlays.lightWireCount()).toBe(9 + 36 + 96);
    point.setActive(false);
    step();
    expect(overlays.lightIconsOnCanvas(world)).toHaveLength(3);
    expect(overlays.lightWireCount()).toBe(9 + 36);
  });

  it("lists light segments for a world matrix", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const sun = lightSegments({ type: "directional", range: 0, spotAngle: 0 }, identity, false);
    expect(sun).toHaveLength(9);
    expect(sun[0][1]).toEqual([0, 0, -2]); // the arrow points down -Z
    expect(lightSegments({ type: "ambient", range: 0, spotAngle: 0 }, identity, true)).toHaveLength(0);
  });

  it("finds camera and light icons under a canvas point", () => {
    const cam = editNode("cam", [0, 0, 5]);
    cam.addBehavior(Camera);
    const lamp = editNode("lamp", [2, 0, 5]);
    lamp.addBehavior(Light, { type: "point" });
    step();
    expect(overlays.iconsAt(world, 400, 300).map((n) => n.entity)).toEqual([cam.entity]);
    expect(overlays.iconsAt(world, 520, 305).map((n) => n.entity)).toEqual([lamp.entity]);
    expect(overlays.iconsAt(world, 100, 100)).toEqual([]);
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
    overlays.setOverlayProvider(() => overlay());
    step();
    overlays.dispose();
    expect(scene.meshes.filter((m) => m.name.startsWith("myco.editor"))).toHaveLength(0);
    expect(layer.utilityLayerScene.meshes.filter((m) => m.name.startsWith("myco.editor"))).toHaveLength(0);
    overlays.sync(world); // harmless after dispose
  });
});
