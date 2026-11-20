// The zone gizmo as a viewport tool (ADR 0162 E1): the overlay, handle drags written through the editor's undoable
// commands, and editing as the tool being active.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioReverbZone, Engine } from "../../../myco";
import { AddComponent } from "../../../editor/document";
import { openSceneFile } from "../../../editor/project";
import { editor, SetField, viewportTools } from "../../../editor/sdk";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew, sceneViewTools, type SceneViewCanvas } from "../../../editor/testing";
import type { EditorOverlay } from "../../../engine/editor";
import type { FakeRenderSurface } from "../../../engine/render/fakeViewport";
import { ZONE_TYPE, zoneTool, type EditingZone } from "./AudioReverbZoneGizmo";
import { editZoneAction } from "./EditZoneButton";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
const ZONE_TOOL_ID = zoneTool.id;
/** The zone being edited: the zone tool's mode. */
const editing = () => editor.viewport.mode<EditingZone>(ZONE_TOOL_ID).value;
/** Edit a zone, as the Edit Zone button does. */
const editZone = (zone: EditingZone) => editor.viewport.enter(ZONE_TOOL_ID, zone);
const select = (key: string | null) => editor.scene.selection.set(key ? [key] : []);
const escape = (target: EventTarget) => target.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));

describe("the reverb zone tool", () => {
  let engine: Engine;
  let dispose: () => void;
  let surface: FakeRenderSurface;
  /** The canvas the tool host listens on: pointer events are dispatched to it, at client = canvas coordinates. */
  let canvas: SceneViewCanvas;
  let drawn: () => EditorOverlay;
  /** Where the tool host listens for keys. */
  let keys: EventTarget;
  /** What the zone tool draws this frame. */
  const zoneOverlay = (): EditorOverlay => drawn();

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    // The fake surface's fixed camera looks along +z: the canvas point (400 + 100x, 300 - 100y) is the world point (x, y).
    const off = viewportTools.register(zoneTool);
    const view = sceneViewTools(engine);
    surface = view.surface;
    canvas = view.canvas;
    drawn = view.overlay;
    keys = view.window;
    dispose = () => (view.stop(), off());
  });

  afterEach(() => {
    dispose();
    editor.viewport.leave(ZONE_TOOL_ID);
    select(null);
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
    select(id);
    editZone({ key: id, index: 0 });
  };

  /** The zone as the live scene has it now: undo and redo rebuild the node, so a held reference goes stale. */
  const live = (scene: ReturnType<typeof zoneNode>["scene"], id: string) => scene.sync.nodeFor(id)!.getBehavior(AudioReverbZone)!;

  /** A node at the origin with a zone: a 4 x 2 x 6 box (blend 2) or a radius 5 sphere. */
  function zoneNode(data: Record<string, unknown> = {}) {
    const scene = editor.scene.peekOpen()!;
    const id = insertNew(scene, "empty", { position: [0, 0, 0] });
    scene.stack.execute(new AddComponent(id, { type: ZONE_TYPE, data: { size: [4, 2, 6], blendDistance: 2, ...data } }));
    const node = scene.sync.nodeFor(id)!;
    return { scene, id, node, zone: node.getBehavior(AudioReverbZone)! };
  }

  it("registers its overlay, and draws every zone: bright when selected, dim when not", () => {
    const { id } = zoneNode();
    const dim = zoneOverlay();
    expect(dim.lines.length).toBe(12 + 3); // twelve box edges, three shell loops
    select(id);
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
    select(box.id);
    editZone({ key: box.id, index: 0 });
    const handles = zoneOverlay().handles;
    expect(handles.map((h) => h.id).sort()).toEqual(["blend", "x+", "x-", "y+", "y-", "z+", "z-"]);
    close(handles.find((h) => h.id === "x+")!.position, [2, 0, 0]);
    close(handles.find((h) => h.id === "blend")!.position, [2 + Math.SQRT2, 1 + Math.SQRT2, 0]);
    box.scene.stack.execute(new SetField(box.id, ZONE_TYPE, "size", [8, 2, 6]));
    close(zoneOverlay().handles.find((h) => h.id === "x+")!.position, [4, 0, 0]); // follows the field
    const sphere = zoneNode({ shape: "sphere" });
    select(sphere.id);
    editZone({ key: sphere.id, index: 0 });
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

  it("moves both faces with Alt, and a cancelled drag still closes its undo step", () => {
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

  it("puts a drag back on Escape, recording nothing, and keeps editing", () => {
    const { scene, id, zone } = zoneNode();
    edit(id);
    const undo = scene.stack.undoLabel;
    pointer("pointerdown", handleAt("x+"));
    pointer("pointermove", world(5, 0));
    expect(zone.size.x).toBeCloseTo(7, 6);
    escape(keys);
    expect(live(scene, id).size.x).toBeCloseTo(4, 6);
    expect(scene.stack.undoLabel).toBe(undo);
    expect(editing()).toEqual({ key: id, index: 0 });
  });

  it("is active exactly while a zone is edited", () => {
    const { id } = zoneNode();
    select(id);
    editZone({ key: id, index: 0 });
    expect(editor.viewport.activeTool).toBe(ZONE_TOOL_ID);
    escape(keys); // Escape ends editing
    expect(editing()).toBeNull();
    editZone({ key: id, index: 0 });
    editor.viewport.enter("another.tool", null); // so does another tool
    expect(editing()).toBeNull();
    editZone({ key: id, index: 0 });
    select(null); // and selecting another node
    expect(editing()).toBeNull();
    expect(editor.viewport.activeTool).toBeNull();
  });

  it("ends editing when the edited zone is removed from its card, and when uninstalled", () => {
    const { id } = zoneNode();
    select(id);
    const zone = { key: id, index: 0 };
    editZone(zone);
    const info = { type: ZONE_TYPE, index: 0 } as Parameters<NonNullable<typeof editZoneAction.onRemove>>[0]["info"];
    editZoneAction.onRemove!({ scene: null!, paths: [[id]], info: { ...info, index: 1 } }); // another zone: no change
    expect(editing()).toEqual(zone);
    editZoneAction.onRemove!({ scene: null!, paths: [[id]], info });
    expect(editing()).toBeNull();
    editZone(zone);
    dispose();
    dispose = () => {};
    expect(editing()).toBeNull();
    expect(surface.adapter.overlay).toBeNull(); // the tool's overlay went with it: the scene view draws none
  });
});
