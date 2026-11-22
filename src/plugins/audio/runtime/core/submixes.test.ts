// ADR 0331: the core backend's instance submix pool, through its interface: the pool size (settings, default 32, the
// core's 64 at most), SUBMIX records (kinds, bypass, catalogue parameters with defaults), refusals (warned once, marked
// in a capture), close, and the replays after a RESET or a new bus tree.
import { describe, expect, it } from "vitest";
import type { Effect } from "../../../../engine/audio/effects/types";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import { SUBMIX_FX_CHORUS, SUBMIX_FX_COMPRESSOR, SUBMIX_FX_LOWPASS, SUBMIX_FX_ON, SUBMIXES_MAX, type SubmixEffects } from "../wire.generated";
import { CoreSubmixes, DEFAULT_SUBMIXES, submixEffect } from "./submixes";
import type { ReplayBuilder } from "./replay";

const fx = (type: string, params: Record<string, number> = {}, on = true): Effect => ({ id: type, type, on, params } as Effect);

function rig(pool?: number) {
  const sent: { slot: number; group: number; bus: number; effects: SubmixEffects[] }[] = [];
  const parents: (number | null)[] = [];
  const keys: string[] = [];
  const clock = { now: 0 };
  const warnings: string[] = [];
  const markers: string[] = [];
  let profile: ProfileSink = NULL_PROFILE_SINK;
  const buses = new Map([["Master", 0], ["SFX", 1], ["Music", 2]]);
  const s = new CoreSubmixes({
    writer: { submix: (slot, group, bus, effects, parent = null) => { sent.push({ slot, group, bus, effects: effects.map((e) => ({ ...e, p: [...e.p] })) }); parents.push(parent); } },
    now: () => clock.now,
    session: { maySend: true, mayQueue: true } as never,
    poolSize: () => pool,
    busIndex: (name) => buses.get(name) ?? -1,
    profile: () => profile,
    warnOnce: (k, m) => { keys.push(k); warnings.push(m); },
  });
  return { s, sent, parents, keys, clock, warnings, markers, buses, record: () => { profile = { ...NULL_PROFILE_SINK, marker: (t: string) => void markers.push(t) }; } };
}

describe("CoreSubmixes (ADR 0331)", () => {
  it("sends a group's chain as the core's kinds, parameters in the catalogue's order with its defaults", () => {
    const { s, sent } = rig();
    expect(s.capacity).toBe(DEFAULT_SUBMIXES);
    expect(s.open(5, "SFX", [fx("lowpass", { cutoff: 800 }), fx("compressor", { ratio: 6 }, false), fx("chorus"), fx("envelope")], "a.playlist.json")).toBe(true);
    expect(sent).toHaveLength(1);
    const [rec] = sent;
    expect([rec!.slot, rec!.group, rec!.bus]).toEqual([0, 5, 1]);
    expect(rec!.effects.map((e) => [e.type, e.flags])).toEqual([[SUBMIX_FX_LOWPASS, SUBMIX_FX_ON], [SUBMIX_FX_COMPRESSOR, 0], [SUBMIX_FX_CHORUS, SUBMIX_FX_ON], [0, SUBMIX_FX_ON]]); // ABI 4.6 runs chorus; envelope is a voice effect
    expect(rec!.effects[2]!.p.slice(0, 3)).toEqual([0.8, 30, 50]); // rate, depth, mix (defaults)
    expect(rec!.effects[0]!.p.slice(0, 3)).toEqual([800, 0.1, 0]); // cutoff, resonance and drive (defaults)
    expect(rec!.effects[1]!.p.slice(0, 6)).toEqual([-18, 6, 10, 120, 0, 30]); // threshold, ratio, attack, release, makeup, knee
    expect(submixEffect(fx("highpass")).p[0]).toBe(20);
  });

  it("refuses past the pool (warned once, marked in a capture) and frees a slot on close", () => {
    const { s, sent, warnings, markers, record } = rig(2);
    record();
    expect(s.open(1, "SFX", [fx("lowpass")], "a")).toBe(true);
    expect(s.open(2, "SFX", [fx("lowpass")], "b")).toBe(true);
    expect(s.open(3, "SFX", [fx("lowpass")], "c")).toBe(false);
    expect(s.refused).toBe(1);
    expect(warnings[0]).toMatch(/"c" plays without its effects.*submixes: 2/);
    expect(markers).toEqual(["submix refused: c (pool of 2 full)"]);
    s.close(1);
    expect(sent.at(-1)).toEqual({ slot: 0, group: 0, bus: 0, effects: [] });
    expect(s.open(3, "SFX", [fx("lowpass")], "c")).toBe(true);
    expect(sent.at(-1)!.slot).toBe(0);
    expect(s.size).toBe(2);
    // Reopening a group reconfigures its slot.
    expect(s.open(3, "Music", [fx("highpass")], "c")).toBe(true);
    expect([sent.at(-1)!.slot, sent.at(-1)!.bus]).toEqual([0, 2]);
    expect(s.size).toBe(2);
  });

  it("clamps the pool to the core's slots; 0 refuses every instance", () => {
    expect(rig(1000).s.capacity).toBe(SUBMIXES_MAX);
    expect(rig(0).s.open(1, "SFX", [fx("lowpass")], "a")).toBe(false);
  });

  it("replays every slot in use after a RESET, and re-sends them with new bus indices after a new tree", () => {
    const { s, sent, buses } = rig();
    s.open(4, "SFX", [fx("lowpass")], "a");
    s.open(9, "Music", [fx("compressor")], "b");
    s.close(4);
    const records: number[] = [];
    s.replayHeader({ record: (bytes: number) => void records.push(bytes) } as unknown as ReplayBuilder);
    expect(records).toEqual([24 + 40]);
    buses.set("Music", 7);
    sent.length = 0;
    s.busesReset();
    expect(sent.map((r) => [r.slot, r.group, r.bus])).toEqual([[1, 9, 7]]);
  });
});

describe("CoreSubmixes levels and tails (ADR 0331, ABI 4.9)", () => {
  const delay = fx("delay", { time: 500, feedback: 50 });

  it("a level's submix has no group, feeds its parent level, and is reused by its key without a resend", () => {
    const { s, sent, parents } = rig();
    expect(s.open(5, "SFX", [fx("lowpass")], "a")).toBe(true);
    const root = s.levelOf(5)!;
    expect(root.slot).toBe(0);
    const nested = s.openLevel(5, "a>b", "SFX", [fx("eq")], root, "b")!;
    const clip = s.openLevel(5, "a/clip:c", "SFX", [delay], nested, "c")!;
    expect([nested.slot, clip.slot]).toEqual([1, 2]);
    expect(sent.slice(1).map((r) => [r.slot, r.group, r.bus])).toEqual([[1, 0, 1], [2, 0, 1]]);
    expect(parents.slice(1)).toEqual([0, 1]);
    // Played again with the same effects list: the same slot, nothing sent.
    const effects = [fx("gain")];
    const again = s.openLevel(5, "x", "SFX", effects, null, "x")!;
    const n = sent.length;
    expect(s.openLevel(5, "x", "SFX", effects, null, "x")).toBe(again);
    expect(sent).toHaveLength(n);
    // Another instance's level of the same key is its own.
    expect(s.openLevel(6, "x", "SFX", effects, null, "x")!.slot).not.toBe(again.slot);
    expect(s.levelOf(6)).toBeNull();
  });

  it("close frees tail-less chains at once and lets a delay ring out ungrouped until its tail is over", () => {
    const { s, sent, clock } = rig();
    s.open(5, "SFX", [delay], "a");
    s.openLevel(5, "lvl", "SFX", [fx("lowpass")], s.levelOf(5), "lvl");
    s.open(6, "SFX", [fx("lowpass")], "b");
    sent.length = 0;
    s.close(6);
    expect(sent).toEqual([{ slot: 2, group: 0, bus: 0, effects: [] }]); // freed at once
    sent.length = 0;
    s.close(5);
    // The instance's slots ring out together: the root slot loses its group (no new voices), the level keeps its chain.
    expect(sent.map((r) => [r.slot, r.group, r.effects.length])).toEqual([[0, 0, 1]]);
    expect(s.size).toBe(2);
    expect(s.levelOf(5)).toBeNull();
    // 500 ms at 50 % feedback falls 80 dB in ~7.1 s: still held at 5 s, freed (both) when asked for a slot after it.
    clock.now = 5;
    s.open(7, "SFX", [fx("lowpass")], "c");
    expect(s.size).toBe(3);
    clock.now = 8;
    sent.length = 0;
    s.open(8, "SFX", [fx("lowpass")], "d");
    expect(sent.filter((r) => r.effects.length === 0).map((r) => r.slot).sort()).toEqual([0, 1]);
    expect(s.size).toBe(2);
  });

  it("a full pool frees the ringing instance nearest its end before it refuses, and warns once", () => {
    const { s, keys, clock } = rig(2);
    s.open(1, "SFX", [delay], "a");
    s.close(1);
    clock.now = 1;
    expect(s.open(2, "SFX", [fx("lowpass")], "b")).toBe(true);
    expect(s.open(3, "SFX", [fx("lowpass")], "c")).toBe(true); // took the ringing slot
    expect(s.openLevel(3, "k", "SFX", [fx("eq")], null, "c/k")).toBeNull();
    expect(s.open(4, "SFX", [fx("lowpass")], "d")).toBe(false);
    expect(keys.filter((k) => k === "submix-full")).toHaveLength(2); // one key: the host's warnOnce says it once
    expect(s.refused).toBe(2);
  });
});
