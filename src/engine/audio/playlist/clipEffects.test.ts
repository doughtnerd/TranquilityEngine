// ADR 0331 levels (the audio core's ABI 4.9): a sequence clip's effect chain runs on a submix of the clip's own, so the
// parse takes the instance level's types (a delay, a reverb) and a gain without a problem; a type no submix runs (the
// ADSR envelope) still gets one.
import { describe, expect, it } from "vitest";
import { parsePlaylist } from "./format";

const seq = (effects: unknown[]) => ({
  format: "myco.playlist@1", type: "sequence", entries: [],
  sequence: { length: 1, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "a.wav", at: 0, length: 0, effects }] }] },
});

describe("a sequence clip's effects (ADR 0331 levels)", () => {
  it("a delay, a reverb and a gain on a clip parse without a problem", () => {
    const { playlist, problems } = parsePlaylist(seq([{ id: "d", type: "delay" }, { id: "r", type: "reverb" }, { id: "g", type: "gain", params: { gain: -3 } }]));
    expect(problems).toEqual([]);
    expect(playlist.sequence!.tracks[0]!.clips[0]!.effects.map((e) => e.type)).toEqual(["delay", "reverb", "gain"]);
  });

  it("an envelope (no submix runs it) is kept with a problem", () => {
    const { problems } = parsePlaylist(seq([{ id: "e", type: "envelope" }]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("can't run at the instance level");
  });
});
