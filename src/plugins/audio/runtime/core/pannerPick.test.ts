// The panner pick over a voice table. H3's HRTF cases (ported from `hrtfPick.test.ts`, which A5 replaced): the top
// `voices.hrtf` mixed spatial voices by audibility, 1.2x hysteresis, unflags before flags, virtual, paused and non-spatial
// voices left out, a freed slot forgotten, a limit of 0 clearing everything, never more than 32. ADR 0162 A5's bed cases
// (R13): kind 2 where the bus has a bed, the 500 ms kind dwell in game time, the bed-to-HRTF exemption, the limit held
// while a dwell holds a voice, a bed removed by a replan.
import { describe, expect, it } from "vitest";
import { KIND_DWELL_MS, MAX_HRTF_VOICES, PannerKind, PannerPick, type PannerSink } from "./pannerPick";
import { HYSTERESIS } from "./selection";
import { VoiceFlag, VoiceReason, VoiceState, VoiceTable } from "./voiceTable";

/** A table of mixed spatial voices with these audibilities, and a pick with a recording sink. */
function setup(audibility: number[], capacity = 64) {
  const table = new VoiceTable(capacity);
  const ids = audibility.map((a) => {
    const id = table.allocate(0, 128, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    table.flags[i] = VoiceFlag.SPATIAL;
    table.audibility[i] = a;
    return id;
  });
  const pick = new PannerPick(table);
  const log: string[] = [];
  // "+" HRTF, "-" equal-power, "b" the bed.
  const sink: PannerSink = { setPanner: (i, kind) => log.push(`${kind === PannerKind.HRTF ? "+" : kind === PannerKind.BED ? "b" : "-"}${i}`) };
  const flagged = () => [...Array(table.capacity).keys()].filter((i) => pick.flag[i] === 1);
  const bedSlot = new Uint8Array(32).fill(0xff);
  let nowMs = 0;
  return {
    table,
    ids,
    pick,
    log,
    sink,
    flagged,
    bedSlot,
    advance: (ms: number) => {
      nowMs += ms;
    },
    run: (n: number) => pick.run({ hrtf: n, bedSlot, nowMs }, sink),
  };
}

describe("PannerPick, HRTF (H3)", () => {
  it("flags the top N by audibility", () => {
    const { run, flagged, log } = setup([0.1, 0.9, 0.5, 0.7, 0.3]);
    expect(run(2)).toBe(2);
    expect(flagged()).toEqual([1, 3]);
    expect(log.sort()).toEqual(["+1", "+3"]);
  });

  it("keeps a flagged voice until another is more than 1.2x louder (hysteresis)", () => {
    const { table, run, flagged, log } = setup([0.5, 0.4]);
    run(1);
    expect(flagged()).toEqual([0]);
    table.audibility[1] = 0.5 * HYSTERESIS * 0.99; // louder, but not by 1.2x
    log.length = 0;
    run(1);
    expect(flagged()).toEqual([0]);
    expect(log).toEqual([]);
    table.audibility[1] = 0.5 * HYSTERESIS * 1.01;
    run(1);
    expect(flagged()).toEqual([1]);
    expect(log).toEqual(["-0", "+1"]); // the unflag goes first
  });

  it("leaves out virtual, paused, non-spatial and inaudible voices, and unflags voices that become so", () => {
    const { table, run, flagged, log } = setup([0.9, 0.8, 0.7, 0.6, 1e-6]);
    table.state[1] = VoiceState.VIRTUAL;
    table.flags[2] = 0; // not spatial
    table.flags[3] = VoiceFlag.SPATIAL | VoiceFlag.PAUSED;
    run(8);
    expect(flagged()).toEqual([0]);
    table.state[0] = VoiceState.VIRTUAL; // demoted by selection
    log.length = 0;
    run(8);
    expect(flagged()).toEqual([]);
    expect(log).toEqual(["-0"]); // still on the core: told
  });

  it("forgets a freed slot without a message, and a reused slot starts unflagged", () => {
    const { table, ids, pick, run, log, flagged } = setup([0.9]);
    run(1);
    expect(pick.panner(0)).toBe(1);
    table.free(ids[0]!, VoiceReason.NONE);
    pick.forget(0);
    expect(pick.panner(0)).toBe(0);
    const id = table.allocate(0, 128, 0, VoiceState.PLAYING);
    expect(id & 0xffff).toBe(0);
    expect(pick.panner(0)).toBe(0);
    table.flags[0] = 0; // the new voice isn't spatial
    log.length = 0;
    run(1);
    expect(flagged()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("a reused slot that wasn't forgotten isn't mistaken for the old voice", () => {
    const { table, ids, pick, run, log } = setup([0.9]);
    run(1);
    table.free(ids[0]!, VoiceReason.NONE); // no forget
    table.allocate(0, 128, 0, VoiceState.PLAYING);
    expect(pick.panner(0)).toBe(0);
    log.length = 0;
    run(1); // non-spatial now (allocate cleared nothing, but flags were 0 after free)
    expect(log.filter((l) => l.startsWith("-"))).toEqual([]);
  });

  it("a limit of 0 unflags everything; the limit is clamped to 32", () => {
    const { run, flagged, log, pick, sink } = setup(Array.from({ length: 40 }, (_, k) => 1 - k / 100));
    expect(run(100)).toBe(MAX_HRTF_VOICES);
    expect(flagged()).toHaveLength(32);
    log.length = 0;
    expect(run(0)).toBe(0);
    expect(flagged()).toEqual([]);
    expect(log).toHaveLength(32);
    expect(log.every((l) => l.startsWith("-"))).toBe(true);
    run(4);
    pick.clear(sink);
    expect(flagged()).toEqual([]);
    expect(pick.count).toBe(0);
  });

  it("never flags more than the limit after one frame's changes, whatever the churn", () => {
    const n = 200;
    const { table, run, flagged } = setup(Array.from({ length: n }, () => Math.random()), 256);
    for (let f = 0; f < 50; f++) {
      for (let i = 0; i < n; i++) table.audibility[i] = Math.random();
      run(16);
      expect(flagged().length).toBe(16);
    }
  });

  it("with no bed anywhere an HRTF voice leaves at once, as M2 (no dwell without a bed)", () => {
    const s = setup([0.5, 0.4]);
    s.run(1);
    s.table.audibility[0] = 0.1;
    s.table.audibility[1] = 0.9;
    s.log.length = 0;
    s.run(1);
    expect(s.log).toEqual(["-0", "+1"]);
  });
});

describe("PannerPick, beds (ADR 0162 A5)", () => {
  type Rig = ReturnType<typeof setup>;
  /** Voices on bus 0, which has a bed in slot 0, with these audibilities. */
  function withBed(audibility: number[]): Rig {
    const s = setup(audibility);
    s.bedSlot[0] = 0;
    return s;
  }
  const kinds = (s: Rig): number[] => s.ids.map((id) => s.pick.panner(id & 0xffff));

  it("sends the voices outside the HRTF top to the bed where their bus has one, the rest equal-power", () => {
    const s = withBed([0.9, 0.5, 0.3, 0.2]);
    s.table.bus[3] = 1; // bus 1 has no bed
    expect(s.run(1)).toBe(1);
    expect(kinds(s)).toEqual([PannerKind.HRTF, PannerKind.BED, PannerKind.BED, PannerKind.EQUAL_POWER]);
    expect(s.pick.bedCount).toBe(2);
    expect(s.log.sort()).toEqual(["+0", "b1", "b2"]);
  });

  it("runs the bed with the HRTF limit 0 (audio.spatial equalPower keeps beds)", () => {
    const s = withBed([0.9, 0.5]);
    expect(s.run(0)).toBe(0);
    expect(kinds(s)).toEqual([PannerKind.BED, PannerKind.BED]);
  });

  it("holds an HRTF voice that left the top until 500 ms of game time after its last change, then the bed", () => {
    const s = withBed([0.5, 0.4]);
    s.run(1);
    expect(kinds(s)).toEqual([PannerKind.HRTF, PannerKind.BED]);
    s.advance(KIND_DWELL_MS - 100); // voice 0 has been HRTF for 400 ms
    s.table.audibility[0] = 0.1;
    s.table.audibility[1] = 0.9; // the other is now much louder
    s.log.length = 0;
    s.run(1);
    // voice 0 is held; the limit is 1, so voice 1 waits for the slot: never two HRTF voices
    expect(kinds(s)).toEqual([PannerKind.HRTF, PannerKind.BED]);
    expect(s.pick.count).toBe(1);
    expect(s.log).toEqual([]);
    s.advance(100);
    s.run(1);
    expect(kinds(s)).toEqual([PannerKind.BED, PannerKind.HRTF]);
    expect(s.log).toEqual(["b0", "+1"]); // the demotion goes first
  });

  it("a bed voice takes a free HRTF slot at once, whatever its dwell (bed to HRTF is exempt)", () => {
    const s = withBed([0.9, 0.2]);
    s.run(1);
    expect(kinds(s)).toEqual([PannerKind.HRTF, PannerKind.BED]);
    s.advance(1); // voice 1 has been on the bed for 1 ms
    s.run(2); // the limit rose: a slot is free
    expect(kinds(s)).toEqual([PannerKind.HRTF, PannerKind.HRTF]);
    expect(s.pick.count).toBe(2);
  });

  it("a first kind has no dwell: a new voice starts HRTF or on the bed at once", () => {
    const s = withBed([0.9]);
    s.run(1);
    expect(kinds(s)).toEqual([PannerKind.HRTF]);
    const id = s.table.allocate(0, 128, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    s.table.flags[i] = VoiceFlag.SPATIAL;
    s.table.audibility[i] = 0.1;
    s.run(1);
    expect(s.pick.panner(i)).toBe(PannerKind.BED);
  });

  it("never holds more HRTF voices than the limit, even when the limit drops", () => {
    const s = withBed(Array.from({ length: 12 }, (_, k) => 1 - k / 20));
    s.run(8);
    expect(s.pick.count).toBe(8);
    s.advance(10);
    s.run(4); // held voices past the new limit don't stay
    expect(s.pick.count).toBe(4);
    for (let f = 0; f < 40; f++) {
      s.advance(30);
      for (let i = 0; i < 12; i++) s.table.audibility[i] = Math.random();
      s.run(4);
      expect(s.pick.count).toBeLessThanOrEqual(4);
    }
  });

  it("a replan that removes the bus's bed puts its bed voices back to equal-power without a wait", () => {
    const s = withBed([0.9, 0.5]);
    s.run(1);
    expect(kinds(s)[1]).toBe(PannerKind.BED);
    s.bedSlot[0] = 0xff;
    s.log.length = 0;
    s.run(1);
    expect(kinds(s)).toEqual([PannerKind.HRTF, PannerKind.EQUAL_POWER]);
    expect(s.log).toEqual(["-1"]);
    expect(s.pick.bedCount).toBe(0);
  });

  it("counts the kind changes that involve the bed, and clear puts every voice back to equal-power", () => {
    const s = withBed([0.9, 0.5]);
    s.run(1); // voice 1: equal-power to bed
    expect(s.pick.bedSwitches).toBe(1);
    s.pick.clear(s.sink);
    expect(kinds(s)).toEqual([PannerKind.EQUAL_POWER, PannerKind.EQUAL_POWER]);
    expect(s.pick.count).toBe(0);
    expect(s.pick.bedCount).toBe(0);
  });

  it("never puts a virtual or paused voice on the bed", () => {
    const s = withBed([0.9, 0.5, 0.4]);
    s.table.state[1] = VoiceState.VIRTUAL;
    s.table.flags[2] = VoiceFlag.SPATIAL | VoiceFlag.PAUSED;
    s.run(1);
    expect(kinds(s)).toEqual([PannerKind.HRTF, PannerKind.EQUAL_POWER, PannerKind.EQUAL_POWER]);
  });
});
