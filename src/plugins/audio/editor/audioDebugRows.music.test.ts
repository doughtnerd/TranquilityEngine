// ADR 0166 P10, leaf L-P10a: the music rows' thresholds (architecture §9) on hand-built `MusicDebugRow`s.
import { describe, expect, it } from "vitest";
import type { MusicDebugRow, MusicDebugTotals } from "../runtime/backend";
import { MUSIC_COLUMNS, MusicWatch, leadHealth, musicInstanceRows, musicTotalsRows, pendingText, type Row } from "./audioDebugRows";

const row = (over: Partial<MusicDebugRow> = {}): MusicDebugRow => ({
  id: 1,
  asset: "music/town.event.json",
  state: "playing",
  segment: "verse",
  pass: 1,
  bar: 1,
  beat: 1,
  tick: 0,
  tempo: 120,
  beatsPerBar: 4,
  time: 0,
  pending: null,
  groups: [],
  stems: [],
  primeLastMs: 0,
  primeEmaMs: 0,
  leadMs: 0,
  replans: {},
  refusals: {},
  lateGroups: 0,
  groupsHeld: 0,
  groupTimeouts: 0,
  lastSlipFrames: 0,
  recoveries: {},
  missedBeats: 0,
  stingers: { played: 0, late: 0, skipped: 0, dropped: 0 },
  ...over,
});

const totals = (over: Partial<MusicDebugTotals> = {}): MusicDebugTotals => ({
  poolUsed: 0,
  poolSize: 8,
  poolHighWater: 0,
  musicRingRefused: 0,
  streamStartsLate: 0,
  maxSlipFrames: 0,
  splitQuanta: 0,
  voiceSplits: 0,
  curvePoolFull: 0,
  groupTableFull: 0,
  ...over,
});

/** The row with `id`; fails the test when it is missing. */
const find = (rows: readonly Row[], id: string): Row => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

/** The cell of an instance row under the column with `label`. */
const cellOf = (r: Row, label: string): { text: string; health?: string } => {
  const i = MUSIC_COLUMNS.findIndex((c) => c.label === label);
  const cell = r.cells[i];
  if (!cell) throw new Error(`no cell ${label}`);
  return cell;
};

/** The health of a totals row (`id`) for these instance rows. */
const totalsHealth = (rows: readonly MusicDebugRow[], t: MusicDebugTotals | undefined, id: string, watch?: MusicWatch): string | undefined =>
  find(musicTotalsRows(rows, t, watch), id).health;

/** A watch that saw a timeout and a recovery count at 0 s and at 60 s. */
const watchWithRate = (timeouts: number, recovered: number): { watch: MusicWatch; rows: MusicDebugRow[] } => {
  const watch = new MusicWatch();
  watch.observe(0, [row()], undefined);
  const rows = [row({ groupTimeouts: timeouts, recoveries: { rebuild: recovered } })];
  watch.observe(60, rows, undefined);
  return { watch, rows };
};

describe("L-P10a music health (architecture §9)", () => {
  it("replans.deadline per 100 transitions: green below 1, amber 1 to 10, red above 10", () => {
    const watch = new MusicWatch();
    // 100 transitions (the pass rises each sample) and no re-plans: green.
    for (let i = 0; i <= 100; i++) watch.observe(i * 0.1, [row({ pass: 1 + i })], undefined);
    expect(totalsHealth([], undefined, "replansDeadline", watch)).toBe("ok");
    // One re-plan in 100 transitions: amber (1 is not below 1).
    watch.observe(10.1, [row({ pass: 101, replans: { deadline: 1 } })], undefined);
    expect(watch.deadlineReplansPer100()).toBe(1);
    expect(totalsHealth([], undefined, "replansDeadline", watch)).toBe("warn");
    // Eleven re-plans in 100 transitions: red.
    watch.observe(10.2, [row({ pass: 101, replans: { deadline: 11 } })], undefined);
    expect(totalsHealth([], undefined, "replansDeadline", watch)).toBe("bad");
  });

  it("re-plans that rise with no transition read red; none before the first transition reads 0", () => {
    const quiet = new MusicWatch();
    quiet.observe(0, [row()], undefined);
    quiet.observe(1, [row()], undefined);
    expect(quiet.deadlineReplansPer100()).toBe(0);

    const stuck = new MusicWatch();
    stuck.observe(0, [row()], undefined);
    stuck.observe(1, [row({ replans: { deadline: 1 } })], undefined);
    expect(stuck.deadlineReplansPer100()).toBe(Infinity);
    expect(totalsHealth([], undefined, "replansDeadline", stuck)).toBe("bad");
  });

  it("refusals.poolFull, leadOverBeat, tailRefused, stingers.skipped, curvePoolFull: green at 0, amber when non-zero", () => {
    for (const cause of ["poolFull", "leadOverBeat", "tailRefused"]) {
      expect(totalsHealth([row()], totals(), `refusal:${cause}`)).toBe("ok");
      expect(totalsHealth([row({ refusals: { [cause]: 2 } })], totals(), `refusal:${cause}`)).toBe("warn");
    }
    expect(totalsHealth([row()], totals(), "stingersSkipped")).toBe("ok");
    expect(totalsHealth([row({ stingers: { played: 0, late: 0, skipped: 1, dropped: 0 } })], totals(), "stingersSkipped")).toBe("warn");
    expect(totalsHealth([], totals({ curvePoolFull: 0 }), "curvePoolFull")).toBe("ok");
    expect(totalsHealth([], totals({ curvePoolFull: 1 }), "curvePoolFull")).toBe("warn");
  });

  it("refusals.neverFits (permanent) is red on any count", () => {
    expect(totalsHealth([row()], totals(), "refusal:neverFits")).toBe("ok");
    expect(totalsHealth([row({ refusals: { neverFits: 1 } })], totals(), "refusal:neverFits")).toBe("bad");
    // A cause the panel does not name is permanent too.
    expect(totalsHealth([row({ refusals: { mystery: 1 } })], totals(), "refusal:mystery")).toBe("bad");
  });

  it("lateGroups, groupsHeld and streamStartsLate are red on any count", () => {
    expect(totalsHealth([row()], totals(), "lateGroups")).toBe("ok");
    expect(totalsHealth([row({ lateGroups: 1 })], totals(), "lateGroups")).toBe("bad");
    expect(totalsHealth([row()], totals(), "groupsHeld")).toBe("ok");
    expect(totalsHealth([row({ groupsHeld: 1 })], totals(), "groupsHeld")).toBe("bad");
    expect(totalsHealth([], totals({ streamStartsLate: 0 }), "streamStartsLate")).toBe("ok");
    expect(totalsHealth([], totals({ streamStartsLate: 1 }), "streamStartsLate")).toBe("bad");
  });

  it("groupTimeouts and recoveries: green at 0, amber up to 1 per minute, red above", () => {
    const idle = new MusicWatch();
    expect(totalsHealth([row()], totals(), "groupTimeouts", idle)).toBe("ok");
    expect(totalsHealth([row()], totals(), "recoveries", idle)).toBe("ok");

    const one = watchWithRate(1, 1);
    expect(one.watch.groupTimeoutsPerMinute()).toBe(1);
    expect(totalsHealth(one.rows, totals(), "groupTimeouts", one.watch)).toBe("warn");
    expect(totalsHealth(one.rows, totals(), "recoveries", one.watch)).toBe("warn");

    const many = watchWithRate(2, 2);
    expect(totalsHealth(many.rows, totals(), "groupTimeouts", many.watch)).toBe("bad");
    expect(totalsHealth(many.rows, totals(), "recoveries", many.watch)).toBe("bad");
  });

  it("lead: green to 150 ms, amber to one beat or 330 ms, red above a beat", () => {
    // 120 BPM: a beat is 500 ms.
    expect(leadHealth(150, 120)).toBe("ok");
    expect(leadHealth(151, 120)).toBe("warn");
    expect(leadHealth(500, 120)).toBe("warn");
    expect(leadHealth(501, 120)).toBe("bad");
    // 60 BPM: a beat is 1000 ms, so 600 ms is still amber.
    expect(leadHealth(600, 60)).toBe("warn");
  });

  it("splitQuanta, musicRingRefused and groupTableFull are red on any count", () => {
    for (const k of ["splitQuanta", "musicRingRefused", "groupTableFull"] as const) {
      expect(totalsHealth([], totals(), k)).toBe("ok");
      expect(totalsHealth([], totals({ [k]: 1 }), k)).toBe("bad");
    }
  });

  it("a clock that goes backwards clears MusicWatch", () => {
    const watch = new MusicWatch();
    for (let i = 0; i <= 100; i++) watch.observe(i * 0.1, [row({ pass: 1 + i, replans: { deadline: i === 100 ? 5 : 0 } })], undefined);
    expect(watch.deadlineReplansPer100()).toBe(5);
    // The clock jumps back (a rebuild): the history is gone, so the old re-plans no longer count.
    watch.observe(1, [row({ pass: 1, replans: { deadline: 0 } })], undefined);
    expect(watch.deadlineReplansPer100()).toBe(0);
  });
});

describe("L-P10a music rows", () => {
  it("one instance row per MusicDebugRow, cells matching MUSIC_COLUMNS in count", () => {
    const out = musicInstanceRows([row({ id: 1 }), row({ id: 2 })], 48000);
    expect(out.map((r) => r.id)).toEqual(["music1", "music2"]);
    for (const r of out) expect(r.cells).toHaveLength(MUSIC_COLUMNS.length);
  });

  it("pendingText names target, time, tier, rule key, parent, exit and enter; null reads none", () => {
    expect(
      pendingText({ to: "verse", time: "5:1", rule: 2, ruleKey: "intro>verse", tier: 2, parent: "parent", exit: "nextBar", enter: "cue:in" }),
    ).toBe("verse at 5:1, tier 2 rule intro>verse from parent, exit nextBar, enter cue:in");
    expect(pendingText(null)).toBe("none");
  });

  it("groups and stems show primed n of N; a stem with no ring shows decoded", () => {
    const [r] = musicInstanceRows(
      [
        row({
          groups: [{ id: 1, state: "priming", primed: 2, of: 3 }],
          stems: [
            { name: "drums", primed: true, streamed: true, ring: 2 },
            { name: "pad", primed: true, streamed: false, ring: null },
          ],
        }),
      ],
      48000,
    );
    expect(cellOf(r!, "Groups").text).toBe("2 of 3 primed");
    expect(cellOf(r!, "Stems").text).toContain("2 of 2 primed");
    expect(cellOf(r!, "Stems").text).toContain("pad decoded");
    expect(cellOf(r!, "Stems").text).toContain("drums ring 2");
  });

  it("record-valued counters (replans, refusals, recoveries) list their non-zero causes; all zero reads 0", () => {
    const [r] = musicInstanceRows([row({ replans: { deadline: 2, primeLate: 0 }, refusals: { poolFull: 1 }, recoveries: { rebuild: 0 } })], 48000);
    expect(cellOf(r!, "Re-plans").text).toBe("deadline 2");
    expect(cellOf(r!, "Refusals").text).toBe("poolFull 1");
    expect(cellOf(r!, "Recoveries").text).toBe("0");

    const [z] = musicInstanceRows([row({ replans: { deadline: 0 }, refusals: {}, recoveries: {} })], 48000);
    expect(cellOf(z!, "Re-plans").text).toBe("0");
    expect(cellOf(z!, "Refusals").text).toBe("0");
    expect(cellOf(z!, "Recoveries").text).toBe("0");
  });

  it("lastSlipFrames shows frames and milliseconds at the sample rate", () => {
    const [r] = musicInstanceRows([row({ lastSlipFrames: 480 })], 48000);
    expect(cellOf(r!, "Last slip").text).toBe("480 frames (10 ms)");
  });

  it("totals rows: pool used of size with high-water; undefined totals still returns the summed rows", () => {
    const out = musicTotalsRows([row({ lateGroups: 1 })], totals({ poolUsed: 3, poolHighWater: 5 }));
    expect(find(out, "poolUsed").cells[1]!.text).toBe("3 of 8 (high-water 5)");
    expect(find(out, "poolUsed").health).toBe("info");
    expect(totalsHealth([], totals({ poolUsed: 8, poolSize: 8 }), "poolUsed")).toBe("warn");

    const bare = musicTotalsRows([row({ lateGroups: 1 })], undefined);
    expect(bare.some((r) => r.id === "poolUsed")).toBe(false);
    expect(find(bare, "lateGroups").cells[1]!.text).toBe("1");
  });

  it("no instances: musicInstanceRows returns an empty list", () => {
    expect(musicInstanceRows([], 48000)).toEqual([]);
  });
});
