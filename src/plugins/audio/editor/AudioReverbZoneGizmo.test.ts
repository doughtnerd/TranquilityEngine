// The zone gizmo as a viewport tool (ADR 0162 E1): the overlay, handle drags written through the editor's undoable
// commands, and editing as the tool being active.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioReverbZone, Engine } from "../../../myco";
import { AddComponent } from "../../../editor/document";
import { createNode } from "../../../editor/nodeCreate";
import { openSceneFile } from "../../../editor/project";
import { createRegistry } from "../../../editor/sdk/registry";
import type { ViewportToolContribution } from "../../../editor/sdk";
import { SetField } from "../../../editor/document";
import { activateViewportTool, activeViewportTool, openScene, pickTool, playState, selection } from "../../../editor/state";
import { DEMO_SCENE, demoAssets, demoSettings } from "../../../editor/testing";
import { createViewportToolHost, type ViewportHostCanvas } from "../../../editor/viewportTools";
import { addEditorOverlay, removeEditorOverlay, type EditorOverlay } from "../../../engine/editor";
import { FakeRenderSurface } from "../../../engine/render/fakeViewport";
import { ZONE_TYPE, editingZone, zoneTool } from "./AudioReverbZoneGizmo";
import { editZoneAction } from "./EditZoneButton";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
const ZONE_TOOL_ID = zoneTool.id;

/** A canvas the tool host listens on: pointer events are dispatched to it, at client = canvas coordinates. */
function fakeCanvas(): ViewportHostCanvas {
  return Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0 }), style: { cursor: "" } });
}

describe("the reverb zone tool", () => {
  let engine: Engine;
  let dispose: () => void;
  let surface: FakeRenderSurface;
  let canvas: ViewportHostCanvas;
  const overlays = new Map<string, string>();
  const providers = new Map<string, () => EditorOverlay>();
  /** What the zone tool draws this frame. */
  const zoneOverlay = (): EditorOverlay => providers.get(ZONE_TOOL_ID)!();

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    playState.value = "edit";
    // The fake surface's fixed camera looks along +z: the canvas point (400 + 100x, 300 - 100y) is the world point (x, y).
    surface = new FakeRenderSurface();
    engine.world.render = surface;
    canvas = fakeCanvas();
    const tools = createRegistry<ViewportToolContribution>("Viewport tool");
    tools.register(zoneTool);
    dispose = createViewportToolHost({
      engine,
      world: engine.world,
      canvas,
      keys: new EventTarget(),
      tools,
      addOverlay: (id, provider, kind) => {
        overlays.set(id, kind);
        providers.set(id, provider);
        addEditorOverlay(engine.world, id, provider, kind);
      },
      removeOverlay: (id) => {
        overlays.delete(id);
        providers.delete(id);
        removeEditorOverlay(engine.world, id);
      },
    });
  });

  afterEach(() => {
    dispose();
    editingZone.value = null;
    selection.value = null;
    activateViewportTool(null);
    engine.world.render = null;
    engine.dispose();
  });

  type Pointer = { x: number; y: number; alt?: boolean };
  const pointer = (type: string, p: Pointer) =>
    canvas.dispatchEvent(Object.assign(new Event(type), { clientX: p.x, clientY: p.y, button: 0, altKey: p.alt ?? false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 }));
  /** Press on the canvas, move through `moves`, then release (or cancel): a drag as the scene view gets it. */
  const drag = (press: Pointer, moves: Pointer[], end: "pointerup" | "pointercancel" = "pointerup") => {
    pointer("pointerdown", press);
    for (const m of moves) pointer("pointermove", m);
    pointer(end, moves.at(-1) ?? press);
  };
  /** Where a handle of the edited zone is on the canvas. */
  const handleAt = (id: string): Pointer => {
    const [x, y] = surface.adapter.worldToCanvas(zoneOverlay().handles.find((h) => h.id === id)!.position);
    return { x, y };
  };
  /** The canvas point of world (x, y) on the fake camera. */
  const world = (x: number, y: number): Pointer => ({ x: 400 + 100 * x, y: 300 - 100 * y });
  /** Select a zone's node and edit its zone (the Edit zone button does this). */
  const edit = (id: string) => {
    selection.value = id;
    editingZone.value = { key: id, index: 0 };
  };

  /** The zone as the live scene has it now: undo and redo rebuild the node, so a held reference goes stale. */
  const live = (scene: ReturnType<typeof zoneNode>["scene"], id: string) => scene.sync.nodeFor(id)!.getBehavior(AudioReverbZone)!;

  /** A node at the origin with a zone: a 4 x 2 x 6 box (blend 2) or a radius 5 sphere. */
  function zoneNode(data: Record<string, unknown> = {}) {
    const scene = openScene.value!;
    const id = createNode(scene, "empty", { position: [0, 0, 0] });
    scene.stack.execute(new AddComponent(id, { type: ZONE_TYPE, data: { size: [4, 2, 6], blendDistance: 2, ...data } }));
    const node = scene.sync.nodeFor(id)!;
    return { scene, id, node, zone: node.getBehavior(AudioReverbZone)! };
  }

  it("registers its overlay, and draws every zone: bright when selected, dim when not", () => {
    expect(overlays.has(ZONE_TOOL_ID)).toBe(true);
    const { id } = zoneNode();
    const dim = zoneOverlay();
    expect(dim.lines.length).toBe(12 + 3); // twelve box edges, three shell loops
    selection.value = id;
    const bright = zoneOverlay();
    expect(bright.lines.length).toBe(15);
    expect(bright.lines[0]!.color).not.toBe(dim.lines[0]!.color);
    expect(bright.handles).toEqual([]); // handles only while editing
  });

  it("draws no shell for a hard edge, and a sphere as three circles", () => {
    zoneNode({ blendDistance: 0 });
    expect(zoneOverlay().lines.length).toBe(12);
    zoneNode({ shape: "sphere", blendDistance: 1 });
    expect(zoneOverlay().lines.length).toBe(12 + 3 + 3);
  });

  it("shows the face handles and the blend handle while editing, and the rim handles for a sphere", () => {
    const box = zoneNode();
    selection.value = box.id;
    editingZone.value = { key: box.id, index: 0 };
    const handles = zoneOverlay().handles;
    expect(handles.map((h) => h.id).sort()).toEqual(["blend", "x+", "x-", "y+", "y-", "z+", "z-"]);
    close(handles.find((h) => h.id === "x+")!.position, [2, 0, 0]);
    close(handles.find((h) => h.id === "blend")!.position, [2 + Math.SQRT2, 1 + Math.SQRT2, 0]);
    box.scene.stack.execute(new SetField(box.id, ZONE_TYPE, "size", [8, 2, 6]));
    close(zoneOverlay().handles.find((h) => h.id === "x+")!.position, [4, 0, 0]); // follows the field
    const sphere = zoneNode({ shape: "sphere" });
    selection.value = sphere.id;
    editingZone.value = { key: sphere.id, index: 0 };
    expect(zoneOverlay().handles.map((h) => h.id).sort()).toEqual(["blend", "radius:x+", "radius:x-", "radius:y+", "radius:y-", "radius:z+", "radius:z-"]);
  });

  it("drags a face: the size and centre are written, the opposite face stays, and one undo restores both", () => {
    const { scene, id, zone } = zoneNode();
    edit(id);
    // x+ handle at world (2, 0, 0). Press on it, drag to x = 5: the face is 5 from the centre, so the box spans -2..5.
    pointer("pointerdown", handleAt("x+"));
    pointer("pointermove", world(5, 0));
    expect(zone.size.x).toBeCloseTo(7, 6); // 5 - (-2)
    expect(zone.center.x).toBeCloseTo(1.5, 6);
    expect([zone.size.y, zone.size.z, zone.center.y]).toEqual([2, 6, 0]);
    pointer("pointerup", world(5, 0));
    expect(scene.stack.undoLabel).toBe("Resize zone");
    scene.stack.undo(); // one step
    expect(live(scene, id).size.x).toBeCloseTo(4, 6);
    expect(live(scene, id).center.x).toBeCloseTo(0, 6);
    scene.stack.redo();
    expect(live(scene, id).size.x).toBeCloseTo(7, 6);
    expect(live(scene, id).center.x).toBeCloseTo(1.5, 6);
  });

  it("moves both faces with Alt, and a cancelled drag still closes its undo group", () => {
    const { scene, id, zone } = zoneNode();
    edit(id);
    pointer("pointerdown", handleAt("x+"));
    pointer("pointermove", { ...world(5, 0), alt: true });
    expect(zone.size.x).toBeCloseTo(10, 6);
    expect(zone.center.x).toBeCloseTo(0, 6);
    pointer("pointercancel", world(5, 0));
    scene.stack.undo();
    expect(live(scene, id).size.x).toBeCloseTo(4, 6);
  });

  it("drags a sphere's radius handle and undoes it", () => {
    const { scene, id, zone } = zoneNode({ shape: "sphere", radius: 5 });
    edit(id);
    drag(handleAt("radius:x+"), [world(8.5, 0)]);
    expect(zone.radius).toBeCloseTo(8.5, 6);
    scene.stack.undo();
    expect(live(scene, id).radius).toBeCloseTo(5, 6);
  });

  it("drags the blend handle along the diagonal and never below 0", () => {
    const { scene, id, zone } = zoneNode(); // box half (2, 1, 3), blend 2: handle at (2 + 1.4142, 1 + 1.4142, 0)
    edit(id);
    const at = 2 + Math.SQRT2, atY = 1 + Math.SQRT2;
    pointer("pointerdown", handleAt("blend"));
    // Move the pointer 3 further out along the diagonal: blend becomes 5.
    const k = 3 * Math.SQRT1_2;
    pointer("pointermove", world(at + k, atY + k));
    expect(zone.blendDistance).toBeCloseTo(5, 4);
    pointer("pointermove", world(0, 0));
    expect(zone.blendDistance).toBe(0);
    pointer("pointerup", world(0, 0));
    scene.stack.undo();
    expect(live(scene, id).blendDistance).toBe(2);
  });

  it("a handle whose axis the camera sees end-on doesn't move (the press is taken, nothing is written)", () => {
    const { scene, id } = zoneNode();
    // Turned 90 degrees about y, the zone's x axis lies along the camera's view direction.
    scene.stack.execute(new SetField(id, "engine.Transform", "rotation", [0, 90, 0]));
    const turned = live(scene, id);
    edit(id);
    const undo = scene.stack.undoLabel;
    drag(handleAt("x+"), [{ x: handleAt("x+").x + 100, y: handleAt("x+").y + 100 }]);
    expect([turned.size.x, turned.size.y, turned.size.z]).toEqual([4, 2, 6]);
    expect(scene.stack.undoLabel).toBe(undo);
  });

  it("drags a face along whatever canvas direction its axis shows: a z face turned to face up drags along y", () => {
    const { scene, id } = zoneNode();
    scene.stack.execute(new SetField(id, "engine.Transform", "rotation", [90, 0, 0]));
    const turned = live(scene, id);
    edit(id);
    const from = handleAt("z+");
    // The z+ face's handle is 3 from the centre (the canvas centre); 100 px further out along that line is 1 world unit.
    const d = Math.hypot(from.x - 400, from.y - 300);
    expect(d).toBeCloseTo(300, 4);
    drag(from, [{ x: from.x + ((from.x - 400) / d) * 100, y: from.y + ((from.y - 300) / d) * 100 }]);
    expect(turned.size.z).toBeCloseTo(7, 6);
  });

  it("is active exactly while a zone is edited", () => {
    const { id } = zoneNode();
    selection.value = id;
    editingZone.value = { key: id, index: 0 };
    expect(activeViewportTool.value).toBe(ZONE_TOOL_ID);
    pickTool("move"); // a transform tool ends editing
    expect(editingZone.value).toBeNull();
    editingZone.value = { key: id, index: 0 };
    activateViewportTool("another.tool");
    expect(editingZone.value).toBeNull();
    editingZone.value = { key: id, index: 0 };
    selection.value = null; // and selecting another node
    expect(editingZone.value).toBeNull();
    expect(activeViewportTool.value).toBeNull();
  });

  it("ends editing when the edited zone is removed from its card, and when uninstalled", () => {
    const { id } = zoneNode();
    selection.value = id;
    const editing = { key: id, index: 0 };
    editingZone.value = editing;
    const info = { type: ZONE_TYPE, index: 0 } as Parameters<NonNullable<typeof editZoneAction.onRemove>>[0]["info"];
    editZoneAction.onRemove!({ scene: null!, paths: [[id]], info: { ...info, index: 1 } }); // another zone: no change
    expect(editingZone.value).toEqual(editing);
    editZoneAction.onRemove!({ scene: null!, paths: [[id]], info });
    expect(editingZone.value).toBeNull();
    editingZone.value = editing;
    dispose();
    dispose = () => {};
    expect(editingZone.value).toBeNull();
    expect(overlays.has(ZONE_TOOL_ID)).toBe(false);
  });
});
