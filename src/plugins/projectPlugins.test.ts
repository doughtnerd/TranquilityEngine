// Per-project plugin enabling (ADR 0133): disabling Sky unregisters its Component and asset kind, scenes
// show its entries as missing (data kept), and enabling restores them; the settings validate.
import { afterEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { pluginSettingsProblems, resolveSettings } from "../engine/core/settings";
import { assetKind } from "../editor/assetBrowser";
import { disabledPluginOf, missingBadge } from "../editor/componentEdits";
import type { SceneFile } from "../editor/document";
import { OrbitCamera } from "../editor/OrbitCamera";
import { openSceneFile } from "../editor/project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets } from "../editor/projects";
import { disabledPluginsOf, setDisabledPlugins, settingsProblems, settingsWarnings } from "../editor/projectSettingsModel";
import { currentProject, openScene, sceneCamera } from "../editor/state";
import { MemoryFileSystem, ROOT, demoFolder } from "../editor/testing";
import { applyEditorPlugins, pluginManifests } from "./editorPlugins";
import "./editorBoot";

afterEach(() => void applyEditorPlugins(undefined));

describe("the plugins setting", () => {
  it("validates: malformed values are problems, unknown names only warnings", () => {
    expect(pluginSettingsProblems(undefined)).toEqual({ problems: [], warnings: [] });
    expect(pluginSettingsProblems({ disabled: ["myco.sky"] }, ["myco.sky"])).toEqual({ problems: [], warnings: [] });
    expect(pluginSettingsProblems(5).problems).toHaveLength(1);
    expect(pluginSettingsProblems({ disabled: "myco.sky" }).problems).toHaveLength(1);
    expect(pluginSettingsProblems({ disabled: ["a", "a"] }).problems).toHaveLength(1);
    expect(pluginSettingsProblems({ extra: 1 }).problems).toHaveLength(1);
    const unknown = pluginSettingsProblems({ disabled: ["nope"] }, ["myco.sky"]);
    expect(unknown.problems).toEqual([]);
    expect(unknown.warnings).toHaveLength(1);
  });

  it("flows through resolveSettings and the panel's model", () => {
    expect(resolveSettings({ plugins: { disabled: ["myco.sky"] } }).plugins).toEqual({ disabled: ["myco.sky"] });
    expect(resolveSettings({}).plugins).toBeUndefined();
    let d = setDisabledPlugins({}, ["myco.sky"]);
    expect(disabledPluginsOf(d)).toEqual(["myco.sky"]);
    expect(settingsProblems(d)).toEqual([]);
    expect(settingsWarnings(d, ["myco.sky"])).toEqual([]);
    expect(settingsWarnings(setDisabledPlugins({}, ["gone"]), ["myco.sky"]).join()).toContain("gone");
    d = setDisabledPlugins(d, []);
    expect(d.plugins).toBeUndefined();
  });

  it("every first-party manifest has a title and a description", () => {
    for (const m of pluginManifests().filter((x) => ["myco.sky", "myco.materials", "myco.physics", "myco.physics-rapier", "myco.navigation"].includes(x.name))) {
      expect(m.title, m.name).toBeTruthy();
      expect(m.description, m.name).toBeTruthy();
    }
  });
});

describe("disabling a plugin in the editor", () => {
  it("makes its asset kind generic and its Component missing, and enabling restores both", async () => {
    Input.reset();
    const fs: MemoryFileSystem = demoFolder();
    const scenePath = joinPath(ROOT, "scenes/main.scene.json");
    const scene = JSON.parse(fs.files.get(scenePath) as string) as SceneFile;
    scene.nodes.push({ id: "sky", name: "Sky", components: [{ type: "engine.Transform" }, { type: "engine.Sky", data: {} }] });
    fs.files.set(scenePath, JSON.stringify(scene));
    const project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    currentProject.value = project;
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, project.mainScene!);
    const missing = () => openScene.value!.sync.missingComponents(["sky"]).map((c) => c.type);

    expect(assetKind("a.sky.json")).toBe("sky");
    expect(getComponentClass("engine.Sky")).toBeDefined();
    expect(missing()).toEqual([]);
    expect(disabledPluginOf("engine.Sky")).toBeNull();

    expect(applyEditorPlugins(["myco.sky"], { layout: "live" }).problems).toEqual([]);
    openScene.value!.sync.build();
    expect(assetKind("a.sky.json")).not.toBe("sky");
    expect(getComponentClass("engine.Sky")).toBeUndefined();
    expect(missing()).toEqual(["engine.Sky"]);
    expect(disabledPluginOf("engine.Sky")).toBe("Sky");
    expect(missingBadge("engine.Sky")).toBe("missing (plugin Sky is disabled)");
    expect(missingBadge("game.Gone")).toBe("missing script");
    expect(openScene.value!.doc.node("sky").components!.map((c) => c.type)).toContain("engine.Sky"); // data kept

    applyEditorPlugins(undefined, { layout: "live" });
    openScene.value!.sync.build();
    expect(assetKind("a.sky.json")).toBe("sky");
    expect(getComponentClass("engine.Sky")).toBeDefined();
    expect(missing()).toEqual([]);
    engine.dispose();
    currentProject.value = null;
  });
});
