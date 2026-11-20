/**
 * Binary searches over an ascending list of numbers (ADR 0261): the three questions a timeline asks of sorted times. Each
 * takes an optional `n` so a growable buffer can be searched over its filled part without a view.
 */

/** The first index in `a[0..n)` whose value is `>= t`; `n` when none is. */
export function firstAtOrAfter(a: ArrayLike<number>, t: number, n = a.length): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first index in `a[0..n)` whose value is `> t`; `n` when none is. */
export function firstAfter(a: ArrayLike<number>, t: number, n = a.length): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last index in `a[0..n)` whose value is `<= t` (the value in force at `t`); -1 when `t` precedes them all. */
export function lastAtOrBefore(a: ArrayLike<number>, t: number, n = a.length): number {
  return firstAfter(a, t, n) - 1;
}
