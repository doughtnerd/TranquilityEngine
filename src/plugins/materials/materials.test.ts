// The Materials plugin (ADR 0133: Material and Shader together; ADR 0134): its editor half registers
// the material, shader graph and sub-graph asset kinds, their formats and the Shader Graph panel,
// and removes them all when deactivated.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMaterialSettings, formatMaterial, type MaterialSettings } from "../../engine/scene/material";
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph } from "../../engine/scene/shaderGraph";
import { assetKind, opensInCodePanel } from "../../editor/assetBrowser";
import { _reset, openAssetDocument } from "../../editor/assetDocuments";
import { acceptsFile } from "../../editor/assetFieldKinds";
import { inspectableAsset } from "../../editor/assetImport";
import { kindIcon, kindLabel, kindOpens } from "../../editor/assetKindLookup";
import { isKnownPanel, isOnDemand, panelBeside, panelTitle } from "../../editor/layout/model";
import { joinPath, openFolderProject } from "../../editor/projects";
import { assetFormats, assetKinds, panels } from "../../editor/sdk/contributions";
import { activatePlugins, deactivatePlugin, isPluginActive } from "../../editor/sdk/plugins";
import { currentProject } from "../../editor/state";
import { MemoryFileSystem, ROOT } from "../../editor/testing";
import { previewKind } from "../../editor/thumbnails/keys";
import { EDITOR_PLUGINS } from "../editor";
import { RUNTIME_PLUGINS } from "../runtime";
import { materialsEditorPlugin } from "./editor";
import { materialsRuntimePlugin } from "./runtime";

const MATERIAL = "materials/hull.material.json";
const GRAPH = "shaders/glow.shadergraph.json";
const SUB = "shaders/ripple.shadersubgraph.json";
const KINDS = ["material", "shadergraph", "shadersubgraph"] as const;

beforeEach(() => activatePlugins([materialsEditorPlugin]));
afterEach(() => {
  _reset();
  deactivatePlugin(materialsEditorPlugin.manifest.name);
  currentProject.value = null;
});

describe("the Materials plugin's editor half (ADR 0134)", () => {
  it("is listed with its runtime half, sharing one manifest", () => {
    expect(EDITOR_PLUGINS).toContain(materialsEditorPlugin);
    expect(RUNTIME_PLUGINS).toContain(materialsRuntimePlugin);
    expect(materialsRuntimePlugin.manifest).toBe(materialsEditorPlugin.manifest);
    expect(materialsEditorPlugin.manifest).toMatchObject({ name: "myco.materials", server: false });
  });

  it("detects its three kinds, case-insensitively, none of which open in the Code panel", () => {
    expect(assetKind(MATERIAL)).toBe("material");
    expect(assetKind("materials/Hull.MATERIAL.json")).toBe("material");
    expect(assetKind(GRAPH)).toBe("shadergraph");
    expect(assetKind(SUB)).toBe("shadersubgraph");
    for (const k of KINDS) expect(opensInCodePanel(k), k).toBe(false);
  });

  it("gives them labels, icons, previews, inspectors, open behaviour and New… entries", () => {
    expect(KINDS.map((k) => kindLabel(k))).toEqual(["Material", "Shader Graph", "Sub Graph"]);
    for (const k of KINDS) expect(kindIcon(k), k).toMatch(/^M/);
    expect([previewKind(MATERIAL), previewKind(GRAPH), previewKind(SUB)]).toEqual(["material", "shadergraph", null]);
    for (const p of [MATERIAL, GRAPH, SUB]) expect(inspectableAsset(p), p).toBe(p);
    // A material only selects; graphs open in the Shader Graph panel.
    expect([kindOpens(MATERIAL), kindOpens(GRAPH), kindOpens(SUB)]).toEqual([false, true, true]);
    expect(KINDS.map((k) => assetKinds.get(k)?.create?.label)).toEqual(["New Material", "New Shader Graph", "New Shader Sub Graph"]);
  });

  it("lets material fields take materials and shader graphs, not sub-graphs", () => {
    expect(acceptsFile("material", MATERIAL)).toBe(true);
    expect(acceptsFile("material", GRAPH)).toBe(true);
    expect(acceptsFile("material", SUB)).toBe(false);
    expect(acceptsFile("environment", MATERIAL)).toBe(false);
  });

  it("registers the Shader Graph panel beside the Scene view, in the default layout", () => {
    expect(isKnownPanel("shadergraph")).toBe(true);
    expect(panelTitle("shadergraph")).toBe("Shader Graph");
    expect(panelBeside("shadergraph")).toBe("scene");
    expect(isOnDemand("shadergraph")).toBe(false);
  });

  it("registers formats that round-trip and report problems as messages", () => {
    const material = assetFormats.get("material")!;
    const settings: MaterialSettings = { ...defaultMaterialSettings(), metalness: 0.25 };
    const read = material.parse(JSON.parse(formatMaterial(settings)), MATERIAL);
    expect(read.problems).toEqual([]);
    expect(material.format(read.value)).toBe(formatMaterial(settings));
    expect(material.writeDelay).toBe(150);
    for (const [id, graph, path] of [["shadergraph", defaultShaderGraph(), GRAPH], ["shadersubgraph", defaultShaderSubGraph(), SUB]] as const) {
      const format = assetFormats.get(id)!;
      const back = format.parse(JSON.parse(formatShaderGraph(graph)), path);
      expect(back.problems, id).toEqual([]);
      expect(format.format(back.value), id).toBe(formatShaderGraph(graph));
      const bad = format.parse("nope", path);
      expect(bad.problems.length, id).toBeGreaterThan(0);
      expect(Object.keys(bad.problems[0]!)).toEqual(["message"]);
    }
  });

  it("edits a material through its asset document", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, MATERIAL), formatMaterial(defaultMaterialSettings()));
    const project = await openFolderProject(fs, ROOT);
    currentProject.value = project;
    const doc = openAssetDocument<MaterialSettings>(project, MATERIAL, "material");
    doc.edit({ ...doc.value.peek(), roughness: 0.75 });
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, MATERIAL))).toMatch(/"roughness": 0.75/);
    doc.undo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, MATERIAL))).toBe(formatMaterial(defaultMaterialSettings()));
  });

  it("removes everything when deactivated", () => {
    deactivatePlugin("myco.materials");
    expect(isPluginActive("myco.materials")).toBe(false);
    for (const p of [MATERIAL, GRAPH, SUB]) {
      expect(assetKind(p), p).toBe("json");
      expect(previewKind(p), p).toBeNull();
      expect(inspectableAsset(p), p).toBeNull();
      expect(acceptsFile("material", p), p).toBe(false);
    }
    for (const k of KINDS) {
      expect(kindLabel(k), k).toBeUndefined();
      expect(assetFormats.get(k), k).toBeUndefined();
    }
    expect(panels.get("shadergraph")).toBeUndefined();
    expect(isKnownPanel("shadergraph")).toBe(false);
  });
});

describe("New… entries", () => {
  it("create a material in materials/ and graphs in shaders/ when the project has those folders", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "materials/old.material.json"), "{}");
    fs.files.set(joinPath(ROOT, "shaders/old.shadergraph.json"), "{}");
    currentProject.value = await openFolderProject(fs, ROOT);
    expect(await assetKinds.get("material")!.create!.create("")).toBe("materials/New Material.material.json");
    expect(await assetKinds.get("shadergraph")!.create!.create("")).toBe("shaders/New Shader Graph.shadergraph.json");
    expect(await assetKinds.get("shadersubgraph")!.create!.create("")).toBe("shaders/New Sub Graph.shadersubgraph.json");
  });
});
