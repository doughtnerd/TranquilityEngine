// ADR 0249: the event rows (the playlist runtime's instances, ADR 0343) and the music section are composed once above the
// backend seam, for `Audio.debug()` and the capture's keyframe, whichever backend plays. The keyframe half keeps FU5's rule (no Set, Map or array per keyframe; every row a
// pooled object), counted by construction, never by heap deltas.
import { describe, expect, it } from "vitest";
import type { AudioCaptureSource, BackendKeyframe } from "./backend";
import { KEYFRAME_PITCH_ONE, NO_NAME } from "./capture/keyframeLayout";
import { debugRows, KeyframeRows } from "./audioRows";
import { Audio } from "./Audio";
import { eventKit, pla, sample } from "./playlists/testKit";

const kit = eventKit();

/** Boots with two playlists and plays each once: two instances. */
async function twoPlaying(): Promise<void> {
  await kit.boot({ "p.playlist.json": pla("clip", [sample("a.wav")]), "q.playlist.json": pla("clip", [sample("b.wav")]) });
  Audio.play("p.playlist.json");
  Audio.play("q.playlist.json");
}

/** A backend's keyframe: one voice of instance 9, nothing else. */
function source(): AudioCaptureSource & { calls: number } {
  const k: BackendKeyframe = {
    voices: [{ id: 1, clip: 0, slot: 0, state: 0, priority: 0, reason: 0, gain: 1, pitch: KEYFRAME_PITCH_ONE, audibility: 0, playheadFrames: 0 }],
    buses: [], metered: [], eventVoices: new Map([[9, 1]]),
    mix: { slotTableVersion: 3, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: NO_NAME, masterVolume: 1, hiddenMute: 0 },
  };
  const s = { calls: 0, recorderTap: null, setProfileSink() {}, keyframe: () => (s.calls++, k) };
  return s;
}

/** Counts constructions of Set and Map, and the array builders a keyframe could reach, for the length of `body`. */
function countConstructions(body: () => void): { sets: number; maps: number; arrays: number } {
  const g = globalThis as unknown as { Set: SetConstructor; Map: MapConstructor };
  const RealSet = g.Set, RealMap = g.Map;
  const c = { sets: 0, maps: 0, arrays: 0 };
  class CountedSet<T> extends RealSet<T> { constructor(v?: Iterable<T> | null) { super(v); c.sets++; } }
  class CountedMap<K, V> extends RealMap<K, V> { constructor(v?: Iterable<readonly [K, V]> | null) { super(v); c.maps++; } }
  const patched: [object, string, unknown][] = [];
  const wrap = (owner: object, key: string): void => {
    const real = (owner as Record<string, unknown>)[key] as (...a: unknown[]) => unknown;
    patched.push([owner, key, real]);
    (owner as Record<string, unknown>)[key] = function (this: unknown, ...a: unknown[]) { c.arrays++; return real.apply(this, a); };
  };
  g.Set = CountedSet as unknown as SetConstructor;
  g.Map = CountedMap as unknown as MapConstructor;
  for (const k of ["map", "filter", "slice", "concat", "flat", "flatMap", "splice", "toSorted"]) wrap(Array.prototype, k);
  for (const k of ["from", "of"]) wrap(Array, k);
  for (const k of ["keys", "values", "entries"]) wrap(Object, k);
  try { body(); } finally {
    g.Set = RealSet;
    g.Map = RealMap;
    for (const [owner, key, real] of patched) (owner as Record<string, unknown>)[key] = real;
  }
  return c;
}

describe("KeyframeRows (the capture's keyframe, ADR 0249)", () => {
  it("passes the backend's sections through and adds one event row per playing playlist instance; no music rows", async () => {
    const src = source();
    const rows = new KeyframeRows(src, { time: 1 });
    let p = rows.read((_t, name) => name.length, NO_NAME);
    expect(p.events).toEqual([]); // no instance plays: the backend's voice counts alone make no row
    await twoPlaying();
    p = rows.read((_t, name) => name.length, NO_NAME);
    expect(src.calls).toBe(2);
    expect(p.voices.map((v) => v.id)).toEqual([1]);
    expect(p.mix.slotTableVersion).toBe(3);
    expect(p.events.map((e) => [e.asset, e.voices])).toEqual([["p.playlist.json".length, 1], ["q.playlist.json".length, 1]]);
    expect(p.music).toEqual([]);
  });

  it("builds nothing per keyframe after warm-up, and reuses its arrays and rows", async () => {
    await twoPlaying();
    const rows = new KeyframeRows(source(), { time: 1 });
    const nameId = (_t: string, name: string): number => name.length;
    const first = rows.read(nameId, NO_NAME);
    const events = [...first.events];
    const arrays = [first.events, first.music];
    for (let i = 0; i < 5; i++) rows.read(nameId, NO_NAME);
    const c = countConstructions(() => { for (let i = 0; i < 600; i++) rows.read(nameId, NO_NAME); });
    expect(c).toEqual({ sets: 0, maps: 0, arrays: 0 });
    const p = rows.read(nameId, NO_NAME);
    expect(p).toBe(first);
    [p.events, p.music].forEach((a, k) => expect(a).toBe(arrays[k]));
    p.events.forEach((r, k) => expect(r).toBe(events[k]));
  });
});

describe("debugRows (Audio.debug()'s event rows and music section, ADR 0249)", () => {
  it("a backend with music gets an empty music section and totals from its own view; the instances are event rows", async () => {
    await twoPlaying();
    const b = kit.fake;
    const rows = debugRows(b.debug(), b);
    expect(rows.music).toEqual([]);
    expect(rows.musicTotals).toMatchObject({ poolUsed: 0, groupsLate: 0, refusals: {}, stingers: { played: 0, late: 0, skipped: 0, dropped: 0 } });
    expect(rows.events.map((r) => r.asset)).toEqual(["p.playlist.json", "q.playlist.json"]);
    expect(rows.eventTotals).toEqual({ lateStarts: 0 });
    expect(rows.playlistTotals?.lateStarts).toBe(0);
  });

  it("a backend without music (the pending stand-in) reports no music section", async () => {
    await twoPlaying();
    const b = kit.fake;
    b.music = undefined;
    const rows = debugRows(b.debug(), b);
    expect(rows.music).toBeUndefined();
    expect(rows.musicTotals).toBeUndefined();
  });
});
