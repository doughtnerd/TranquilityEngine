// ADR 0158 §5 (E3.9): `debugRows(listed)` keeps a retired instance's row while the backend still lists its voices
// (`Audio.debug` passes each event id's listed voices), counts them, never shows two rows for one group, and forgets
// a retired instance once it is not listed. The core end to end is in `core/debugAutomationLoopback.test.ts`.
import { describe, expect, it } from "vitest";
import { Audio } from "../index";
import { events, type EventDebugRow } from "./eventRuntime";
import { clip, eventKit, F } from "./eventTestKit";

const kit = eventKit();

describe("events debug rows go with their last listed voice (E3.9)", () => {
  it("a stopped instance's row stays while listed, keeps its group from a new instance, and is then forgotten", async () => {
    await kit.boot({ "e.audioevent.json": { format: F, root: { type: "layer", children: [clip("a.wav"), clip("b.wav")] } } });
    const a = Audio.play("e.audioevent.json");
    const id = events().debugRows()[0]!.id;
    a.stop(0.5);
    // Not playing: without the backend's listing it has no row (as before); listed, it keeps one, counting those voices.
    expect(events().debugRows()).toEqual([]);
    expect(events().debugRows(new Map([[id, 2]]))).toEqual([expect.objectContaining({ id, asset: "e.audioevent.json", voices: 2 })]);
    expect(events().debugRows(new Map([[id, 1]]))[0]!.voices).toBe(1);
    // E3.10: the next play takes a different group (the old one's voices are still fading): two rows.
    const b = Audio.play("e.audioevent.json");
    const idB = events().debugRows()[0]!.id;
    expect(idB).not.toBe(id);
    expect(events().debugRows(new Map([[id, 2], [idB, 1]]))).toEqual([expect.objectContaining({ id: idB, voices: 2 }), expect.objectContaining({ id, voices: 2 })]);
    b.stop(0);
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

  it("pooled (`out` passed, the keyframe source per keyframe): the same rows, the same objects call after call, and Audio.debug's rows stay fresh", async () => {
    await kit.boot({ "e.audioevent.json": { format: F, root: { type: "layer", children: [clip("a.wav"), clip("b.wav")] } } });
    const a = Audio.play("e.audioevent.json");
    Audio.play("e.audioevent.json");
    const fresh = events().debugRows();
    const out: EventDebugRow[] = [];
    const first = events().debugRows(undefined, out);
    expect(first).toBe(out);
    expect(out).toEqual(fresh);
    const objects = [...out];
    const params = out.map((r) => r.parameters);
    for (let n = 0; n < 5; n++) {
      events().debugRows(undefined, out);
      out.forEach((r, k) => { expect(r).toBe(objects[k]); expect(r.parameters).toBe(params[k]); });
    }
    // A stopped instance still listed keeps its pooled row; the unlisted pass empties `out`.
    const id = out[0]!.id;
    a.stop(0.5);
    events().debugRows(new Map([[id, 2]]), out);
    expect(out).toEqual([expect.objectContaining({ voices: 2 }), expect.objectContaining({ id, voices: 2 })]);
    expect(events().debugRows(undefined, out)).toHaveLength(1);
    // The unpooled rows are not the pool's.
    expect(events().debugRows()[0]).not.toBe(out[0]);
  });
});
