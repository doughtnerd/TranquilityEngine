// ADR 0158 §5 (E3.9): `debugRows(listed)` keeps a retired instance's row while the backend still lists its voices
// (`Audio.debug` passes each event id's listed voices), counts them, never shows two rows for one group, and forgets
// a retired instance once it is not listed. The core end to end is in `core/debugAutomationLoopback.test.ts`.
import { describe, expect, it } from "vitest";
import { Audio } from "../index";
import { events } from "./eventRuntime";
import { clip, eventKit, F } from "./eventTestKit";

const kit = eventKit();

describe("events debug rows go with their last listed voice (E3.9)", () => {
  it("a stopped instance's row stays while listed, yields its group to a new instance, and is then forgotten", async () => {
    await kit.boot({ "e.audioevent.json": { format: F, root: { type: "layer", children: [clip("a.wav"), clip("b.wav")] } } });
    const a = Audio.play("e.audioevent.json");
    const id = events().debugRows()[0]!.id;
    a.stop(0.5);
    // Not playing: without the backend's listing it has no row (as before); listed, it keeps one, counting those voices.
    expect(events().debugRows()).toEqual([]);
    expect(events().debugRows(new Map([[id, 2]]))).toEqual([expect.objectContaining({ id, asset: "e.audioevent.json", voices: 2 })]);
    expect(events().debugRows(new Map([[id, 1]]))[0]!.voices).toBe(1);
    // The next play takes the free group: one row for it, the playing instance's.
    const b = Audio.play("e.audioevent.json");
    expect(events().debugRows(new Map([[id, 4]]))).toEqual([expect.objectContaining({ id, voices: 2 })]);
    b.stop(0);
    // The old instance was forgotten when the new one showed; the newest retired one is the group's row now.
    expect(events().debugRows(new Map([[id, 1]]))).toHaveLength(1);
    // Once not listed, gone for good.
    expect(events().debugRows(new Map())).toEqual([]);
    expect(events().debugRows(new Map([[id, 1]]))).toEqual([]);
  });

  it("an instance whose voices have all ended stays listed until the backend drops them", async () => {
    await kit.boot({ "e.audioevent.json": { format: F, root: clip("a.wav") } });
    Audio.play("e.audioevent.json");
    const id = events().debugRows()[0]!.id;
    kit.fake.voices[0]!.end();
    expect(events().debugRows(new Map([[id, 1]]))).toEqual([expect.objectContaining({ id, voices: 1 })]);
    events().update(0.016); // reaped: retired
    expect(events().debugRows(new Map([[id, 1]]))).toEqual([expect.objectContaining({ id, voices: 1 })]);
    expect(events().debugRows(new Map())).toEqual([]);
  });
});
