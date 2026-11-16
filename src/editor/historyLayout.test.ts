import { describe, expect, it } from "vitest";
import { layoutHistory, relativeTime } from "./historyLayout";

describe("History panel layout", () => {
  it("puts a straight line of states in one column, newest first", () => {
    const l = layoutHistory([{ seq: 0, parent: -1 }, { seq: 1, parent: 0 }, { seq: 2, parent: 1 }]);
    expect(l.rows.map((r) => r.seq)).toEqual([2, 1, 0]);
    expect(l.rows.every((r) => r.col === 0)).toBe(true);
    expect(l.columns).toBe(1);
  });

  it("keeps the newest branch on the left and moves older branches to new columns", () => {
    // 0 → 1 → 2, then undo to 1 and edit: 3. Then 3 → 4.
    const l = layoutHistory([
      { seq: 0, parent: -1 },
      { seq: 1, parent: 0 },
      { seq: 2, parent: 1 },
      { seq: 3, parent: 1 },
      { seq: 4, parent: 3 },
    ]);
    const col = Object.fromEntries(l.rows.map((r) => [r.seq, r.col]));
    expect(col).toEqual({ 0: 0, 1: 0, 3: 0, 4: 0, 2: 1 });
    expect(l.columns).toBe(2);
  });

  it("handles a pruned root (a state whose parent is gone)", () => {
    const l = layoutHistory([{ seq: 5, parent: -1 }, { seq: 6, parent: 5 }]);
    expect(l.rows.map((r) => [r.seq, r.col])).toEqual([[6, 0], [5, 0]]);
  });
});

describe("relative time", () => {
  const now = 1_000_000_000;
  it("formats seconds, minutes, hours and days", () => {
    expect(relativeTime(now - 1000, now)).toBe("just now");
    expect(relativeTime(now - 12_000, now)).toBe("12s ago");
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 d ago");
  });
});
