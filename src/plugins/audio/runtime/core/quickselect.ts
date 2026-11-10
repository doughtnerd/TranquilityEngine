// Top-k selection for the voice selection (ADR 0157 A3.1, leaf L1; api-and-models §3 "Selection": "quickselect
// (O(L), no sort, no allocation) the top min(configured, mixedCap)").
//
// `selectTopK` partially orders two parallel arrays in place, keys and the items they belong to, so the k largest
// keys come first. It is Hoare's quickselect with a median-of-three pivot and a three-way (Dijkstra) partition, so
// runs of equal keys, common when many voices share a gain and priority, cost one pass instead of degrading to
// O(n^2). Average O(n); nothing is allocated; recursion is replaced by narrowing one range.

/**
 * @internal Reorders `keys[0..n)` and `items[0..n)` together so that `keys[0..k)` hold the `k` largest keys (in no
 * particular order) and every key in `keys[k..n)` is at most the smallest of them. Ties at the boundary are broken
 * arbitrarily. `k <= 0` or `k >= n` returns at once (nothing to separate). Keys must not be NaN. O(n) on average, no
 * allocation, no recursion.
 */
export function selectTopK(keys: Float32Array | Float64Array, items: Uint16Array | Uint32Array | Int32Array, n: number, k: number): void {
  if (k <= 0 || k >= n) return;
  let lo = 0;
  let hi = n - 1;
  // Invariant: the k-th largest (index k - 1 in descending order) lies in [lo, hi]; everything left of lo is >= it
  // and everything right of hi is <= it.
  const target = k - 1;
  while (lo < hi) {
    // Median of three (lo, mid, hi) as the pivot value.
    const mid = lo + ((hi - lo) >> 1);
    const a = keys[lo]!;
    const b = keys[mid]!;
    const c = keys[hi]!;
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
    // Three-way partition, descending: [lo, lt) > pivot, [lt, i) == pivot, (gt, hi] < pivot.
    let lt = lo;
    let gt = hi;
    let i = lo;
    while (i <= gt) {
      const v = keys[i]!;
      if (v > pivot) {
        swap(keys, items, lt, i);
        lt++;
        i++;
      } else if (v < pivot) {
        swap(keys, items, i, gt);
        gt--;
      } else {
        i++;
      }
    }
    if (target < lt) hi = lt - 1;
    else if (target > gt) lo = gt + 1;
    else return; // the target falls in the run equal to the pivot: done
  }
}

function swap(keys: Float32Array | Float64Array, items: Uint16Array | Uint32Array | Int32Array, i: number, j: number): void {
  const k = keys[i]!;
  keys[i] = keys[j]!;
  keys[j] = k;
  const t = items[i]!;
  items[i] = items[j]!;
  items[j] = t;
}
