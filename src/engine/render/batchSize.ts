/**
 * How big the next batch of work is, from how long the last one took against a time budget: double
 * while it took under half the budget, else scale it to the budget. The warm-up sizes its batches by
 * the time their shader effects took (`render/babylon/warmUp.ts`, ADR 0080). Pure.
 */

/** The next batch's size from the last one's `size`, which took `spentMs` of a `budgetMs` budget; 1 to `max`. */
export function nextBatchSize(size: number, spentMs: number, max: number, budgetMs: number): number {
  if (spentMs < budgetMs / 2) return Math.min(max, size * 2);
  return Math.max(1, Math.min(max, Math.round((size * budgetMs) / spentMs)));
}
