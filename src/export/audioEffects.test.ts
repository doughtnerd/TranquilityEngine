// ADR 0352 §8 (B5): plugin audio effects in a game build, from the tremolo sample (`samples/fx-tremolo`). The plan picks
// the enabled plugin's module, the build writer copies it and writes `game.json`'s `audioEffects` (with the module's
// hash), and the player's registration (`registerBuildAudioEffects`, what `player/main.ts` runs before the Engine) hands
// it to the audio backend once one is installed; a module whose bytes changed after the build is refused. A disabled
// plugin ships nothing. Read from disk as `npm run export` reads it; written into an in-memory folder.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectSpec } from "../engine/audio/effects/catalogue";
import { MemoryFileSystem } from "../editor/memoryFs";
import { setAudioBackend } from "../plugins/audio/runtime/backend";
import { applyEffectPluginSet } from "../plugins/audio/runtime/effectPlugins/projectSet";
import { makeFakeBackend } from "../plugins/audio/runtime/testing";
import { registerBuildAudioEffects } from "../player/audioEffects";
import { readProject } from "../server/project";
import { fileSystemFolder, writeWebBuild, type FileSource } from "./buildWriter";
import type { GameManifest } from "./format";
import { planWebBuild } from "./webBuild";

const DIR = fileURLToPath(new URL("../../samples/fx-tremolo/", import.meta.url));
const OUT = "C:\\Out\\tremolo";
const PLAYER: Record<string, string> = { "files.json": JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }), "assets/player-x.js": "// player", "myco.js": "export {};", "player.html": "<title>player</title>" };
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const disk: FileSource = { read: async (path) => new Uint8Array(await readFile(join(DIR, ...path.split("/")))) };
const player: FileSource = {
  read: async (path) => {
    if (!(path in PLAYER)) throw new Error(`no ${path}`);
    return PLAYER[path]!;
  },
};

/** Exports the sample (with `disabled` plugins off) into a memory folder; the build's files by build path. */
async function exportSample(disabled: string[] = []) {
  const project = await readProject(DIR);
  const settings = { ...project.settings, plugins: { disabled } };
  const plan = await planWebBuild({ name: "fx-tremolo", settings, files: project.files, scripts: project.scripts, json: project.json });
  const fs = new MemoryFileSystem();
  const written = await writeWebBuild(plan, {
    project: disk,
    player,
    playerWhere: "the test player",
    folder: fileSystemFolder(fs, OUT),
    platform: "web",
    transcode: async () => {
      throw new Error("no images here");
    },
    bake: async () => ({ bytes: new Uint8Array(), dropped: [] }),
  });
  const file = (p: string) => fs.files.get(`${OUT}\\${p.replace(/\//g, "\\")}`);
  return { plan, written, file, manifest: JSON.parse(file("game.json") as string) as GameManifest };
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(async () => {
  await applyEffectPluginSet([]);
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("plugin audio effects in a build (the tremolo sample)", () => {
  it("copies the enabled plugin's module and writes audioEffects with its hash into game.json", async () => {
    const wasm = new Uint8Array(await readFile(join(DIR, "plugins/tremolo/dsp/tremolo.wasm")));
    const { file, manifest } = await exportSample();
    expect(file("project/plugins/tremolo/dsp/tremolo.wasm")).toEqual(wasm);
    expect(manifest.audioEffects).toHaveLength(1);
    const entry = manifest.audioEffects![0]!;
    expect(entry).toMatchObject({ plugin: "example.tremolo", title: "Tremolo", version: "1.0.0", module: "dsp", url: "project/plugins/tremolo/dsp/tremolo.wasm", hash: sha256(wasm), memoryMB: 1 });
    expect(entry.effects.map((e) => [e.spec.type, e.kind, e.instructionsPerFrame, e.maxInstances])).toEqual([["example.tremolo", 0, 300, 32]]);
    expect(entry.effects[0]!.spec.params.map((p) => p.name)).toEqual(["rate", "depth", "shape"]);
  });

  it("the player registers them before the Engine: the catalogue at once, the module once a backend is installed", async () => {
    const { file, manifest } = await exportSample();
    const read = async (path: string) => (file(path) as Uint8Array | undefined) ?? null;
    // No backend yet (the player registers before `Engine.create`).
    expect(await registerBuildAudioEffects(manifest.audioEffects, read)).toEqual([]);
    expect(effectSpec("example.tremolo").plugin?.state).toBe("on");
    const fake = makeFakeBackend();
    setAudioBackend(fake);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.effectPlugins!.registrations.map((r) => [r.plugin, r.module, r.effects.map((e) => e.spec.type)])).toEqual([["example.tremolo", "dsp", ["example.tremolo"]]]);
  });

  it("the player refuses a module whose bytes aren't the build's (its effects pass through), and an entry that isn't one", async () => {
    const { manifest } = await exportSample();
    const fake = makeFakeBackend();
    setAudioBackend(fake);
    const problems = await registerBuildAudioEffects([...manifest.audioEffects!, { plugin: "broken" }], async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(problems.join("\n")).toContain("an entry of game.json's audioEffects isn't one (broken)");
    expect(problems.join("\n")).toContain("module dsp (project/plugins/tremolo/dsp/tremolo.wasm) is missing");
    expect(fake.effectPlugins!.registrations).toEqual([]);
  });

  it("a disabled plugin ships neither its module nor audioEffects", async () => {
    const { file, manifest } = await exportSample(["example.tremolo"]);
    expect(manifest.audioEffects).toBeUndefined();
    expect(file("project/plugins/tremolo/dsp/tremolo.wasm")).toBeUndefined();
    expect(manifest.files).not.toContain("plugins/tremolo/dsp/tremolo.wasm");
    expect(manifest.files).toContain("plugins/tremolo/plugin.json");
  });
});
