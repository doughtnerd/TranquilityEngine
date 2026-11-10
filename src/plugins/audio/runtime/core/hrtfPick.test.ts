// H3 (leaf L1): the HRTF assignment over a voice table: the top `voices.hrtf` mixed spatial voices by audibility, 1.2x
// hysteresis, unflags before flags, virtual, paused and non-spatial voices left out, a freed slot forgotten, a limit of
// 0 clearing everything, and never more than 32.
import { describe, expect, it } from "vitest";
import { HrtfPick, MAX_HRTF_VOICES, type HrtfSink } from "./hrtfPick";
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
  const pick = new HrtfPick(table);
  const log: string[] = [];
  const sink: HrtfSink = { setPanner: (i, on) => log.push(`${on ? "+" : "-"}${i}`) };
  const flagged = () => [...Array(table.capacity).keys()].filter((i) => pick.flag[i] === 1);
  return { table, ids, pick, log, sink, flagged, run: (n: number) => pick.run(n, sink) };
}

describe("HrtfPick (H3)", () => {
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
});
