import { parsePlaylist } from "../playlist/format";
/**
 * Every audio event in the repo migrates without throwing and gives a structurally valid playlist (ADR 0329): exactly
 * one sample per Clip, Switch maps pointing at real entries, sequence clips with exactly one source. The repo's events
 * are the samples' (`samples/**\/*.audioevent.json`); `src/engine/audio/__fixtures__` holds no event files (only music
 * clip facts in TypeScript).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateProjectAudioEvents, playlistPathFor } from "./index";
import { validatePlaylist } from "./testing/playlistShape";

const ROOT = join(__dirname, "../../../..");

function find(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) find(p, out);
    else if (name.endsWith(".audioevent.json")) out.push(p);
  }
  return out;
}

const files = [...find(join(ROOT, "samples")), ...find(join(ROOT, "src/engine/audio/__fixtures__"))];
const texts = new Map(files.map((f) => [relative(ROOT, f).split("\\").join("/"), readFileSync(f, "utf8")]));

describe("every repo audio event migrates", () => {
  it("finds the sample events", () => {
    expect([...texts.keys()].sort()).toEqual([
      "samples/flappy/music/town.audioevent.json",
      "samples/sound-lab/audio/events/engine-single.audioevent.json",
      "samples/sound-lab/audio/events/engine.audioevent.json",
      "samples/sound-lab/audio/events/footstep.audioevent.json",
      "samples/sound-lab/audio/events/music-intensity.audioevent.json",
      "samples/sound-lab/audio/music/music-list3.audioevent.json",
      "samples/sound-lab/audio/music/music-loop.audioevent.json",
      "samples/sound-lab/audio/music/music-playlist.audioevent.json",
      "samples/sound-lab/audio/music/music-stems8.audioevent.json",
      "samples/sound-lab/audio/music/music-world.audioevent.json",
      "samples/sound-lab/audio/music/rhythm-click.audioevent.json",
      "samples/sound-lab/audio/music/rhythm-game.audioevent.json",
    ]);
  });

  for (const withLengths of [false, true]) {
    it(`gives valid playlists ${withLengths ? "with" : "without"} sample lengths`, () => {
      const result = migrateProjectAudioEvents(texts, withLengths ? { sampleSeconds: () => 8 } : {});
      expect(result.deletes.sort()).toEqual([...texts.keys()].sort());
      expect(result.references).toEqual(result.deletes.map((from) => ({ from, to: playlistPathFor(from) })));
      for (const [path, text] of result.writes) {
        const { playlist, problems } = parsePlaylist(JSON.parse(text), path);
        expect(problems, path).toEqual([]);
        expect(playlist.format, path).toBe("myco.playlist@1");
        expect(validatePlaylist(playlist), path).toEqual([]);
      }
    });
  }
});
