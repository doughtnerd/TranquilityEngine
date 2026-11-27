// The asset reference module (ADR 0148): one rule for who uses an asset, what an asset depends
// on, and rewriting or removing references, over an in-memory project.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { meshesEditorPlugin } from "../plugins/meshes/editor";
import { assetDependencies, assetUsers, hasOwnReferences, removeReferences, rewriteReferences, type ReferenceSource } from "./assetReferences";
import { assetRefPath, namesAsset, parseAssetRef, sceneWithoutAsset, settingsWithoutAsset, withMovedAssets } from "./assetRefValues";
import type { SceneFile } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, useProjectAssets, type EditorProject } from "./projects";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";
import { openAssetDocument, type AssetDocument } from "./assetDocuments";
import { deleteAssets } from "./assetDelete";
import { moveAssets } from "./assetOps";
import { askBeforeDeletingAssets } from "./preferences";
import { openScene, sceneCamera, status } from "./state";
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
    expect(await assetUsers(project, "images/bird.png")).toEqual(["materials/wood.material.json", "prefabs/crate.prefab.json"]);
    expect(await assetUsers(project, "images/sheet.png")).toEqual(["prefabs/walker.prefab.json", "scenes/main.scene.json", "scripts/Walker.ts"]);
    expect(await assetUsers(project, "prefabs/crate.prefab.json")).toEqual(["scenes/main.scene.json", "scripts/Spawner.ts"]);
    expect(await assetUsers(project, "prefabs/music.prefab.json")).toEqual(["project.json"]);
  });

  it("narrows to one slice, and widens to what is inside a folder", async () => {
    await open();
    expect(await assetUsers(project, "images/sheet.png#walk")).toEqual(["prefabs/walker.prefab.json", "scripts/Walker.ts"]);
    expect(await assetUsers(project, "images")).toContain("materials/wood.material.json");
  });

  it("includes the open scene's unsaved document", async () => {
    await open();
    expect(await assetUsers(project, "images/gone.png", { path: "scenes/main.scene.json", text: '{"x":"asset:images/gone.png"}' })).toEqual(["scenes/main.scene.json (unsaved edits)"]);
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
    const { updated, notRewritten: scriptUsers } = await rewriteReferences(project, [["images", "art"], ["prefabs/music.prefab.json", "audio.prefab.json"]], "Move");
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

  it("leaves strings that merely equal a moved folder's path in scenes, prefabs and settings, but follows its references and plain JSON's folder paths", async () => {
    ({ fs, project } = await openTestProject({
      ...FILES,
      "project.json": json({ name: "t", worlds: ["images"], tags: ["images"] }),
      "scenes/named.scene.json": scene([
        { id: "images", name: "images", components: [{ type: "engine.Transform" }, { type: "game.Folder", data: { tag: "images", dir: "asset:images", inside: "images/bird.png" } }] },
        { id: "other", parent: "images", components: [{ type: "engine.Transform" }] },
      ]),
      "audio/packages.json": json({ include: ["images", "images/**"] }),
    }));
    await project.move("images", "art");
    await rewriteReferences(project, [["images", "art"]], "Move");
    const named = JSON.parse(onDisk("scenes/named.scene.json"));
    expect(named.nodes[0].id).toBe("images");
    expect(named.nodes[0].name).toBe("images");
    expect(named.nodes[1].parent).toBe("images");
    expect(named.nodes[0].components[1].data).toEqual({ tag: "images", dir: "asset:art", inside: "art/bird.png" });
    expect(JSON.parse(onDisk("project.json"))).toEqual({ name: "t", worlds: ["images"], tags: ["images"] });
    expect(JSON.parse(onDisk("audio/packages.json"))).toEqual({ include: ["art", "art/**"] });
  });

  it("renames one slice only, and finds single-quoted script users", async () => {
    await open();
    const { updated, notRewritten: scriptUsers } = await rewriteReferences(project, [["images/sheet.png#walk", "images/sheet.png#run"]], "Rename slice");
    expect(updated).toEqual(["prefabs/walker.prefab.json"]);
    expect(onDisk("prefabs/walker.prefab.json")).toContain('"asset:images/sheet.png#run"');
    expect(onDisk("scenes/main.scene.json")).toContain("#walk_0"); // another slice
    expect(scriptUsers).toEqual(["scripts/Walker.ts"]);
    await project.move("prefabs/crate.prefab.json", "prefabs/box.prefab.json");
    expect((await rewriteReferences(project, [["prefabs/crate.prefab.json", "prefabs/box.prefab.json"]], "Rename")).notRewritten).toEqual(["scripts/Spawner.ts"]);
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
    expect(await assetUsers(project, "images/bird.png")).toEqual(["materials/wood.material.json"]);
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

  it("removes instances of a prefab that a prefab instance adds, with their added children", () => {
    const outer: SceneFile = {
      format: "myco.scene@4",
      nodes: [
        {
          id: "level",
          prefab: "prefabs/level.prefab.json",
          overrides: [{ addNodes: [{ id: "p", prefab: "prefabs/pipe.prefab.json" }, { id: "under", parent: "p" }, { id: "kept", components: [{ type: "engine.SpriteRenderer", data: { sprite: "asset:images/bird.png" } }] }] }],
        },
      ],
    };
    const result = sceneWithoutAsset(outer, "prefabs/pipe.prefab.json");
    expect(result.changed).toBe(true);
    expect(result.removedNodes).toEqual([]); // only the file's own nodes are listed
    expect(result.file.nodes[0].overrides![0].addNodes!.map((n) => n.id)).toEqual(["kept"]);
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

  it("drops a deleted action set file from input.actionSets (ADR 0433)", () => {
    expect(settingsWithoutAsset({ input: { join: "single", actionSets: ["input/a.actions.json", "input/b.actions.json"] } }, "input/a.actions.json")).toEqual({
      settings: { input: { join: "single", actionSets: ["input/b.actions.json"] } },
      changed: true,
    });
  });
});

// ADR 0302: a project-wide edit asks each file's owner to apply it, and users come from the same readers as dependencies.
describe("project-wide edits through each file's owner (ADR 0302)", () => {
  interface Cue {
    clip: string;
    gain: number;
  }
  const CUE = "audio/hit.cue.json";
  /** The cue format's layout: clip first, two-space indent. */
  const cueText = (cue: Cue) => `${JSON.stringify({ clip: cue.clip, gain: cue.gain }, null, 2)}\n`;
  let unregister: () => void;
  const opened: AssetDocument<Cue>[] = [];
  const openCue = (path = CUE) => {
    const doc = openAssetDocument<Cue>(project, path, "cue");
    opened.push(doc);
    return doc;
  };

  beforeAll(() => {
    unregister = assetKinds.register(<AssetKindContribution<Cue>>{
      id: "cue",
      extensions: [".cue.json"],
      label: "Cue",
      icon: "",
      format: {
        parse: (raw) => {
          const r = (raw ?? {}) as Partial<Cue>;
          return { value: { clip: typeof r.clip === "string" ? r.clip : "", gain: typeof r.gain === "number" ? r.gain : 1 }, problems: [] };
        },
        format: cueText,
        empty: () => ({ clip: "", gain: 1 }),
        writeDelay: 50,
      },
    });
  });
  afterAll(() => unregister());
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((d) => d.flush()));
  });

  async function openCues(files: Record<string, string | Uint8Array> = {}) {
    ({ fs, project } = await openTestProject({
      "audio/hit.wav": new Uint8Array([1]),
      [CUE]: cueText({ clip: "audio/hit.wav", gain: 1 }),
      ...files,
    }));
  }

  it("Undo after a rename keeps the new path in an open asset document", async () => {
    await openCues();
    const doc = openCue();
    doc.edit({ clip: "audio/hit.wav", gain: 0.5 }, { label: "Gain" });
    await doc.flush();
    await project.move("audio/hit.wav", "audio/punch.wav");
    const { updated } = await rewriteReferences(project, [["audio/hit.wav", "audio/punch.wav"]], "Update references to punch.wav");
    expect(updated).toEqual([CUE]);
    expect(doc.value.value).toEqual({ clip: "audio/punch.wav", gain: 0.5 });
    expect(doc.undoLabel.value).toBe("Gain"); // the rename isn't a step to undo: the history follows it
    doc.undo();
    expect(doc.value.value).toEqual({ clip: "audio/punch.wav", gain: 1 });
    await doc.flush();
    expect(onDisk(CUE)).toBe(cueText({ clip: "audio/punch.wav", gain: 1 }));
    doc.redo();
    expect(doc.value.value).toEqual({ clip: "audio/punch.wav", gain: 0.5 });
  });

  it("renaming the clip in the Assets panel (moveAssets) leaves no old path in the open document's history", async () => {
    await openCues();
    const doc = openCue();
    doc.edit({ clip: "audio/hit.wav", gain: 0.5 }, { label: "Gain" });
    expect(await moveAssets([["audio/hit.wav", "audio/punch.wav"]], "Renamed")).toBe(true);
    expect(doc.value.value).toEqual({ clip: "audio/punch.wav", gain: 0.5 });
    doc.undo();
    expect(doc.value.value).toEqual({ clip: "audio/punch.wav", gain: 1 });
    await doc.flush();
    expect(onDisk(CUE)).toBe(cueText({ clip: "audio/punch.wav", gain: 1 }));
  });

  it("lists an open document's unwritten reference as a user, and rewrites it", async () => {
    await openCues({ "audio/other.wav": new Uint8Array([2]) });
    const doc = openCue();
    doc.edit({ clip: "audio/other.wav", gain: 1 }, { coalesce: true }); // not written yet
    await project.move("audio/other.wav", "audio/thud.wav");
    expect((await rewriteReferences(project, [["audio/other.wav", "audio/thud.wav"]], "Move")).updated).toEqual([CUE]);
    expect(doc.value.value.clip).toBe("audio/thud.wav");
  });

  it("a rename during a pending coalesced edit isn't overwritten when the edit is written", async () => {
    await openCues();
    const doc = openCue();
    doc.edit({ clip: "audio/hit.wav", gain: 0.2 }, { coalesce: true });
    await project.move("audio/hit.wav", "audio/punch.wav");
    await rewriteReferences(project, [["audio/hit.wav", "audio/punch.wav"]], "Update references");
    await doc.flush();
    expect(doc.value.value).toEqual({ clip: "audio/punch.wav", gain: 0.2 });
    expect(onDisk(CUE)).toBe(cueText({ clip: "audio/punch.wav", gain: 0.2 }));
    doc.undo();
    expect(doc.value.value).toEqual({ clip: "audio/punch.wav", gain: 1 });
  });

  it("writes a closed asset file through its kind's format, unless the format would lose something it holds", async () => {
    await openCues({
      "audio/a.cue.json": '{"gain":1,"clip":"audio/hit.wav"}',
      "audio/b.cue.json": '{"clip":"audio/hit.wav","gain":1,"note":"kept"}',
    });
    await project.move("audio/hit.wav", "audio/punch.wav");
    const { updated } = await rewriteReferences(project, [["audio/hit.wav", "audio/punch.wav"]], "Move");
    expect(updated.sort()).toEqual(["audio/a.cue.json", "audio/b.cue.json", CUE]);
    expect(onDisk("audio/a.cue.json")).toBe(cueText({ clip: "audio/punch.wav", gain: 1 })); // canonical layout
    expect(JSON.parse(onDisk("audio/b.cue.json"))).toEqual({ clip: "audio/punch.wav", gain: 1, note: "kept" }); // the format drops "note"
  });

  describe("with the Meshes plugin's reference readers", () => {
    beforeAll(() => activatePlugins([meshesEditorPlugin]));
    afterAll(() => deactivatePlugin(meshesEditorPlugin.manifest.name));
    // Model files are served as bytes, not text: the readers get their text from the project's URL for them.
    const bytes = (text: string) => new TextEncoder().encode(text);
    const MODEL_TEXTS: Record<string, string> = {
      "models/crate.obj": "mtllib crate.mtl\nv 0 0 0\n",
      "models/crate.mtl": "newmtl a\nmap_Kd tex/crate.png\n",
      "models/car.gltf": json({ images: [{ uri: "tex/crate.png" }] }),
    };
    const MODELS: Record<string, string | Uint8Array> = {
      ...Object.fromEntries(Object.entries(MODEL_TEXTS).map(([p, t]) => [p, bytes(t)])),
      "models/tex/crate.png": new Uint8Array([1]),
      "prefabs/crate.prefab.json": scene([{ id: "c", components: [{ type: "engine.MeshRenderer", data: { mesh: "asset:models/crate.obj" } }] }]),
    };

    it("finds the files a kind's reader says name an asset: an .mtl's texture, an .obj's material library", async () => {
      ({ fs, project } = await openTestProject(MODELS));
      expect(await assetUsers(project, "models/tex/crate.png")).toEqual(["models/car.gltf", "models/crate.mtl"]);
      expect(await assetUsers(project, "models/crate.mtl")).toEqual(["models/crate.obj"]);
      expect(await assetUsers(project, "models/tex")).toEqual(["models/car.gltf", "models/crate.mtl"]);
    });

    it("agrees with dependencies: every file a file depends on lists it as a user", async () => {
      ({ fs, project } = await openTestProject({ ...FILES, ...MODELS }));
      const texts = new Map<string, string>();
      for (const [p, v] of Object.entries({ ...FILES, ...MODELS, ...MODEL_TEXTS })) if (typeof v === "string") texts.set(p, v);
      const src: ReferenceSource = { files: project.files, text: (p) => texts.get(p) };
      for (const file of project.files) for (const dep of assetDependencies(src, file)) expect(await assetUsers(project, dep), `${file} → ${dep}`).toContain(file);
    });

    const textOf = (path: string) => new TextDecoder().decode(fs.files.get(joinPath(ROOT, path)) as Uint8Array);
    const GLTF = json({ buffers: [{ uri: "car.bin" }, { uri: "data:application/octet-stream;base64,AA==" }], images: [{ uri: "tex/paint%20red.png" }] });

    it("rewrites the model files that name a moved texture through their kind", async () => {
      ({ fs, project } = await openTestProject(MODELS));
      await project.move("models/tex/crate.png", "models/tex/box.png");
      const { updated, notRewritten } = await rewriteReferences(project, [["models/tex/crate.png", "models/tex/box.png"]], "Move");
      expect(updated.sort()).toEqual(["models/car.gltf", "models/crate.mtl"]);
      expect(notRewritten).toEqual([]);
      expect(textOf("models/crate.mtl")).toBe("newmtl a\nmap_Kd tex/box.png\n");
      expect(textOf("models/car.gltf")).toBe(MODEL_TEXTS["models/car.gltf"].replace("tex/crate.png", "tex/box.png")); // the layout is kept
      expect(await assetUsers(project, "models/tex/box.png")).toEqual(["models/car.gltf", "models/crate.mtl"]);
    });

    it("keeps a .gltf moved without its buffer and images pointing at them", async () => {
      ({ fs, project } = await openTestProject({ "models/car.gltf": bytes(GLTF), "models/car.bin": new Uint8Array([1]), "models/tex/paint red.png": new Uint8Array([1]) }));
      await project.move("models/car.gltf", "vehicles/car.gltf");
      const { updated, notRewritten } = await rewriteReferences(project, [["models/car.gltf", "vehicles/car.gltf"]], "Move");
      expect(updated).toEqual(["vehicles/car.gltf"]);
      expect(notRewritten).toEqual([]);
      const gltf = JSON.parse(textOf("vehicles/car.gltf")) as { buffers: { uri: string }[]; images: { uri: string }[] };
      expect(gltf.buffers.map((b) => b.uri)).toEqual(["../models/car.bin", "data:application/octet-stream;base64,AA=="]);
      expect(gltf.images.map((i) => i.uri)).toEqual(["../models/tex/paint%20red.png"]);
      expect(await assetUsers(project, "models/car.bin")).toEqual(["vehicles/car.gltf"]);
      expect(await assetUsers(project, "models/tex/paint red.png")).toEqual(["vehicles/car.gltf"]);
    });

    it("keeps an .obj moved without its .mtl, and an .mtl moved without its textures, pointing at them", async () => {
      ({ fs, project } = await openTestProject(MODELS));
      await project.move("models/crate.obj", "crate.obj");
      await project.move("models/crate.mtl", "models/libs/crate.mtl");
      const moves = [["models/crate.obj", "crate.obj"], ["models/crate.mtl", "models/libs/crate.mtl"]] as const;
      const { updated } = await rewriteReferences(project, moves, "Move");
      expect(updated.sort()).toEqual(["crate.obj", "models/libs/crate.mtl", "prefabs/crate.prefab.json"]);
      expect(textOf("crate.obj")).toBe("mtllib models/libs/crate.mtl\nv 0 0 0\n");
      expect(textOf("models/libs/crate.mtl")).toBe("newmtl a\nmap_Kd ../tex/crate.png\n");
      expect(await assetUsers(project, "models/tex/crate.png")).toEqual(["models/car.gltf", "models/libs/crate.mtl"]);
    });

    it("changes nothing in a model moved with everything it names", async () => {
      ({ fs, project } = await openTestProject(MODELS));
      await project.move("models", "art");
      const { updated, notRewritten } = await rewriteReferences(project, [["models", "art"]], "Move");
      expect(updated).toEqual(["prefabs/crate.prefab.json"]);
      expect(notRewritten).toEqual([]);
      expect(textOf("art/crate.mtl")).toBe(MODEL_TEXTS["models/crate.mtl"]);
      expect(textOf("art/car.gltf")).toBe(MODEL_TEXTS["models/car.gltf"]);
    });

    it("still reports the files of a kind that reads its format but doesn't rewrite it", async () => {
      const unregisterNotes = assetKinds.register({ id: "notes", extensions: [".notes"], label: "Notes", icon: "", references: { read: (_path, text) => text.split("\n").filter(Boolean) } });
      try {
        ({ fs, project } = await openTestProject({ ...MODELS, "docs/todo.notes": bytes("models/tex/crate.png\n") }));
        await project.move("models/tex/crate.png", "models/tex/box.png");
        const { notRewritten } = await rewriteReferences(project, [["models/tex/crate.png", "models/tex/box.png"]], "Move");
        expect(notRewritten).toEqual(["docs/todo.notes"]);
      } finally {
        unregisterNotes();
      }
    });

    it("deleting a texture an .mtl names says the .mtl still refers to it", async () => {
      ({ fs, project } = await openTestProject(MODELS));
      askBeforeDeletingAssets.value = false;
      try {
        expect(await deleteAssets(["models/tex/crate.png"])).toBe(true);
      } finally {
        askBeforeDeletingAssets.value = true;
      }
      expect(status.value?.text).toContain("Still referred to by models/car.gltf, models/crate.mtl.");
    });
  });
});
