// A3.1: the voice selection over a voice table (api-and-models §3 "Selection"): the top `cap` by audibility,
// hysteresis 1.2x, a 3-frame dwell, forced virtual voices (inaudible Worlds, paused), bus gains and mute, the priority
// weight, a dropping cap, MIN_AUDIBILITY, the core's demote, and steals past a bus's `maxVoices`.
import { describe, expect, it } from "vitest";
import { listenerSpaceDirection } from "./spatial";
import { DWELL_FRAMES, effectiveMixedCap, HYSTERESIS, ListenerBasis, MIN_AUDIBILITY, priorityWeight, rankTop, SCORE_BUDGET, SCORE_RATIO, Selection, type SelectionSink } from "./selection";
import { VoiceFlag, VoiceReason, VoiceState, VoiceTable } from "./voiceTable";

/** A sink that records the changes and frees stolen slots as the backend does. */
function recorder(table: VoiceTable) {
  const log: string[] = [];
  const sink: SelectionSink = {
    setMixed: (i, mixed) => log.push(`${mixed ? "+" : "-"}${i}`),
    steal: (i) => {
      log.push(`x${i}`);
      table.free(((table.gen[i]! << 16) | i) >>> 0, VoiceReason.STOLEN);
    },
  };
  return { log, sink };
}

/** A table and selection with `gains.length` voices on the core, admitted in order under `cap`. */
function setup(gains: number[], cap: number, capacity = 64) {
  const table = new VoiceTable(capacity);
  const sel = new Selection(table);
  const ids = gains.map((g) => {
    const id = table.allocate(0, 0, 0, VoiceState.WAITING_FOR_DATA);
    const i = id & 0xffff;
    table.gain[i] = g;
    const mixed = sel.admit(i, cap);
    // As `coreBackend.launch` does.
    table.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
    table.reason[i] = mixed ? VoiceReason.NONE : VoiceReason.VIRTUAL;
    return id;
  });
  const { log, sink } = recorder(table);
  return { table, sel, ids, log, sink, run: (c = cap) => sel.run(c, sink) };
}

const mixedSlots = (t: VoiceTable): number[] => [...Array(t.capacity).keys()].filter((i) => t.state[i] === VoiceState.PLAYING);

describe("Selection (A3.1)", () => {
  it("admits voices mixed while there is room, then virtual", () => {
    const { table } = setup([1, 1, 1, 1, 1], 3);
    expect(mixedSlots(table)).toEqual([0, 1, 2]);
    expect(table.state[3]).toBe(VoiceState.VIRTUAL);
  });

  it("keeps the `cap` loudest mixed, swapping in louder voices admitted virtual in the same frame", () => {
    const { table, run, log } = setup([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], 4);
    expect(mixedSlots(table)).toEqual([0, 1, 2, 3]);
    const stats = run();
    expect(mixedSlots(table)).toEqual([6, 7, 8, 9]);
    expect(stats).toMatchObject({ candidates: 10, mixed: 4, promoted: 4, demoted: 4 });
    expect(log.filter((e) => e.startsWith("+")).sort()).toEqual(["+6", "+7", "+8", "+9"]);
    expect(table.reason[0]).toBe(VoiceReason.VIRTUAL);
    expect(table.reason[9]).toBe(VoiceReason.NONE);
    // Steady: nothing changes on later frames.
    log.length = 0;
    for (let f = 0; f < 10; f++) run();
    expect(log).toEqual([]);
  });

  it("hysteresis: a virtual voice replaces a mixed one only when more than 1.2x louder", () => {
    const { table, run, log } = setup([1.0, 1.1], 1);
    for (let f = 0; f < 5; f++) run();
    expect(mixedSlots(table)).toEqual([0]);
    expect(log).toEqual([]);
    table.gain[1] = HYSTERESIS * 1.0 + 0.01;
    run();
    expect(mixedSlots(table)).toEqual([1]);
    expect(log).toEqual(["-0", "+1"]);
  });

  it("dwell: a voice that just changed keeps its state for 3 frames", () => {
    const { table, run, log } = setup([1, 0.1], 1);
    run();
    table.gain[1] = 2; // much louder: swap now (both settled)
    run();
    expect(mixedSlots(table)).toEqual([1]);
    log.length = 0;
    table.gain[0] = 10; // now 0 is far louder, but both just changed
    for (let f = 1; f < DWELL_FRAMES; f++) {
      run();
      expect(mixedSlots(table), `frame ${f} after the change`).toEqual([1]);
    }
    run();
    expect(mixedSlots(table)).toEqual([0]);
    expect(log).toEqual(["-1", "+0"]);
  });

  it("voices of an inaudible World go virtual at once, and come back after the dwell", () => {
    const table = new VoiceTable(8);
    const sel = new Selection(table);
    const { log, sink } = recorder(table);
    const a = table.allocate(0, 128, 3, VoiceState.WAITING_FOR_DATA) & 0xffff;
    const b = table.allocate(0, 128, 0, VoiceState.WAITING_FOR_DATA) & 0xffff;
    for (const i of [a, b]) {
      table.gain[i] = 1;
      table.state[i] = sel.admit(i, 8) ? VoiceState.PLAYING : VoiceState.VIRTUAL;
      table.reason[i] = VoiceReason.NONE;
    }
    sel.run(8, sink);
    log.length = 0;
    sel.setWorldAudible(3, false);
    sel.setWorldAudible(0, false); // key 0 can't be made inaudible
    sel.run(8, sink);
    expect(log).toEqual([`-${a}`]);
    expect(table.reason[a]).toBe(VoiceReason.VIRTUAL);
    expect(table.audibility[a]).toBe(0);
    expect(table.state[b]).toBe(VoiceState.PLAYING);
    sel.setWorldAudible(3, true);
    log.length = 0;
    for (let f = 1; f < DWELL_FRAMES; f++) sel.run(8, sink);
    expect(log).toEqual([]);
    sel.run(8, sink);
    expect(log).toEqual([`+${a}`]);
  });

  it("a paused voice is virtual whatever the room", () => {
    const { table, run, log } = setup([1, 1], 4);
    run();
    table.flags[0]! |= VoiceFlag.PAUSED;
    run();
    expect(log).toEqual(["-0"]);
    expect(table.audibility[0]).toBe(0);
  });

  it("audibility is gain x fade x bus effective gain x the priority weight", () => {
    const { table, sel, run } = setup([0.5], 4);
    table.fadeGain[0] = 0.5;
    table.priority[0] = 255;
    table.bus[0] = 2;
    sel.busGain[2] = 0.8;
    run();
    expect(table.audibility[0]).toBeCloseTo(0.5 * 0.5 * 0.8 * 2, 6);
    expect(priorityWeight(0)).toBe(1);
    expect(priorityWeight(255)).toBe(2);
  });

  it("priority raises audibility mildly: equal gains, the higher priority is mixed", () => {
    const table = new VoiceTable(8);
    const sel = new Selection(table);
    const { sink } = recorder(table);
    const low = table.allocate(0, 0, 0, VoiceState.VIRTUAL) & 0xffff;
    const high = table.allocate(0, 255, 0, VoiceState.VIRTUAL) & 0xffff;
    table.gain[low] = 1;
    table.gain[high] = 1;
    sel.run(1, sink);
    expect(mixedSlots(table)).toEqual([high]);
  });

  it("a muted bus makes its voices virtual with reason busMuted", () => {
    const { table, sel, run } = setup([1, 1], 4);
    table.bus[1] = 1;
    run();
    sel.busGain[1] = 0;
    for (let f = 0; f < DWELL_FRAMES; f++) run();
    expect(table.state[1]).toBe(VoiceState.VIRTUAL);
    expect(table.reason[1]).toBe(VoiceReason.BUS_MUTED);
    expect(table.state[0]).toBe(VoiceState.PLAYING);
  });

  it("a cap that drops below the voices kept by their dwell demotes the quietest of them", () => {
    const { table, run, log } = setup([0.1, 0.2, 0.3, 0.4], 4);
    run(); // all admitted mixed: the dwell exemption from admit is spent here, nothing changes
    expect(log).toEqual([]);
    run(2);
    expect(mixedSlots(table)).toEqual([2, 3]);
    expect(log.sort()).toEqual(["-0", "-1"]);
  });

  it("never promotes a voice below MIN_AUDIBILITY, and demotes a settled mixed one that fell silent", () => {
    const { table, run, log } = setup([0, 1], 4);
    expect(table.state[0]).toBe(VoiceState.VIRTUAL);
    for (let f = 0; f < 5; f++) run();
    expect(table.state[0]).toBe(VoiceState.VIRTUAL);
    table.gain[1] = MIN_AUDIBILITY / 10;
    run();
    expect(log).toEqual(["-1"]);
  });

  it("the core's demote (STATUS `demoted`) restarts the dwell: no re-promote for 3 frames", () => {
    const { table, run, log, ids } = setup([1, 1], 4);
    run();
    table.markDemoted(ids[0]!);
    for (let f = 1; f < DWELL_FRAMES; f++) run();
    expect(log).toEqual([]);
    run();
    expect(log).toEqual(["+0"]);
  });

  it("steals the excess past a bus's maxVoices, lowest priority then lowest audibility", () => {
    const table = new VoiceTable(16);
    const sel = new Selection(table);
    const { log, sink } = recorder(table);
    const prio = [100, 50, 50, 200, 10];
    const slots = prio.map((p, k) => {
      const i = table.allocate(1, p, 0, VoiceState.VIRTUAL) & 0xffff;
      table.gain[i] = k === 1 ? 0.5 : 1;
      return i;
    });
    const other = table.allocate(0, 0, 0, VoiceState.VIRTUAL) & 0xffff;
    table.gain[other] = 1;
    table.setBusLimits([0, 2]);
    sel.run(16, sink);
    expect(sel.stats.stolen).toBe(3);
    // 10 first, then of the two at 50 the quieter, then the other 50.
    expect(log.filter((e) => e.startsWith("x"))).toEqual([`x${slots[4]}`, `x${slots[1]}`, `x${slots[2]}`]);
    expect(table.busLive[1]).toBe(2);
    expect(table.endedReason(((table.gen[slots[4]!]! - 1) << 16) | slots[4]!)).toBe(VoiceReason.STOLEN);
    expect(table.state[other]).not.toBe(VoiceState.FREE);
  });

  it("STOPPING voices count towards a bus's excess and are left alone", () => {
    const table = new VoiceTable(8);
    const sel = new Selection(table);
    const { log, sink } = recorder(table);
    const a = table.allocate(0, 10, 0, VoiceState.PLAYING);
    table.allocate(0, 20, 0, VoiceState.PLAYING);
    table.requestStop(a, 0.1);
    table.setBusLimits([1]);
    sel.run(8, sink);
    expect(log.filter((e) => e.startsWith("x"))).toEqual([]);
  });

  it("records steals in the table's recent-steals ring with the selection frame", () => {
    const table = new VoiceTable(4);
    const sel = new Selection(table);
    const { sink } = recorder(table);
    for (let k = 0; k < 4; k++) table.allocate(0, 10, 0, VoiceState.VIRTUAL);
    sel.run(4, sink);
    sel.run(4, sink);
    const id = table.allocate(0, 200, 5, VoiceState.VIRTUAL); // full: steals one
    expect(id).not.toBe(0);
    expect(table.stolenSize).toBe(1);
    expect(table.stolenFrame[0]).toBe(2);
    expect(table.stolenPriority[0]).toBe(10);
  });

  it("allocates nothing per frame: the same scratch arrays, steady over many frames", () => {
    const { sel, run, table } = setup(Array.from({ length: 64 }, (_, k) => (k + 1) / 64), 16, 64);
    const keys = (sel as unknown as { keys: Float32Array }).keys;
    for (let f = 0; f < 1000; f++) {
      table.gain[f % 64] = ((f * 7919) % 64) / 64;
      run();
    }
    expect((sel as unknown as { keys: Float32Array }).keys).toBe(keys);
    expect(mixedSlots(table).length).toBeLessThanOrEqual(16);
  });

  it("rankTop and effectiveMixedCap", () => {
    const keys = Float32Array.from([1, 5, 3, 4]);
    const items = Uint16Array.from([0, 1, 2, 3]);
    expect(rankTop(keys, items, 4, 2)).toBe(2);
    expect([...items.subarray(0, 2)].sort()).toEqual([1, 3]);
    expect(rankTop(keys, items, 4, 10)).toBe(4);
    expect(rankTop(keys, items, 4, -1)).toBe(0);
    expect(effectiveMixedCap(128, 0)).toBe(128);
    expect(effectiveMixedCap(128, 40)).toBe(40);
    expect(effectiveMixedCap(128, 300)).toBe(128);
  });
});

describe("ListenerBasis (A3.1)", () => {
  it("gives exactly listenerSpaceDirection's direction and distance, without allocating per call", () => {
    const cases: [number[], number[], number[], number[]][] = [
      [[3, 1, 4], [0, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[-2, 5, 7], [1, 2, 3], [0.3, -0.2, 0.9], [0.1, 1, 0.2]],
      [[1, 1, 1], [1, 1, 1], [0, 0, 1], [0, 1, 0]],
      [[4, 0, 0], [0, 0, 0], [0, 1, 0], [0, 1, 0]], // degenerate frame
      [[4, 0, 0], [0, 0, 0], [0, 0, 0], [0, 1, 0]], // zero forward
    ];
    const basis = new ListenerBasis();
    for (const [src, pos, fwd, up] of cases) {
      basis.set(pos, fwd, up);
      basis.locate(src[0]!, src[1]!, src[2]!);
      const want = listenerSpaceDirection(src as unknown as readonly [number, number, number], pos as never, fwd as never, up as never);
      expect([basis.dirX, basis.dirY, basis.dirZ]).toEqual([...want.direction]);
      expect(basis.distance).toBe(want.distance);
    }
  });
});

describe("ListenerBasis handedness (ADR 0164)", () => {
  it("a listener facing +Z hears a source at +X on its right (listener-space +X)", () => {
    const basis = new ListenerBasis();
    basis.set([0, 0, 0], [0, 0, 1], [0, 1, 0]);
    basis.locate(3, 0, 0);
    expect(basis.dirX).toBeCloseTo(1, 12);
    expect(basis.dirZ).toBeCloseTo(0, 12);
    basis.locate(0, 0, 5);
    expect(basis.dirZ).toBeCloseTo(-1, 12); // ahead is listener-space -Z
  });
});

describe("score refresh for the core's own demote (A3.3)", () => {
  /** `n` mixed voices at gain 1 whose PLAY sent their audibility as the score, and a sink that records score updates. */
  function scored(n: number) {
    const { table, sel, sink } = setup(Array(n).fill(1), n, Math.max(64, n));
    for (let i = 0; i < n; i++) sel.noteScoreSent(i, sel.audibilityOf(i));
    const scores: [number, number][] = [];
    sink.setScore = (i, score) => scores.push([i, score]);
    return { table, sel, sink, scores, run: () => sel.run(n, sink) };
  }

  it("sends nothing while audibility stays within 3 dB of the score sent", () => {
    const { table, scores, run } = scored(4);
    table.gain[1] = 1.4; // +2.9 dB
    table.gain[2] = 0.71; // -3.0 dB, still inside
    for (let f = 0; f < 5; f++) run();
    expect(scores).toEqual([]);
  });

  it("re-sends a mixed voice's score once it moves more than 3 dB either way, then not again", () => {
    const { table, sel, scores, run } = scored(4);
    table.gain[1] = 2;
    table.gain[3] = 0.5;
    const stats = run();
    expect(scores.map(([i]) => i)).toEqual([1, 3]);
    expect(scores[0]![1]).toBeCloseTo(table.audibility[1]!, 6);
    expect(sel.sentScore[3]).toBeCloseTo(table.audibility[3]!, 6);
    expect(stats.scores).toBe(2);
    scores.length = 0;
    run();
    expect(scores).toEqual([]);
    expect(SCORE_RATIO).toBeCloseTo(Math.SQRT2);
  });

  it("only mixed voices: a virtual voice's score is sent when it is promoted and moves", () => {
    const { table, scores, run } = scored(2);
    table.state[1] = VoiceState.VIRTUAL;
    table.gain[1] = 0.1;
    run();
    expect(scores.map(([i]) => i)).not.toContain(1);
  });

  it("sends at most SCORE_BUDGET a frame and the rest on later frames", () => {
    const n = SCORE_BUDGET + 10;
    const { table, scores, run } = scored(n);
    for (let i = 0; i < n; i++) table.gain[i] = 4;
    run();
    expect(scores).toHaveLength(SCORE_BUDGET);
    run();
    expect(scores).toHaveLength(n);
    expect(new Set(scores.map(([i]) => i)).size).toBe(n);
    run();
    expect(scores).toHaveLength(n);
  });

  it("a sink without setScore gets no score work", () => {
    const { table, sel, ids } = setup([1, 1], 2);
    void ids;
    table.gain[0] = 8;
    const { sink } = recorder(table);
    expect(sel.run(2, sink).scores).toBe(0);
  });
});
