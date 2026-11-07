import { describe, expect, it } from "vitest";
import type { HistoryFile, HistoryState } from "./document";
import { cleanPruneDays, DAY_MS, pruneHistoryByAge } from "./historyPrune";

const NOW = 1_000 * DAY_MS;
const st = (seq: number, parent: number, ageDays: number, extra: Partial<HistoryState> = {}): HistoryState => ({ seq, parent, label: `s${seq}`, time: NOW - ageDays * DAY_MS, hash: `h${seq}`, ...extra });
const file = (states: HistoryState[], current: number, saved = 0): HistoryFile => ({ format: "myco.history@1", scene: "s", root: 0, current, saved, nextSeq: states.length, states });
const seqs = (f: HistoryFile) => f.states.map((s) => s.seq);

describe("pruneHistoryByAge (ADR 0116)", () => {
  //  0 - 1 - 2 - 3 (current)
  //       \ 4 - 5 (old branch)
  //   \ 6 (old leaf off the root)
  const tree = () => file([st(0, -1, 100), st(1, 0, 100), st(2, 1, 100), st(3, 2, 1), st(4, 1, 90), st(5, 4, 80), st(6, 0, 70, { redoChild: undefined })], 3, 3);

  it("0 days, or nothing old, changes nothing", () => {
    const f = tree();
    expect(pruneHistoryByAge(f, 0, NOW)).toBe(f);
    expect(pruneHistoryByAge(f, 200, NOW)).toBe(f);
  });

  it("drops old branches but never the path from the root to the current state", () => {
    const pruned = pruneHistoryByAge(tree(), 30, NOW);
    expect(seqs(pruned)).toEqual([0, 1, 2, 3]); // the whole path stays though 0-2 are old
    expect(pruned.current).toBe(3);
  });

  it("keeps an old state whose descendant is recent, and the path to the saved state", () => {
    const f = file([st(0, -1, 100), st(1, 0, 100), st(2, 1, 100), st(3, 1, 100), st(4, 3, 2), st(5, 0, 100)], 2, 0);
    expect(seqs(pruneHistoryByAge(f, 30, NOW))).toEqual([0, 1, 2, 3, 4]); // 3 is kept for its child 4; 5 goes
    const g = file([st(0, -1, 100), st(1, 0, 100), st(2, 1, 100), st(3, 0, 100)], 3, 2);
    expect(seqs(pruneHistoryByAge(g, 30, NOW))).toEqual([0, 1, 2, 3]); // current 3 and saved 2 both kept
  });

  it("repairs redoChild pointers to removed states, and doesn't change its input", () => {
    const f = file([st(0, -1, 100, { redoChild: 2 }), st(1, 0, 1), st(2, 0, 100)], 1, 1);
    const before = JSON.stringify(f);
    const pruned = pruneHistoryByAge(f, 30, NOW);
    expect(seqs(pruned)).toEqual([0, 1]);
    expect("redoChild" in pruned.states[0]).toBe(false);
    expect(JSON.stringify(f)).toBe(before);
  });

  it("survives a cyclic or malformed file", () => {
    const f = file([st(0, 1, 100), st(1, 0, 100)], 0, 0);
    expect(() => pruneHistoryByAge(f, 1, NOW)).not.toThrow();
    expect(pruneHistoryByAge({ ...f, states: undefined as never }, 1, NOW).states).toBeUndefined();
  });

  it("reads the setting as whole days", () => {
    expect([cleanPruneDays(-3), cleanPruneDays("x"), cleanPruneDays(7.9), cleanPruneDays("30"), cleanPruneDays(1e9)]).toEqual([0, 0, 7, 30, 36500]);
  });
});
