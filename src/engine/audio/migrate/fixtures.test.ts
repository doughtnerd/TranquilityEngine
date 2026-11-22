import { parsePlaylist } from "../playlist/format";
import { parseDerivedSample } from "../sample/format";
import { parseImportSettings } from "../../scene/importSettings";
/**
 * Every audio event the repo had migrates without throwing and gives a structurally valid playlist (ADR 0329): exactly
 * one sample per Clip, Switch maps pointing at real entries, sequence clips with exactly one source. The samples' own
 * events were migrated (their playlists are in `samples/`); the originals are kept here as the migration's fixtures
 * (`__fixtures__/<sample>/...`, read-only).
 *
 * The Sound Lab's engines were fixed by hand after the first migration (their loop regions became held loops in the
 * samples' sidecars, ADR 0328); the migration now writes what that fix wrote, checked here against the sample's files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { audioFileSeconds } from "./audioDuration";
import { migrateProjectAudioEvents, playlistPathFor } from "./index";
import { validatePlaylist } from "./testing/playlistShape";

const ROOT = join(__dirname, "__fixtures__");
const SAMPLES = join(__dirname, "../../../../samples");

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
    it(`gives valid playlists and sample files ${withLengths ? "with" : "without"} sample lengths`, () => {
      const result = migrateProjectAudioEvents(texts, withLengths ? { sampleSeconds: () => 8 } : {});
      expect(result.deletes.sort()).toEqual([...texts.keys()].sort());
      expect(result.references).toEqual(result.deletes.map((from) => ({ from, to: playlistPathFor(from) })));
      for (const [path, text] of result.writes) {
        if (path.endsWith(".meta.json")) {
          expect(parseImportSettings(JSON.parse(text), path).problems, path).toEqual([]);
          continue;
        }
        if (path.endsWith(".sample.json")) {
          expect(parseDerivedSample(JSON.parse(text), path).problems, path).toEqual([]);
          continue;
        }
        const { playlist, problems } = parsePlaylist(JSON.parse(text), path);
        expect(problems, path).toEqual([]);
        expect(playlist.format, path).toBe("myco.playlist@1");
        expect(validatePlaylist(playlist), path).toEqual([]);
      }
    });
  }
});

describe("the Sound Lab's engines migrate to what they were fixed to by hand", () => {
  const EVENTS = "sound-lab/audio/events";
  const lab = new Map([...texts].filter(([p]) => p.startsWith(`${EVENTS}/engine`)).map(([p, t]) => [p.slice("sound-lab/".length), t]));
  // The samples' real lengths, from their WAV headers, as the driver reads them.
  const seconds = (p: string): number | undefined => {
    const file = join(SAMPLES, "sound-lab", p);
    return existsSync(file) ? audioFileSeconds(new Uint8Array(readFileSync(file))) : undefined;
  };
  const result = migrateProjectAudioEvents(lab, { sampleSeconds: seconds });
  const sampleFile = (p: string) => JSON.parse(readFileSync(join(SAMPLES, "sound-lab", p), "utf8"));
  const withoutIds = (loops: { id: string }[] | undefined) => loops?.map(({ id: _id, ...rest }) => rest);

  for (const name of ["engine", "engine-single"]) {
    it(`${name}.playlist.json equals the sample's`, () => {
      const path = `audio/events/${name}.playlist.json`;
      const mine = parsePlaylist(JSON.parse(result.writes.get(path)!), path);
      const theirs = parsePlaylist(sampleFile(path), path);
      expect(mine.problems).toEqual([]);
      expect(mine.playlist).toEqual(theirs.playlist);
    });
  }

  it("writes the engine samples' sidecars with the hand-fixed loops (ids aside), and nothing else", () => {
    const sidecars = ["engine-high", "engine-idle", "engine-mid", "engine-single"].map((n) => `audio/events/${n}.wav.meta.json`);
    expect(result.samples).toEqual({ newSidecars: sidecars, changedSidecars: [], derived: [] });
    for (const path of sidecars) {
      const mine = parseImportSettings(JSON.parse(result.writes.get(path)!), path);
      const theirs = parseImportSettings(sampleFile(path), path);
      expect(mine.problems, path).toEqual([]);
      expect({ ...mine.settings.sample, loops: withoutIds(mine.settings.sample?.loops) }, path)
        .toEqual({ ...theirs.settings.sample, loops: withoutIds(theirs.settings.sample?.loops) });
      expect({ ...mine.settings, sample: null }, path).toEqual({ ...theirs.settings, sample: null });
    }
  });
});
