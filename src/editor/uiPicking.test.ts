import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine } from "../engine";
import { buildUI, loadUITestSupport } from "../engine/tests/uiMarkup";
import { orderClickHits, partitionUIHits } from "./uiPicking";

let engine: Engine;
beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});
afterEach(() => {
  engine.dispose();
  Assets.clearSources();
});

describe("click ordering", () => {
  it("splits hits keeping order and puts painted UI before the scene and bare UI after", () => {
    // UI elements come only from a view's component (ADR 0417, 0419): a text, a bare panel and a painted one.
    const ui = buildUI(`<Canvas><p id="a">a</p><div id="bare"></div><div id="b" background-color="#ffffff"></div></Canvas>`);
    const [a, bare, b] = ["#a", "#bare", "#b"].map((s) => ui.query(s)!.component);
    expect(partitionUIHits([a, bare, b])).toEqual({ painted: [a, b], bare: [bare] });
    expect(orderClickHits(["ui:a", "ui:b"], ["mesh", "ui:a"], ["ui:bare", "mesh"])).toEqual(["ui:a", "ui:b", "mesh", "ui:bare"]);
  });
});
