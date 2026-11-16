// A bitonic sorting network (ADR 0126): the compare-and-swap stages that sort `n` (a power of two)
// (key, value) pairs ascending, and one stage run in JavaScript, the reference for what each GPU pass of
// the particle sort (`sort.ts`) does. Pure.

/** The bitonic network's stages for `n` (a power of two): [k, j] pairs, in order. */
export function bitonicStages(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 2; k <= n; k *= 2) for (let j = k / 2; j >= 1; j /= 2) out.push([k, j]);
  return out;
}

/** Apply one bitonic stage to (key, value) pairs in place: what one GPU pass does. */
export function bitonicStep(pairs: Float32Array, n: number, k: number, j: number): void {
  for (let i = 0; i < n; i++) {
    const l = i ^ j;
    if (l <= i) continue;
    const up = (i & k) === 0;
    const a = pairs[i * 2];
    const b = pairs[l * 2];
    if (up ? a > b : a < b) {
      const v = pairs[i * 2 + 1];
      pairs[i * 2] = b;
      pairs[i * 2 + 1] = pairs[l * 2 + 1];
      pairs[l * 2] = a;
      pairs[l * 2 + 1] = v;
    }
  }
}
