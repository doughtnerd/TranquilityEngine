// ADR 0331: the core backend's instance submix pool, through its interface: the pool size (settings, default 32, the
// core's 64 at most), SUBMIX records (kinds, bypass, catalogue parameters with defaults), refusals (warned once, marked
// in a capture), close, and the replays after a RESET or a new bus tree.
import { describe, expect, it } from "vitest";
import type { Effect } from "../../../../engine/audio/effects/types";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import { SUBMIX_FX_COMPRESSOR, SUBMIX_FX_LOWPASS, SUBMIX_FX_ON, SUBMIXES_MAX, type SubmixEffects } from "../wire.generated";
import { CoreSubmixes, DEFAULT_SUBMIXES, submixEffect } from "./submixes";
import type { ReplayBuilder } from "./replay";

const fx = (type: string, params: Record<string, number> = {}, on = true): Effect => ({ id: type, type, on, params } as Effect);

function rig(pool?: number) {
  const sent: { slot: number; group: number; bus: number; effects: SubmixEffects[] }[] = [];
  const warnings: string[] = [];
  const markers: string[] = [];
  let profile: ProfileSink = NULL_PROFILE_SINK;
  const buses = new Map([["Master", 0], ["SFX", 1], ["Music", 2]]);
  const s = new CoreSubmixes({
    writer: { submix: (slot, group, bus, effects) => void sent.push({ slot, group, bus, effects: effects.map((e) => ({ ...e, p: [...e.p] })) }) },
    session: { maySend: true, mayQueue: true } as never,
    poolSize: () => pool,
    busIndex: (name) => buses.get(name) ?? -1,
    profile: () => profile,
    warnOnce: (_k, m) => void warnings.push(m),
  });
  return { s, sent, warnings, markers, buses, record: () => { profile = { ...NULL_PROFILE_SINK, marker: (t: string) => void markers.push(t) }; } };
}

describe("CoreSubmixes (ADR 0331)", () => {
  it("sends a group's chain as the core's kinds, parameters in the catalogue's order with its defaults", () => {
    const { s, sent } = rig();
    expect(s.capacity).toBe(DEFAULT_SUBMIXES);
    expect(s.open(5, "SFX", [fx("lowpass", { cutoff: 800 }), fx("compressor", { ratio: 6 }, false), fx("chorus")], "a.playlist.json")).toBe(true);
    expect(sent).toHaveLength(1);
    const [rec] = sent;
    expect([rec!.slot, rec!.group, rec!.bus]).toEqual([0, 5, 1]);
    expect(rec!.effects.map((e) => [e.type, e.flags])).toEqual([[SUBMIX_FX_LOWPASS, SUBMIX_FX_ON], [SUBMIX_FX_COMPRESSOR, 0], [0, SUBMIX_FX_ON]]);
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
    expect(records).toEqual([20 + 40]);
    buses.set("Music", 7);
    sent.length = 0;
    s.busesReset();
    expect(sent.map((r) => [r.slot, r.group, r.bus])).toEqual([[1, 9, 7]]);
  });
});
