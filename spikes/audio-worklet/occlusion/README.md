# Audio occlusion raycast cost (Rapier 3D, main thread)

Measures what listener-to-source occlusion rays cost on the main thread with `@dimforge/rapier3d-compat` 0.21.0 (the package `src/plugins/physics-rapier/runtime/rapier3d.ts` uses; it builds `new RAPIER.World(gravity)` and queries with `world.castRay`).

Run from the repo root: `node spikes/audio-worklet/occlusion/run.mjs` (about 40 s; writes `results.json`). `bench.js` is shared by Node and the Chromium page (`index.html`, served by `run.mjs`).

## Method

- Scenes (static, plus 50 small dynamic bodies with zero gravity): `boxes200` (200 boxes in 100 m), `boxes2000` (2,000 boxes in 300 m), `trimesh100k` (2 bumpy 135x135 terrain tiles + 8 wall meshes = 98,480 triangles), `mixed` (2,000 boxes + the trimeshes).
- Per frame: one listener (moving slowly), S sources at 5-65 m, R rays per source (R=1 centre ray; R=5 adds four 1 m offsets at the source for a spread). Ray length = distance to source, `solid = true`.
- `castRay` = first hit (`world.castRay`). `all` = `world.intersectionsWithRay` with a callback that counts and continues.
- One `Ray` object is mutated and reused. Allocating a new `Ray` per query made no measurable difference (see `results.json`, `alloc`).
- 30-200 timed frames per cell after 20 warm-up frames; p50/p95 per frame.
- Environments: Node v26.10.0, and Playwright Chromium page main thread. **Chromium's `performance.now()` is quantised to 0.1 ms on a page without cross-origin isolation**, so small Chromium numbers are coarse; Node's are the precise ones. The two agree within about 20%.

## Results (p50 ms per frame, Node; Chromium in brackets for the corners)

`castRay`, R=1 / R=5:

| Scene | S=32 | S=64 | S=128 | S=256 | us/ray |
|---|---|---|---|---|---|
| boxes200 | 0.06 / 0.24 | 0.14 / 0.68 | 0.25 / 1.43 | 0.59 / 2.27 (0.3 / 2.0) | 1.5-2.3 |
| boxes2000 | 0.07 / 0.24 | 0.09 / 0.51 | 0.19 / 1.50 | 0.51 / 2.35 (0.4 / 2.3) | 1.5-2.1 |
| trimesh100k | 0.07 / 0.43 | 0.12 / 0.66 | 0.35 / 1.57 | 1.01 / 4.93 (0.7 / 3.3) | 2.0-4.0 |
| mixed | 0.13 / 0.53 | 0.17 / 1.05 | 0.35 / 2.01 | 1.02 / 5.55 (0.8 / 4.1) | 3.3-4.3 |

`intersectionsWithRay` (all hits), R=1 / R=5:

| Scene | S=32 | S=256 | us/ray |
|---|---|---|---|
| boxes200 | 0.15 / 0.63 | 0.87 / 4.2 (0.8 / 4.6) | 3.3-4.6 |
| boxes2000 | 0.16 / 0.67 | 1.13 / 6.5 (1.2 / 6.8) | 4.2-5.1 |
| trimesh100k | 0.10 / 0.60 | 1.40 / 6.7 (0.9 / 4.9) | 3.0-5.5 |
| mixed | 0.35 / 1.42 | 3.09 / 14.8 (2.6 / 10.3) | 8.9-12.1 |

p95 is typically 1.2-1.6x p50 (mixed, S=256, R=5, `all`: p95 17.5 ms Node, 14.3 ms Chromium, over the 16.7 ms budget). Full grid, all S values, both environments: `results.json` (or the console output of `run.mjs`).

Rule of thumb: `castRay` costs about 2-4 us/ray, `intersectionsWithRay` about 3-5 us/ray on single-type scenes and 9-12 us/ray on the mixed scene (two BVHs and many hits per long ray). Cost per ray barely depends on S, so frame cost is linear in S x R.

## Keeping the BVH current

Rapier 0.21 has no explicit query-pipeline update call: the broad-phase BVH is refreshed inside `world.step()`. I checked that after `setTranslation` a `castRay` still sees the old position until the next `step()` (`seesMoveBeforeStep: false`, `seesMoveAfterStep: true`). So occlusion queries are one physics step stale at most, and no extra cost is paid beyond the step.

Cost of `step()` with 50 dynamic bodies teleported each frame (p50 ms, Node; no gravity, no contacts to speak of), versus the same scene with nothing moving:

| Scene | idle step | 50 moved | delta |
|---|---|---|---|
| boxes200 | 0.14 | 0.17 | +0.03 |
| boxes2000 | 0.24 | 0.41 | +0.17 |
| trimesh100k | 0.12 | 0.28 | +0.16 |
| mixed | 0.25 | 0.56 | +0.31 (p95 0.95) |

Chromium agrees within its 0.1 ms resolution (mixed: 0.4 moved). The physics step runs anyway for gameplay, so this is the marginal cost of a current BVH, not an audio-only cost.

## Caveats

- Random-ish scenes: sources mostly sit in the open or behind boxes, so many rays hit early. Rays that travel long distances through dense geometry cost more; the `all` numbers show that.
- One thread, no GC pressure from the rest of the game; real frames also pay for rendering, scripts and physics. Treat these as lower bounds, and measured shares as the audio system's slice.
- Only `solid = true` rays, no filter groups or predicates. A JS `filterPredicate` costs a wasm-to-JS call per candidate; avoid it and use collision groups.
- Chromium timer quantisation (above). Results are single runs on one Windows machine.
- Static trimesh colliders only; dynamic or deforming trimeshes were not tested.

## Recommended budget

Give audio occlusion about 1 ms of the 16.7 ms frame (6%), p95. At 3-4 us/ray that is roughly 250 `castRay` rays per frame (up to 150 on mixed levels, and fewer if `intersectionsWithRay` is used).

- Default: 1 `castRay` per audible source, only for the sources actually mixed (the loudest 32-64), not every logical voice.
- Amortize: round-robin so each source is re-tested every 4-6 frames (about 10-15 Hz) and smooth the occlusion gain over 100-200 ms. 256 sources at R=1 is then about 50 rays per frame.
- Spread (R=5) only for the 8-16 nearest or loudest sources, and run it less often than the centre ray (every 8-10 frames).
- Skip or reuse for distant, quiet, or non-moving pairs: if neither listener nor source moved beyond a small threshold, keep the last result.
- Use `intersectionsWithRay` (wall counting or thickness) sparingly: 2-3x the cost of `castRay`, so budget it at 50-100 per frame and only for the nearest sources.
- Hard cap: a per-frame ray counter that stops casting when the budget is spent and resumes next frame.
