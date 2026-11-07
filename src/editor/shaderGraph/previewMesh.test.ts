import { describe, expect, it } from "vitest";
import { compileShaderGraph } from "../../engine/render/shaderGraph/compile";
import { defaultShaderGraph, formatShaderGraph, parseShaderGraph } from "../../engine/scene/shaderGraph";
import { setGraphPreviewMesh } from "./graphEdit";

describe("main preview mesh (ADR 0117)", () => {
  it("round-trips through the file, leaving spheres unwritten and ignoring bad values", () => {
    const g = defaultShaderGraph();
    expect(formatShaderGraph(g)).not.toContain("previewMesh");
    expect(formatShaderGraph(setGraphPreviewMesh(g, "sphere"))).not.toContain("previewMesh");
    const cube = setGraphPreviewMesh(g, "cube");
    expect(formatShaderGraph(cube)).toContain('"previewMesh": "cube"');
    expect(parseShaderGraph(JSON.parse(formatShaderGraph(cube))).graph.previewMesh).toBe("cube");
    expect(parseShaderGraph({ format: "myco.shadergraph@1", previewMesh: "bogus" }).graph.previewMesh).toBeUndefined();
    expect(parseShaderGraph({ format: "myco.shadergraph@1", previewMesh: "quad" }).graph.previewMesh).toBeUndefined();
  });
  it("setGraphPreviewMesh returns the same graph when unchanged and drops the field for sphere", () => {
    const g = defaultShaderGraph();
    expect(setGraphPreviewMesh(g, "sphere")).toBe(g);
    const cap = setGraphPreviewMesh(g, "capsule");
    expect(cap).not.toBe(g);
    expect(cap.previewMesh).toBe("capsule");
    expect(setGraphPreviewMesh(cap, "capsule")).toBe(cap);
    expect("previewMesh" in setGraphPreviewMesh(cap, "sphere")).toBe(false);
    expect(g.previewMesh).toBeUndefined();
  });
  it("does not change the compiled shader key", () => {
    const g = defaultShaderGraph();
    expect(compileShaderGraph(setGraphPreviewMesh(g, "plane")).key).toBe(compileShaderGraph(g).key);
  });
});
