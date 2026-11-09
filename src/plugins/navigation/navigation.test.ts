// The Navigation plugin's editor half (ADR 0065, 0134): the formation asset kind and format, and formations
// edit through an asset document.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultFormation, formatFormation, setFormationCell, type NavFormationAsset } from "../../engine/nav/formation";
import { assetKind } from "../../editor/assetBrowser";
import { _reset, assetDocumentsMoved, openAssetDocument } from "../../editor/assetDocuments";
import { acceptsFile } from "../../editor/assetFieldKinds";
import { inspectableAsset } from "../../editor/assetImport";
import { kindIcon, kindLabel, registeredKind } from "../../editor/assetKindLookup";
import { joinPath, openFolderProject } from "../../editor/projects";
import { inspectorSectionsFor, registeredInspectorSections } from "../../editor/ui/inspectorSections";
import { assetFormats, assetKinds, panelExtensions, projectSettingsSections } from "../../editor/sdk/contributions";
import { activatePlugins, deactivatePlugin, isPluginActive } from "../../editor/sdk/plugins";
import { currentProject } from "../../editor/state";
import { MemoryFileSystem, ROOT, useCoreAssetKinds } from "../../editor/testing";
import { EDITOR_PLUGINS } from "../editor";
import { RUNTIME_PLUGINS } from "../runtime";
import { navigationEditorPlugin } from "./editor";
import { navigationRuntimePlugin } from "./runtime";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const FORMATION = "navigation/wedge.formation.json";

async function open(files: Record<string, string>) {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  for (const [p, text] of Object.entries(files)) fs.files.set(joinPath(ROOT, p), text);
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return { project, fs };
}

const mask = (): NavFormationAsset => ({ ...defaultFormation(), shape: "mask" });

beforeEach(() => activatePlugins([navigationEditorPlugin]));
afterEach(() => {
  _reset();
  deactivatePlugin("myco.navigation");
  currentProject.value = null;
});

describe("the Navigation plugin's editor half (ADR 0134)", () => {
  it("is listed with its runtime half, sharing one manifest", () => {
    expect(EDITOR_PLUGINS).toContain(navigationEditorPlugin);
    expect(RUNTIME_PLUGINS).toContain(navigationRuntimePlugin);
    expect(navigationRuntimePlugin.manifest).toBe(navigationEditorPlugin.manifest);
  });

  it("registers the formation asset kind: matching, label, icon, inspector and formation fields", () => {
    expect(assetKind(FORMATION)).toBe("formation");
    expect(assetKind("Wedge.FORMATION.json")).toBe("formation");
    expect(kindLabel("formation")).toBe("Formation");
    expect(kindIcon("formation")).toMatch(/^M/);
    expect(inspectableAsset(FORMATION)).toBe(FORMATION);
    expect(acceptsFile("formation", FORMATION)).toBe(true);
    expect(acceptsFile("tileset", FORMATION)).toBe(false);
    expect(assetKinds.get("formation")?.inspector).toBeTypeOf("function");
  });

  it("registers a format that round-trips a formation and reports problems as messages", () => {
    const format = assetFormats.get("formation")!;
    const painted = setFormationCell(mask(), 2, 1, true);
    const read = format.parse(JSON.parse(formatFormation(painted)), FORMATION);
    expect(read.problems).toEqual([]);
    expect(read.value).toEqual(painted);
    expect(format.format(read.value)).toBe(formatFormation(painted));
    const bad = format.parse("nope", FORMATION);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(Object.keys(bad.problems[0]!)).toEqual(["message"]);
  });

  it("edits a formation through its asset document: a paint stroke is one undo step, a rename keeps the history", async () => {
    const { project, fs } = await open({ [FORMATION]: formatFormation(mask()) });
    const doc = openAssetDocument<NavFormationAsset>(project, FORMATION, "formation");
    for (const x of [0, 1, 2]) doc.edit(setFormationCell(doc.value.peek(), x, 0, true), { coalesce: true });
    await doc.flush();
    const text = () => fs.files.get(joinPath(ROOT, FORMATION)) as string;
    expect(text()).toBe(formatFormation(setFormationCell(setFormationCell(setFormationCell(mask(), 0, 0, true), 1, 0, true), 2, 0, true)));
    assetDocumentsMoved([[FORMATION, "navigation/renamed.formation.json"]]);
    doc.undo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, "navigation/renamed.formation.json"))).toBe(formatFormation(mask()));
    expect(doc.canUndo.value).toBe(false);
  });

  it("adds the Navigation category to Project settings, after Graphics", () => {
    const section = projectSettingsSections.get("navigation");
    expect(section).toMatchObject({ title: "Navigation", after: "Graphics" });
  });

  it("adds the navigation counters under the Worlds panel", () => {
    expect(panelExtensions.list().map((e) => [e.id, e.panel])).toEqual([["navigation-debug", "worlds"]]);
  });

  it("registers the navigation components' Inspector sections, which load", async () => {
    expect(registeredInspectorSections("engine.NavChunk")).toHaveLength(2);
    // Rooted-only sections show for a top-level node only.
    expect(inspectorSectionsFor("engine.NavChunk", [["a", "b"]])).toHaveLength(0);
    expect(inspectorSectionsFor("engine.NavChunk", [["a"]])).toHaveLength(2);
    for (const type of ["engine.NavAgent", "engine.NavAvoidanceObstacle", "engine.NavGroup", "engine.NavResolutionVolume", "engine.NavModifierVolume", "engine.NavCostVolume"]) {
      expect(registeredInspectorSections(type), type).toHaveLength(1);
    }
    for (const type of ["engine.NavChunk", "engine.NavAgent", "engine.NavAvoidanceObstacle", "engine.NavGroup", "engine.NavResolutionVolume", "engine.NavModifierVolume", "engine.NavCostVolume"]) {
      for (const view of registeredInspectorSections(type)) {
        await view.preload();
        expect(view.loaded, type).toBe(true);
      }
    }
  }, 60_000);

  it("removes everything when deactivated", () => {
    deactivatePlugin("myco.navigation");
    expect(isPluginActive("myco.navigation")).toBe(false);
    expect(registeredKind("formation")).toBeUndefined();
    expect(assetFormats.get("formation")).toBeUndefined();
    expect(projectSettingsSections.list()).toEqual([]);
    expect(panelExtensions.list()).toEqual([]);
    for (const type of ["engine.NavChunk", "engine.NavAgent", "engine.NavGroup", "engine.NavCostVolume"]) expect(registeredInspectorSections(type), type).toEqual([]);
  });
});
