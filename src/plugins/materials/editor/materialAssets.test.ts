import { afterEach, describe, expect, it, vi } from "vitest";
import { openAssetDocument, type AssetDocument } from "../../../editor/assetDocuments";
import { useEditorPlugins } from "../../testEditorPlugins";
import { materialsEditorPlugin } from ".";
import { moveAssets } from "../../../editor/assetOps";
import type { MaterialSettings } from "../../../engine/scene/material";
import { materialShaderFile, withKeywordValue } from "./materialAssets";
import { parseMaterial } from "../../../engine/scene/material";
import { joinPath, openFolderProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";


// The formats come from the Materials plugin (ADR 0134).
useEditorPlugins([materialsEditorPlugin], "each");
afterEach(() => {
  vi.useRealTimers();
});

/** Change the material through its asset document, as the Inspector does; written unless the edit coalesces. */
async function edit(doc: AssetDocument<MaterialSettings>, patch: Partial<MaterialSettings> | ((now: MaterialSettings) => Partial<MaterialSettings>), options?: { coalesce?: boolean }): Promise<void> {
  const now = doc.value.peek();
  doc.edit({ ...now, ...(typeof patch === "function" ? patch(now) : patch) }, options);
  if (!options?.coalesce) await doc.flush();
}

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
    await edit(doc, { metalness: 0.5 });
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
    const { fs, doc } = await openMaterial();
    for (const v of [0.1, 0.2, 0.3]) void edit(doc, { roughness: v }, { coalesce: true });
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).toMatch(/"roughness": 0.3/);
    doc.undo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).not.toMatch(/roughness/);
    expect(doc.canUndo.value).toBe(false);
  });

  it("keeps its history across a rename", async () => {
    const { fs, doc } = await openMaterial();
    await edit(doc, { metalness: 0.5 });
    await moveAssets([["m.material.json", "n.material.json"]]);
    expect(doc.path).toBe("n.material.json");
    doc.undo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "n.material.json"))).not.toMatch(/metalness/);
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
    const { fs, project, doc } = await openMaterial();
    await edit(doc, (now) => ({ keywords: withKeywordValue(now.keywords, { name: "RIM" }, true), instancing: "thin" }));
    const { settings } = parseMaterial(JSON.parse(fs.files.get(joinPath(ROOT, "m.material.json")) as string), "m.material.json");
    expect([settings.keywords, settings.instancing]).toEqual([{ RIM: true }, "thin"]);
    await edit(doc, (now) => ({ keywords: withKeywordValue(now.keywords, { name: "RIM" }, false), instancing: "auto" }));
    expect(fs.files.get(joinPath(ROOT, "m.material.json"))).not.toMatch(/keywords|instancing/);
  });
});

describe("materialShaderFile (ADR 0459)", () => {
  it("names the project file however the reference is written, so a ./ form isn't reported missing", () => {
    for (const shader of ["asset:shaders/a.shadergraph.json", "asset:./shaders/a.shadergraph.json", "/shaders/a.shadergraph.json"]) {
      expect(materialShaderFile({ shader })).toBe("shaders/a.shadergraph.json");
    }
    expect(materialShaderFile({ shader: "lit" })).toBeNull();
  });
});
