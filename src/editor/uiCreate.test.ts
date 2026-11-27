import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { buildMenuTree } from "./componentCategories";
import { newNodeKinds, type NodeKind } from "./nodeKinds";
import { openSceneFile } from "./project";
import { openScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew } from "./testing";

// ADR 0421, 0423: game UI is made only by a UIView's Svelte component, so the Create menu's UI section is UI View alone.

let engine: Engine | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});

describe("UI in the editor (ADR 0421, 0423)", () => {
  it("files UIView under UI", () => {
    expect(buildMenuTree([{ id: "engine.UIView", name: "UIView", group: "Engine" as const }], new Map())[0]!.label).toBe("UI");
  });

  it("offers only UI View under UI, and creates it as a UIView node", async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const scene = openScene.value!;
    expect(newNodeKinds().filter((k) => k.category === "UI").map((k) => k.label)).toEqual(["UI View"]);
    const made = (kind: NodeKind) => scene.doc.node(insertNew(scene, kind));
    expect(made("ui-view").components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.UIView"]);
  });
});
