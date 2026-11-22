// ADR 0338 §8 (B5): the editor's plugin loading is a call site of the plugin effects. Opening the tremolo sample's
// folder and loading its code (`loadProjectCode`, what Play and every script reload run) registers the plugin's effects
// with the catalogue, its module with the audio backend's `effectPlugins` capability and with offline renders; a reload
// with nothing changed leaves the module alone, a rebuilt module re-registers, a plugin turned off leaves the backend
// and greys its effects, and closing the project drops them all. The backend is the audio test double, which records.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectSpec } from "../engine/audio/effects/catalogue";
import { offlineEffectHost } from "../engine/audio/sample/offlinePlugins";
import { joinPath, openFolderProject } from "../editor/projects";
import { MemoryFileSystem } from "../editor/testing";
import { setAudioBackend } from "./audio/runtime/backend";
import { makeFakeBackend, type FakeBackend } from "./audio/runtime/testing";
import { loadProjectCode, unloadThirdPartyPlugins } from "./thirdPartyEditor";
import "./editorBoot";

const SAMPLE = new URL("../../samples/fx-tremolo/", import.meta.url);
const ROOT = "C:\\Games\\tremolo";
const WASM = new Uint8Array(readFileSync(new URL("plugins/tremolo/dsp/tremolo.wasm", SAMPLE)));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The sample's folder (its manifest, module, mix and project file), optionally with another project.json or module. */
function folder(options: { projectJson?: object; wasm?: Uint8Array } = {}): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  const text = (p: string) => readFileSync(new URL(p, SAMPLE), "utf8");
  fs.files.set(joinPath(ROOT, "project.json"), options.projectJson ? JSON.stringify(options.projectJson) : text("project.json"));
  fs.files.set(joinPath(ROOT, "audio.json"), text("audio.json"));
  fs.files.set(joinPath(ROOT, "plugins/tremolo/plugin.json"), text("plugins/tremolo/plugin.json"));
  fs.files.set(joinPath(ROOT, "plugins/tremolo/dsp/tremolo.wasm"), options.wasm ?? WASM);
  return fs;
}

/** A valid copy of the tremolo module with a custom section appended: other bytes, the same code (a rebuild). */
const rebuilt = (): Uint8Array => new Uint8Array([...WASM, 0, 4, 3, 0x61, 0x62, 0x63]);

let fake: FakeBackend;
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fake = makeFakeBackend();
  setAudioBackend(fake);
});
afterEach(() => {
  unloadThirdPartyPlugins();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

/** Lets the unload's promise settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("plugin audio effects in the editor's plugin loading", () => {
  it("loading the project's code registers the plugin's effects, its module with the backend and with offline renders", async () => {
    const project = await openFolderProject(folder(), ROOT);
    const result = await loadProjectCode(project);
    expect(result.problems).toEqual([]);
    expect(effectSpec("example.tremolo").plugin).toMatchObject({ name: "example.tremolo", title: "Tremolo", state: "on" });
    const regs = fake.effectPlugins!.registrations;
    expect(regs.map((r) => [r.plugin, r.version, r.module, r.effects.map((e) => e.spec.type)])).toEqual([["example.tremolo", "1.0.0", "dsp", ["example.tremolo"]]]);
    expect(regs[0]!.bytes.length).toBeGreaterThan(WASM.length); // instrumented (fuel)
    expect(offlineEffectHost()?.identity("example.tremolo")).toEqual({ plugin: "example.tremolo", version: "1.0.0", hash: sha256(WASM) });
  });

  it("a reload with nothing changed leaves the module alone; a rebuilt module registers again", async () => {
    const fs = folder();
    const project = await openFolderProject(fs, ROOT);
    await loadProjectCode(project);
    await loadProjectCode(project);
    expect(fake.effectPlugins!.registrations).toHaveLength(1);
    const next = rebuilt();
    await project.writeBinary("plugins/tremolo/dsp/tremolo.wasm", next);
    await loadProjectCode(project);
    expect(fake.effectPlugins!.registrations).toHaveLength(2);
    expect(offlineEffectHost()?.identity("example.tremolo")?.hash).toBe(sha256(next));
  });

  it("a plugin turned off leaves the backend and offline renders, and its effects grey out (kept, passing through)", async () => {
    const project = await openFolderProject(folder(), ROOT);
    await loadProjectCode(project);
    const off = await openFolderProject(folder({ projectJson: { name: "fx-tremolo", plugins: { disabled: ["example.tremolo"] } } }), ROOT);
    await loadProjectCode(off);
    expect(fake.effectPlugins!.unregistered).toContain("example.tremolo");
    expect(effectSpec("example.tremolo").plugin?.state).toBe("off");
    expect(offlineEffectHost()?.identity("example.tremolo")).toBeNull();
  });

  it("a plugin whose module file is missing is refused by the plan (the wasm-exists check), so nothing registers", async () => {
    const fs = folder();
    fs.files.delete(joinPath(ROOT, "plugins/tremolo/dsp/tremolo.wasm"));
    const project = await openFolderProject(fs, ROOT);
    const result = await loadProjectCode(project);
    expect(result.problems.map((p) => p.message).join("\n")).toContain("its audio module dsp's file plugins/tremolo/dsp/tremolo.wasm doesn't exist");
    expect(fake.effectPlugins!.registrations).toEqual([]);
  });

  it("closing the project drops the plugin's effects everywhere", async () => {
    const project = await openFolderProject(folder(), ROOT);
    await loadProjectCode(project);
    unloadThirdPartyPlugins();
    await settle();
    expect(fake.effectPlugins!.unregistered).toContain("example.tremolo");
    expect(effectSpec("example.tremolo").plugin?.state).toBe("missing");
    expect(offlineEffectHost()?.identity("example.tremolo")).toBeNull();
  });
});
