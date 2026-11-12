// ADR 0166 task SM2: the Sound Lab's music events (samples/sound-lab/audio/music/*.audioevent.json) read from disk. Each parses
// without a problem, its clips exist with the facts the lint needs (read from the WAV headers `tools/makeMusic.mjs` writes),
// and the lint finds nothing: the stems of a segment are one length, nothing needs a ring, no cue is past the audio.
// The rules the world event authors (cut, three crossfade curves, a bridge, two stingers) and the loop event's `while`
// region with a tail are checked here as data. Bridges (R3b), tails (R4a) and the `while` release (R4b) play; the loop
// event's release is played sample-exact on the real core in `src/plugins/audio/runtime/music/regions.loopback.test.ts`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAudioEvent, type AudioEventAsset } from "../audio/eventFormat";
import { isMusicContainer, type MusicNode, type SegmentNode } from "../audio/musicFormat";
import { validateMusic, type MusicClipFacts } from "../audio/musicValidate";

const MUSIC = fileURLToPath(new URL("../../../samples/sound-lab/audio/music/", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../../samples/sound-lab/", import.meta.url));

function load(name: string): { asset: AudioEventAsset; problems: string[] } {
  const { value, problems } = parseAudioEvent(JSON.parse(readFileSync(`${MUSIC}${name}.audioevent.json`, "utf8")));
  return { asset: value, problems };
}

/** The facts of a clip of the sample, from its WAV header. */
function facts(path: string): MusicClipFacts | undefined {
  let b: Buffer;
  try {
    b = readFileSync(`${SAMPLE}${path}`);
  } catch {
    return undefined;
  }
  return { frames: b.readUInt32LE(40) / 2, rate: b.readUInt32LE(24), channels: b.readUInt16LE(22), gapless: true, codec: "pcm", bytes: b.length };
}

const main = (root: MusicNode): SegmentNode[] => (isMusicContainer(root) ? root.children.flatMap(main) : [root]);

describe("the Sound Lab's music events", () => {
  for (const name of ["music-world", "music-loop", "music-playlist"]) {
    it(`${name}: parses without a problem and the lint finds nothing`, () => {
      const { asset, problems } = load(name);
      expect(problems).toEqual([]);
      const root = asset.musicRoot as MusicNode;
      const library = isMusicContainer(root) ? (root.library as SegmentNode[]) : [];
      const v = validateMusic({ segments: main(root), library }, facts);
      expect(v.issues).toEqual([]);
      expect(v.peakRings).toBe(0); // every stem is decoded: no ring is used
    });
  }

  it("the world event: a switch on State with a rule for every pair, the three curves, a cut and a bridge", () => {
    const root = load("music-world").asset.musicRoot;
    if (root?.type !== "musicSwitch") throw new Error("the world event's root is a switch");
    expect(root.children.map((c) => c.id)).toEqual(["explore", "combat", "calm"]);
    const rule = (from: string, to: string) => root.transitions.find((r) => r.from === from && r.to === to);
    expect(rule("explore", "combat")?.fadeOut.amount).toBe(0); // the cut
    expect(rule("combat", "explore")?.fadeOut.curve).toBe("equalPower");
    expect(rule("explore", "calm")?.fadeOut.curve).toBe("linear");
    expect(rule("calm", "explore")?.fadeOut.curve).toBe("sCurve");
    expect(rule("calm", "combat")?.bridge?.segment).toBe("riser");
    expect(root.library.map((s) => s.id).sort()).toEqual(["hit", "riser"]);
    expect(root.stingers.map((s) => [s.trigger, s.at])).toEqual([["hit", "beat"], ["hitBar", "bar"]]);
  });

  it("the loop event: a 2-bar region with a 4-beat tail that loops while Loop is hold", () => {
    const root = load("music-loop").asset.musicRoot as SegmentNode;
    expect(root.regions).toEqual([{ id: "body", from: "1:1:0", to: "3:1:0", count: 0, tailBeats: 4, while: { parameter: "Loop", is: "hold" } }]);
  });

  it("the playlist event: three children, two plays each, forever", () => {
    const root = load("music-playlist").asset.musicRoot;
    if (root?.type !== "playlist") throw new Error("the playlist event's root is a playlist");
    expect(root.children.map((c) => [c.id, (c as SegmentNode).plays])).toEqual([["tour-explore", 2], ["tour-calm", 2], ["tour-combat", 2]]);
    expect(root.rounds).toBe(0);
  });
});
