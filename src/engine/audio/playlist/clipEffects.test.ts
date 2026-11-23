// ADR 0345 levels (the audio core's ABI 4.9): a sequence clip's effect chain runs on a submix of the clip's own, so the
// parse takes the instance level's types (a delay, a reverb) and a gain without a problem; ADR 0362: the Amp envelope
// runs on the clip's voices (ABI 6.1), so it parses without one too. A voice-only type nothing runs on a clip still gets one.
import { describe, expect, it } from "vitest";
import { parsePlaylist } from "./format";

const seq = (effects: unknown[]) => ({
  format: "myco.playlist@1", type: "sequence", entries: [],
  sequence: { length: 1, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "a.wav", at: 0, length: 0, effects }] }] },
});

describe("a sequence clip's effects (ADR 0345 levels)", () => {
  it("a delay, a reverb and a gain on a clip parse without a problem", () => {
    const { playlist, problems } = parsePlaylist(seq([{ id: "d", type: "delay" }, { id: "r", type: "reverb" }, { id: "g", type: "gain", params: { gain: -3 } }]));
    expect(problems).toEqual([]);
    expect(playlist.sequence!.tracks[0]!.clips[0]!.effects.map((e) => e.type)).toEqual(["delay", "reverb", "gain"]);
  });

  it("an Amp envelope (ADR 0362: the clip's voices run it) parses without a problem, its hold included", () => {
    const { playlist, problems } = parsePlaylist(seq([{ id: "e", type: "envelope", params: { attack: 10, hold: 20, release: 300 } }]));
    expect(problems).toEqual([]);
    expect(playlist.sequence!.tracks[0]!.clips[0]!.effects[0]!.params).toMatchObject({ attack: 10, hold: 20, release: 300 });
  });

  it("a sample-only type (fades) is kept with a problem", () => {
    const { problems } = parsePlaylist(seq([{ id: "f", type: "fades" }]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("can't run at the instance level");
  });
});
