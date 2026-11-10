import { describe, expect, it } from "vitest";
import { formatAudioEvent, parseAudioEvent, type AudioEventAsset, type RandomNode } from "../../../engine/audio/eventFormat";
import { createEventFromClips } from "./createEventFromClips";

describe("createEventFromClips", () => {
  it("makes a random root with one clip child per path, in order", () => {
    const { event } = createEventFromClips(["sfx/a.ogg", "sfx/b.ogg", "sfx/c.ogg"]);
    const root = event.root as RandomNode;
    expect(root.type).toBe("random");
    expect(root.mode).toBe("step");
    expect(root.gap).toBe(0);
    expect(root.children.map((c) => (c.type === "clip" ? c.clip : c.type))).toEqual(["sfx/a.ogg", "sfx/b.ogg", "sfx/c.ogg"]);
    for (const c of root.children) expect(c.type).toBe("clip");
  });

  it("drops duplicate paths", () => {
    const { event, name } = createEventFromClips(["sfx/a.ogg", "sfx/b.ogg", "sfx/a.ogg"]);
    const root = event.root as RandomNode;
    expect(root.children.map((c) => (c.type === "clip" ? c.clip : ""))).toEqual(["sfx/a.ogg", "sfx/b.ogg"]);
    expect(name).toBe("New Event");
  });

  it("sets avoidRepeat 1 for two or more clips, 0 for one or none", () => {
    expect((createEventFromClips(["a.ogg", "b.ogg"]).event.root as RandomNode).avoidRepeat).toBe(1);
    expect((createEventFromClips(["a.ogg"]).event.root as RandomNode).avoidRepeat).toBe(0);
    expect((createEventFromClips([]).event.root as RandomNode).avoidRepeat).toBe(0);
  });

  it("carries the event defaults (limit 4 oldest, cooldown 0.05) and a full node base", () => {
    const { event } = createEventFromClips(["sfx/a.ogg", "sfx/b.ogg"]);
    expect(event.format).toBe("myco.audioevent@1");
    expect(event.bus).toBe("");
    expect(event.volume).toBe(1);
    expect(event.pitch).toBe(1);
    expect(event.volumeRandom).toEqual([0, 0]);
    expect(event.pitchRandom).toEqual([0, 0]);
    expect(event.priority).toBe(128);
    expect(event.spatial).toBeUndefined();
    expect(event.limit).toEqual({ maxInstances: 4, steal: "oldest" });
    expect(event.cooldown).toBe(0.05);
    expect(event.parameters).toEqual([]);
    expect(event.automation).toEqual([]);

    const root = event.root as RandomNode;
    const base = { volume: 1, pitch: 1, volumeRandom: [0, 0], pitchRandom: [0, 0], delay: 0, automation: [], weight: 1, fade: 0 };
    expect(root).toMatchObject(base);
    for (const c of root.children) {
      expect(c).toMatchObject({ ...base, type: "clip", loop: false, startOffset: 0, sustain: false });
    }
    // No array is shared between nodes.
    const arrays = [root.volumeRandom, root.pitchRandom, ...root.children.flatMap((c) => [c.volumeRandom, c.pitchRandom])];
    expect(new Set(arrays).size).toBe(arrays.length);
  });

  it("round-trips through formatAudioEvent and parseAudioEvent with no problems", () => {
    const { event } = createEventFromClips(["sfx/step_01.ogg", "sfx/step_02.ogg", "sfx/step_03.ogg"]);
    const { value, problems } = parseAudioEvent(JSON.parse(formatAudioEvent(event)));
    expect(problems).toEqual([]);
    expect(value).toEqual(event as AudioEventAsset);
  });

  it("names the event after what the clips share, minus trailing digits and separators", () => {
    expect(createEventFromClips(["sfx/step_01.ogg", "sfx/step_02.ogg"]).name).toBe("step");
    expect(createEventFromClips(["a/hit-1.wav", "a/hit-2.wav", "a/hit-3.wav"]).name).toBe("hit");
  });

  it("names a single clip after itself, without folder or extension", () => {
    expect(createEventFromClips(["a/hit.wav"]).name).toBe("hit");
    expect(createEventFromClips(["sfx/Door.OGG"]).name).toBe("Door");
  });

  it("falls back to New Event when nothing is shared or there are no clips", () => {
    expect(createEventFromClips(["a.ogg", "b.ogg"]).name).toBe("New Event");
    expect(createEventFromClips([]).name).toBe("New Event");
  });
});
