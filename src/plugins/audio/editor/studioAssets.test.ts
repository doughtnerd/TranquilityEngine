/**
 * The Studio's asset kinds through the editor's asset-kind registry (ADR 0143, 0148, 0233, 0302): what `assetKind`
 * resolves, the kinds' formats and reference readers as the registry holds them, and a move rewriting the references
 * inside playlists and derived samples.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assetKind, registeredKind } from "../../../editor/assetKindLookup";
import { assetDependencies, assetUsers, rewriteReferences } from "../../../editor/assetReferences";
import { activatePlugins, deactivatePlugin, type EditorPlugin } from "../../../editor/sdk/plugins";
import { closeTestProject, openTestProject, ROOT, useCoreAssetKinds } from "../../../editor/testing";
import { joinPath } from "../../../editor/projects";
import { emptyPlaylist, emptyPlaylistBody, formatPlaylist, parsePlaylist } from "../../../engine/audio/playlist/format";
import type { EmbeddedEntry, PlaylistAsset } from "../../../engine/audio/playlist/types";
import { applyBlipPreset } from "../../../engine/audio/generators/blipPresets";
import { emptyGenerator, formatGenerator, parseGenerator } from "../../../engine/audio/generators/format";
import { registerStudioAssetKinds } from "./studioAssets";

/** Just the Studio kinds, as the audio plugin's `activate` registers them. */
const plugin: EditorPlugin = { manifest: { name: "studio-kinds-test", version: "1.0.0" } as EditorPlugin["manifest"], activate: registerStudioAssetKinds };

useCoreAssetKinds();
beforeAll(() => activatePlugins([plugin]));
afterAll(() => deactivatePlugin(plugin.manifest.name));
afterEach(() => closeTestProject());

const use = { volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop" as const, curves: {} };
/** A sample in an embedded Clip (samples play only in a Clip). */
function clipOf(sample: string): EmbeddedEntry {
  const body = emptyPlaylistBody("clip");
  body.entries = [{ kind: "sample", sample, trim: null, loop: "inherit", ...use }];
  return { kind: "embedded", embedded: body, ...use };
}

function playlist(): PlaylistAsset {
  const p = emptyPlaylist("queue");
  p.spatial = { attenuation: "audio/far.attenuation.json", occlusion: false, doppler: 0, spread: null };
  p.entries = [clipOf("audio/step.wav"), { kind: "linked", playlist: "audio/other.playlist.json", ...use }, clipOf("audio/step.sample.json")];
  return p;
}

const SAMPLE = JSON.stringify({ format: "myco.sample@1", source: "audio/step.wav", range: [0, 0.5], lineage: { kind: "snippet", parent: "audio/base.sample.json", mode: "pin" } });
const ATTENUATION = JSON.stringify({ format: "myco.attenuation@1", minDistance: 2, maxDistance: 40 });

describe("the Studio's asset kinds", () => {
  it("resolve by file ending, ahead of plain JSON", () => {
    expect(assetKind("audio/music.playlist.json")).toBe("playlist");
    expect(assetKind("audio/Step.Sample.json")).toBe("derivedSample");
    expect(assetKind("audio/far.attenuation.json")).toBe("attenuation");
    expect(registeredKind("playlist")).toMatchObject({ label: "Playlist", folder: "audio", referencedAs: ["playlist"] });
    expect(registeredKind("playlist")!.panel).toBeUndefined();
  });

  it("read and write their files through the engine's formats", () => {
    const p = registeredKind("playlist")!.format!;
    const text = p.format(playlist());
    expect(text).toBe(formatPlaylist(playlist()));
    expect(p.parse(JSON.parse(text), "a.playlist.json")).toEqual({ value: parsePlaylist(JSON.parse(text)).playlist, problems: [] });
    expect(p.parse(undefined, "a.playlist.json").problems.length).toBeGreaterThan(0);

    const s = registeredKind("derivedSample")!.format!;
    const sample = s.parse(JSON.parse(SAMPLE), "a.sample.json");
    expect(sample.problems).toEqual([]);
    expect(s.parse(JSON.parse(s.format(sample.value)), "a.sample.json").value).toEqual(sample.value);

    const a = registeredKind("attenuation")!.format!;
    const att = a.parse(JSON.parse(ATTENUATION), "far.attenuation.json");
    expect(att.problems).toEqual([]);
    expect(att.value).toMatchObject({ minDistance: 2, maxDistance: 40 });
    expect(a.parse(JSON.parse(a.format(a.empty())), "x.attenuation.json").problems).toEqual([]);
  });

  it("say what their files name", () => {
    expect(registeredKind("playlist")!.references!.read("audio/a.playlist.json", formatPlaylist(playlist())))
      .toEqual(["audio/far.attenuation.json", "audio/step.wav", "audio/other.playlist.json", "audio/step.sample.json"]);
    expect(registeredKind("derivedSample")!.references!.read("audio/s.sample.json", SAMPLE)).toEqual(["audio/step.wav", "audio/base.sample.json"]);
    expect(registeredKind("playlist")!.references!.read("audio/a.playlist.json", "{ nope")).toEqual([]);
  });

  it("are dependencies and users in the project, and a move rewrites the paths inside them", async () => {
    const { project, fs } = await openTestProject({
      "audio/a.playlist.json": formatPlaylist(playlist()),
      "audio/step.wav": new Uint8Array([1]),
      "audio/step.sample.json": SAMPLE,
      "audio/far.attenuation.json": ATTENUATION,
    });
    expect(assetDependencies({ files: project.files, text: (p) => project.textOf(p) }, "audio/a.playlist.json")).toEqual(expect.arrayContaining(["audio/far.attenuation.json", "audio/step.wav", "audio/step.sample.json"]));
    expect((await assetUsers(project, ["audio/step.wav"])).sort()).toEqual(["audio/a.playlist.json", "audio/step.sample.json"]);

    await project.move("audio/step.wav", "sfx/step.wav");
    await project.move("audio/far.attenuation.json", "audio/presets/far.attenuation.json");
    const moves: [string, string][] = [["audio/step.wav", "sfx/step.wav"], ["audio/far.attenuation.json", "audio/presets/far.attenuation.json"]];
    const { updated, notRewritten } = await rewriteReferences(project, moves, "Move");
    expect(updated.sort()).toEqual(["audio/a.playlist.json", "audio/step.sample.json"]);
    expect(notRewritten).toEqual([]);

    const read = (path: string) => fs.files.get(joinPath(ROOT, path)) as string;
    const moved = parsePlaylist(JSON.parse(read("audio/a.playlist.json")));
    expect(moved.problems).toEqual([]);
    expect(moved.playlist.spatial!.attenuation).toBe("audio/presets/far.attenuation.json");
    expect((moved.playlist.entries[0] as EmbeddedEntry).embedded.entries[0]).toMatchObject({ sample: "sfx/step.wav" });
    expect(JSON.parse(read("audio/step.sample.json"))).toMatchObject({ source: "sfx/step.wav", lineage: { parent: "audio/base.sample.json" } });
  });

  describe("generators (ADR 0346)", () => {
    const COIN = formatGenerator(applyBlipPreset(emptyGenerator("blip"), "coin", 1734));
    function usesCoin(): PlaylistAsset {
      const p = emptyPlaylist("clip");
      p.entries = [{ kind: "generator", generator: "audio/ui/coin.generator.json", ...use }];
      return p;
    }
    const baked = JSON.stringify({ format: "myco.import@1", generated: { generator: "audio/ui/coin.generator.json", hash: "ab", seed: 1734, variation: 0 } });

    it("resolve, and read and write through the engine's generator format", () => {
      expect(assetKind("audio/ui/Coin.generator.json")).toBe("generator");
      expect(registeredKind("generator")).toMatchObject({ label: "Generator", folder: "audio" });
      const g = registeredKind("generator")!.format!;
      const read = g.parse(JSON.parse(COIN), "coin.generator.json");
      expect(read).toEqual({ value: parseGenerator(JSON.parse(COIN)).generator, problems: [] });
      expect(g.format(read.value)).toBe(COIN);
      expect(g.parse(JSON.parse(g.format(g.empty())), "x.generator.json").problems).toEqual([]);
      expect(g.parse({ kind: "blip" }, "x.generator.json").problems).toEqual([{ message: 'x.generator.json: format: expected "myco.generator@1"; reading it anyway.' }]);
    });

    it("are named by playlists and baked samples' sidecars, and a move rewrites both", async () => {
      const { project, fs } = await openTestProject({
        "audio/ui/coin.generator.json": COIN,
        "audio/shop.playlist.json": formatPlaylist(usesCoin()),
        "audio/ui/coin.baked.wav": new Uint8Array([1]),
        "audio/ui/coin.baked.wav.meta.json": baked,
      });
      expect(registeredKind("playlist")!.references!.read("audio/shop.playlist.json", formatPlaylist(usesCoin()))).toEqual(["audio/ui/coin.generator.json"]);
      expect((await assetUsers(project, ["audio/ui/coin.generator.json"])).sort()).toEqual(["audio/shop.playlist.json", "audio/ui/coin.baked.wav.meta.json"]);

      await project.move("audio/ui/coin.generator.json", "audio/sfx/coin.generator.json");
      const { updated, notRewritten } = await rewriteReferences(project, [["audio/ui/coin.generator.json", "audio/sfx/coin.generator.json"]], "Move");
      expect(updated.sort()).toEqual(["audio/shop.playlist.json", "audio/ui/coin.baked.wav.meta.json"]);
      expect(notRewritten).toEqual([]);
      const read = (path: string) => fs.files.get(joinPath(ROOT, path)) as string;
      expect(parsePlaylist(JSON.parse(read("audio/shop.playlist.json"))).playlist.entries[0]).toMatchObject({ kind: "generator", generator: "audio/sfx/coin.generator.json" });
      expect(JSON.parse(read("audio/ui/coin.baked.wav.meta.json")).generated.generator).toBe("audio/sfx/coin.generator.json");
    });
  });
});
