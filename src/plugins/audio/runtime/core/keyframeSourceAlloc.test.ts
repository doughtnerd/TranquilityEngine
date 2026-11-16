// FU5 (M5 wave 10 follow-up to So1's soak 1): the keyframe source builds a keyframe without constructing anything: no Set, Map or
// array per keyframe, and every row of every section is a pooled object reused by the next keyframe. Counted by construction
// (constructor and array-builder counters over many keyframes), never by heap deltas. The event runtime's `debugRows` is the
// real one (pooled when given `out`); live events through it are covered by `events/debugRowsRetire.test.ts`.
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { LOUD_OUTPUT_TAP } from "../wire.generated";
import { KeyframeSource, type KeyframeHost, type KeyframeNameId } from "./keyframeSource";
import { VoiceState, VoiceTable } from "./voiceTable";

/** The keyframe bus row's metered flag (§5.5). */
const KF_BUS_METERED = 32;

const NO_NAME = 0xffffffff;

function loudness(paused: boolean) {
  return { paused, incomplete: false, tainted: false, truePeakBound: "exact", momentary: -20, shortTerm: -21, integrated: -22, lra: 3, maxTruePeak: -1, maxMomentary: -18, elapsed: 5 };
}

function rig() {
  const settings = defaultAudioSettings();
  const mixer = new Mixer(settings);
  const names = settings.buses.map((b) => b.name);
  const table = new VoiceTable(8);
  for (let i = 0; i < 3; i++) {
    table.state[i] = VoiceState.PLAYING;
    table.bus[i] = 2;
    table.gen[i] = 1;
  }
  const host = {
    table,
    clips: { info: (): null => null },
    mixer,
    buses: { slots: { slots: names.map((name) => ({ state: "live", name, gen: 0 })), version: 7 } },
    masterVolume: 1,
    hiddenMuted: false,
  } as unknown as KeyframeHost;
  const hub = {
    target: null,
    busLoudness: (name: string) => (name === "Music" || name === names[0] ? loudness(name === "Music") : null),
  } as never;
  const nameId: KeyframeNameId = (_t, name) => name.length;
  return { source: new KeyframeSource(host, hub), nameId };
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

afterEach(() => { /* the counters restore themselves in `finally` */ });

describe("KeyframeSource: no allocation per keyframe (FU5)", () => {
  it("constructs no Set, Map or array over 600 keyframes after warm-up", () => {
    const { source, nameId } = rig();
    for (let i = 0; i < 5; i++) source.read(nameId, NO_NAME); // warm-up: the pools fill, the interning runs
    const c = countConstructions(() => { for (let i = 0; i < 600; i++) source.read(nameId, NO_NAME); });
    expect(c).toEqual({ sets: 0, maps: 0, arrays: 0 });
  });

  it("every section's array and every row is the same object keyframe after keyframe", () => {
    const { source, nameId } = rig();
    const first = source.read(nameId, NO_NAME);
    const arrays = [first.voices, first.buses, first.metered, first.events, first.music];
    const rows = [...first.voices, ...first.buses, ...first.metered];
    expect(first.metered.length).toBe(2); // the output, then Music
    for (let i = 0; i < 50; i++) {
      const p = source.read(nameId, NO_NAME);
      expect(p).toBe(first);
      expect([p.voices, p.buses, p.metered, p.events, p.music]).toEqual(arrays);
      [p.voices, p.buses, p.metered, p.events, p.music].forEach((a, k) => expect(a).toBe(arrays[k]));
      [...p.voices, ...p.buses, ...p.metered].forEach((r, k) => expect(r).toBe(rows[k]));
    }
  });

  it("the metered rows keep their contents: the output first, then the chosen bus, with its pause bit and the mix mask", () => {
    const { source, nameId } = rig();
    source.read(nameId, NO_NAME);
    const p = source.read(nameId, NO_NAME);
    expect(p.metered.map((m) => m.slot)).toEqual([LOUD_OUTPUT_TAP, 1]);
    expect(p.metered.map((m) => m.flags)).toEqual([0, 1]);
    expect(p.metered[0]).toMatchObject({ momentary: -20, shortTerm: -21, integrated: -22, lra: 3, maxTruePeak: -1, maxMomentary: -18, elapsed: 5 });
    expect(p.mix.loudnessPausedMask).toBe(2);
    expect(p.buses.map((b) => (b.flags & KF_BUS_METERED) !== 0)).toEqual([true, true, false, false, false]);
    expect(p.mix.targetIndex).toBe(0);
  });
});
