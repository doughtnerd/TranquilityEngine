// Third-party plugins in the editor (ADR 0139): a project folder's plugins/ sources are read as
// scripts, both halves activate after loading, a reload re-activates them from the new code, static
// asset kinds register, and disabling a plugin unloads it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../engine/core/registry";
import { assetKind } from "../editor/assetBrowser";
import { joinPath, openFolderProject } from "../editor/projects";
import { assetKinds, componentNotes } from "../editor/sdk/contributions";
import { isPluginActive } from "../editor/sdk/plugins";
import { MemoryFileSystem } from "../editor/testing";
import { isRuntimePluginActive } from "./runtimeContext";
import { allPluginManifests, loadProjectCode, projectPlugins, unloadThirdPartyPlugins } from "./thirdPartyEditor";
import "./editorBoot";

const FIXTURE = resolve(__dirname, "fixtures/spinner-project");
const ROOT = "C:\\Games\\spinner";

async function fixtureFolder(): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else fs.files.set(joinPath(ROOT, relative(FIXTURE, full).split(sep).join("/")), readFileSync(full, "utf8"));
    }
  };
  walk(FIXTURE);
  return fs;
}

const note = () => componentNotes.list().find((n) => n.id === "acme.spinner.note")?.note("acme.Spinner") ?? null;

afterEach(() => unloadThirdPartyPlugins());

describe("third-party plugins in the editor", () => {
  it("loads both halves of a project plugin, with its static asset kind, and lists it", async () => {
    const project = await openFolderProject(await fixtureFolder(), ROOT);
    expect([...project.scripts.keys()].sort()).toEqual(["plugins/spinner/editor/index.ts", "plugins/spinner/runtime/index.ts", "scripts/useSpinner.ts"]);
    const result = await loadProjectCode(project);
    expect(result.problems).toEqual([]);
    expect(isRuntimePluginActive("acme.spinner")).toBe(true);
    expect(isPluginActive("acme.spinner")).toBe(true);
    expect(getComponentClass("acme.Spinner")).toBeDefined();
    expect(note()).toBe("spins at 90°/s");
    expect(assetKinds.get("spin")?.label).toBe("Spin Preset");
    expect(assetKind("presets/fast.spin.json")).toBe("spin");
    expect(allPluginManifests().map((m) => m.name)).toContain("acme.spinner");
    expect(projectPlugins.value.usable.map((p) => p.manifest.name)).toEqual(["acme.spinner"]);
  });

  it("re-activates the editor half from the new code when a plugin file is saved (live reload)", async () => {
    const fs = await fixtureFolder();
    const project = await openFolderProject(fs, ROOT);
    await loadProjectCode(project);
    expect(note()).toBe("spins at 90°/s");
    await project.writeScript("plugins/spinner/runtime/index.ts", project.scripts.get("plugins/spinner/runtime/index.ts")!.replace("speed = 90", "speed = 180"));
    const result = await loadProjectCode(project);
    expect(result.problems).toEqual([]);
    expect(note()).toBe("spins at 180°/s");
    expect(componentNotes.list().filter((n) => n.id === "acme.spinner.note")).toHaveLength(1);
  });

  it("unloads a disabled plugin: its Component, contributions and asset kind go", async () => {
    const fs = await fixtureFolder();
    fs.files.set(joinPath(ROOT, "project.json"), JSON.stringify({ name: "Spinner fixture", plugins: { disabled: ["acme.spinner"] } }));
    fs.files.delete(joinPath(ROOT, "scripts/useSpinner.ts"));
    const project = await openFolderProject(fs, ROOT);
    const result = await loadProjectCode(project);
    expect(result.problems).toEqual([]);
    expect(isRuntimePluginActive("acme.spinner")).toBe(false);
    expect(isPluginActive("acme.spinner")).toBe(false);
    expect(getComponentClass("acme.Spinner")).toBeUndefined();
    expect(note()).toBeNull();
    expect(assetKinds.get("spin")).toBeUndefined();
  });

  it("reports a refused plugin with the script problems, and loads none of its code", async () => {
    const fs = await fixtureFolder();
    const manifest = JSON.parse(fs.files.get(joinPath(ROOT, "plugins/spinner/plugin.json")) as string) as Record<string, unknown>;
    fs.files.set(joinPath(ROOT, "plugins/spinner/plugin.json"), JSON.stringify({ ...manifest, dependencies: { "acme.core": "^1.0.0" } }));
    fs.files.delete(joinPath(ROOT, "scripts/useSpinner.ts"));
    const project = await openFolderProject(fs, ROOT);
    const result = await loadProjectCode(project);
    expect(result.problems).toEqual([{ path: "plugins/spinner/plugin.json", message: "acme.spinner needs the plugin acme.core, which isn't installed" }]);
    expect(result.loaded).toEqual([]);
    expect(isPluginActive("acme.spinner")).toBe(false);
  });
});
