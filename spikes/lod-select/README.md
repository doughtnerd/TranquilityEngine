# LOD selection cost in plain JS

**Question:** can per-view LOD selection (world bounding sphere, 6-plane frustum test, screen-relative height,
level pick against 4 thresholds) run in TypeScript, or does it need the wasm core?

**Method:** `node uncached.mjs N` recomputes each world sphere from its 4x4 matrix every view; `node cached.mjs N`
reads world spheres cached when a matrix changes (the engine already detects matrix changes, `render/changeDetection.ts`).
200 warm-up views, then 7 runs x 100 views; p50 and max of the per-run mean. Node 22, shared 4-core Xeon at load
about 2.5 (smoke-level; Chromium's V8 is the same engine).

| groups | uncached p50 / max (ms per view) | cached p50 / max (ms per view) |
|---|---|---|
| 1,000 | 0.150 / 0.169 | 0.013 / 0.016 |
| 10,000 | 1.138 / 1.596 | 0.227 / 0.263 |
| 50,000 | 5.631 / 5.974 | 1.237 / 1.271 |

**Finding:** with cached world spheres, selection costs about 0.23 ms per view for 10,000 groups, so TypeScript is
enough (about 0.9 ms at 4x CPU throttling, est.). Cache world bounds; recompute only for moved renderers.
