// The collider gizmo as a viewport tool (ADR 0138, 0142): editing a collider is the tool being active, its
// outline overlay is a "colliders" overlay, and its 2D outlines are selectable.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../../engine";
import { viewportTools } from "../../../editor/sdk/contributions";
import { setEditorOverlayFilter, shownEditorOverlays } from "../../../engine/editor";
import { openSceneFile } from "../../../editor/project";
import { activateViewportTool, activeViewportTool, pickTool, playState, selection } from "../../../editor/state";
import { DEMO_SCENE, demoAssets, demoSettings, sceneViewTools } from "../../../editor/testing";
import { selectableOutlines } from "../../../editor/viewportTools";
import { colliderTool, editingCollider } from "./colliderGizmo";

const COLLIDER_TOOL_ID = colliderTool.id;
import { editColliderAction } from "./EditColliderButton";

describe("the collider tool", () => {
  let engine: Engine;
  let dispose: () => void;
  /** The scene view's overlays that draw collider outlines (kind "colliders"). */
  const colliderOverlays = () => {
    setEditorOverlayFilter(engine.world, (kind) => kind === "colliders");
    const ids = shownEditorOverlays(engine.world);
    setEditorOverlayFilter(engine.world, null);
    return ids;
  };

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    playState.value = "edit";
    const off = viewportTools.register(colliderTool);
    const view = sceneViewTools(engine);
    dispose = () => (view.stop(), off());
  });

  afterEach(() => {
    dispose();
    selection.value = null;
    activateViewportTool(null);
    engine.dispose();
  });

  it("draws a colliders overlay and marks the 2D outlines selectable", () => {
    expect(colliderOverlays()).toEqual([COLLIDER_TOOL_ID]);
    expect(selectableOutlines(engine.world).length).toBe(3); // ground, ceiling, bird
  });

  it("is active exactly while a collider is edited", () => {
    selection.value = "ground-collider";
    editingCollider.value = { key: "ground-collider", type: "engine.BoxCollider2D", index: 0 };
    expect(activeViewportTool.value).toBe(COLLIDER_TOOL_ID);
    pickTool("move"); // a transform tool ends editing
    expect(editingCollider.value).toBeNull();
    editingCollider.value = { key: "ground-collider", type: "engine.BoxCollider2D", index: 0 };
    activateViewportTool("another.tool"); // so does another tool
    expect(editingCollider.value).toBeNull();
    editingCollider.value = { key: "ground-collider", type: "engine.BoxCollider2D", index: 0 };
    selection.value = "bird"; // and selecting another node
    expect(editingCollider.value).toBeNull();
    expect(activeViewportTool.value).toBeNull();
  });

  it("ends editing when the edited collider is removed from its card, and when uninstalled", () => {
    selection.value = "ground-collider";
    const editing = { key: "ground-collider", type: "engine.BoxCollider2D" as const, index: 0 };
    editingCollider.value = editing;
    const info = { type: "engine.BoxCollider2D", index: 0 } as Parameters<NonNullable<typeof editColliderAction.onRemove>>[0]["info"];
    editColliderAction.onRemove!({ scene: null!, paths: [["ground-collider"]], info: { ...info, index: 1 } }); // another collider: no change
    expect(editingCollider.value).toEqual(editing);
    editColliderAction.onRemove!({ scene: null!, paths: [["ground-collider"]], info });
    expect(editingCollider.value).toBeNull();
    editingCollider.value = editing;
    dispose();
    dispose = () => {};
    expect(editingCollider.value).toBeNull();
    expect(colliderOverlays()).toEqual([]);
  });
});
