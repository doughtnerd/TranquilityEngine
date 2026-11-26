import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { buildMenuTree } from "./componentCategories";
import { newNodeKinds, type NodeKind } from "./nodeKinds";
import { openSceneFile } from "./project";
import { openScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew } from "./testing";

// ADR 0417: game UI is made only from UI documents, so the Create menu's UI section is UI Document alone.

let engine: Engine | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});

describe("UI in the editor (ADR 0077, 0417)", () => {
  it("files UIDocument under UI", () => {
    expect(buildMenuTree([{ id: "engine.UIDocument", name: "UIDocument", group: "Engine" as const }], new Map())[0]!.label).toBe("UI");
  });

  it("offers only UI Document under UI, and creates it as a UIDocument node", async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const scene = openScene.value!;
    expect(newNodeKinds().filter((k) => k.category === "UI").map((k) => k.label)).toEqual(["UI Document"]);
    const made = (kind: NodeKind) => scene.doc.node(insertNew(scene, kind));
    expect(made("ui-document").components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.UIDocument"]);
  });
});
