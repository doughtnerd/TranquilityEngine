// ADR 0360 §8, the export rule: a web build ships the offline render module (the Babylon fallback renders generators
// with it) only when its project may play a generator: a `*.generator.json`, or a playlist embedding one. The plan says
// so (`offlineRender`) and the build writer leaves the module out of the player's files otherwise.
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../editor/memoryFs";
import { typescript } from "../editor/moduleImports";
import { fileSystemFolder, writeWebBuild, type FileSource } from "./buildWriter";
import { isOfflineRenderFile, planWebBuild, projectMayUseGenerators, type BuildSource } from "./webBuild";

beforeAll(() => typescript().then(() => undefined), 60_000);

const OFFLINE = "assets/myco_audio_offline-AbC123.wasm";
const PLAYER: Record<string, string> = {
  "files.json": JSON.stringify({ files: [OFFLINE, "assets/player-x.js", "myco.js", "player.html"] }),
  [OFFLINE]: "\0asm",
  "assets/player-x.js": "// player",
  "myco.js": "export {};",
  "player.html": "<title>player</title>",
};

function source(json: Record<string, string>, files: string[] = []): BuildSource {
  const all = new Map(Object.entries({ "project.json": '{ "name": "Gen" }', "scenes/main.scene.json": "{}", ...json }));
  return { name: "gen", settings: JSON.parse(all.get("project.json")!), files: [...all.keys(), ...files], scripts: new Map(), json: all };
}

const reader = (files: Record<string, string>): FileSource => ({
  read: async (path) => {
    const v = files[path];
    if (v === undefined) throw new Error(`no ${path}`);
    return v;
  },
});

async function written(src: BuildSource): Promise<string[]> {
  const plan = await planWebBuild(src);
  const fs = new MemoryFileSystem();
  const project: Record<string, string> = Object.fromEntries([...src.json].concat(src.files.filter((f) => !src.json.has(f)).map((f) => [f, "x"])));
  await writeWebBuild(plan, {
    project: reader(project), player: reader(PLAYER), playerWhere: "the test player",
    folder: fileSystemFolder(fs, "/out"), platform: "web",
    transcode: async () => { throw new Error("no images here"); },
    bake: async () => ({ bytes: new Uint8Array(0), dropped: [] }),
  });
  // The memory file system keeps Windows-style paths.
  return [...fs.files.keys()].map((k) => k.replace(/\\/g, "/").replace(/^\/out\//, ""));
}

describe("the offline render module in builds", () => {
  it("names the module Vite emits", () => {
    expect(isOfflineRenderFile(OFFLINE)).toBe(true);
    expect(isOfflineRenderFile("assets/myco_audio_offline.wasm")).toBe(true);
    expect(isOfflineRenderFile("assets/myco_audio_decode-x.wasm")).toBe(false);
    expect(isOfflineRenderFile("project/myco_audio_offline.txt")).toBe(false);
  });

  it("is shipped for a project with a generator asset or an embedded generator, and left out otherwise", async () => {
    const asset = source({}, ["audio/coin.generator.json"]);
    const embedded = source({ "audio/hum.playlist.json": JSON.stringify({ format: "myco.playlist@1", type: "clip", entries: [{ generator: { kind: "oscillator", params: {} } }] }) });
    const none = source({ "audio/step.playlist.json": JSON.stringify({ format: "myco.playlist@1", type: "clip", entries: [{ sample: "audio/step.wav" }] }) }, ["audio/step.wav"]);
    expect(projectMayUseGenerators(asset.files, asset.json)).toBe(true);
    expect(projectMayUseGenerators(embedded.files, embedded.json)).toBe(true);
    expect(projectMayUseGenerators(none.files, none.json)).toBe(false);
    expect((await planWebBuild(asset)).offlineRender).toBe(true);
    expect((await planWebBuild(none)).offlineRender).toBe(false);
    expect(await written(asset)).toContain(OFFLINE);
    expect(await written(embedded)).toContain(OFFLINE);
    const plain = await written(none);
    expect(plain).not.toContain(OFFLINE);
    expect(plain).toContain("assets/player-x.js");
    expect(plain).toContain("index.html");
  });
});
