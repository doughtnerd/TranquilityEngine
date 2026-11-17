// The collider gizmo as a viewport tool (ADR 0138, 0142, 0231): editing a collider is the tool's mode, entered
// through `editor.viewport` as the Edit Collider button does; its outline overlay is a "colliders" overlay, its 2D
// outlines are selectable, and a handle drag is one undo step that Escape puts back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../../engine";
import { editor, viewportTools, type SelectableOutline, type ViewportToolContext } from "../../../editor/sdk";
import { setEditorOverlayFilter, type EditorOverlayKind } from "../../../engine/editor";
import { openSceneFile } from "../../../editor/project";
import { DEMO_SCENE, demoAssets, demoSettings, sceneViewTools, type SceneViewTools } from "../../../editor/testing";
import { colliderTool, type EditingCollider } from "./colliderGizmo";
import { editColliderAction } from "./EditColliderButton";

const COLLIDER_TOOL_ID = colliderTool.id;
const GROUND: EditingCollider = { key: "ground-collider", type: "engine.BoxCollider2D", index: 0 };
const editing = () => editor.viewport.mode<EditingCollider>(COLLIDER_TOOL_ID).value;
const select = (key: string | null) => editor.scene.selection.set(key ? [key] : []);

describe("the collider tool", () => {
  let engine: Engine;
  let view: SceneViewTools;
  let dispose: () => void;
  /** How many lines the scene view draws when only overlays of kinds `shown` accepts are drawn (as play mode's Gizmos menu filters). */
  const linesDrawn = (shown: (kind: EditorOverlayKind) => boolean) => {
    setEditorOverlayFilter(engine.world, shown);
    const lines = view.overlay().lines.length;
    setEditorOverlayFilter(engine.world, null);
    return lines;
  };

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const off = viewportTools.register(colliderTool);
    view = sceneViewTools(engine);
    dispose = () => (view.stop(), off());
  });

  afterEach(() => {
    dispose();
    select(null);
    editor.viewport.leave(COLLIDER_TOOL_ID);
    engine.dispose();
  });

  it("draws a colliders overlay and marks the 2D outlines selectable", () => {
    expect(linesDrawn((kind) => kind === "colliders")).toBeGreaterThan(0); // the collider outlines are a "colliders" overlay
    expect(linesDrawn((kind) => kind !== "colliders")).toBe(0); // and nothing else draws them
    // What the tool hands the host as selectable, read through its own install.
    const outlines: (() => Iterable<SelectableOutline>)[] = [];
    const ctx = { engine, world: engine.world, overlay: () => {}, onPress: () => {}, selectable: (o: () => Iterable<SelectableOutline>) => void outlines.push(o) };
    colliderTool.install(ctx as unknown as ViewportToolContext<EditingCollider>);
    expect(outlines.flatMap((o) => [...o()]).map((s) => s.node.name).sort()).toEqual(["Bird", "Ceiling", "Ground"].map((n) => expect.stringContaining(n)));
  });

  it("is active exactly while a collider is edited, and selecting another node ends editing", () => {
    select("ground-collider");
    editor.viewport.enter(COLLIDER_TOOL_ID, GROUND);
    expect(editor.viewport.activeTool).toBe(COLLIDER_TOOL_ID);
    view.window.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" })); // Escape ends editing
    expect(editing()).toBeNull();
    editor.viewport.enter(COLLIDER_TOOL_ID, GROUND);
    editor.viewport.enter("another.tool", null); // so does another tool
    expect(editing()).toBeNull();
    editor.viewport.enter(COLLIDER_TOOL_ID, GROUND);
    select("bird"); // and selecting another node
    expect(editing()).toBeNull();
    expect(editor.viewport.activeTool).toBeNull();
  });

  it("ends editing when the edited collider is removed from its card, and when uninstalled", () => {
    select("ground-collider");
    editor.viewport.enter(COLLIDER_TOOL_ID, GROUND);
    const info = { type: "engine.BoxCollider2D", index: 0 } as Parameters<NonNullable<typeof editColliderAction.onRemove>>[0]["info"];
    editColliderAction.onRemove!({ scene: null!, paths: [["ground-collider"]], info: { ...info, index: 1 } }); // another collider: no change
    expect(editing()).toEqual(GROUND);
    editColliderAction.onRemove!({ scene: null!, paths: [["ground-collider"]], info });
    expect(editing()).toBeNull();
    editor.viewport.enter(COLLIDER_TOOL_ID, GROUND);
    dispose();
    dispose = () => {};
    expect(editing()).toBeNull();
    expect(view.surface.adapter.overlay).toBeNull(); // its overlay went with it: the scene view draws none
  });

  it("makes a handle drag one undo step, and Escape puts it back", () => {
    select("ground-collider");
    editor.viewport.enter(COLLIDER_TOOL_ID, GROUND);
    const scene = editor.scene.peekOpen()!;
    const size = () => JSON.stringify(scene.doc.fieldValue("ground-collider", "engine.BoxCollider2D", "size", 0));
    const before = size(), steps = scene.stack.allStates.length;
    const handle = view.overlay().handles.find((h) => h.id === "right")!;
    const [hx, hy] = view.surface.adapter.worldToCanvas(handle.position);
    const pointer = (type: string, dx: number) =>
      view.canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: hx + dx, clientY: hy, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 }));
    pointer("pointerdown", 0);
    pointer("pointermove", 20);
    pointer("pointermove", 40);
    pointer("pointerup", 40);
    expect(size()).not.toBe(before);
    expect(scene.stack.allStates.length).toBe(steps + 1);
    expect(scene.stack.undoLabel).toBe("Resize collider");
    const dragged = size();
    pointer("pointerdown", 40);
    pointer("pointermove", 80);
    const resized = size();
    view.window.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
    expect(resized).not.toBe(dragged);
    expect(size()).toBe(dragged); // put back, nothing recorded
    expect(scene.stack.allStates.length).toBe(steps + 1);
    expect(editing()).toEqual(GROUND); // Escape ended the drag, not editing
  });
});
