import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { environmentEditorPlugin } from "../plugins/environment/editor";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { Engine } from "../engine";
import { FakeRenderSurface } from "../engine/render/fakeViewport";
import { assetKind } from "./assetBrowser";
import { bakeOpenSceneProbe } from "./probeBake";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { openScene, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

// `.env` files are the Environment plugin's kind (ADR 0140).
useEditorPlugins([environmentEditorPlugin]);

let fs: MemoryFileSystem;
let project: EditorProject;
beforeEach(async () => {
  fs = demoFolder();
  project = await openFolderProject(fs, ROOT);
});

describe("assetKind", () => {
  it("treats named .env files as environments and a bare .env as other", () => {
    expect(assetKind("probes/room.env")).toBe("environment");
    expect(assetKind(".env")).toBe("other");
    expect(assetKind("sub/.env")).toBe("other");
  });
});

/** A scene file with a ReflectionProbe node named `name` (id "probe"). */
const probeScene = (name: string) => JSON.stringify({ format: "myco.scene@1", nodes: [{ id: "probe", name, components: [{ type: "engine.Transform", data: {} }, { type: "engine.ReflectionProbe", data: {} }] }] });

describe("baking a probe from the Inspector (ADR 0110)", () => {
  let engine: Engine | null = null;
  let surface: FakeRenderSurface;
  /** Open `path` (holding a probe named `name`) in an editor whose viewport bakes `bytes`. */
  async function open(path: string, name: string): Promise<void> {
    fs.files.set(joinPath(ROOT, path), probeScene(name));
    project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    surface = new FakeRenderSurface();
    engine.world.render = surface;
    openSceneFile(engine, path);
  }
  const bakedMap = () => openScene.value!.doc.fieldValue("probe", "engine.ReflectionProbe", "bakedMap");
  afterEach(() => {
    engine?.dispose();
    engine = null;
    status.value = null;
  });

  it("writes the bytes to a free file in the scene's probes folder, then sets bakedMap and refresh as one step each", async () => {
    await open("scenes/main.scene.json", "Lobby");
    surface.adapter.bakeResult = new Uint8Array([7, 8]).buffer;
    await bakeOpenSceneProbe(openScene.value!, "probe", project);
    expect(Array.from(fs.files.get(joinPath(ROOT, "scenes/probes/main-Lobby.env")) as Uint8Array)).toEqual([7, 8]);
    expect(bakedMap()).toBe("asset:scenes/probes/main-Lobby.env");
    expect(openScene.value!.doc.fieldValue("probe", "engine.ReflectionProbe", "refresh")).toBe("baked");
  });

  it("names the file safely beside a scene at the top, and numbers it when the name is taken", async () => {
    await project.writeBinary("probes/main-A-B.env", new Uint8Array([1]));
    await open("main.scene.json", "A/B");
    await bakeOpenSceneProbe(openScene.value!, "probe", project);
    expect(bakedMap()).toBe("asset:probes/main-A-B 2.env");
  });

  it("reuses the file bakedMap names", async () => {
    await open("main.scene.json", "Lobby");
    surface.adapter.bakeResult = new Uint8Array([1]).buffer;
    await bakeOpenSceneProbe(openScene.value!, "probe", project);
    surface.adapter.bakeResult = new Uint8Array([2]).buffer;
    await bakeOpenSceneProbe(openScene.value!, "probe", project);
    expect(bakedMap()).toBe("asset:probes/main-Lobby.env");
    expect(Array.from(fs.files.get(joinPath(ROOT, "probes/main-Lobby.env")) as Uint8Array)).toEqual([2]);
    expect(fs.files.has(joinPath(ROOT, "probes/main-Lobby 2.env"))).toBe(false);
  });

  it("edits nothing when the bake rejects", async () => {
    await open("main.scene.json", "Lobby");
    surface.adapter.bakeResult = new Error("probes are off");
    const before = JSON.stringify(openScene.value!.doc.toJSON());
    await expect(bakeOpenSceneProbe(openScene.value!, "probe", project)).rejects.toThrow("probes are off");
    expect(JSON.stringify(openScene.value!.doc.toJSON())).toBe(before);
    expect(status.value?.text).toMatch(/Couldn't bake Lobby/);
  });
});
