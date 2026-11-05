import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { knownEngineCategory } from "./componentCategories";
import { NEW_NODE_KINDS, newNodeEntry } from "./nodeCreate";
import { openSceneFile } from "./project";
import { openScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

// ADR 0069: the game UI components in the Create menu and the Add Component menu's UI category.

let engine: Engine | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});

describe("UI in the editor (ADR 0069)", () => {
  it("files the UI components under UI", () => {
    for (const id of ["engine.UICanvas", "engine.UIPanel", "engine.UIText", "engine.UIImage", "engine.UIButton", "engine.UIInputField"]) expect(knownEngineCategory(id)).toBe("UI");
  });

  it("creates each UI element with its component", async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const doc = openScene.value!.doc;
    expect(NEW_NODE_KINDS.filter((k) => k.kind.startsWith("ui-")).map((k) => k.label)).toEqual(["UI Canvas", "UI Panel", "UI Text", "UI Image", "UI Button", "UI Input Field"]);
    const types = (kind: Parameters<typeof newNodeEntry>[1]) => newNodeEntry(doc, kind, null).components!.map((c) => c.type);
    expect(types("ui-canvas")).toEqual(["engine.Transform", "engine.UICanvas"]);
    expect(types("ui-button")).toEqual(["engine.Transform", "engine.UIButton"]);
    expect(types("ui-input-field")).toEqual(["engine.Transform", "engine.UIInputField"]);
    expect(newNodeEntry(doc, "ui-text", null).components![1].data).toEqual({ text: "New Text" });
  });
});
