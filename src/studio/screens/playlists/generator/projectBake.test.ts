// Bake through the Studio's open project (ADR 0360 §6, §9): the Bake dialog's call (`BAKE` with the dialog's options)
// writes the WAV and its sidecar into the project, and Rebake on a sample that went out of date renders it again over
// its own file, its sidecar edited through the document the Samples inspector shows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readAsset } from "../../../../editor/assetDocuments";
import { joinPath, openFolderProject, type EditorProject } from "../../../../editor/projects";
import { activatePlugins, deactivatePlugin, type EditorPlugin } from "../../../../editor/sdk/plugins";
import { currentProject } from "../../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../../editor/testing";
import { applyBlipPreset } from "../../../../engine/audio/generators/blipPresets";
import { emptyGeneratorBody, formatGenerator } from "../../../../engine/audio/generators/format";
import type { GeneratorAsset, GeneratorBody } from "../../../../engine/audio/generators/types";
import { decodeWavPcm } from "../../../../engine/audio/sample/wavPcm";
import { sidecarPath, type ImportSettings } from "../../../../engine/scene/importSettings";
import { registerStudioAssetKinds } from "../../../../plugins/audio/editor/studioAssets";
import { sampleSession, SIDECAR_KIND } from "../../samples/sampleSession";
import { BAKE, NO_PROJECT, bakeAvailability, defaultBakeOptions, provenanceView, rebakeOptions } from "./bakeModel";

const plugin: EditorPlugin = { manifest: { name: "studio-bake-test", version: "1.0.0" } as EditorPlugin["manifest"], activate: registerStudioAssetKinds };
beforeAll(() => activatePlugins([plugin]));
afterAll(() => deactivatePlugin(plugin.manifest.name));

const GEN = "audio/ui/coin.generator.json";
const coin: GeneratorBody = { ...applyBlipPreset(emptyGeneratorBody("blip"), "coin", 1734), seed: 1734 };
let fs: MemoryFileSystem;
let project: EditorProject;

const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));
const sidecarOf = (path: string) => readAsset<ImportSettings>(project, sidecarPath(path), SIDECAR_KIND).value;
const generatorNow = (path: string) => (project.files.includes(path) ? readAsset<GeneratorAsset>(project, path, "generator").value : null);
const pcmOf = (path: string) => Array.from(decodeWavPcm(onDisk(path) as Uint8Array)!.pcm);

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, GEN), formatGenerator({ ...coin }));
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});

afterEach(() => {
  currentProject.value = null;
});

describe("Bake in the Studio", () => {
  it("is off with no project open, and the call rejects", async () => {
    expect(bakeAvailability(BAKE, GEN, null)).toEqual({ enabled: false, reason: NO_PROJECT });
    currentProject.value = null;
    await expect(BAKE!(GEN, defaultBakeOptions(GEN, false))).rejects.toThrow("no project is open");
  });

  it("writes the dialog's files into the open project", async () => {
    expect(bakeAvailability(BAKE, GEN, project.canSave).enabled).toBe(true);
    const r = await BAKE!(GEN, { ...defaultBakeOptions(GEN, false), variations: 2, queue: true });
    expect(r).toEqual({ files: ["audio/ui/coin.baked.wav", "audio/ui/coin.baked2.wav"], queue: "audio/ui/coin.baked.playlist.json" });
    for (const f of [...r.files, r.queue!, sidecarPath(r.files[0]!)]) {
      expect(project.files).toContain(f);
      expect(onDisk(f)).toBeDefined();
    }
    // A float WAV of the render, and a sidecar saying where it came from.
    expect(pcmOf(r.files[0]!).length).toBeGreaterThan(1000);
    expect(sidecarOf(r.files[1]!).generated).toMatchObject({ generator: GEN, seed: 1735, variation: 1 });
    expect(provenanceView(sidecarOf(r.files[0]!).generated, generatorNow, BAKE)!.state).toBe("current");
  });

  it("bakes the generator as the editor holds it, and Replace uses edits the project's playlists", async () => {
    await project.writeText("audio/shop.playlist.json", `${JSON.stringify({ format: "myco.playlist@1", type: "clip", entries: [{ generator: GEN }] }, null, 2)}\n`);
    const r = await BAKE!(GEN, { ...defaultBakeOptions(GEN, false), replaceUses: true });
    expect(JSON.parse(project.textOf("audio/shop.playlist.json")!).entries[0]).toEqual({ sample: r.files[0] });
  });

  it("rebakes an out-of-date sample over its own file", async () => {
    const r = await BAKE!(GEN, { ...defaultBakeOptions(GEN, false), variations: 2 });
    const sample = r.files[1]!;
    // The Samples inspector has the sample open.
    const session = sampleSession(project, sample);
    const before = session.settings.value!.generated!;
    const was = pcmOf(sample);
    // The generator changes: the sample is out of date.
    await project.writeText(GEN, formatGenerator({ ...coin, params: { ...coin.params, baseFrequency: 0.3 } }));
    expect(provenanceView(before, generatorNow, BAKE)!.state).toBe("outOfDate");
    const again = await BAKE!(GEN, rebakeOptions(sample, before, false));
    expect(again.files).toEqual([sample]);
    // No new file: the sample and its sidecar were rewritten, the variation kept.
    expect(project.files.filter((f) => f.endsWith(".wav"))).toHaveLength(2);
    expect(pcmOf(sample)).not.toEqual(was);
    const after = session.settings.value!.generated!;
    expect(after).toMatchObject({ generator: GEN, seed: 1735, variation: 1 });
    expect(provenanceView(after, generatorNow, BAKE)!.state).toBe("current");
    expect(JSON.parse(onDisk(sidecarPath(sample)) as string).generated.hash).toBe(after.hash);
    // The rewrite is one undo step of the sidecar's document.
    session.undo();
    expect(session.settings.value!.generated!.hash).toBe(before.hash);
  });
});
