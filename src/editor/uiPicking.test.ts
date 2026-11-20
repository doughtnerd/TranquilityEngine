import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Color, Engine, GameObject } from "../engine";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../engine/ui/components";
import { orderClickHits, partitionUIHits } from "./uiPicking";
import type { UIComponentType } from "../engine/ui/components";

let engine: Engine;
beforeEach(async () => {
  engine = await Engine.create({ headless: true });
});
afterEach(() => engine.dispose());

const make = <T extends UIPanel | UIText | UIImage | UICanvas | UIInputField | UIButton>(type: new () => T, init: Partial<T> = {}): T => GameObject.create("n").addBehavior(type as never, init as never) as T;

describe("click ordering", () => {
  it("splits hits keeping order and puts painted UI before the scene and bare UI after", () => {
    const bare = make(UIPanel), a = make(UIText, { text: "a" }), b = make(UIPanel, { backgroundColor: Color.white });
    expect(partitionUIHits([a, bare, b])).toEqual({ painted: [a, b], bare: [bare] });
    expect(orderClickHits(["ui:a", "ui:b"], ["mesh", "ui:a"], ["ui:bare", "mesh"])).toEqual(["ui:a", "ui:b", "mesh", "ui:bare"]);
  });
});
