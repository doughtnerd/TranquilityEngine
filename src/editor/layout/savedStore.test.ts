import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../../engine/platform/Storage";
import { joinPath } from "../projects";
import { ROOT, closeTestProject, openTestProject } from "../testing";
import { closePanel, defaultLayout, instancesOf, openTypes } from "./model";
import { addVersion, newLayoutFile, layoutFileText, type LayoutFile } from "./saved";
import {
  activeLayoutFile,
  applyDefaultLayout,
  applySavedLayout,
  deleteLayout,
  layoutModified,
  layoutsWithPanels,
  refreshSavedLayouts,
  removePanelsFromLayouts,
  renameLayout,
  restoreLayoutVersion,
  saveLayout,
  saveLayoutAs,
  savedLayouts,
  setLayoutPlatform,
  setLayoutScopes,
  whyNoProjectLayouts,
  whyNoSave,
} from "./savedStore";
import { layout } from "./store";

let storage: MemoryStorage;
const typesOf = (l = layout.value) => openTypes(l);
const closeType = (type: string) => (layout.value = closePanel(layout.value, instancesOf(layout.value, type)[0]!));

beforeEach(async () => {
  storage = new MemoryStorage();
  setLayoutPlatform(async () => ({ fs: null, userStorage: storage }));
  await refreshSavedLayouts(null); // nothing from the last test
  applyDefaultLayout();
});
afterEach(() => {
  closeTestProject();
  applyDefaultLayout();
});

describe("saved layouts (ADR 0174)", () => {
  it("saves the working layout as a project file in .layouts/ and lists it; Default can't be saved over", async () => {
    const { fs } = await openTestProject();
    await refreshSavedLayouts();
    expect(whyNoSave()).toMatch(/Default/);
    closeType("code");
    const file = await saveLayoutAs("Scripting", ["project"]);
    expect(file).toBe("scripting.layout.json");
    const text = fs.files.get(joinPath(ROOT, ".layouts/scripting.layout.json")) as string;
    expect(JSON.parse(text)).toMatchObject({ format: "myco.layout@1", name: "Scripting", head: 1 });
    expect(savedLayouts.value.map((s) => [s.name, !!s.project, !!s.user])).toEqual([["Scripting", true, false]]);
    expect(activeLayoutFile.value).toBe(file);
    expect(layoutModified.value).toBe(false);
  });

  it("saves user layouts to per-user storage, one entry per file", async () => {
    await saveLayoutAs("Mine", ["user"]);
    expect(await storage.list("settings")).toEqual(["layouts/mine.layout.json"]);
    await refreshSavedLayouts(null);
    expect(savedLayouts.value.map((s) => s.name)).toEqual(["Mine"]);
  });

  it("switches between layouts, marks changes, and saves over a layout as a new version", async () => {
    await openTestProject();
    const file = (await saveLayoutAs("Full", ["user", "project"]))!;
    closeType("history");
    expect(layoutModified.value).toBe(true);
    await saveLayout();
    const saved = savedLayouts.value.find((s) => s.file === file)!;
    expect(saved.newest.versions.map((v) => [v.seq, v.parent])).toEqual([[1, 0], [2, 1]]);
    expect(saved.user).toEqual(saved.project); // mirrored
    applyDefaultLayout();
    expect(typesOf()).toContain("history");
    expect(applySavedLayout(file)).toBe(true);
    expect(typesOf()).not.toContain("history");
    await restoreLayoutVersion(file, 1);
    expect(typesOf()).toContain("history");
    expect(savedLayouts.value[0]!.newest.head).toBe(1);
  });

  it("renames (the file follows), moves between places and deletes", async () => {
    const { fs } = await openTestProject();
    await refreshSavedLayouts();
    const file = (await saveLayoutAs("Audio", ["project"]))!;
    await renameLayout(file, "Mixing");
    expect(fs.files.has(joinPath(ROOT, ".layouts/audio.layout.json"))).toBe(false);
    expect(fs.files.has(joinPath(ROOT, ".layouts/mixing.layout.json"))).toBe(true);
    expect(activeLayoutFile.value).toBe("mixing.layout.json");
    await setLayoutScopes("mixing.layout.json", ["user"]);
    expect(fs.files.has(joinPath(ROOT, ".layouts/mixing.layout.json"))).toBe(false);
    expect(await storage.list("settings")).toEqual(["layouts/mixing.layout.json"]);
    await deleteLayout("mixing.layout.json");
    expect(savedLayouts.value).toEqual([]);
    expect(activeLayoutFile.value).toBeNull();
  });

  it("reads layouts committed to the project, and can't write project layouts in a read-only project", async () => {
    const committed: LayoutFile = newLayoutFile("Team", defaultLayout(), 1);
    await openTestProject({ ".layouts/team.layout.json": layoutFileText(committed), ".layouts/notes.txt": "x" });
    await refreshSavedLayouts();
    expect(savedLayouts.value.map((s) => s.name)).toEqual(["Team"]);
    expect(whyNoProjectLayouts(null)).toMatch(/no project/);
  });

  it("finds the layouts holding a plugin's panels, and removes them as a new version", async () => {
    await openTestProject();
    const file = (await saveLayoutAs("With worlds", ["project"]))!;
    expect(layoutsWithPanels(["worlds"]).map((l) => l.name)).toEqual(["Current layout", "With worlds"]);
    await removePanelsFromLayouts(["worlds"], "Removed the Worlds panel");
    expect(typesOf()).not.toContain("worlds");
    const saved = savedLayouts.value.find((s) => s.file === file)!;
    expect(saved.newest.versions.at(-1)!.label).toBe("Removed the Worlds panel");
    expect(saved.newest.head).toBe(2);
    expect(layoutsWithPanels(["worlds"])).toEqual([]);
    // The old arrangement is one Restore away.
    await restoreLayoutVersion(file, 1);
    expect(typesOf()).toContain("worlds");
  });

  it("lists the newer copy of a layout kept in both places", async () => {
    const old = newLayoutFile("Shared", defaultLayout(), 1);
    const newer = addVersion({ ...old, name: "Shared (team)" }, defaultLayout(), 50);
    await storage.save("settings", "layouts/shared.layout.json", layoutFileText(old));
    await openTestProject({ ".layouts/shared.layout.json": layoutFileText(newer) });
    await refreshSavedLayouts();
    expect(savedLayouts.value.map((s) => s.name)).toEqual(["Shared (team)"]);
  });
});
