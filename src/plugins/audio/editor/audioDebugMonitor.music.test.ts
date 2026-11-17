// ADR 0166 P10 (leaf L-P10a) through the monitor (ADR 0220): the music rows' thresholds (architecture §9), and the rule
// that a total comes from a cumulative counter (`musicTotals`), never from a sum over the playing instances.
import { describe, expect, it } from "vitest";
import type { MusicDebugRow, MusicDebugTotals } from "../runtime/backend";
import { AudioDebugMonitor, type AudioDebugView, type Row } from "./audioDebugMonitor";
import { musicRow as row, musicTotals as totals, rowOf, sectionOf, snapshot, viewAfter } from "./testing/debugSnapshot";

/** A sample at `time` with these music rows and totals (null: a backend without music totals). */
const sample = (time: number, music: MusicDebugRow[], musicTotals: MusicDebugTotals | null = totals(), sampleRate = 48_000) => snapshot({ time, sampleRate, music, musicTotals: musicTotals ?? undefined });

const totalsRows = (v: AudioDebugView): Row[] => sectionOf(v, "musicTotals").rows;
const instanceRows = (v: AudioDebugView): Row[] => sectionOf(v, "music").rows;
/** A totals row's value cell. */
const total = (v: AudioDebugView, id: string) => rowOf(totalsRows(v), id).cells[1]!;
/** The cell of an instance row under the column with `label`. */
const cellOf = (v: AudioDebugView, r: Row, label: string) => {
  const i = sectionOf(v, "music").columns!.findIndex((c) => c.label === label);
  const cell = r.cells[i];
  if (!cell) throw new Error(`no cell ${label}`);
  return cell;
};
/** The one instance row of a single-sample view, and the view. */
const oneInstance = (r: MusicDebugRow, sampleRate = 48_000) => {
  const v = viewAfter(sample(0, [r], totals(), sampleRate));
  return { v, r: instanceRows(v)[0]! };
};

describe("ADR 0220: totals come from the cumulative counters", () => {
  it("a hold in progress reads red in the totals, though the instance's row counts it only once it resumes", () => {
    const m = new AudioDebugMonitor();
    m.observe(sample(0, [row()]));
    expect(total(m.view()!, "groupsHeld")).toMatchObject({ text: "0", health: "ok" });
    // The core counts the hold when it begins; the row's own groupsHeld is still 0.
    m.observe(sample(0.25, [row({ groups: [{ id: 3, state: "held", primed: 1, of: 2 }] })], totals({ groupsHeld: 1 })));
    expect(total(m.view()!, "groupsHeld")).toMatchObject({ text: "1", health: "bad" });
    expect(cellOf(m.view()!, instanceRows(m.view()!)[0]!, "Late / held / timeouts").text).toBe("0 / 0 / 0");
  });

  it("late and abandoned totals stay counted after the instance stops", () => {
    const m = new AudioDebugMonitor();
    m.observe(sample(0, [row({ lateGroups: 2, groupTimeouts: 1 })], totals({ groupsLate: 2, groupsAbandoned: 1 })));
    m.observe(sample(0.25, [], totals({ groupsLate: 2, groupsAbandoned: 1 })));
    const v = m.view()!;
    expect(instanceRows(v)).toEqual([]);
    expect(total(v, "lateGroups")).toMatchObject({ text: "2", health: "bad" });
    expect(total(v, "groupTimeouts").text).toMatch(/^1 /);
    expect(total(v, "groupTimeouts").health).not.toBe("ok");
  });

  it("refusals, recoveries and skipped stingers come from main's session totals, ended music included", () => {
    const m = new AudioDebugMonitor();
    m.observe(sample(0, [], totals({ refusals: { neverFits: 1, poolFull: 2 }, recoveries: { hidden: 1 }, stingers: { played: 3, late: 0, skipped: 1, dropped: 0 } })));
    const v = m.view()!;
    expect(total(v, "refusal:neverFits")).toMatchObject({ text: "1", health: "bad" });
    expect(total(v, "refusal:poolFull")).toMatchObject({ text: "2", health: "warn" });
    expect(total(v, "recoveries").text).toMatch(/^1 /);
    expect(total(v, "stingersSkipped")).toMatchObject({ text: "1", health: "warn" });
  });

  it("a total ignores the playing rows: their counts appear only in the instance table", () => {
    const busy = row({ lateGroups: 4, groupsHeld: 4, groupTimeouts: 4, refusals: { neverFits: 4 }, recoveries: { crash: 4 }, stingers: { played: 0, late: 0, skipped: 4, dropped: 0 } });
    const v = viewAfter(sample(0, [busy]));
    for (const id of ["lateGroups", "groupsHeld", "refusal:neverFits", "stingersSkipped"]) expect(total(v, id).text, id).toBe("0");
    expect(total(v, "groupTimeouts").text).toMatch(/^0 /);
    expect(total(v, "recoveries").text).toMatch(/^0 /);
    expect(cellOf(v, instanceRows(v)[0]!, "Late / held / timeouts").text).toBe("4 / 4 / 4");
  });

  it("a backend without music totals shows no totals rows", () => {
    expect(totalsRows(viewAfter(sample(0, [row({ lateGroups: 1 })], null)))).toEqual([]);
  });
});

describe("L-P10a music health (architecture §9)", () => {
  it("replans.deadline per 100 transitions: green below 1, amber 1 to 10, red above 10", () => {
    const m = new AudioDebugMonitor();
    // 100 transitions (the pass rises each sample) and no re-plans: green.
    for (let i = 0; i <= 100; i++) m.observe(sample(i * 0.1, [row({ pass: 1 + i })]));
    expect(total(m.view()!, "replansDeadline")).toMatchObject({ text: "0 per 100 transitions", health: "ok" });
    // One re-plan in 100 transitions: amber (1 is not below 1).
    m.observe(sample(10.1, [row({ pass: 101 })], totals({ replans: { deadline: 1 } })));
    expect(total(m.view()!, "replansDeadline")).toMatchObject({ text: "1 per 100 transitions", health: "warn" });
    // Eleven re-plans in 100 transitions: red.
    m.observe(sample(10.2, [row({ pass: 101 })], totals({ replans: { deadline: 11 } })));
    expect(total(m.view()!, "replansDeadline").health).toBe("bad");
    // The instance table's re-plans cell takes the same colour.
    expect(cellOf(m.view()!, instanceRows(m.view()!)[0]!, "Re-plans").health).toBe("bad");
  });

  it("re-plans that rise with no transition read red; none before the first transition reads 0", () => {
    expect(total(viewAfter(sample(0, [row()]), sample(1, [row()])), "replansDeadline")).toMatchObject({ text: "0 per 100 transitions", health: "ok" });
    expect(total(viewAfter(sample(0, [row()]), sample(1, [row()], totals({ replans: { deadline: 1 } }))), "replansDeadline").health).toBe("bad");
  });

  it("a re-plan of an instance that ended between two samples still counts", () => {
    const m = new AudioDebugMonitor();
    for (let i = 0; i <= 10; i++) m.observe(sample(i * 0.1, [row({ pass: 1 + i })]));
    m.observe(sample(1.1, [], totals({ replans: { deadline: 1 } })));
    expect(total(m.view()!, "replansDeadline").text).toBe("10 per 100 transitions");
  });

  it("refusals.poolFull, leadOverBeat, tailRefused, stingers.skipped, curvePoolFull, encodedOverBudget: green at 0, amber when non-zero", () => {
    for (const cause of ["poolFull", "leadOverBeat", "tailRefused"]) {
      expect(total(viewAfter(sample(0, [])), `refusal:${cause}`).health).toBe("ok");
      expect(total(viewAfter(sample(0, [], totals({ refusals: { [cause]: 2 } }))), `refusal:${cause}`).health).toBe("warn");
    }
    for (const k of ["curvePoolFull", "encodedOverBudget"] as const) {
      expect(total(viewAfter(sample(0, [])), k).health).toBe("ok");
      expect(total(viewAfter(sample(0, [], totals({ [k]: 2 }))), k).health).toBe("warn");
    }
  });

  it("refusals.neverFits (permanent) is red on any count, and so is a cause the panel does not name", () => {
    expect(total(viewAfter(sample(0, [])), "refusal:neverFits").health).toBe("ok");
    expect(total(viewAfter(sample(0, [], totals({ refusals: { neverFits: 1 } }))), "refusal:neverFits").health).toBe("bad");
    expect(total(viewAfter(sample(0, [], totals({ refusals: { mystery: 1 } }))), "refusal:mystery").health).toBe("bad");
  });

  it("groupsLate, groupsHeld, streamStartsLate, splitQuanta, musicRingRefused and groupTableFull are red on any count", () => {
    const ids = { groupsLate: "lateGroups", groupsHeld: "groupsHeld", streamStartsLate: "streamStartsLate", splitQuanta: "splitQuanta", musicRingRefused: "musicRingRefused", groupTableFull: "groupTableFull" } as const;
    for (const [k, id] of Object.entries(ids)) {
      expect(total(viewAfter(sample(0, [])), id).health, id).toBe("ok");
      expect(total(viewAfter(sample(0, [], totals({ [k]: 1 }))), id).health, id).toBe("bad");
    }
  });

  it("groups abandoned and recoveries: green at 0, amber up to 1 per minute, red above, rated from the totals", () => {
    const rated = (n: number) => viewAfter(sample(0, [row()]), sample(60, [row({ groupTimeouts: n, recoveries: { rebuild: n } })], totals({ groupsAbandoned: n, recoveries: { rebuild: n } })));
    const idle = rated(0);
    expect(total(idle, "groupTimeouts")).toMatchObject({ text: "0 (0/min)", health: "ok" });
    expect(total(idle, "recoveries").health).toBe("ok");
    const one = rated(1);
    expect(total(one, "groupTimeouts")).toMatchObject({ text: "1 (1/min)", health: "warn" });
    expect(total(one, "recoveries").health).toBe("warn");
    const many = rated(2);
    expect(total(many, "groupTimeouts").health).toBe("bad");
    expect(total(many, "recoveries").health).toBe("bad");
    // The instance cells colour by the same rates.
    expect(cellOf(many, instanceRows(many)[0]!, "Late / held / timeouts").health).toBe("bad");
    expect(cellOf(many, instanceRows(many)[0]!, "Recoveries").health).toBe("bad");
  });

  it("a clock that goes backwards starts the music history over", () => {
    const m = new AudioDebugMonitor();
    for (let i = 0; i <= 100; i++) m.observe(sample(i * 0.1, [row({ pass: 1 + i })], totals({ replans: { deadline: i === 100 ? 5 : 0 } })));
    expect(total(m.view()!, "replansDeadline").text).toBe("5 per 100 transitions");
    // The clock jumps back (a rebuild): the history is gone, so the old re-plans no longer count.
    m.observe(sample(1, [row({ pass: 1 })]));
    expect(total(m.view()!, "replansDeadline").text).toBe("0 per 100 transitions");
  });

  it("lead: green to 150 ms, amber to one beat, red above a beat", () => {
    const leadHealth = (leadMs: number, tempo: number) => {
      const { v, r } = oneInstance(row({ leadMs, tempo }));
      return cellOf(v, r, "Prime (ms)").health;
    };
    // 120 BPM: a beat is 500 ms.
    expect([150, 151, 500, 501].map((ms) => leadHealth(ms, 120))).toEqual(["ok", "warn", "warn", "bad"]);
    // 60 BPM: a beat is 1000 ms, so 600 ms is still amber.
    expect(leadHealth(600, 60)).toBe("warn");
  });
});

describe("L-P10a music rows", () => {
  it("one instance row per MusicDebugRow, cells matching the columns in count", () => {
    const v = viewAfter(sample(0, [row({ id: 1 }), row({ id: 2 })]));
    expect(instanceRows(v).map((r) => r.id)).toEqual(["music1", "music2"]);
    for (const r of instanceRows(v)) expect(r.cells).toHaveLength(sectionOf(v, "music").columns!.length);
  });

  it("Pending names target, time, tier, rule key, parent, exit and enter; null reads none", () => {
    const pendingText = (pending: MusicDebugRow["pending"]) => {
      const { v, r } = oneInstance(row({ pending }));
      return cellOf(v, r, "Pending").text;
    };
    expect(pendingText({ to: "verse", time: "5:1", rule: 2, ruleKey: "intro>verse", tier: 2, parent: "parent", exit: "nextBar", enter: "cue:in" })).toBe("verse at 5:1, tier 2 rule intro>verse from parent, exit nextBar, enter cue:in");
    expect(pendingText(null)).toBe("none");
  });

  it("groups and stems show primed n of N; a stem with no ring shows decoded", () => {
    const { v, r } = oneInstance(row({ groups: [{ id: 1, state: "priming", primed: 2, of: 3 }], stems: [{ name: "drums", primed: true, streamed: true, ring: 2 }, { name: "pad", primed: true, streamed: false, ring: null }] }));
    expect(cellOf(v, r, "Groups").text).toBe("2 of 3 primed");
    expect(cellOf(v, r, "Stems").text).toBe("2 of 2 primed (drums ring 2; pad decoded)");
  });

  it("record-valued counters (replans, refusals, recoveries) list their non-zero causes; all zero reads 0", () => {
    const a = oneInstance(row({ replans: { deadline: 2, primeLate: 0 }, refusals: { poolFull: 1 }, recoveries: { rebuild: 0 } }));
    expect(["Re-plans", "Refusals", "Recoveries"].map((l) => cellOf(a.v, a.r, l).text)).toEqual(["deadline 2", "poolFull 1", "0"]);
    const z = oneInstance(row({ replans: { deadline: 0 }, refusals: {}, recoveries: {} }));
    expect(["Re-plans", "Refusals", "Recoveries"].map((l) => cellOf(z.v, z.r, l).text)).toEqual(["0", "0", "0"]);
  });

  it("lastSlipFrames shows frames and milliseconds at the sample rate", () => {
    const { v, r } = oneInstance(row({ lastSlipFrames: 480 }));
    expect(cellOf(v, r, "Last slip").text).toBe("480 frames (10 ms)");
  });

  it("pool used of size with high-water; amber when every ring is in use", () => {
    expect(total(viewAfter(sample(0, [], totals({ poolUsed: 3, poolHighWater: 5 }))), "poolUsed")).toMatchObject({ text: "3 of 8 (high-water 5)", health: "info" });
    expect(total(viewAfter(sample(0, [], totals({ poolUsed: 8, poolSize: 8 }))), "poolUsed").health).toBe("warn");
  });

  it("no instances: the Music section has no rows and says so", () => {
    const v = viewAfter(sample(0, []));
    expect(instanceRows(v)).toEqual([]);
    expect(sectionOf(v, "music").empty).toBe("No music playing");
  });
});
