// Per-asset undo and redo for a graph editor: whole-graph snapshots, kept for the session while
// the panel shows another asset (ADR 0046, 0060).

/** Undo and redo for one asset: the snapshots before and after the current one. */
export interface GraphHistory<T> {
  undo: T[];
  redo: T[];
}

export interface GraphHistories<T> {
  /** An asset's history this session. */
  get(path: string): GraphHistory<T>;
  /** Record that the asset was `before` until an edit; the redo stack is cleared. */
  record(path: string, before: T): void;
  /** Step back from `current`: returns the snapshot to show, or undefined with nothing to undo. */
  undo(path: string, current: T): T | undefined;
  /** Step forward from `current`: returns the snapshot to show, or undefined with nothing to redo. */
  redo(path: string, current: T): T | undefined;
  /** Forget an asset's history (its file was renamed or deleted). */
  forget(path: string): void;
}

/** A history store for one kind of asset, each asset keeping at most `limit` undo steps. */
export function createGraphHistory<T>(limit = 200): GraphHistories<T> {
  const histories = new Map<string, GraphHistory<T>>();
  const get = (path: string) => {
    let h = histories.get(path);
    if (!h) histories.set(path, (h = { undo: [], redo: [] }));
    return h;
  };
  return {
    get,
    record(path, before) {
      const h = get(path);
      h.undo.push(before);
      if (h.undo.length > limit) h.undo.shift();
      h.redo.length = 0;
    },
    undo(path, current) {
      const h = get(path);
      const prev = h.undo.pop();
      if (prev !== undefined) h.redo.push(current);
      return prev;
    },
    redo(path, current) {
      const h = get(path);
      const next = h.redo.pop();
      if (next !== undefined) h.undo.push(current);
      return next;
    },
    forget: (path) => histories.delete(path),
  };
}
