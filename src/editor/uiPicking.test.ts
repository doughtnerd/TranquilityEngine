import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject } from "../engine";
import { UIDocument, loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { orderClickHits, partitionUIHits } from "./uiPicking";

let engine: Engine;
beforeEach(async () => {
  Assets.clearSources();
  // UI elements come only from documents (ADR 0417): a text, a bare panel and a painted one.
  Assets.addSource(Assets.fromObject({ "ui/pick.ui.xml": `<Canvas><Text id="a">a</Text><Panel id="bare"/><Panel id="b" background-color="#ffffff"/></Canvas>` }));
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
});
afterEach(() => {
  engine.dispose();
  Assets.clearSources();
});

describe("click ordering", () => {
  it("splits hits keeping order and puts painted UI before the scene and bare UI after", async () => {
    const doc = GameObject.create("UI").addBehavior(UIDocument, { document: "asset:ui/pick.ui.xml" });
    await doc.ready;
    const [a, bare, b] = ["#a", "#bare", "#b"].map((s) => doc.query(s)!.component);
    expect(partitionUIHits([a!, bare!, b!])).toEqual({ painted: [a, b], bare: [bare] });
    expect(orderClickHits(["ui:a", "ui:b"], ["mesh", "ui:a"], ["ui:bare", "mesh"])).toEqual(["ui:a", "ui:b", "mesh", "ui:bare"]);
  });
});
