import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { buildMenuTree } from "./componentCategories";
import { newNodeKinds, type NodeKind } from "./nodeKinds";
import { openSceneFile } from "./project";
import { openScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew } from "./testing";

// ADR 0069: the game UI components in the Create menu and the Add Component menu's UI category.

let engine: Engine | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});

describe("UI in the editor (ADR 0069)", () => {
  it("files the UI components under UI", () => {
    for (const id of ["engine.UICanvas", "engine.UIPanel", "engine.UIText", "engine.UIImage", "engine.UIButton", "engine.UIInputField"]) expect(buildMenuTree([{ id, name: id, group: "Engine" as const }], new Map())[0]!.label).toBe("UI");
  });

  it("creates each UI element with its component", async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const scene = openScene.value!;
    const made = (kind: NodeKind) => scene.doc.node(insertNew(scene, kind));
    expect(newNodeKinds().filter((k) => k.kind.startsWith("ui-")).map((k) => k.label)).toEqual(["UI Canvas", "UI Panel", "UI Text", "UI Image", "UI Button", "UI Input Field", "UI Document"]);
    const types = (kind: NodeKind) => made(kind).components!.map((c) => c.type);
    expect(types("ui-canvas")).toEqual(["engine.Transform", "engine.UICanvas"]);
    expect(types("ui-button")).toEqual(["engine.Transform", "engine.UIButton"]);
    expect(types("ui-input-field")).toEqual(["engine.Transform", "engine.UIInputField"]);
    expect(made("ui-text").components![1].data).toEqual({ text: "New Text" });
  });
});
