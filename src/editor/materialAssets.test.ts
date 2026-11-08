import { afterEach, describe, expect, it, vi } from "vitest";
import { _reset, openAssetDocument } from "./assetDocuments";
import { moveAssets } from "./assetOps";
import type { MaterialSettings } from "../engine/scene/material";
import { colorHex } from "../engine/scene/material";
import { parseShaderAsset } from "../engine/scene/shaderAsset";
import { createShader, editMaterial, readMaterial, withKeywordValue } from "./materialAssets";
import { joinPath, openFolderProject } from "./projects";
import { currentProject } from "./state";
import { MemoryFileSystem, ROOT } from "./testing";


afterEach(() => {
  _reset();
  vi.useRealTimers();
});

async function openMaterial() {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, "m.material.json"), '{ "format": "myco.material@1" }');
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return { fs, project, doc: openAssetDocument<MaterialSettings>(project, "m.material.json", "material") };
}

describe("material asset documents (ADR 0134)", () => {
  it("writes an edit once and undoes and redoes it", async () => {
    const { fs, project, doc } = await openMaterial();
    const write = vi.spyOn(project, "writeText");
    await editMaterial(project, "m.material.json", { metalness: 0.5 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).toMatch(/"metalness": 0.5/);
    doc.undo();
    await doc.flush();
    expect(doc.value.value.metalness).not.toBe(0.5);
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).not.toMatch(/metalness/);
    doc.redo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).toMatch(/"metalness": 0.5/);
  });

  it("makes a coalesced drag one undo step", async () => {
    vi.useFakeTimers();
    const { fs, project, doc } = await openMaterial();
    for (const v of [0.1, 0.2, 0.3]) void editMaterial(project, "m.material.json", { roughness: v }, { coalesce: true });
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).toMatch(/"roughness": 0.3/);
    doc.undo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).not.toMatch(/roughness/);
    expect(doc.canUndo.value).toBe(false);
  });

  it("keeps its history across a rename", async () => {
    const { fs, project, doc } = await openMaterial();
    await editMaterial(project, "m.material.json", { metalness: 0.5 });
    await moveAssets([["m.material.json", "n.material.json"]]);
    expect(doc.path).toBe("n.material.json");
    doc.undo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "n.material.json"))).not.toMatch(/metalness/);
  });
});

describe("editing material assets (ADR 0043)", () => {
  it("applies quick edits one after another, each to the file as the last left it", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "m.material.json"), '{ "format": "myco.material@1" }');
    const project = await openFolderProject(fs, ROOT);
    // Started together, as two Inspector edits before the first write lands.
    const results = await Promise.all([
      editMaterial(project, "m.material.json", { metalness: 0.8 }),
      editMaterial(project, "m.material.json", (now) => ({ tiling: [2, now.tiling[1]] })),
      editMaterial(project, "m.material.json", { metalness: 0.8 }), // no change by then
    ]);
    expect(results).toEqual([true, true, false]);
    const { settings } = readMaterial(project, "m.material.json");
    expect([settings.metalness, settings.tiling, colorHex(settings.color)]).toEqual([0.8, [2, 1], "#ffffff"]);
  });
});

describe("material keywords and instancing (ADR 0106)", () => {
  it("leaves out a keyword set to its default", () => {
    const rim = { name: "RIM" };
    const quality = { name: "QUALITY", values: ["LOW", "HIGH"] };
    expect(withKeywordValue({}, rim, true)).toEqual({ RIM: true });
    expect(withKeywordValue({ RIM: true }, rim, false)).toEqual({});
    expect(withKeywordValue({}, quality, "HIGH")).toEqual({ QUALITY: "HIGH" });
    expect(withKeywordValue({ QUALITY: "HIGH" }, quality, "LOW")).toEqual({});
  });

  it("writes keywords and instancing to the file", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "m.material.json"), '{ "format": "myco.material@1" }');
    const project = await openFolderProject(fs, ROOT);
    await editMaterial(project, "m.material.json", (now) => ({ keywords: withKeywordValue(now.keywords, { name: "RIM" }, true), instancing: "thin" }));
    const { settings } = readMaterial(project, "m.material.json");
    expect([settings.keywords, settings.instancing]).toEqual([{ RIM: true }, "thin"]);
    await editMaterial(project, "m.material.json", (now) => ({ keywords: withKeywordValue(now.keywords, { name: "RIM" }, false), instancing: "auto" }));
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).not.toMatch(/keywords|instancing/);
  });
});

describe("New Shader", () => {
  it("creates the shader asset with WGSL and GLSL beside it, under a free name, in shaders/ if present", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "shaders/old.shader.json"), '{ "format": "myco.shader@1" }');
    const project = await openFolderProject(fs, ROOT);
    currentProject.value = project;
    try {
      const first = await createShader("");
      expect(first).toBe("shaders/New Shader.shader.json");
      for (const f of ["shaders/New Shader.wgsl", "shaders/New Shader.glsl"]) expect(fs.files.get(joinPath(ROOT, f))).toContain("surface(");
      const { shader, problems } = parseShaderAsset(JSON.parse(fs.files.get(joinPath(ROOT, first!)) as string));
      expect(problems).toEqual([]);
      expect(shader.properties.map((p) => p.name)).toEqual(["Tint"]);
      expect(shader.wgsl).toEqual({ file: "asset:shaders/New Shader.wgsl" });
      expect(shader.glsl).toEqual({ file: "asset:shaders/New Shader.glsl" });
      expect(await createShader("")).toBe("shaders/New Shader 2.shader.json");
    } finally {
      currentProject.value = null;
    }
  });
});
