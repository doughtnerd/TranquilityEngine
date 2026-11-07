// Pruning a saved edit history by age (ADR 0116, on ADR 0027): states older than N days go,
// except any state still needed. A state is kept if it's newer than the cutoff, on the path from
// the root to the current state (the way back to the head and the way forward from the root), on
// the path to the saved state (so the history still matches the file on disk), or an ancestor of
// anything kept (a patch is stored against its parent, so the tree must stay connected). What's
// left is old branches nobody has touched: whole subtrees whose every state is old.
import type { HistoryFile, HistoryState } from "./document";

export const DAY_MS = 86_400_000;

/** `days` as a setting: a whole number of days at least 0 (anything else: 0, which keeps everything). */
export function cleanPruneDays(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(36500, Math.floor(n)) : 0;
}

/**
 * `file` without its old, unneeded states (a new object; `file` is untouched). `days` 0 (or less)
 * prunes nothing. Returns the same object when nothing goes.
 */
export function pruneHistoryByAge(file: HistoryFile, days: number, now = Date.now()): HistoryFile {
  const d = cleanPruneDays(days);
  if (d === 0 || !Array.isArray(file.states)) return file;
  const cutoff = now - d * DAY_MS;
  const bySeq = new Map<number, HistoryState>(file.states.map((s) => [s.seq, s]));
  const keep = new Set<number>();
  // Mark `seq` and its ancestors (guarding against a cycle in a damaged file).
  const keepPath = (seq: number) => {
    for (let s: HistoryState | undefined = bySeq.get(seq), n = 0; s && !keep.has(s.seq) && n <= bySeq.size; s = bySeq.get(s.parent), n++) keep.add(s.seq);
  };
  keepPath(file.current);
  keepPath(file.saved);
  keepPath(file.root);
  for (const s of file.states) if (!(s.time < cutoff)) keepPath(s.seq);
  if (keep.size === file.states.length) return file;
  const states = file.states
    .filter((s) => keep.has(s.seq))
    .map((s) => (s.redoChild !== undefined && !keep.has(s.redoChild) ? withoutRedoChild(s) : s));
  return { ...file, states };
}

function withoutRedoChild(s: HistoryState): HistoryState {
  const { redoChild: _gone, ...rest } = s;
  return rest;
}
