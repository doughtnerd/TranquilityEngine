import { describe, expect, it } from "vitest";
import {
  AUDIO_EVENT_FORMAT,
  formatAudioEvent,
  parseAudioEvent,
  type AudioEventAsset,
} from "../../../engine/audio/eventFormat";
import { audioEventFormat, audioEventReferences, eventClipPaths, renameEventClips } from "./eventAsset";

/** An event built from a literal root through the engine's lenient parser. */
const eventOf = (root: unknown): AudioEventAsset => parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root }).value;

const clip = (path: string) => ({ type: "clip", clip: path });

describe("audioEventFormat", () => {
  it("parses a valid event with no problems and formats it back to the same value", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT,
      bus: "SFX",
      volume: 0.8,
      root: { type: "random", avoidRepeat: 1, children: [clip("sfx/a.ogg"), clip("sfx/b.ogg")] },
    });
    expect(problems).toEqual([]);

    const text = audioEventFormat.format(value);
    const again = audioEventFormat.parse(JSON.parse(text), "x.audioevent.json");
    expect(again.value).toEqual(value);
    expect(again.problems).toEqual([]);
    expect(text).toBe(formatAudioEvent(value));
  });

  it("reports parse problems as { message } and never throws, for undefined and for junk", () => {
    for (const raw of [undefined, "junk"]) {
      const read = audioEventFormat.parse(raw, "x.audioevent.json");
      expect(read.problems.length).toBeGreaterThan(0);
      for (const problem of read.problems) expect(typeof problem.message).toBe("string");
      expect(read.value.root.type).toBe("layer");
    }
  });
});

describe("eventClipPaths", () => {
  it("lists clips at every depth, once each, in tree order", () => {
    const event = eventOf({
      type: "random",
      children: [
        { type: "sequence", children: [clip("sfx/b.ogg"), clip("sfx/a.ogg")] },
        clip("sfx/c.ogg"),
        { type: "sequence", children: [clip("sfx/a.ogg")] },
      ],
    });
    expect(eventClipPaths(event)).toEqual(["sfx/b.ogg", "sfx/a.ogg", "sfx/c.ogg"]);
  });

  it("includes the start, loop and end slots of a sustain node", () => {
    const event = eventOf({
      type: "sustain",
      start: clip("s.ogg"),
      loop: clip("l.ogg"),
      end: clip("e.ogg"),
    });
    expect(eventClipPaths(event)).toEqual(["s.ogg", "l.ogg", "e.ogg"]);
  });

  it("leaves out empty paths", () => {
    const event = eventOf({ type: "layer", children: [clip(""), clip("x.ogg")] });
    expect(eventClipPaths(event)).toEqual(["x.ogg"]);
  });
});

describe("renameEventClips", () => {
  const event = eventOf({
    type: "layer",
    children: [
      { type: "random", children: [clip("a.ogg"), clip("keep.ogg")] },
      { type: "sustain", start: clip("a.ogg"), loop: clip("loop.ogg"), end: clip("a.ogg") },
    ],
  });

  it("rewrites every matching clip, including nested and sustain slots, without touching others", () => {
    const renamed = renameEventClips(event, new Map([["a.ogg", "moved/a.ogg"]]));
    expect(eventClipPaths(renamed)).toEqual(["moved/a.ogg", "keep.ogg", "loop.ogg"]);
    expect(renamed.root).toMatchObject({
      type: "layer",
      children: [
        { type: "random", children: [{ clip: "moved/a.ogg" }, { clip: "keep.ogg" }] },
        { type: "sustain", start: { clip: "moved/a.ogg" }, loop: { clip: "loop.ogg" }, end: { clip: "moved/a.ogg" } },
      ],
    });
  });

  it("does not modify its input", () => {
    const before = JSON.stringify(event);
    renameEventClips(event, new Map([["a.ogg", "moved/a.ogg"]]));
    expect(JSON.stringify(event)).toBe(before);
  });

  it("returns an equal event when nothing matches", () => {
    const renamed = renameEventClips(event, new Map([["nope.ogg", "x.ogg"]]));
    expect(renamed).toEqual(event);
  });
});

describe("audioEventReferences", () => {
  it("reads the clip paths from file text and nothing from invalid JSON", () => {
    const event = eventOf({ type: "sequence", children: [clip("sfx/a.ogg"), clip("sfx/b.ogg")] });
    expect(audioEventReferences.read("sfx/x.audioevent.json", formatAudioEvent(event))).toEqual(["sfx/a.ogg", "sfx/b.ogg"]);
    expect(audioEventReferences.read("sfx/x.audioevent.json", "{ not json")).toEqual([]);
  });
});
