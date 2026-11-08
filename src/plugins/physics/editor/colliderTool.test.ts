// The collider gizmo as a viewport tool (ADR 0138, 0142): editing a collider is the tool being active, its
// outline overlay is a "colliders" overlay, and its 2D outlines are selectable.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../../engine";
import { createRegistry } from "../../../editor/sdk/registry";
import type { ViewportToolContribution } from "../../../editor/sdk";
import { openSceneFile } from "../../../editor/project";
import { activateViewportTool, activeViewportTool, pickTool, playState, selection } from "../../../editor/state";
import { DEMO_SCENE, demoAssets, demoSettings } from "../../../editor/testing";
import { createViewportToolHost, selectableOutlines } from "../../../editor/viewportTools";
import { COLLIDER_TOOL_ID, colliderTool, editingCollider } from "./colliderGizmo";
import { editColliderAction } from "./EditColliderButton";

describe("the collider tool", () => {
  let engine: Engine;
  let dispose: () => void;
  const overlays = new Map<string, string>();

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    playState.value = "edit";
    const tools = createRegistry<ViewportToolContribution>("Viewport tool");
    tools.register(colliderTool);
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
    selection.value = null;
    activateViewportTool(null);
    engine.dispose();
  });

  it("draws a colliders overlay and marks the 2D outlines selectable", () => {
    expect(overlays.get(COLLIDER_TOOL_ID)).toBe("colliders");
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
    expect(overlays.has(COLLIDER_TOOL_ID)).toBe(false);
  });
});
