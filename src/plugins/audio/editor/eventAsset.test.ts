import { describe, expect, it } from "vitest";
import {
  AUDIO_EVENT_FORMAT,
  formatAudioEvent,
  parseAudioEvent,
  type AudioEventAsset,
} from "../../../engine/audio/migrate/legacy/eventFormat";
import { audioEventReferences } from "./eventAsset";

/** An event built from a literal root through the engine's lenient parser. */
const eventOf = (root: unknown): AudioEventAsset => parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root }).value;

const clip = (path: string) => ({ type: "clip", clip: path });

/** The clip paths the kind's references extractor reads from the event's saved text. */
const eventClipPaths = (event: AudioEventAsset): readonly string[] => audioEventReferences.read("sfx/x.audioevent.json", formatAudioEvent(event));

describe("audioEventReferences clip paths", () => {
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

describe("audioEventReferences", () => {
  it("reads the clip paths from file text and nothing from invalid JSON", () => {
    const event = eventOf({ type: "sequence", children: [clip("sfx/a.ogg"), clip("sfx/b.ogg")] });
    expect(audioEventReferences.read("sfx/x.audioevent.json", formatAudioEvent(event))).toEqual(["sfx/a.ogg", "sfx/b.ogg"]);
    expect(audioEventReferences.read("sfx/x.audioevent.json", "{ not json")).toEqual([]);
  });
});
