import { parsePlaylist } from "../playlist/format";
/**
 * Every audio event the repo had migrates without throwing and gives a structurally valid playlist (ADR 0329): exactly
 * one sample per Clip, Switch maps pointing at real entries, sequence clips with exactly one source. The samples' own
 * events were migrated (their playlists are in `samples/`); the originals are kept here as the migration's fixtures
 * (`__fixtures__/<sample>/...`, read-only).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateProjectAudioEvents, playlistPathFor } from "./index";
import { validatePlaylist } from "./testing/playlistShape";

const ROOT = join(__dirname, "__fixtures__");

function find(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) find(p, out);
    else if (name.endsWith(".audioevent.json")) out.push(p);
  }
  return out;
}

const files = find(ROOT);
const texts = new Map(files.map((f) => [relative(ROOT, f).split("\\").join("/"), readFileSync(f, "utf8")]));

describe("every repo audio event migrates", () => {
  it("finds the samples' old events", () => {
    expect([...texts.keys()].sort()).toEqual([
      "flappy/music/town.audioevent.json",
      "sound-lab/audio/events/engine-single.audioevent.json",
      "sound-lab/audio/events/engine.audioevent.json",
      "sound-lab/audio/events/footstep.audioevent.json",
      "sound-lab/audio/events/music-intensity.audioevent.json",
      "sound-lab/audio/music/music-list3.audioevent.json",
      "sound-lab/audio/music/music-loop.audioevent.json",
      "sound-lab/audio/music/music-playlist.audioevent.json",
      "sound-lab/audio/music/music-stems8.audioevent.json",
      "sound-lab/audio/music/music-world.audioevent.json",
      "sound-lab/audio/music/rhythm-click.audioevent.json",
      "sound-lab/audio/music/rhythm-game.audioevent.json",
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
