// Timelines (`myco.timeline@1`, ADR 0371, D46) through their parse and write: the clip track model bound relative to the
// director, without bone tracks.
import { describe, expect, it } from "vitest";
import { emptyTimeline, formatTimeline, parseTimeline, timelineReferences, timelineToJson, type Timeline } from "./timeline";

function timeline(): Timeline {
  return {
    ...emptyTimeline(), name: "Intro", rate: 24, duration: 12, loop: true,
    tracks: [
      { kind: "subclip", target: { nodePath: "Hero", component: "", field: "" }, keys: [{ time: 0, end: 4, clip: "asset:clips/wave.anim.json", offset: 0, speed: 1, blendIn: 0, blendOut: 0.5 }, { time: 3.5, end: 8, clip: "asset:cutscenes/inner.timeline.json", offset: 1, speed: 1, blendIn: 0.5, blendOut: 0 }] },
      { kind: "control", target: { nodePath: "", component: "", field: "" }, keys: [{ time: 2, action: "cameraCut", target: "Cameras/Wide" }, { time: 6, action: "slotPlay", target: "Hero", payload: { slot: "UpperBody", clip: "Wave" } }] },
      { kind: "vec3", target: { nodePath: "Cameras/Wide", component: "engine.Transform", field: "position" }, name: "", curves: [[[0, 0], [12, 5]], [], []] },
      { kind: "audio", target: { nodePath: "", component: "", field: "" }, keys: [{ time: 0, end: 12, audio: "asset:music/intro.playlist.json" }] },
      { kind: "activation", target: { nodePath: "Title", component: "", field: "" }, keys: [{ time: 1, end: 3 }] },
    ],
  };
}

describe("timelines (myco.timeline@1)", () => {
  it("round-trip", () => {
    const x = timeline();
    const read = parseTimeline(JSON.parse(formatTimeline(x)));
    expect(read).toEqual({ value: x, problems: [] });
  });

  it("write only what differs from the defaults", () => {
    expect(timelineToJson(emptyTimeline())).toEqual({ format: "myco.timeline@1", duration: 10, tracks: [] });
    expect(parseTimeline(timelineToJson(emptyTimeline()))).toEqual({ value: emptyTimeline(), problems: [] });
  });

  it("refuse bone tracks, which bind a skeleton rather than the director's nodes", () => {
    const read = parseTimeline({ format: "myco.timeline@1", duration: 1, tracks: [{ kind: "bone", target: { bone: "Hips" } }] }, "a.timeline.json");
    expect(read.problems).toEqual(["a.timeline.json: tracks[0]: a timeline binds nodes, not bones; the bone track is dropped."]);
    expect(read.value.tracks).toEqual([]);
  });

  it("fall back on bad values with one problem each", () => {
    expect(parseTimeline({ format: "myco.timeline@1", duration: "long" }).problems).toEqual(["duration: must be a number; using 1."]);
    expect(parseTimeline({ format: "myco.timeline@1", rate: 0 }).problems).toEqual(["rate: 0 is outside 1..240; using 1."]);
    expect(parseTimeline({ duration: 1 }).problems).toEqual(['format: expected "myco.timeline@1"; reading it anyway.']);
  });

  it("name the clips, timelines and audio they play", () => {
    expect(timelineReferences(timeline())).toEqual(["clips/wave.anim.json", "cutscenes/inner.timeline.json", "music/intro.playlist.json"]);
  });
});
