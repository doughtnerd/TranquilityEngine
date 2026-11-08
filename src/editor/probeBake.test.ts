import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, ReflectionProbe } from "../engine";
import { assetKind } from "./assetBrowser";
import { SetField } from "./document";
import { bakeProbe, probeBakePath } from "./probeBake";
import { editorSettings, joinPath, openFolderProject, type EditorProject } from "./projects";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

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

describe("probeBakePath", () => {
  it("names a free file in the scene's probes folder", async () => {
    expect(probeBakePath(project, "scenes/main.scene.json", "Lobby", "")).toBe("scenes/probes/main-Lobby.env");
    expect(probeBakePath(project, "main.scene.json", "A/B", "")).toBe("probes/main-A-B.env");
    await project.writeBinary("scenes/probes/main-Lobby.env", new Uint8Array([1]));
    expect(probeBakePath(project, "scenes/main.scene.json", "Lobby", "")).toBe("scenes/probes/main-Lobby 2.env");
  });
  it("reuses the file bakedMap names", () => {
    expect(probeBakePath(project, "main.scene.json", "Lobby", "asset:probes/x.env")).toBe("probes/x.env");
  });
});

describe("bakeProbe", () => {
  it("writes the bytes then sets bakedMap and refresh", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    const node = GameObject.create("Lobby", { parent: engine.world.root });
    node.addComponent(ReflectionProbe);
    const log: string[] = [];
    const commands: SetField[] = [];
    const path = await bakeProbe({
      project, scenePath: "main.scene.json", node, nodeId: "n1", hasNode: () => true,
      viewport: { bakeReflectionProbe: async () => { log.push("bake"); return new Uint8Array([7, 8]).buffer; } },
      execute: (c) => { log.push("edit"); commands.push(c); },
    });
    expect(path).toBe("probes/main-Lobby.env");
    expect(Array.from(fs.files.get(joinPath(ROOT, path)) as Uint8Array)).toEqual([7, 8]);
    expect(log).toEqual(["bake", "edit", "edit"]);
    expect(commands.length).toBe(2);
  });
  it("edits nothing when the bake rejects", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    const node = GameObject.create("Lobby", { parent: engine.world.root });
    node.addComponent(ReflectionProbe);
    const commands: unknown[] = [];
    await expect(bakeProbe({
      project, scenePath: "main.scene.json", node, nodeId: "n1", hasNode: () => true,
      viewport: { bakeReflectionProbe: async () => { throw new Error("probes are off"); } },
      execute: (c) => commands.push(c),
    })).rejects.toThrow("probes are off");
    expect(commands).toEqual([]);
  });
});
