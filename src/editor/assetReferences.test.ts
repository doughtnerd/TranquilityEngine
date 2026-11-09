// The asset reference module (ADR 0148): one rule for who uses an asset, what an asset depends
// on, and rewriting or removing references, over an in-memory project.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { meshesEditorPlugin } from "../plugins/meshes/editor";
import {
  assetDependencies,
  assetRefPath,
  assetUsers,
  hasOwnReferences,
  namesAsset,
  parseAssetRef,
  removeReferences,
  rewriteReferences,
  sceneWithoutAsset,
  settingsWithoutAsset,
  withMovedAssets,
  type ReferenceSource,
} from "./assetReferences";
import type { SceneFile } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, useProjectAssets, type EditorProject } from "./projects";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";
import { openScene, sceneCamera } from "./state";
import { closeTestProject, openTestProject, ROOT, useCoreAssetKinds, type MemoryFileSystem } from "./testing";

useCoreAssetKinds();

const json = (v: unknown) => JSON.stringify(v, null, 2);
const scene = (nodes: SceneFile["nodes"]): string => json({ format: "myco.scene@1", nodes });

/** A small project: prefabs and a scene naming images, slices and prefabs in every spelling, a material, settings and scripts. */
const FILES: Record<string, string | Uint8Array> = {
  "project.json": json({ name: "t", autoload: ["prefabs/music.prefab.json"] }),
  "images/sheet.png": new Uint8Array([1]),
  "images/bird.png": new Uint8Array([2]),
  "images/bird.png.bak": new Uint8Array([3]),
  "prefabs/music.prefab.json": scene([{ id: "m", components: [{ type: "engine.Transform" }] }]),
  "prefabs/crate.prefab.json": scene([{ id: "c", components: [{ type: "engine.SpriteRenderer", data: { sprite: "./images/bird.png" } }] }]),
  "prefabs/walker.prefab.json": scene([{ id: "w", components: [{ type: "engine.SpriteRenderer", data: { sprite: "asset:images/sheet.png#walk" } }] }]),
  "prefabs/decoy.prefab.json": scene([{ id: "d", name: "images/bird.png.bak", components: [{ type: "engine.Transform" }] }]),
  "materials/wood.material.json": json({ texture: "asset:images/bird.png" }),
  "scenes/main.scene.json": scene([
    { id: "crate", prefab: "prefabs/crate.prefab.json" },
    { id: "hero", components: [{ type: "engine.Transform" }, { type: "engine.SpriteRenderer", data: { sprite: "asset:images/sheet.png#walk_0" } }] },
  ]),
  "scripts/Spawner.ts": `export const crate = 'prefabs/crate.prefab.json';\n`,
  "scripts/Walker.ts": "export const frame = `asset:images/sheet.png#walk`;\n",
};

let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path)) as string;
const source = (files: Record<string, string | Uint8Array>): ReferenceSource => ({ files: Object.keys(files), text: (p) => (typeof files[p] === "string" ? files[p] : undefined) });

async function open(withScene = false) {
  ({ fs, project } = await openTestProject(FILES));
  if (!withScene) return;
  Input.reset();
  useProjectAssets(project);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
}

afterEach(() => {
  openScene.value?.sync.dispose();
  openScene.value = null;
  closeTestProject();
});

describe("reference strings", () => {
  it("split into prefix, path and slice; the path drops asset:, ./ and #slice", () => {
    expect(parseAssetRef("asset:./images/a.png#walk")).toEqual({ prefix: "asset:./", path: "images/a.png", slice: "walk" });
    expect(parseAssetRef("images/a.png")).toEqual({ prefix: "", path: "images/a.png", slice: null });
    for (const ref of ["asset:images/a.png", "./images/a.png", "/images/a.png", "images/a.png#x"]) expect(assetRefPath(ref), ref).toBe("images/a.png");
  });

  it("name a file, its slices, or just one slice", () => {
    expect(namesAsset("asset:images/a.png#walk", "images/a.png")).toBe(true);
    expect(namesAsset("./images/a.png", "images/a.png")).toBe(true);
    expect(namesAsset("images/a.png.bak", "images/a.png")).toBe(false);
    expect(namesAsset("asset:images/a.png#walk", "images/a.png#walk")).toBe(true);
    expect(namesAsset("asset:images/a.png#walk_0", "images/a.png#walk")).toBe(false);
    expect(namesAsset(3, "images/a.png")).toBe(false);
  });
});

describe("who uses an asset", () => {
  it("finds JSON files and scripts quoting it in any spelling (quotes, asset:, ./, #slice), not longer names", async () => {
    await open();
    expect(assetUsers(project, "images/bird.png")).toEqual(["materials/wood.material.json", "prefabs/crate.prefab.json"]);
    expect(assetUsers(project, "images/sheet.png")).toEqual(["prefabs/walker.prefab.json", "scenes/main.scene.json", "scripts/Walker.ts"]);
    expect(assetUsers(project, "prefabs/crate.prefab.json")).toEqual(["scenes/main.scene.json", "scripts/Spawner.ts"]);
    expect(assetUsers(project, "prefabs/music.prefab.json")).toEqual(["project.json"]);
  });

  it("narrows to one slice, and widens to what is inside a folder", async () => {
    await open();
    expect(assetUsers(project, "images/sheet.png#walk")).toEqual(["prefabs/walker.prefab.json", "scripts/Walker.ts"]);
    expect(assetUsers(project, "images")).toContain("materials/wood.material.json");
  });

  it("includes the open scene's unsaved document", async () => {
    await open();
    expect(assetUsers(project, "images/gone.png", { path: "scenes/main.scene.json", text: '{"x":"asset:images/gone.png"}' })).toEqual(["scenes/main.scene.json (unsaved edits)"]);
  });
});

describe("what an asset depends on", () => {
  it("is every JSON reference string to a project file, once each, slices as their image", () => {
    const files = { "a.prefab.json": json({ x: "asset:./images/s.png#walk", y: ["images/s.png", "materials/m.material.json", "hello"] }), "images/s.png": new Uint8Array(), "materials/m.material.json": "{}" };
    expect(assetDependencies(source(files), "a.prefab.json")).toEqual(["images/s.png", "materials/m.material.json"]);
    expect(assetDependencies(source({ "broken.json": "{" }), "broken.json")).toEqual([]);
  });

  describe("with model formats from the Meshes plugin's kinds", () => {
    const files = {
      "models/crate.obj": "mtllib crate.mtl\nv 0 0 0\n",
      "models/crate.mtl": "newmtl a\nmap_Kd -bm 1 tex/crate.png\nbump ./tex/n.png\n",
      "models/tex/crate.png": new Uint8Array(),
      "models/tex/n.png": new Uint8Array(),
      "models/car.gltf": json({ buffers: [{ uri: "car.bin" }, { uri: "data:application/octet-stream;base64,AA==" }], images: [{ uri: "./tex/paint%20red.png" }, { uri: "missing.png" }] }),
      "models/car.bin": new Uint8Array(),
      "models/tex/paint red.png": new Uint8Array(),
    };

    it("knows no model format without the plugin", () => {
      expect(assetDependencies(source(files), "models/crate.obj")).toEqual([]);
      expect(hasOwnReferences("models/crate.obj")).toBe(false);
    });

    describe("enabled", () => {
      beforeAll(() => activatePlugins([meshesEditorPlugin]));
      afterAll(() => deactivatePlugin(meshesEditorPlugin.manifest.name));

      it("reads an .obj's material libraries, an .mtl's maps and a .gltf's buffers and images", () => {
        expect(assetDependencies(source(files), "models/crate.obj")).toEqual(["models/crate.mtl"]);
        expect(assetDependencies(source(files), "models/crate.mtl")).toEqual(["models/tex/crate.png", "models/tex/n.png"]);
        expect(assetDependencies(source(files), "models/car.gltf")).toEqual(["models/car.bin", "models/tex/paint red.png"]);
      });

      it("never reads binary models as text", () => {
        expect(["models/crate.obj", "models/crate.mtl", "models/car.gltf"].every(hasOwnReferences)).toBe(true);
        expect(hasOwnReferences("models/car.glb")).toBe(false);
        expect(hasOwnReferences("models/robot.fbx")).toBe(false);
      });
    });
  });
});

describe("rewriting references for moves", () => {
  it("keeps prefixes and slices, and offers a slice whole before its image", () => {
    const rename = (p: string) => (p === "images/a.png" ? "art/a.png" : p === "art/b.png#x" ? "art/b.png#y" : null);
    expect(withMovedAssets({ a: "asset:./images/a.png#walk", b: ["./images/a.png"], c: "art/b.png#x", d: "images/a.png.bak" }, rename)).toEqual({
      value: { a: "asset:./art/a.png#walk", b: ["./art/a.png"], c: "art/b.png#y", d: "images/a.png.bak" },
      changed: true,
    });
  });

  it("updates every JSON user on disk (./ spelling, slices, materials, settings) and lists the scripts", async () => {
    await open();
    await project.move("images", "art");
    await project.move("prefabs/music.prefab.json", "audio.prefab.json");
    const { updated, scriptUsers } = await rewriteReferences(project, [["images", "art"], ["prefabs/music.prefab.json", "audio.prefab.json"]], "Move");
    expect(updated.sort()).toEqual(["materials/wood.material.json", "prefabs/crate.prefab.json", "prefabs/decoy.prefab.json", "prefabs/walker.prefab.json", "project.json", "scenes/main.scene.json"]);
    expect(onDisk("prefabs/crate.prefab.json")).toContain('"./art/bird.png"');
    expect(onDisk("prefabs/walker.prefab.json")).toContain('"asset:art/sheet.png#walk"');
    expect(onDisk("scenes/main.scene.json")).toContain('"asset:art/sheet.png#walk_0"');
    expect(onDisk("materials/wood.material.json")).toContain('"asset:art/bird.png"');
    expect(JSON.parse(onDisk("project.json")).autoload).toEqual(["audio.prefab.json"]);
    expect(onDisk("prefabs/decoy.prefab.json")).toContain('"art/bird.png.bak"'); // in the moved folder too
    expect(scriptUsers).toEqual(["scripts/Walker.ts"]); // quoted in back quotes, kept as written
    expect(onDisk("scripts/Walker.ts")).toContain("asset:images/sheet.png#walk");
  });

  it("renames one slice only, and finds single-quoted script users", async () => {
    await open();
    const { updated, scriptUsers } = await rewriteReferences(project, [["images/sheet.png#walk", "images/sheet.png#run"]], "Rename slice");
    expect(updated).toEqual(["prefabs/walker.prefab.json"]);
    expect(onDisk("prefabs/walker.prefab.json")).toContain('"asset:images/sheet.png#run"');
    expect(onDisk("scenes/main.scene.json")).toContain("#walk_0"); // another slice
    expect(scriptUsers).toEqual(["scripts/Walker.ts"]);
    await project.move("prefabs/crate.prefab.json", "prefabs/box.prefab.json");
    expect((await rewriteReferences(project, [["prefabs/crate.prefab.json", "prefabs/box.prefab.json"]], "Rename")).scriptUsers).toEqual(["scripts/Spawner.ts"]);
  });

  it("edits the open scene as one undo step instead of its file, and rebuilds instances of a changed prefab", async () => {
    await open(true);
    const { doc, stack } = openScene.value!;
    await project.move("prefabs/crate.prefab.json", "prefabs/box.prefab.json");
    await project.move("images/bird.png", "images/robin.png");
    const { updated } = await rewriteReferences(project, [["prefabs/crate.prefab.json", "prefabs/box.prefab.json"], ["images/bird.png", "images/robin.png"]], "Update references");
    expect([...updated].sort()).toEqual(["materials/wood.material.json", "prefabs/box.prefab.json", "scenes/main.scene.json (unsaved)"]);
    expect(doc.node("crate").prefab).toBe("prefabs/box.prefab.json");
    expect(stack.undoLabel).toBe("Update references");
    expect(onDisk("scenes/main.scene.json")).toContain('"prefabs/crate.prefab.json"'); // saving writes it
    stack.undo();
    expect(doc.node("crate").prefab).toBe("prefabs/crate.prefab.json");
  });
});

describe("removing references to a deleted asset", () => {
  it("cleans scenes, prefabs and settings on disk; other JSON and scripts keep theirs", async () => {
    await open();
    expect(await removeReferences(project, "images/bird.png", "Remove")).toEqual(["prefabs/crate.prefab.json"]);
    expect(JSON.parse(onDisk("prefabs/crate.prefab.json")).nodes[0].components[0].data).toEqual({});
    expect(onDisk("materials/wood.material.json")).toContain("images/bird.png");
    expect(assetUsers(project, "images/bird.png")).toEqual(["materials/wood.material.json"]);
    expect(await removeReferences(project, "prefabs/music.prefab.json", "Remove")).toEqual(["project.json"]);
    expect(JSON.parse(onDisk("project.json")).autoload).toEqual([]);
  });

  it("removes a slice's references only, and a prefab's instances from the open scene as one undo step", async () => {
    await open(true);
    expect(await removeReferences(project, "images/sheet.png#walk", "Remove")).toEqual(["prefabs/walker.prefab.json"]);
    const { doc, stack } = openScene.value!;
    expect(await removeReferences(project, "prefabs/crate.prefab.json", "Remove references to crate.prefab.json")).toEqual(["scenes/main.scene.json (unsaved)"]);
    expect(doc.has("crate")).toBe(false);
    expect(stack.undoLabel).toBe("Remove references to crate.prefab.json");
  });
});

describe("cleaning a parsed file of a deleted asset", () => {
  const file: SceneFile = {
    format: "myco.scene@1",
    nodes: [
      { id: "pipe", prefab: "prefabs/pipe.prefab.json", overrides: [{ component: "engine.Transform", field: "position", value: [1, 2, 0] }] },
      { id: "label", parent: "pipe", components: [{ type: "engine.Transform" }] }, // a child of the instance
      {
        id: "spawner",
        components: [
          { type: "engine.Transform" },
          { type: "game.Spawner", data: { prefab: "prefabs/pipe.prefab.json", target: { $node: "label" }, keep: { $node: "bird" }, list: ["prefabs/pipe.prefab.json", "prefabs/other.prefab.json"] } },
        ],
      },
      { id: "bird", components: [{ type: "engine.SpriteRenderer", data: { sprite: "asset:images/bird.png", color: "#ffffff" } }] },
      {
        id: "bg",
        prefab: "prefabs/bg.prefab.json",
        overrides: [
          { component: "engine.SpriteRenderer", field: "sprite", value: "asset:images/bird.png" },
          { component: "engine.SpriteRenderer", field: "orderInLayer", value: 2 },
          { addComponent: { type: "engine.SpriteRenderer", data: { sprite: "asset:images/bird.png" } } },
        ],
      },
    ],
  };

  it("removes a prefab's instances with their children, and sets references to them to None", () => {
    const result = sceneWithoutAsset(file, "prefabs/pipe.prefab.json");
    expect(result.changed).toBe(true);
    expect(result.removedNodes.sort()).toEqual(["label", "pipe"]);
    expect(result.file.nodes.map((n) => n.id)).toEqual(["spawner", "bird", "bg"]);
    expect(result.file.nodes[0].components![1].data).toEqual({ target: null, keep: { $node: "bird" }, list: ["prefabs/other.prefab.json"] }); // the field naming it goes back to its default
    expect(file.nodes).toHaveLength(5); // the input isn't touched
  });

  it("drops fields and overrides naming an image, in components and added components", () => {
    const result = sceneWithoutAsset(file, "images/bird.png");
    expect(result.changed).toBe(true);
    expect(result.removedNodes).toEqual([]);
    expect(result.file.nodes.find((n) => n.id === "bird")!.components![0].data).toEqual({ color: "#ffffff" });
    expect(result.file.nodes.find((n) => n.id === "bg")!.overrides).toEqual([
      { component: "engine.SpriteRenderer", field: "orderInLayer", value: 2 },
      { addComponent: { type: "engine.SpriteRenderer", data: {} } },
    ]);
  });

  it("changes nothing when nothing names it", () => {
    const result = sceneWithoutAsset(file, "images/other.png");
    expect(result.changed).toBe(false);
    expect(result.file.nodes).toEqual(file.nodes);
  });

  it("drops autoloads from the project settings", () => {
    expect(settingsWithoutAsset({ name: "x", autoload: ["prefabs/music.prefab.json", "prefabs/ui.prefab.json"] }, "prefabs/music.prefab.json")).toEqual({
      settings: { name: "x", autoload: ["prefabs/ui.prefab.json"] },
      changed: true,
    });
    expect(settingsWithoutAsset({ name: "x" }, "prefabs/music.prefab.json").changed).toBe(false);
  });
});
