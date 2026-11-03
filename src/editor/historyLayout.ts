// Layout for the History panel (ADR 0027): one row per state, newest at the top, with a column
// per branch like the undotree plugin. Pure, so it's unit-tested.

export interface TreeState {
  readonly seq: number;
  readonly parent: number;
}

export interface HistoryRow {
  readonly seq: number;
  readonly parent: number;
  /** Branch column (0 = leftmost). */
  readonly col: number;
}

export interface HistoryLayout {
  /** Newest first. */
  readonly rows: HistoryRow[];
  /** Number of columns used. */
  readonly columns: number;
}

/**
 * Columns: at each state, the child whose subtree holds the newest state continues in the
 * parent's column; every other child starts a new column. So the most recent line of work stays
 * on the left and older branches fan out to the right.
 */
export function layoutHistory(states: readonly TreeState[]): HistoryLayout {
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const s of states) {
    if (s.parent === -1 || !states.some((p) => p.seq === s.parent)) roots.push(s.seq);
    else children.set(s.parent, [...(children.get(s.parent) ?? []), s.seq]);
  }
  // Newest state anywhere in each subtree.
  const newest = new Map<number, number>();
  const newestIn = (seq: number): number => {
    const known = newest.get(seq);
    if (known !== undefined) return known;
    const n = Math.max(seq, ...(children.get(seq) ?? []).map(newestIn));
    newest.set(seq, n);
    return n;
  };
  const col = new Map<number, number>();
  let next = 0;
  const place = (seq: number, c: number) => {
    col.set(seq, c);
    const kids = [...(children.get(seq) ?? [])].sort((a, b) => newestIn(b) - newestIn(a));
    kids.forEach((k, i) => place(k, i === 0 ? c : ++next));
  };
  for (const r of roots) place(r, roots.indexOf(r) === 0 ? 0 : ++next);
  const parentOf = new Map(states.map((s) => [s.seq, s.parent]));
  const rows = [...states]
    .sort((a, b) => b.seq - a.seq)
    .map((s) => ({ seq: s.seq, parent: parentOf.get(s.seq) ?? -1, col: col.get(s.seq) ?? 0 }));
  return { rows, columns: next + 1 };
}

/** "just now", "12s ago", "3 min ago", "2 h ago", "4 d ago". */
export function relativeTime(time: number, now: number): string {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
