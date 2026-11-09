import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetKind, buildFolderTree, findFolder, opensInCodePanel, searchEntries, searchFiles } from "./assetBrowser";
import { navigationEditorPlugin } from "../plugins/navigation/editor";
import { particlesEditorPlugin } from "../plugins/particles/editor";
import { tilemapsEditorPlugin } from "../plugins/tilemaps/editor";
import { environmentEditorPlugin } from "../plugins/environment/editor";
import { meshesEditorPlugin } from "../plugins/meshes/editor";
import { uiEditorPlugin } from "../plugins/ui/editor";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";
import { sampleProject, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const demo = sampleProject();

const PLUGINS = [particlesEditorPlugin, navigationEditorPlugin, tilemapsEditorPlugin, meshesEditorPlugin, environmentEditorPlugin, uiEditorPlugin];
beforeAll(() => activatePlugins(PLUGINS));
afterAll(() => PLUGINS.forEach((p) => deactivatePlugin(p.manifest.name)));


describe("asset browser: folders and search", () => {
  it("builds a sorted folder tree from project paths", () => {
    const tree = buildFolderTree(["images/b.png", "project.json", "images/a.png", "scenes/main.scene.json", "images/ui/icon.png"]);
    expect(tree.files).toEqual(["project.json"]);
    expect(tree.folders.map((f) => f.name)).toEqual(["images", "scenes"]);
    const images = findFolder(tree, "images")!;
    expect(images.files).toEqual(["images/a.png", "images/b.png"]);
    expect(findFolder(tree, "images/ui")!.files).toEqual(["images/ui/icon.png"]);
    expect(findFolder(tree, "missing")).toBeNull();
    expect(findFolder(tree, "")).toBe(tree);
  });

  it("has the demo's folders", () => {
    const tree = buildFolderTree(demo.files);
    expect(tree.folders.map((f) => f.name)).toEqual(expect.arrayContaining(["images", "music", "prefabs", "scenes"]));
  });

  it("searches file names across folders, every word must match", () => {
    expect(searchFiles(demo.files, "pipe").sort()).toEqual(["images/PipeDown.png", "images/PipeUp.png", "prefabs/pipe-pair.prefab.json"]);
    expect(searchFiles(demo.files, "pipe prefab")).toEqual(["prefabs/pipe-pair.prefab.json"]);
    expect(searchFiles(demo.files, "PIPEUP")).toEqual(["images/PipeUp.png"]);
    expect(searchFiles(demo.files, "  ")).toEqual([]);
  });

  it("knows asset kinds", () => {
    expect(assetKind("scenes/main.scene.json")).toBe("scene");
    expect(assetKind("prefabs/pipe-pair.prefab.json")).toBe("prefab");
    expect(assetKind("fx/a.particlesubgraph.json")).toBe("particlesubgraph");
    expect(assetKind("fx/a.particleblock.json")).toBe("particleblock");
    expect(assetKind("fx/a.particles.json")).toBe("particles");
    expect(assetKind("images/bird.PNG")).toBe("image");
    expect(assetKind("music/town.mp3")).toBe("audio");
    expect(assetKind("ui/menu.ui.xml")).toBe("uidocument");
    expect(assetKind("ui/menu.ui.css")).toBe("stylesheet");
    expect(opensInCodePanel(assetKind("ui/menu.ui.xml"))).toBe(true);
    expect(opensInCodePanel(assetKind("ui/menu.ui.css"))).toBe(true);
    expect(assetKind("project.json")).toBe("json");
  });

  it("knows cubemaps and cube environments, none of which open in the Code panel (skies: the Sky plugin, src/plugins/sky)", () => {
    expect(assetKind("skies/box.cubemap.json")).toBe("cubemap");
    for (const p of ["env/studio.hdr", "env/studio.exr", "env/room.env", "env/room.DDS"]) expect(assetKind(p), p).toBe("environment");
    for (const k of ["cubemap", "environment"] as const) expect(opensInCodePanel(k), k).toBe(false);
    expect(opensInCodePanel("json")).toBe(true);
  });
});

describe("searching slices (ADR 0115)", () => {
  const slices: Record<string, string[]> = { "images/hero.png": ["hero_walk_0", "hero_walk_1", "hero_jump"], "images/tiles.png": ["grass", "walk_path"] };
  const files = ["images/hero.png", "images/tiles.png", "sounds/walk.mp3"];
  const names = (image: string) => slices[image] ?? [];

  it("finds slices by name beside matching files", () => {
    expect(searchEntries(files, "walk", names)).toEqual(["images/hero.png#hero_walk_0", "images/hero.png#hero_walk_1", "images/tiles.png#walk_path", "sounds/walk.mp3"]);
  });

  it("needs every word and ignores case", () => {
    expect(searchEntries(files, "HERO jump", names)).toEqual(["images/hero.png#hero_jump"]);
    expect(searchEntries(files, "hero", names)).toEqual(["images/hero.png#hero_jump", "images/hero.png#hero_walk_0", "images/hero.png#hero_walk_1", "images/hero.png"]);
    expect(searchEntries(files, "  ", names)).toEqual([]);
  });
});
