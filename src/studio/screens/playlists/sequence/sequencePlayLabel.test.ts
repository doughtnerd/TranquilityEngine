// Sequence W-2 (proto W53): the player bar's Play button names what it will play, by the play mode and the selection.
import { describe, expect, it } from "vitest";
import type { Clip, SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import type { SourceFacts } from "./sequenceModel";
import { EMPTY_SELECTION, selectLoop, selectMarker } from "./sequenceSelection";
import { DEFAULT_TRANSPORT, playLabel, type TransportOptions } from "./transportModel";

const A: SourceFacts = { length: 4, loops: [], markers: [] };
const clip = (id: string, at: number): Clip => ({ id, sample: "a.wav", at, length: 2, offset: 0, gain: 0, pitch: 0, pan: 0, reverse: false, sync: true, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [] });
const track: Track = { id: "t1", name: "Music", kind: "audio", color: 1, volume: 0, pan: 0, output: null, mute: false, solo: false, enabled: true, effects: [], automation: [], clips: [clip("c1", 0), clip("c2", 2)] };
const seq: SequenceSettings = {
  length: 8, tempo: null, tracks: [track],
  loops: [{ id: "l1", start: 1, end: 3, active: "always", exit: "finish", exitFadeMs: 0, reentry: "ignore" }, { id: "h1", start: 5, end: 5, active: "held", exit: "finish", exitFadeMs: 0, reentry: "ignore" }],
  markers: [{ id: "m1", name: "Drop", at: 4 }],
};
const label = (sel = EMPTY_SELECTION, playhead = 0, opts: Partial<TransportOptions> = {}) => playLabel(seq, sel, playhead, { ...DEFAULT_TRANSPORT, ...opts }, () => A);

describe("the Play button's words", () => {
  it("follow the selection in Selection mode: clips, a loop, a hold point, a marker; else the playhead", () => {
    expect(label({ ...EMPTY_SELECTION, focus: "clips", clips: ["c1"] })).toBe("Play clip");
    expect(label({ ...EMPTY_SELECTION, focus: "clips", clips: ["c1", "c2"] })).toBe("Play 2 clips");
    expect(label(selectLoop(EMPTY_SELECTION, "l1"))).toBe("Play loop");
    expect(label(selectLoop(EMPTY_SELECTION, "h1"))).toBe("Play from the hold point");
    expect(label(selectMarker(EMPTY_SELECTION, "m1"))).toBe("Play from Drop");
    expect(label(EMPTY_SELECTION, 2.5)).toBe("Play from the playhead");
    expect(label(EMPTY_SELECTION, 0)).toBe("Play from the start");
  });

  it("follow the mode, a playhead at the end plays from the start, and a pre-roll says so", () => {
    expect(label(EMPTY_SELECTION, 3, { mode: "playhead" })).toBe("Play from the playhead");
    expect(label(EMPTY_SELECTION, 8, { mode: "playhead" })).toBe("Play from the start");
    expect(label({ ...EMPTY_SELECTION, focus: "clips", clips: ["c1"] }, 0, { mode: "start" })).toBe("Play from the start");
    expect(label({ ...EMPTY_SELECTION, focus: "clips", clips: ["c2"] }, 0, { preRoll: true })).toBe("Play clip with pre-roll");
  });
});
