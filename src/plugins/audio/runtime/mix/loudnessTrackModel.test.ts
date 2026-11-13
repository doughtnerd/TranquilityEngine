// ADR 0171/0172 (Pf6, L-Pf6a): the profiler's loudness series against the shared `LoudnessStats` fed as the live hub feeds it.
// Pure: sub-blocks are synthesised; time is the sub-block count x 0.1 s of audio, never a clock.
import { describe, expect, it } from "vitest";
import { LOUD_FLAG_RESET, LOUD_OUTPUT_TAP } from "../wire.generated";
import type { KeyframeMetered } from "../capture/format";
import { LoudnessStats, SUB_BLOCK_SECONDS, energyToLufs, linearToDb } from "./loudnessStats";
import { KF_METERED_INCOMPLETE, LoudnessTrackModel, type LoudnessStatusInput } from "./loudnessTrackModel";

const SLOT = 3;
const PER_STATUS = 5;

/** Mean-square energy whose LUFS is `lufs`. */
const energyOf = (lufs: number): number => Math.pow(10, (lufs + 0.691) / 10);

/** Sub-block `k`'s energy (a tone at -23 LUFS, then -14 from sub-block 300 on, so I and S move). */
const tone = (k: number): number => energyOf(k < 300 ? -23 : -14);

interface Plan {
  /** A STATUS covers sub-blocks first .. first + count - 1, newest completing at (first + count) x 0.1 s. */
  first: number;
  count: number;
  /** Sequence number of its first sub-block (differs from `first` after a lost run). */
  seq: number;
  flags?: number;
  peak?: number;
  shed?: number;
}

function statusOf(p: Plan, energy: (k: number) => number): LoudnessStatusInput {
  const e: number[] = [];
  for (let j = 0; j < p.count; j++) e.push(energy(p.first + j));
  return {
    time: (p.first + p.count) * SUB_BLOCK_SECONDS,
    loudShed: p.shed ?? 0,
    loudBuses: [{ slot: SLOT, flags: (p.flags ?? 0) | p.count, firstSeq: p.seq, truePeak: p.peak ?? 0.5 }],
    loudEnergies: e,
  };
}

function plans(total: number): Plan[] {
  const out: Plan[] = [];
  for (let k = 0; k < total; k += PER_STATUS) out.push({ first: k, count: PER_STATUS, seq: k });
  return out;
}

/** The live hub's feed of one STATUS item into a `LoudnessStats` (loudnessHub.ts `feed`), call for call. */
function hubFeed(stats: LoudnessStats, s: LoudnessStatusInput): void {
  const it = s.loudBuses[0]!;
  const count = it.flags & 0x3f;
  if ((it.flags & LOUD_FLAG_RESET) !== 0) stats.epoch();
  stats.takeBlock(it.firstSeq, s.loudEnergies, 0, count);
  stats.notePeak(it.truePeak);
}

describe("replay: the live meter's numbers", () => {
  it("M, S, I and the true peak equal a LoudnessStats fed the same sub-blocks, bit for bit", () => {
    const model = new LoudnessTrackModel();
    const live = new LoudnessStats();
    const list = plans(600);
    const times: number[] = [];
    for (const p of list) {
      const s = statusOf(p, tone);
      model.feed(s);
      hubFeed(live, s);
      times.push(s.time);
      const v = model.valuesAt(SLOT, s.time)!;
      expect(v.time).toBe(s.time);
      expect(v.momentary).toBe(live.momentary);
      expect(v.shortTerm).toBe(live.shortTerm);
      expect(v.integrated).toBe(live.integrated);
      expect(v.lra).toBe(live.lra);
      expect(v.truePeak).toBe(live.maxTruePeak);
      expect(v.incomplete).toBe(live.incomplete);
    }
    // The tone sits where it should: the first minute of -23 then -14 LUFS.
    const early = model.valuesAt(SLOT, 20)!;
    expect(early.momentary).toBeCloseTo(-23, 9);
    expect(early.shortTerm).toBeCloseTo(-23, 9);
    expect(early.integrated).toBeCloseTo(-23, 1);
    expect(model.valuesAt(SLOT, 59.9)!.momentary).toBeCloseTo(-14, 9);
    expect(model.valuesAt(SLOT, 59.9)!.truePeak).toBeCloseTo(linearToDb(0.5), 12);
    expect(energyToLufs(tone(0))).toBeCloseTo(-23, 12);
  });

  it("has one sample per sub-block, 0.1 s apart, and none before the first", () => {
    const model = new LoudnessTrackModel();
    for (const p of plans(100)) model.feed(statusOf(p, tone));
    const s = model.series(SLOT)!;
    expect(s.time.length).toBe(100);
    for (let i = 1; i < s.time.length; i++) expect(s.time[i]! - s.time[i - 1]!).toBeCloseTo(SUB_BLOCK_SECONDS, 12);
    expect(s.time[0]).toBeCloseTo(SUB_BLOCK_SECONDS, 12);
    expect(model.valuesAt(SLOT, 0)).toBeNull();
    expect(model.valuesAt(99, 5)).toBeNull();
    // M reads -Infinity until 4 sub-blocks, S until 30, as the live meter.
    expect(s.momentary[2]).toBe(Number.NEGATIVE_INFINITY);
    expect(s.momentary[3]).not.toBe(Number.NEGATIVE_INFINITY);
    expect(s.shortTerm[28]).toBe(Number.NEGATIVE_INFINITY);
    expect(s.shortTerm[29]).not.toBe(Number.NEGATIVE_INFINITY);
    expect(model.slots()).toEqual([SLOT]);
  });
});

describe("resets and gaps", () => {
  it("a reset restarts I (and a core-side RESET flag, like the hub, keeps it)", () => {
    const model = new LoudnessTrackModel();
    const live = new LoudnessStats();
    for (const p of plans(300)) {
      const s = statusOf(p, tone);
      model.feed(s);
      hubFeed(live, s);
    }
    const before = model.valuesAt(SLOT, 30)!;
    expect(before.integrated).toBeCloseTo(-23, 1);
    model.control(30.0, { kind: "reset", what: "integrated" });
    live.reset("integrated");
    const after = model.valuesAt(SLOT, 30.0)!;
    expect(after.integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(after.integrated).toBe(live.integrated);
    // Louder audio after the reset: I follows only what came after.
    for (const p of plans(600).filter((q) => q.first >= 300)) {
      const s = statusOf(p, (k) => energyOf(-14));
      model.feed(s);
      hubFeed(live, s);
    }
    const end = model.valuesAt(SLOT, 60)!;
    expect(end.integrated).toBe(live.integrated);
    expect(end.integrated).toBeCloseTo(-14, 1);

    // The core's RESET flag is an epoch: histograms stay (the hub's rule), `incomplete` is set.
    const flagged = new LoudnessTrackModel();
    const liveFlagged = new LoudnessStats();
    for (const p of plans(100)) {
      const s = statusOf(p, tone);
      flagged.feed(s);
      hubFeed(liveFlagged, s);
    }
    const s = statusOf({ first: 100, count: PER_STATUS, seq: 0, flags: LOUD_FLAG_RESET }, tone);
    flagged.feed(s);
    hubFeed(liveFlagged, s);
    const v = flagged.valuesAt(SLOT, s.time)!;
    expect(v.integrated).toBe(liveFlagged.integrated);
    expect(v.integrated).not.toBe(Number.NEGATIVE_INFINITY);
    expect(v.incomplete).toBe(true);
    expect(flagged.series(SLOT)!.gaps.some((g) => g.kind === "epoch")).toBe(true);
  });

  it("reset('all') clears the peak and the flags too; a script pause resumes without incomplete", () => {
    const model = new LoudnessTrackModel();
    for (const p of plans(100)) model.feed(statusOf(p, tone));
    expect(model.valuesAt(SLOT, 10)!.truePeak).toBeCloseTo(linearToDb(0.5), 12);
    model.control(10, { kind: "reset" });
    const v = model.valuesAt(SLOT, 10)!;
    expect(v.truePeak).toBe(Number.NEGATIVE_INFINITY);
    expect(v.peak).toBe(Number.NEGATIVE_INFINITY);
    model.control(10.1, { kind: "pause" });
    // While paused the energies are discarded and no sample is added.
    const n = model.series(SLOT)!.time.length;
    model.feed(statusOf({ first: 100, count: PER_STATUS, seq: 100 }, tone));
    expect(model.series(SLOT)!.time.length).toBe(n);
    model.control(10.6, { kind: "resume" });
    expect(model.valuesAt(SLOT, 10.6)!.incomplete).toBe(false);
  });

  it("a lost run marks incomplete, records the gap, and matches the live meter", () => {
    const model = new LoudnessTrackModel();
    const live = new LoudnessStats();
    const list = plans(200);
    // Drop sub-blocks 100..119 (a stalled main): the STATUS after the stall starts at seq 120.
    const kept = list.filter((p) => p.first < 100 || p.first >= 120);
    for (const p of kept) {
      const s = statusOf(p, tone);
      if (s.time <= 10) expect(model.valuesAt(SLOT, s.time)?.incomplete ?? false).toBe(false);
      model.feed(s);
      hubFeed(live, s);
    }
    const s = model.series(SLOT)!;
    expect(live.incomplete).toBe(true);
    expect(live.lost).toBe(20);
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]!.kind).toBe("lost");
    expect(s.gaps[0]!.lost).toBe(20);
    expect(s.gaps[0]!.to - s.gaps[0]!.from).toBeCloseTo(20 * SUB_BLOCK_SECONDS, 9);
    // Incomplete from the first sample after the gap, not before; and the window restarted (M is -Infinity for 0.3 s).
    const firstAfter = s.time.findIndex((t) => t > 12 - 1e-9);
    expect(s.incomplete[firstAfter - 1]).toBe(0);
    expect(s.incomplete[firstAfter]).toBe(1);
    expect(s.momentary[firstAfter]).toBe(Number.NEGATIVE_INFINITY);
    const last = model.valuesAt(SLOT, 20)!;
    expect(last.incomplete).toBe(true);
    expect(last.integrated).toBe(live.integrated);
    expect(last.shortTerm).toBe(live.shortTerm);
  });

  it("a ladder shed span pauses the meter and resumes incomplete, as the hub", () => {
    const model = new LoudnessTrackModel();
    const live = new LoudnessStats();
    for (const p of plans(100)) {
      const s = statusOf(p, tone);
      model.feed(s);
      hubFeed(live, s);
    }
    // Shed: the core sends no new blocks while paused; sequences keep counting (resume jumps ahead by the span).
    model.feed({ time: 11, loudShed: 1, loudBuses: [{ slot: SLOT, flags: 0, firstSeq: 100, truePeak: 0 }], loudEnergies: [] });
    live.pause();
    expect(model.bus(SLOT)!.stats.paused).toBe(true);
    model.feed({ time: 20, loudShed: 0, loudBuses: [{ slot: SLOT, flags: PER_STATUS, firstSeq: 190, truePeak: 0.5 }], loudEnergies: [1, 1, 1, 1, 1] });
    live.resume(true);
    live.takeBlock(190, [1, 1, 1, 1, 1], 0, 5);
    expect(model.bus(SLOT)!.stats.incomplete).toBe(true);
    expect(model.valuesAt(SLOT, 20)!.incomplete).toBe(true);
    expect(model.valuesAt(SLOT, 20)!.integrated).toBe(live.integrated);
  });
});

describe("seek from a keyframe", () => {
  /** A keyframe's metered reading of `slot` from the replay model's state at `t` (f32, as the file stores it). */
  function reading(full: LoudnessTrackModel, t: number): KeyframeMetered {
    const v = full.valuesAt(SLOT, t)!;
    return {
      slot: SLOT, flags: v.incomplete ? KF_METERED_INCOMPLETE : 0, momentary: Math.fround(v.momentary), shortTerm: Math.fround(v.shortTerm),
      integrated: Math.fround(v.integrated), lra: Math.fround(v.lra), maxTruePeak: Math.fround(v.truePeak), maxMomentary: 0, elapsed: 0,
    };
  }

  it("reproduces a full replay's M and S exactly, and its I as held by the keyframe", () => {
    const list = plans(600);
    const full = new LoudnessTrackModel();
    for (const p of list) full.feed(statusOf(p, tone));

    // A keyframe every 1 s (10 sub-blocks, two STATUSes); the seek starts 3.1 s before the cursor at 40 s and holds the
    // newest keyframe at or before each sample.
    const seek = new LoudnessTrackModel("seek");
    const cursor = 40;
    const startFirst = cursor / SUB_BLOCK_SECONDS - 31;
    const keyTimes: number[] = [];
    for (const p of list) {
      if (p.first < startFirst) continue;
      const s = statusOf(p, tone);
      seek.feed(s);
      if (Math.round(s.time * 10) % 10 === 0 && s.time <= cursor + 1e-9) {
        keyTimes.push(s.time);
        seek.addKeyframe(s.time, [reading(full, s.time)]);
      }
    }
    const f = full.valuesAt(SLOT, cursor)!;
    const v = seek.valuesAt(SLOT, cursor)!;
    expect(keyTimes[keyTimes.length - 1]).toBeCloseTo(cursor, 9);
    expect(v.time).toBe(f.time);
    expect(v.momentary).toBe(f.momentary);
    expect(v.shortTerm).toBe(f.shortTerm);
    expect(v.integrated).toBe(Math.fround(f.integrated));
    expect(v.lra).toBe(Math.fround(f.lra));
    expect(v.truePeak).toBe(Math.fround(f.truePeak));
    // Across the whole seek window M and S agree once 4 and 30 sub-blocks have arrived.
    const ss = seek.series(SLOT)!;
    for (let i = 29; i < ss.time.length; i++) {
      const g = full.valuesAt(SLOT, ss.time[i]!)!;
      expect(ss.time[i]).toBe(g.time);
      expect(ss.momentary[i]).toBe(g.momentary);
      expect(ss.shortTerm[i]).toBe(g.shortTerm);
    }
    // Between keyframes I is held (at most one keyframe interval stale): mid-interval it is the previous keyframe's.
    const mid = seek.valuesAt(SLOT, cursor - 0.5)!;
    expect(mid.integrated).toBe(Math.fround(full.valuesAt(SLOT, cursor - 1)!.integrated));
    // Before the first keyframe nothing is held.
    expect(ss.integrated[0]).toBe(Number.NEGATIVE_INFINITY);
  });

  it("a replay model keeps keyframes but reads I from the sub-blocks", () => {
    const full = new LoudnessTrackModel();
    for (const p of plans(100)) full.feed(statusOf(p, tone));
    const m = new LoudnessTrackModel();
    for (const p of plans(100)) m.feed(statusOf(p, tone));
    const kf = reading(full, 5);
    kf.integrated = -99;
    m.addKeyframe(5, [kf]);
    expect(m.bus(SLOT)!.keyframe).toBe(kf);
    expect(m.valuesAt(SLOT, 10)!.integrated).toBe(full.valuesAt(SLOT, 10)!.integrated);
  });
});

describe("target marks", () => {
  const target = { name: "console", integrated: -24, tolerance: 2, truePeak: -1 };

  function modelOf(levels: (k: number) => number, peak = 0.5): LoudnessTrackModel {
    const m = new LoudnessTrackModel();
    for (const p of plans(600)) m.feed(statusOf({ ...p, peak }, (k) => energyOf(levels(k))));
    return m;
  }

  it("marks over spans (integrated above target + tolerance) and under spans, each once, from..to on the axis", () => {
    // Quiet start (-30: under), on target (-24) long enough to pull I in, then very loud (-10: over).
    const quiet = modelOf((k) => (k < 100 ? -30 : -10));
    const marks = quiet.targetMarks(target);
    const integrated = marks.filter((x) => x.metric === "integrated");
    expect(integrated.map((x) => x.kind)).toEqual(["under", "over"]);
    const under = integrated[0]!;
    const over = integrated[1]!;
    expect(under.bus).toBe(SLOT);
    expect(under.from).toBeCloseTo(0.4, 9); // the first sample with I defined: 4 sub-blocks in
    expect(over.from).toBeGreaterThan(under.to);
    expect(over.to).toBeCloseTo(60, 9);
    // The mark's endpoints are samples that really violate, and the one after `under.to` does not.
    const s = quiet.series(SLOT)!;
    const iAt = (t: number): number => s.integrated[s.time.findIndex((x) => Math.abs(x - t) < 1e-9)]!;
    expect(iAt(under.from)).toBeLessThan(-26);
    expect(iAt(under.to)).toBeLessThan(-26);
    expect(iAt(over.from)).toBeGreaterThan(-22);
  });

  it("an on-target tone has no loudness marks; a case per metric", () => {
    const on = modelOf(() => -24);
    expect(on.targetMarks(target)).toEqual([]);
    expect(on.targetMarks(target, { metrics: ["integrated", "shortTerm", "momentary"] })).toEqual([]);
    // Short-term judges the 3 s window: a half-second burst marks over while it fills the window, and I stays inside the tolerance.
    const burst = modelOf((k) => (k >= 500 && k < 505 ? -10 : -24));
    expect(burst.targetMarks(target).filter((x) => x.metric === "integrated")).toEqual([]);
    const st = burst.targetMarks(target, { metrics: ["shortTerm"], truePeak: false });
    expect(st.length).toBeGreaterThan(0);
    expect(st.every((x) => x.metric === "shortTerm")).toBe(true);
    expect(st[0]!.kind).toBe("over");
    const mo = burst.targetMarks(target, { metrics: ["momentary"], truePeak: false });
    expect(mo[0]!.kind).toBe("over");
    expect(mo[0]!.from).toBeGreaterThanOrEqual(50);
    // Short-term is the longer mark (3 s window) and ends later than the momentary one.
    expect(st[0]!.to).toBeGreaterThan(mo[0]!.to);
  });

  it("marks the true peak over the ceiling, per STATUS", () => {
    const m = new LoudnessTrackModel();
    for (const p of plans(100)) m.feed(statusOf({ ...p, peak: p.first >= 40 && p.first < 60 ? 1.2 : 0.5 }, tone));
    const marks = m.targetMarks(target).filter((x) => x.metric === "truePeak");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe("over");
    expect(marks[0]!.from).toBeCloseTo(4.1, 9);
    expect(marks[0]!.to).toBeCloseTo(6, 9);
    expect(m.targetMarks(target, { truePeak: false }).filter((x) => x.metric === "truePeak")).toEqual([]);
  });

  it("warns only: the target is read never written and the series is unchanged by asking", () => {
    const model = modelOf((k) => (k < 100 ? -30 : -10));
    const writes: string[] = [];
    const watched = new Proxy({ ...target }, {
      set(_t, p) { writes.push(`set ${String(p)}`); return true; },
      defineProperty(_t, p) { writes.push(`define ${String(p)}`); return true; },
      deleteProperty(_t, p) { writes.push(`delete ${String(p)}`); return true; },
    });
    const s = model.series(SLOT)!;
    const snapshot = JSON.stringify([s.time, s.integrated.map(String), s.truePeak.map(String)]);
    const a = model.targetMarks(watched, { metrics: ["integrated", "shortTerm", "momentary"] });
    const b = model.targetMarks(watched, { metrics: ["integrated", "shortTerm", "momentary"] });
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(writes).toEqual([]);
    expect(JSON.stringify([s.time, s.integrated.map(String), s.truePeak.map(String)])).toBe(snapshot);
    // The model exposes no setter for anything it judges: only feeding methods mutate it.
    for (const proto of [LoudnessTrackModel.prototype, Object.getPrototypeOf(model.bus(SLOT)!)]) {
      for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) expect(d.set, name).toBeUndefined();
    }
  });

  it("covers the output tap slot like any bus", () => {
    const m = new LoudnessTrackModel();
    const e = energyOf(-10);
    m.feed({ time: 30, loudShed: 0, loudBuses: [{ slot: LOUD_OUTPUT_TAP, flags: 30, firstSeq: 0, truePeak: 0.1 }], loudEnergies: new Array<number>(30).fill(e) });
    expect(m.valuesAt(LOUD_OUTPUT_TAP, 30)!.shortTerm).toBeCloseTo(-10, 9);
    expect(m.targetMarks(target).some((x) => x.bus === LOUD_OUTPUT_TAP && x.kind === "over")).toBe(true);
  });
});
