import { describe, expect, it } from "vitest";
import { defaultShaderGraph } from "../../engine/scene/shaderGraph";
import { addNode, defaultFunction, setFunction } from "./graphEdit";

describe("custom function WGSL body", () => {
  it("sets function.wgsl, leaves the input untouched, and removes the key when empty", () => {
    const g0 = addNode(defaultShaderGraph(), "customFunction", [0, 0]).graph;
    const f = defaultFunction();
    const g1 = setFunction(g0, "customFunction1", { ...f, wgsl: "Out = In;" });
    expect(g1.nodes.find((n) => n.id === "customFunction1")?.function?.wgsl).toBe("Out = In;");
    expect(g0.nodes.find((n) => n.id === "customFunction1")?.function?.wgsl).toBeUndefined(); // pure: undo keeps the old graph
    const g2 = setFunction(g1, "customFunction1", { ...f, wgsl: "" });
    const fn = g2.nodes.find((n) => n.id === "customFunction1")!.function!;
    expect("wgsl" in fn).toBe(false);
    expect(JSON.parse(JSON.stringify(g2)).nodes.find((n: { id: string }) => n.id === "customFunction1").function.wgsl).toBeUndefined();
  });
});
