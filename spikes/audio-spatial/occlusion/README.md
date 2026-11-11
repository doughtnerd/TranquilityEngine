# Audio M3 occlusion: ray cost and time-sliced refresh (spike)

Throwaway measurement code. It imports engine code read-only and touches nothing outside this folder (Vitest's transpile cache goes to `node_modules/.cache` as for any test run).

## Question

Can listener-to-source occlusion run on the main thread inside the audio system's frame budget (command batch <= 0.1 ms, voice bookkeeping <= 0.25 ms per frame, architecture 0157 section 10), at 64 / 256 / 1,024 sources, **through the engine's own physics API**? How many rays per frame should the budget be, and how should sources be refreshed?

## What the engine offers (read from the code)

- `Physics.raycast(origin, direction, maxDistance?, layers?: string[])` (`src/plugins/physics/runtime/Physics.ts`): **first hit only**, returns `{ collider, point, normal, distance } | null`. No all-hits ray query exists; `overlap*` and shape casts do, but no ray version. Multi-wall transmission therefore means re-casting from the hit point (case "R1x3" below).
- `layers` filters by collision layer name (`queryGroups`: membership mask, `PhysicsCore.raycast`, passed to Rapier's `castRayAndGetNormal` as the groups argument). So an "Occluder" layer is a per-query filter, not a separate BVH.
- Path: `Physics.raycast` -> `World.require()` -> World service `myco.physics3d` (ADR 0135) -> `PhysicsCore.raycast` (normalises the direction, builds the groups mask, maps the hit to the `Collider` component) -> Rapier backend (`new Ray` per call). Each hit allocates a result object and two `Vector3`s. Audio would call the service from its system instead of the static class; the work is the same.
- Rapier's BVH is refreshed in `world.step()` (earlier spike), so queries lag at most one physics step. Static colliders cost nothing per frame.

## Method

- `scene.ts`: a headless `Engine` with the Rapier physics plugin; a 200 m x 200 m level of 20x20 cells, about 200 partial walls on layer `Occluder` (lengths 4-10 m, thickness 0.2-1 m, heights 3-6 m, five materials via a table) plus 120 crates on layer `Default` and a floor: **319 colliders** (the count is printed in the results header). Listener walks a circle at 6 m/s. Sources: uniform in an 80 m disc, never inside geometry, 0.8-2.8 m high. About 80% of the rays are blocked, which is a deliberately dense, indoor-like worst case (a ray that hits early is cheaper than one that travels the whole way).
- `occlusion.ts`: the occlusion pass.
  - `castSource`: R rays from the source (R=1 centre; R=3 adds +-1 m lateral offsets; R=5 adds +-1 m vertical) to the listener, first hit, `maxDistance = distance - 0.05`. Hit collider -> material through a `Map` lookup (what the audio system would do with an occluder component), then gain and log2-cutoff tables. A source's target is the mean over its rays (partial occlusion).
  - `frame`: ranking by audibility (`loudness / (1 + d^2)`, partial top-16 selection) -> the top tier is recast every frame, using at most `tierShare` (0.5) of the budget -> round-robin over everyone else (a cursor, skipping sources already cast this frame) until the budget is spent (time budget, checked with `performance.now()` after every source, at least one cast per frame) -> one-pole smoothing (tau 100 ms, cutoff smoothed in the log domain) of **every** source and the write of the per-voice gain / `lpHz` outputs. The frame time reported includes all of it.
  - "Frames to refresh all": the first frame at which every source has been cast at least once, counted from a cold start.
- Moving mode: every source walks at 1-4 m/s (bouncing in the 80 m box; no collision with geometry), the listener circles. Quality metric **stale-wrong %**: every 10th timed frame, untimed, the centre-ray occluded/clear state of every source is recomputed and compared with the scheduler's cached state (includes sources not yet visited).
- Timing: 5 runs (new source placement each) x 600 timed frames after 60 warm-up frames per case; pooled quantiles per frame (so p99.9 is from 3,000 frames); `rays/ms` = rays / total frame time. GC pauses from the engine's result allocations are included in the tails.

## One command

```
node spikes/audio-spatial/occlusion/run.mjs
```

Runs the correctness tests, then the timed grid (about 8-10 minutes at the defaults on a 4-core VM; writes `results.json`), then prints the tables. Env: `RUNS` (5), `FRAMES` (600), `WARMUP` (60), `SECTIONS=rays,sched,transmission`, `SMOKE=1` (RUNS=2, FRAMES=120, writes `results.smoke.json`, labels the output). Tests alone: `npx vitest run --config spikes/audio-spatial/occlusion/vitest.config.mts correctness`.

## Correctness (passing)

| Check | Result |
|---|---|
| Source behind a wall is occluded, source in line of sight is not (hand-built scene) | pass |
| Layer filter: a `Default` crate blocks an unfiltered ray, not an `["Occluder"]` ray; an `Occluder` wall is ignored by a `["Default"]` ray | pass |
| 2,000 sources vs an analytic ray/box test (all colliders, and Occluder only) | 0 / 2000 mismatches each; 0 hit-distance disagreements (> 1 mm); about 1,600 occluded, about 400 clear |
| Filter on 1,000 rays: no `Default` collider in a filtered hit; filtered hits <= unfiltered; rays blocked only by a prop exist | pass (15-30 such rays) |
| Scheduler (count budgets b = 1, 2, 8, 20, 64 at S = 64 / 256 / 1,024) visits every source within `ceil(S / (b - tierCasts))` frames, spends exactly b casts per frame, and in steady state nobody is staler than that bound | pass |
| Time-budget scheduler settles to the truth when static (0 / 256 wrong) and smoothed gain is < 0.99 for exactly the occluded sources | pass |

## Results

**All numbers below are SMOKE timings** (2 runs x 120 frames, Xeon 2.1 GHz x4 shared VM, Node 22, not idle): they check that the runner works, they are not the final figures. The coordinator's idle-machine run replaces them. `results.smoke.json` holds the raw data.

### 1. Ray cost, all S sources every frame (smoke; us per frame)

| S | variant | filter | rays/frame | p50 | p99.9 | max | rays/ms |
|---|---|---|---|---|---|---|---|
| 64 | R1 | Occluder | 64 | 237 | 856 | 856 | 257 |
| 64 | R3 | Occluder | 192 | 651 | 3437 | 3437 | 273 |
| 64 | R5 | Occluder | 320 | 1023 | 3869 | 3869 | 300 |
| 256 | R1 | none / Occluder | 256 | 970 / 1002 | 4664 / 2365 | 4664 / 2365 | 234 / 228 |
| 256 | R3 | Occluder | 768 | 2581 | 6147 | 6147 | 262 |
| 256 | R5 | Occluder | 1280 | 4341 | 8306 | 8306 | 285 |
| 1024 | R1 | none / Occluder | 1024 | 3860 / 3818 | 7430 / 6971 | 7430 / 6971 | 263 / 263 |
| 1024 | R3 | Occluder | 3072 | 10545 | 19924 | 19924 | 280 |
| 1024 | R5 | Occluder | 5120 | 16987 | 27076 | 27076 | 297 |
| 1024 | R1x3 | Occluder | 2565 | 8461 | 19847 | 19847 | 293 |

Smoke reading: about 3.3-4.4 us per ray (230-300 rays/ms) through the engine API, matching the earlier raw-Rapier spike (1.5-4.3 us), so the wrapper adds little. Filtering by the Occluder layer makes no measurable cost difference here. **Casting every source every frame is out**: 1,024 sources x 1 ray is about 3.8 ms; 5 rays about 17 ms (a whole frame).

### 2 + 4. Time-sliced scheduler (smoke; frame = ranking + rays + smoothing of all S)

| S | R | budget | motion | casts/frame | p50 us | p99.9 us | max us | frames to refresh all | stale-wrong % |
|---|---|---|---|---|---|---|---|---|---|
| 64 | 1 | 0.25 ms | static / moving | 54 / 62 | 258 / 233 | 777 / 830 | 777 / 830 | 2 / 2 | - / 0.1 |
| 256 | 1 | 0.25 ms | static / moving | 64 / 69 | 271 / 272 | 948 / 1103 | 948 / 1103 | 6 / 5 | - / 0.9 |
| 256 | 1 | 0.5 ms | static / moving | 117 / 129 | 522 / 522 | 1431 / 5768 | 1431 / 5768 | 5 / 3 | - / 0.3 |
| 256 | 3 | 0.25 ms | static / moving | 20 / 31 | 286 / 275 | 2387 / 1196 | 2387 / 1196 | 36 / 25 | - / 4.2 |
| 1024 | 1 | 0.25 ms | static / moving | 57 / 69 | 326 / 325 | 4233 / 1015 | 4233 / 1015 | 49 / 20 | - / 4.3 |
| 1024 | 1 | 0.5 ms | static / moving | 128 / 133 | 573 / 574 | 1311 / 1142 | 1311 / 1142 | 10 / 9 | - / 1.8 |
| 1024 | 3 | 0.25 ms | static / moving | 30 / 33 | 327 / 327 | 1144 / 1107 | 1144 / 1107 | 78 / 65 | - / 19.3 |
| 1024 | 3 | 0.5 ms | static / moving | 56 / 57 | 574 / 578 | 1469 / 3089 | 1469 / 3089 | 25 / 25 | - / 6.2 |
| 1024 | 1 | top 128 only (no round-robin) | moving | 128 | 421 | 1299 | 1299 | never | 68.5 |

The full grid (R = 1 and 3, 0.25 and 0.5 ms, static and moving, top-N-only) is in the runner's output.

Smoke reading:
- The time budget is respected at p50 (frame = budget + about 0.07 ms for ranking and smoothing at 1,024) but **not at the tail**: p99.9 and max are 3-20x the budget (GC from per-hit allocation, Node timer and VM noise). The tail is the number to watch on the idle run.
- Per-source cost of ranking + smoothing is small: about 60 ns per source per frame (1,024 sources: about 60-75 us), so 1,024 sources eat 0.06 ms of the 0.25 ms voice-bookkeeping budget before any ray.
- Moving sources: stale-wrong stays under about 2% at 0.5 ms with R=1 even at 1,024 sources, and rises to 4-6% at R=3 or 0.25 ms. Re-casting only the top N each frame is wrong for most of the far sources (they are never visited), so round-robin is needed.

### 3. Transmission model, no rays (smoke; per frame)

Table lookups per hit plus aggregation: about 10-70 ns per source (1,024 sources, R=1..5: 14-75 us). Smoothing and writing the per-voice outputs for every source: about 60 ns per source (1,024: about 60 us). Small-S rows are noisy in the smoke run (JIT warm-up); see the runner output.

## Findings (provisional until the idle-machine run)

1. **Ray cost is about 3.5-4 us through the engine API (about 250-300 rays/ms)**, independent of S and of the Occluder filter. 0.25 ms buys about 55-70 rays, 0.5 ms about 115-135.
2. **Recommended budget: 0.25 ms of main thread per frame (about 64 rays) as the default, 0.5 ms (about 128 rays) as a "high" setting.** At 0.25 ms the occlusion pass uses the same share as the voice-bookkeeping budget; it is a separate line, so add it to the main-thread frame accounting.
3. **Scheme: time-sliced, audibility tier plus round-robin, one centre ray per source in the tier and the far set; extra rays (R=3) only for the top few.** Each frame: rank by audibility (cheap), recast the top 16 or so (at most half the budget), round-robin the rest, smooth everything at about 100 ms. Refresh-all times at R=1, 0.25 ms (smoke): 64 sources 2 frames, 256 about 6, 1,024 about 50 (0.8 s); 0.5 ms: about 10 frames at 1,024. 1,024 sources at R=3 and 0.25 ms takes more than a second (65-78 frames) with 19% stale in motion: do not spend R=3 on every source. Spend extra rays on the top handful.
4. Smoothing hides the cadence: at tau 100 ms a source refreshed every 10-50 frames moves smoothly between targets; only a fast-moving listener around a corner shows the lag (the stale-wrong %).
5. The audio system needs `Physics` reachable from its system: through the World service key (a small `raycast(origin, dir, max, layers)` helper on the physics service), not the static class.
6. Voice count that matters is the audible set: sources culled by attenuation (out of range) should not be ranked or cast at all; this spike places all sources within 80 m and ranks them all.

## Unverified

- Final timings: everything above is smoke on a shared 4-core VM. The idle run decides the budgets and the tails.
- Phone numbers (an Android WebView on a low-end phone): Rapier WASM in a WebView is typically several times slower than Node on x86; unmeasured.
- Chromium/Firefox main-thread timings (this is Node 22 only; `performance.now()` is coarser in pages without cross-origin isolation).
- The cost of getting results to the audio thread (the command batch, <= 0.1 ms) and of the real audio system's selection reading the occlusion factor: modelled as plain arrays here, not wired into `audioSystem.ts` / `selection.ts`.
- Dynamic occluders (moving colliders): the BVH refresh is in `world.step()` (earlier spike: +0.03-0.17 ms for 50 moved bodies); not re-measured here. Only static colliders and moving rays are timed.
- Mesh (trimesh) occluders: boxes only here; the earlier spike measured 2-4 us/ray on 100k-triangle meshes.
- Multi-wall transmission via re-casting (R1x3) is crude (no thickness; each hit counts once); the real model may use the hit distance through a thin collider or an authored occluder thickness.
- Sources moving through geometry is allowed in the moving mode; real sources do not.
- GC cost of the engine's per-hit allocation is inside the tails but is not isolated.
