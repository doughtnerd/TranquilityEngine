/**
 * Undo/redo for the Sprite Editor (ADR 0115): an immutable history of snapshots. Pure, so the
 * stack rules are tested without the UI.
 */
export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
  /** The coalescing key of the last push: pushes with the same key replace the present instead of stacking. */
  key: string | null;
}

export const MAX_HISTORY = 100;

export const createHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], key: null });

/**
 * `next` as the new present, the old one becoming an undo step and the redo steps dropped. A
 * `next` equal to the present (by `equal`, default `Object.is`) changes nothing. Pushes sharing a
 * `key` in a row (one drag, one field being typed in) are a single step. At most `limit` steps are kept.
 */
export function pushHistory<T>(h: History<T>, next: T, options: { key?: string | null; equal?: (a: T, b: T) => boolean; limit?: number } = {}): History<T> {
  const { key = null, equal = Object.is, limit = MAX_HISTORY } = options;
  if (equal(h.present, next)) return h;
  if (key !== null && key === h.key) return { ...h, present: next, future: [] };
  const past = [...h.past, h.present];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [], key };
}

/** The present replaced without an undo step (state that isn't an edit, like which slice names were saved). */
export const replacePresent = <T>(h: History<T>, next: T): History<T> => ({ ...h, present: next });

export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;

/** One step back, or `h` itself at the start. The next push starts a new step even with the same key. */
export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null };
}

/** One step forward, or `h` itself at the end. */
export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null };
}
