// What the Inspector shows (ADR 0242): one thing at a time, whichever selection source came last.
// Every source goes through inspectorTarget.ts: the Hierarchy and viewport (nodes), the Assets
// panel (clicks, keys and the commands that select what they make), a UI element, the editor SDK,
// a live World while playing, and the scene settings when nothing is selected. (An asset drop selects
// the nodes it added with `select`; the drag itself is pointer-driven and covered end to end.)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { materialsEditorPlugin } from "../plugins/materials/editor";
import { navigationEditorPlugin } from "../plugins/navigation/editor";
import { particlesEditorPlugin } from "../plugins/particles/editor";
import { tilemapsEditorPlugin } from "../plugins/tilemaps/editor";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { runAsset } from "./assetActions";
import { assetClipboard } from "./assetOps";
import { lastAssetBrowser, resetAssetBrowser, selectedAssets } from "./assetSelection";
import { inspectorTarget, previewAssets, select, selectAssets, selectBone, selectUIElement, showAsset, showSceneSettings } from "./inspectorTarget";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { endLiveInspection, inspectWorld } from "./runtimeInspect";
import { editor } from "./sdk/editor";
import { currentProject, openScene, playState, sceneCamera, selectedKeys, selectedUIElement } from "./state";
import { ROOT, demoFolder, useCoreAssetKinds } from "./testing";
import { uiViewRefKey, type UIViewRef } from "./uiViews";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)
// Materials, shader graphs and particle effects have Inspector views through their plugins (ADR 0134).
useEditorPlugins([materialsEditorPlugin, particlesEditorPlugin, navigationEditorPlugin, tilemapsEditorPlugin], "each");

const INSPECTED = [
  "materials/sail.material.json",
  "shaders/water.shadergraph.json",
  "effects/rain.particles.json",
  "prefabs/ship.prefab.json",
  "images/flag.png",
  "audio/thunder.wav",
];
const HUD: UIViewRef = { host: "bird", index: 0, file: "ui/Hud.svelte", line: 1, column: 0, nth: 0 };

let project: EditorProject;

beforeEach(async () => {
  Input.reset();
  project = await openFolderProject(demoFolder(), ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

afterEach(() => {
  endLiveInspection();
  playState.value = "edit";
  showSceneSettings();
  resetAssetBrowser();
  assetClipboard.value = null;
});

const kind = () => inspectorTarget.value.kind;

/** The file the Inspector shows with `entry` alone selected in the Assets panel, or null. */
function shownFor(entry: string): string | null {
  selectAssets([entry]);
  const target = inspectorTarget.peek();
  selectAssets([]);
  return target.kind === "asset" ? target.path : null;
}

describe("which assets the Inspector can show", () => {
  it("every kind with its own view or import settings; a slice shows its image", () => {
    for (const path of INSPECTED) expect(shownFor(path), path).toBe(path);
    expect(shownFor("images/flag.png#wave")).toBe("images/flag.png");
    expect(shownFor("scenes/main.scene.json")).toBeNull();
    expect(shownFor("scripts/ship.ts")).toBeNull();
    expect(shownFor("materials/")).toBeNull();
  });
});

describe("the scene settings fallback", () => {
  it("shows the open scene's settings with nothing selected, and nothing with no scene open", () => {
    expect(inspectorTarget.value).toEqual({ kind: "sceneSettings", scene: openScene.value });
    const scene = openScene.value;
    openScene.value = null;
    expect(kind()).toBe("nothing");
    openScene.value = scene;
  });

  it("the Hierarchy's scene row clears every selection", () => {
    select(["bird"]);
    selectAssets(["scenes/main.scene.json"]); // can't be shown, so the node stays
    showSceneSettings();
    expect([selectedKeys.value, selectedAssets.value, selectedUIElement.value]).toEqual([[], [], null]);
    expect(kind()).toBe("sceneSettings");
  });
});

describe("nodes (the Hierarchy, the viewport, commands)", () => {
  it("shows the nodes that still exist, active last, and clears the assets and UI element", () => {
    selectAssets(["materials/sail.material.json"]);
    select(["bird", "ceiling"], "bird");
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [["ceiling"], ["bird"]] });
    expect(selectedAssets.value).toEqual([]);
    selectUIElement(HUD);
    select(["ceiling"]);
    expect(selectedUIElement.value).toBeNull();
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [["ceiling"]] });
  });

  it("drops nodes an undo removed, falling back to the scene settings", () => {
    select(["ghost"]);
    expect(kind()).toBe("sceneSettings");
    select(["ghost", "bird"]);
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [["bird"]] });
  });

  it("doesn't fall back to an asset when the nodes are deselected", () => {
    selectAssets(["materials/sail.material.json"]);
    select(["bird"]);
    select([]);
    expect(kind()).toBe("sceneSettings");
  });

  it("the editor SDK's selection goes through the same rule (ADR 0147)", () => {
    selectAssets(["images/PipeUp.png"]);
    expect(kind()).toBe("asset");
    editor.scene.selection.set(["bird"]);
    expect(selectedAssets.value).toEqual([]);
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [["bird"]] });
  });
});

describe("assets (the Assets panel)", () => {
  it("one asset with an Inspector view takes it from the nodes or a UI element, for every kind", () => {
    for (const path of INSPECTED) {
      select(["bird"]);
      selectAssets([path]);
      expect(selectedKeys.value, path).toEqual([]);
      expect(inspectorTarget.value, path).toEqual({ kind: "asset", path });
      selectUIElement(HUD);
      selectAssets([path]);
      expect(selectedUIElement.value, path).toBeNull();
      expect(kind(), path).toBe("asset");
    }
  });

  it("a box drag previews in the panel only, so Escape gives the nodes back", () => {
    select(["bird"]);
    const path = INSPECTED[0];
    previewAssets([path]); // the box covers one inspectable asset
    expect(selectedAssets.value).toEqual([path]);
    expect(selectedKeys.value).toEqual(["bird"]);
    previewAssets([]); // Escape: the selection the drag started from
    expect(kind()).toBe("nodes");
    previewAssets([path]);
    selectAssets(selectedAssets.peek()); // let go: the Inspector follows
    expect(inspectorTarget.value).toEqual({ kind: "asset", path });
  });

  it("a slice shows its image", () => {
    selectAssets(["images/PipeUp.png#a"]);
    expect(inspectorTarget.value).toEqual({ kind: "asset", path: "images/PipeUp.png" });
  });

  it("selections the Inspector can't show leave the nodes", () => {
    select(["bird"]);
    for (const entries of [["scenes/main.scene.json"], ["materials/sail.material.json", "materials/bolt.material.json"], ["images/"], []]) {
      selectAssets(entries);
      expect(selectedKeys.value, entries.join()).toEqual(["bird"]);
      expect(kind()).toBe("nodes");
    }
  });

  it("commands that select what they make show it, with no follow-up call (Duplicate)", async () => {
    select(["bird"]);
    expect(await runAsset("duplicate", { project, entries: ["prefabs/ground.prefab.json"] })).toBe(true);
    expect(selectedKeys.value).toEqual([]);
    expect(inspectorTarget.value).toMatchObject({ kind: "asset", path: expect.stringMatching(/^prefabs\/ground.*\.prefab\.json$/) });
  });

  it("Select Asset buttons and editor.project.reveal open the asset's folder and show it", () => {
    select(["bird"]);
    showAsset("effects/rain.particles.json");
    expect(lastAssetBrowser.value.folder.value).toBe("effects");
    expect(selectedAssets.value).toEqual(["effects/rain.particles.json"]);
    expect(inspectorTarget.value).toEqual({ kind: "asset", path: "effects/rain.particles.json" });
  });
});

describe("a UI element a view rendered", () => {
  it("shows the element and clears the nodes and the assets", () => {
    select(["bird"]);
    selectUIElement(HUD);
    expect(selectedKeys.value).toEqual([]);
    expect(selectedUIElement.value).toBe(uiViewRefKey(HUD));
    expect(inspectorTarget.value).toEqual({ kind: "uiViewElement", ref: HUD });
    selectAssets(["scenes/main.scene.json"]);
    selectUIElement(HUD);
    expect(selectedAssets.value).toEqual([]);
    selectUIElement(null);
    expect(kind()).toBe("sceneSettings");
  });
});

describe("a live World while playing", () => {
  it("wins while one is picked, and the scene's selection is there again after", () => {
    select(["bird"]);
    inspectWorld("Game");
    expect(kind()).toBe("nodes"); // not playing: the edited scene
    playState.value = "playing";
    expect(inspectorTarget.value).toEqual({ kind: "live", world: "Game", node: null });
    inspectWorld(null);
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [["bird"]] });
    inspectWorld("Game");
    endLiveInspection(); // Stop
    expect(kind()).toBe("nodes");
  });
});

describe("a bone of a Skeleton (ADR 0373)", () => {
  it("shows the bone and clears the other selections; any of them replaces it again", () => {
    const scene = openScene.value!;
    select(["bird"]);
    selectBone(scene, ["bird"], "Head", "test.bones");
    expect(selectedKeys.value).toEqual([]);
    expect(inspectorTarget.value).toEqual({ kind: "bone", scene, path: ["bird"], bone: "Head", provider: "test.bones" });
    select(["bird"]);
    expect(kind()).toBe("nodes");
    selectBone(scene, ["bird"], "Head", "test.bones");
    selectAssets([INSPECTED[0]]);
    expect(kind()).toBe("asset");
    selectBone(scene, ["bird"], "Head", "test.bones");
    expect(selectedAssets.value).toEqual([]);
    selectUIElement(HUD);
    expect(kind()).toBe("uiViewElement");
    selectBone(scene, ["bird"], "Head", "test.bones");
    showSceneSettings();
    expect(kind()).toBe("sceneSettings");
  });

  it("gives way to the scene settings once its node is gone", () => {
    selectBone(openScene.value!, ["nobody"], "Head", "test.bones");
    expect(kind()).toBe("sceneSettings");
  });
});
