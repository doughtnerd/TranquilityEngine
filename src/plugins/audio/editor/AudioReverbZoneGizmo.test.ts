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
import { createViewportToolHost } from "../../../editor/viewportTools";
import { ZONE_TOOL_ID, ZONE_TYPE, editingZone, startZoneDrag, zoneOverlay, zoneTool, type RayAt } from "./AudioReverbZoneGizmo";
import { editZoneAction } from "./EditZoneButton";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
// A camera looking down -z with parallel rays: the canvas point (x, y) is the world point (x, y).
const topDown: RayAt = (x, y) => ({ origin: [x, y, 100], direction: [0, 0, -1] });
// A camera looking down -y (from above): the canvas point (x, y) is the world point (x, z = y).
const fromAbove: RayAt = (x, y) => ({ origin: [x, 100, y], direction: [0, -1, 0] });

describe("the reverb zone tool", () => {
  let engine: Engine;
  let dispose: () => void;
  const overlays = new Map<string, string>();

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    playState.value = "edit";
    const tools = createRegistry<ViewportToolContribution>("Viewport tool");
    tools.register(zoneTool);
    dispose = createViewportToolHost({
      engine,
      world: engine.world,
      canvas: null,
      keys: new EventTarget(),
      tools,
      addOverlay: (id, _provider, kind) => void overlays.set(id, kind),
      removeOverlay: (id) => void overlays.delete(id),
    });
  });

  afterEach(() => {
    dispose();
    editingZone.value = null;
    selection.value = null;
    activateViewportTool(null);
    engine.dispose();
  });

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
    const dim = zoneOverlay(engine);
    expect(dim.lines.length).toBe(12 + 3); // twelve box edges, three shell loops
    selection.value = id;
    const bright = zoneOverlay(engine);
    expect(bright.lines.length).toBe(15);
    expect(bright.lines[0]!.color).not.toBe(dim.lines[0]!.color);
    expect(bright.handles).toEqual([]); // handles only while editing
  });

  it("draws no shell for a hard edge, and a sphere as three circles", () => {
    zoneNode({ blendDistance: 0 });
    expect(zoneOverlay(engine).lines.length).toBe(12);
    zoneNode({ shape: "sphere", blendDistance: 1 });
    expect(zoneOverlay(engine).lines.length).toBe(12 + 3 + 3);
  });

  it("shows the face handles and the blend handle while editing, and the rim handles for a sphere", () => {
    const box = zoneNode();
    selection.value = box.id;
    editingZone.value = { key: box.id, index: 0 };
    const handles = zoneOverlay(engine).handles;
    expect(handles.map((h) => h.id).sort()).toEqual(["blend", "x+", "x-", "y+", "y-", "z+", "z-"]);
    close(handles.find((h) => h.id === "x+")!.position, [2, 0, 0]);
    close(handles.find((h) => h.id === "blend")!.position, [2 + Math.SQRT2, 1 + Math.SQRT2, 0]);
    box.scene.stack.execute(new SetField(box.id, ZONE_TYPE, "size", [8, 2, 6]));
    close(zoneOverlay(engine).handles.find((h) => h.id === "x+")!.position, [4, 0, 0]); // follows the field
    const sphere = zoneNode({ shape: "sphere" });
    selection.value = sphere.id;
    editingZone.value = { key: sphere.id, index: 0 };
    expect(zoneOverlay(engine).handles.map((h) => h.id).sort()).toEqual(["blend", "radius:x+", "radius:x-", "radius:y+", "radius:y-", "radius:z+", "radius:z-"]);
  });

  it("drags a face: the size and centre are written, the opposite face stays, and one undo restores both", () => {
    const { scene, id, node, zone } = zoneNode();
    selection.value = id;
    const editing = { key: id, index: 0 };
    // x+ handle at world (2, 0, 0). Press on it, drag to x = 5: the face is 5 from the centre, so the box spans -2..5.
    const drag = startZoneDrag(topDown, scene, { x: 2, y: 0 }, "x+", node, zone, editing)!;
    expect(drag).not.toBeNull();
    drag.move!({ x: 5, y: 0, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    expect(zone.size.x).toBeCloseTo(7, 6); // 5 - (-2)
    expect(zone.center.x).toBeCloseTo(1.5, 6);
    expect([zone.size.y, zone.size.z, zone.center.y]).toEqual([2, 6, 0]);
    drag.end!({ x: 0, y: 0, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    expect(scene.stack.undoLabel).toBe("Resize zone");
    scene.stack.undo(); // one step
    expect(live(scene, id).size.x).toBeCloseTo(4, 6);
    expect(live(scene, id).center.x).toBeCloseTo(0, 6);
    scene.stack.redo();
    expect(live(scene, id).size.x).toBeCloseTo(7, 6);
    expect(live(scene, id).center.x).toBeCloseTo(1.5, 6);
  });

  it("moves both faces with Alt, and a cancelled drag still closes its undo group", () => {
    const { scene, id, node, zone } = zoneNode();
    selection.value = id;
    const drag = startZoneDrag(topDown, scene, { x: 2, y: 0 }, "x+", node, zone, { key: id, index: 0 })!;
    drag.move!({ x: 5, y: 0, button: 0, alt: true, shift: false, ctrl: false, meta: false, pointerId: 1 });
    expect(zone.size.x).toBeCloseTo(10, 6);
    expect(zone.center.x).toBeCloseTo(0, 6);
    drag.cancel!();
    scene.stack.undo();
    expect(live(scene, id).size.x).toBeCloseTo(4, 6);
  });

  it("drags a sphere's radius handle and undoes it", () => {
    const { scene, id, node, zone } = zoneNode({ shape: "sphere", radius: 5 });
    selection.value = id;
    const drag = startZoneDrag(topDown, scene, { x: 5, y: 0 }, "radius:x+", node, zone, { key: id, index: 0 })!;
    drag.move!({ x: 8.5, y: 0, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    expect(zone.radius).toBeCloseTo(8.5, 6);
    drag.end!({ x: 0, y: 0, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    scene.stack.undo();
    expect(live(scene, id).radius).toBeCloseTo(5, 6);
  });

  it("drags the blend handle along the diagonal and never below 0", () => {
    const { scene, id, node, zone } = zoneNode(); // box half (2, 1, 3), blend 2: handle at (2 + 1.4142, 1 + 1.4142, 0)
    selection.value = id;
    const at = 2 + Math.SQRT2, atY = 1 + Math.SQRT2;
    const drag = startZoneDrag(topDown, scene, { x: at, y: atY }, "blend", node, zone, { key: id, index: 0 })!;
    // Move the pointer 3 further out along the diagonal: blend becomes 5.
    const k = 3 * Math.SQRT1_2;
    drag.move!({ x: at + k, y: atY + k, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    expect(zone.blendDistance).toBeCloseTo(5, 4);
    drag.move!({ x: 0, y: 0, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    expect(zone.blendDistance).toBe(0);
    drag.end!({ x: 0, y: 0, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    scene.stack.undo();
    expect(live(scene, id).blendDistance).toBe(2);
  });

  it("drags from a camera that sees an axis end-on without moving the handle (no ray hit on the axis: null)", () => {
    const { scene, id, node, zone } = zoneNode();
    selection.value = id;
    // Looking straight along +x at the x+ handle: the ray is parallel to the handle's axis.
    const endOn: RayAt = () => ({ origin: [-100, 0, 0], direction: [1, 0, 0] });
    expect(startZoneDrag(endOn, scene, { x: 0, y: 0 }, "x+", node, zone, { key: id, index: 0 })).toBeNull();
    expect(startZoneDrag(topDown, scene, { x: 0, y: 0 }, "nope", node, zone, { key: id, index: 0 })).toBeNull();
    // From above, a z face drags along the canvas y.
    const drag = startZoneDrag(fromAbove, scene, { x: 0, y: 3 }, "z+", node, zone, { key: id, index: 0 })!;
    drag.move!({ x: 0, y: 4, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
    expect(zone.size.z).toBeCloseTo(7, 6);
    drag.end!({ x: 0, y: 0, button: 0, alt: false, shift: false, ctrl: false, meta: false, pointerId: 1 });
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
