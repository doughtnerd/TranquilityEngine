import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAttenuationAsset } from "../audio/attenuation/format";
import { lintPlaylist } from "../audio/playlist/lint";
import { parsePlaylist } from "../audio/playlist/format";
import { referencedPaths } from "../audio/playlist/references";
import { parseAudioProject } from "../audio/project/format";
import { FxKind } from "../../../samples/pirates/scripts/data";
import { FX_SOUNDS, HARBOUR_SNAPSHOT, STORM_PARAMETER, UI_CLICK } from "../../../samples/pirates/scripts/sounds";

// King of Pirates' sounds as data (ADR 0343, 0344): the mix in audio.json and a playlist per sound
// in sounds/, read by the same parsers and lint the runtime and the Audio Studio use.

const SAMPLE = fileURLToPath(new URL("../../../samples/pirates", import.meta.url));
const json = (path: string): unknown => JSON.parse(readFileSync(join(SAMPLE, path), "utf8"));
const PLAYLISTS = readdirSync(join(SAMPLE, "sounds")).filter((f) => f.endsWith(".playlist.json")).map((f) => `sounds/${f}`);
const { project, problems: mixProblems } = parseAudioProject(json("audio.json"));
const outputs = new Set([...project.buses.map((b) => b.name), ...project.returns.map((r) => r.name)]);

describe("King of Pirates: the mix", () => {
  it("reads without a problem", () => {
    expect(mixProblems).toEqual([]);
  });

  it("has the Storm parameter, the rain bus that follows it, and the Harbour snapshot the leave dialog starts", () => {
    expect(project.parameters.map((p) => p.name)).toContain(STORM_PARAMETER);
    expect(project.automation).toContainEqual(expect.objectContaining({ on: "Rain", target: "volume", parameter: STORM_PARAMETER }));
    const harbour = project.snapshots.find((s) => s.name === HARBOUR_SNAPSHOT);
    expect(harbour?.start).toEqual({ kind: "code" });
    expect(project.buses.find((b) => b.name === "Rain")?.parent).toBe("Ambience");
  });
});

describe("King of Pirates: the sound playlists", () => {
  it.each(PLAYLISTS)("%s reads and lints clean, plays on a bus of the mix, and names files that exist", (path) => {
    const { playlist, problems } = parsePlaylist(json(path), path);
    expect(problems).toEqual([]);
    expect(lintPlaylist(playlist, { globalParameters: () => project.parameters })).toEqual([]);
    expect(outputs).toContain(playlist.output);
    const named = referencedPaths(playlist);
    expect(named.length).toBeGreaterThan(0);
    for (const file of named) expect(existsSync(join(SAMPLE, file)), file).toBe(true);
  });

  it("the shared falloff reads without a problem", () => {
    expect(parseAttenuationAsset(json("sounds/sea.attenuation.json")).problems).toEqual([]);
  });

  it("every effect the server reports has a sound, and the scripts' playlists exist", () => {
    for (const kind of Object.values(FxKind)) expect(FX_SOUNDS[kind], `FxKind ${kind}`).toBeDefined();
    for (const path of [...Object.values(FX_SOUNDS), UI_CLICK]) expect(PLAYLISTS).toContain(path);
  });

  it("the scenes' looping sounds are playlists on the ambience buses", () => {
    const clips: { clip: string; output: string }[] = [];
    for (const file of ["scenes/menu.scene.json", "scenes/island-bay.scene.json", "scenes/open-ocean.scene.json", "scenes/rocky-maze.scene.json", "prefabs/camera.prefab.json"]) {
      const scene = json(file) as { nodes: { components?: { type: string; data: { clip?: string; output?: string } }[] }[] };
      for (const n of scene.nodes) for (const c of n.components ?? []) if (c.type === "engine.AudioSource") clips.push({ clip: c.data.clip ?? "", output: c.data.output ?? "" });
    }
    expect(clips.length).toBe(5); // the ocean in the menu and the camera, and each arena's rain
    for (const { clip, output } of clips) {
      expect(clip).toMatch(/^asset:sounds\/.+\.playlist\.json$/);
      expect(PLAYLISTS).toContain(clip.slice("asset:".length));
      expect(["Ambience", "Rain"]).toContain(output);
    }
  });
});
