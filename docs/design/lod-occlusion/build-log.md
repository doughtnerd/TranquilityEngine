# Build log: mesh LOD (0459) and occlusion culling (0460)

Coordinator's log of merges, checks and findings. Newest last.

## 2026-11-28

- **Owner decisions:** accepted both records; decision 1 opt-in LOD generation; decision 2 the owner runs real-hardware
  measurements later; decision 3 tolerant occlusion (false occlusions under 16 px at 1080p accepted).
- **First wave:** `spikes/lod-apply/` (per-view object lists 0.055 ms/view at 10k instances; shared vertex buffers 1.13x),
  `spikes/occlusion-safety/` (the rules as first written failed; sloppy stand-ins dropped; decided rules in 0460 §3).
- **Wave 1 merged:** T1 import pipeline (946b858e), T2 visibility core and `LODGroup` (7b47b980), T4 benchmark and
  triangle stats (80f54ceb). Merge fixes: triangles report the last finished frame (a slow frame read early showed 0);
  `.mycomesh` v5 in two older tests; the editor installs the LOD host; `LodMember.castShadows` added to the contract.
- **Benchmark check:** city-auto reports 10,379,022 triangles per frame through the new counter (spike: 10.3M).
- **Wave 2 merged:** T5 Babylon application (4c7e4176), T6 editor (f292cdee). Merge fixes: `LODGroup` in the Rendering
  category; the import panel's styles moved into the meshes plugin (plugins reach the editor only through its SDK).
- **Checks on the merged wave 2:** typecheck clean; `npm test` 13,702 passed after the two fixes above; `npm run test:e2e`
  286 passed, 3 failed. `audio-mix-smoke.spec.ts:129` passed on re-run (flaky under load). **Pre-existing on master
  6a0740ca, not caused by this work:** `dragdrop.spec.ts:69` and `hierarchy.spec.ts:54` (drops onto nodes inside prefab
  instances) fail identically on an untouched master checkout.
- **Wave 3/4 merged:** T3 Rust visibility crate (faa168d7; runtime wasm 18.7 KB gzip, editor 21.4 KB; reduced safety
  scenes at 256x128: 0 false occlusions of 16+ px, 64.6 % of culls kept), T7 placement adds groups + LOD e2e + bench LOD
  variants (67ed3026), T8 crossfade (a52582e8), T9 skinned levels and rig LOD (7dbb35d8). Merge fixes: `build:visibility`
  script; the occlusion contract carries per-triangle errors and edge neighbours (silhouette-only shrink) and camera
  data; `lodGroup` in `AnimatorLodMetric`.
- **Found by the first LOD e2e run (fixed, 659b303a):**
  - **Every crossfade effect failed to compile** on WebGL2: the plugin used `#include<bayerDitherFunctions>`, which Babylon
    doesn't expand in plugin-injected code. Warm-up then waited on the effect until the frame graph timed out, so any scene
    with LOD levels drew nothing. The Bayer rank is now inlined, and the unit test asserts no include in injected code.
    NullEngine unit tests can't catch shader compile errors; only the browser run did.
  - **The LOD bar crashed after undoing a placement** ("This GameObject has been destroyed."): its member poll walked a
    destroyed node. It skips dead nodes now; the placement test passed 5/5 after failing 1 in 3–4 runs before. The
    visibility service also skips components of dead nodes (defensive; no headless repro).
  - Spec fixes (test-only): nodes are found through the scene tree (scenes are nodes, ADR 0016); a smooth model's level 1
    can be chosen at most distances (tiny measured error), so tests compare near against far; the Stats overlay is hidden
    from captures; the shadow check compares captures rather than counting "dark" pixels (the soft shadow is ~25 % darker).
- **LOD e2e (`tests/e2e/lod.spec.ts`): 6 passed** — import panel levels, placement adds the group and the LOD bar, models
  without levels get none, far camera draws a coarser level and fewer triangles and a too-small group is culled, forceLevel
  pins, a culled group keeps casting its shadow, scenes without groups unchanged.
- **Checks on the merged waves 3–4:** `npm test` 13,747 passed and 1 failed: the skinned render feature imported a
  Babylon type outside the backend (ADR 0075 import rule); fixed by deriving the type from the feature interface.
  `npm run test:e2e` 291 passed, 4 failed: `audio-mix-smoke.spec.ts:182` and `codefiles.spec.ts:32` passed on re-run
  (flaky under load); `dragdrop.spec.ts:69` and `hierarchy.spec.ts:54` are the pre-existing master failures.
- **M1 (LOD, hard switches) and M2 (crossfade, skinned levels, rig LOD) are built.** Open for them: a browser pixel check
  of a fade (no holes), the scene-camera marker and click-to-preview on the LOD bar (T11), and the benchmark run.
- **T11a merged (68380236):** click-to-preview a level in the scene view (`RenderPolicy.lodPreview`, scene-view selection
  override), the scene-camera marker on the LOD bar, and `tests/e2e/lod-fade.spec.ts`. **Crossfade pixel check passed**
  on its first run: the silhouette during a 5 s fade stays within 5 % of the steady areas, and the view settles after.
  Limitation: the spec can't prove a fade was running at the captures (fade state isn't public), only that no holes
  appear in the window where it should. The LOD-level debug colouring is not built (needs a hook in the mesh feature).
  Token name: the editor defines `--lod-culled` (records said `--lodCulled`); the code and CSS agree.
- **Benchmark:** forest-auto didn't start play within 10 min on software GL under load (a forest frame takes ~47 s);
  limits raised to 30 min, forest variants to be re-run on an idle machine.
- **CPU against no LOD (2026-11-28).** The first same-conditions run (occlusion-gate harness, `-base` projects without
  `LODGroup`s, 3 runs) showed LOD costing JS CPU, against 0459's target "JS CPU ≤ baseline with LODs on": forest static
  67 → 90 ms, fly 69 → 143 ms; city static 41 → 42, fly 41 → 53. Profiling (`spikes/occlusion-gate/profile.mjs`) found:
  - **Dead Babylon instances.** Pooled drawables never expired at level 0, so every renderer kept a disabled LOD0
    instance; the scene walks all meshes each frame (16,350 meshes for 10k renderers static, 36,626 flying, against
    10,009 without LOD). Fixed: level 0 expires; the pool counts frames (`POOL_FRAMES`), not seconds (a fast camera at a
    high frame rate left more behind, not fewer); off-screen renderers keep their drawable enabled and unlisted, as
    without levels; batches hand a given-back instance to the next renderer switching into them (`FREE_FRAMES`).
  - **Per-frame string work.** `meshesIfLoaded` re-read the asset sources per renderer per call (about 15 % of every
    frame, with or without LOD); it now resolves each reference once per pass (`beginMeshLookups`), and the pure path
    helpers are memoised. This speeds up the baseline too.
  - **Allocations in `prepareViews`** (arrays and closures per renderer per frame): removed; one sweep instead of two.
- **After the fixes (2 runs each, ms p50, SwiftShader, 1280×720, High):**

  | Scene | Base CPU | LOD CPU | Base tris | LOD tris |
  |---|---|---|---|---|
  | forest static | 58.0 | 63.2 | 61.4M | 15.0M |
  | forest fly | 52.9 | 103.8 | 48.1M | 16.1M |
  | city static | 30.6 | **23.5** | 10.3M | 1.8M |
  | city fly | 27.7 | 33.3 | 6.9M | 1.4M |

  City static now meets the target. Forest static is 9 % over; both fly paths are over, forest by about 2×. What remains
  is the per-renderer `InstancedMesh` design under LOD: Babylon's per-mesh walk, frustum and caster tests on each
  instance, level-switch churn, and the engine's per-member gather. 0459's own spike measured thin batches at about half
  the JS CPU of auto. Proposed next (owner decision): draw auto batches through per-pass thin sources while levels are
  applied, as thin batches already do.
- **Visibility stage on the core's change signals (2026-11-28).** Membership is rebuilt only when the new internal
  `World.structureVersion` moves (components added, removed, enabled, disabled; nodes reparented or destroyed); bounds
  only when a node's `tVersion` moves or its meshes change. Profiled, the stage's own code went from ~10.8 to ~4.7 ms a
  frame on the forest fly-through.
- **Measuring on this machine:** SwiftShader on a shared container drifts by tens of percent between runs (the
  unchanged no-LOD forest static read 54.6, 58.0 and 37.3 ms in three sequential runs). Comparisons are now
  interleaved, no-LOD and LOD alternating (`run.mjs --only <id>$`, one run each, three rounds).
- **Interleaved, forest (ms p50 per round):**

  | Path | No LOD | LOD | Mean no LOD → LOD |
  |---|---|---|---|
  | static | 56.0, 57.9, 52.4 | 49.4, 51.9, 58.6 | 55.4 → 53.3 |
  | fly | 51.0, 44.0, 48.3 | 88.7, 86.6, 80.9 | 47.8 → 85.4 |

  Static now meets "JS CPU ≤ baseline" within the noise (LOD lower in two rounds of three), with 4× fewer triangles.
  The fly-through is still 1.8×: level-switch churn and Babylon's per-instance work, which ADR 0461 (Proposed) targets.
- **ADR 0461 built (stage 1 of 0462).** Auto batches draw through per-pass thin buffers while levels apply, outside
  the editor's picking. Interleaved, forest (ms p50 per round, SwiftShader):

  | Path | No LOD | LOD | Mean no LOD → LOD |
  |---|---|---|---|
  | static | 35.9, 38.5, 38.5 | 28.3, 22.5, 23.7 | 37.6 → **24.8** (−34 %) |
  | fly | 37.8, 39.0, 34.9 | 31.9, 34.8, 31.0 | 37.2 → **32.6** (−12 %) |

  LOD p99 on the fly-through: 45–61 ms (no LOD 60–72; before 0461, LOD 190–235). Triangles: static 61.4M → 15.2M,
  fly 48.1M → 16.4M. 0459's target "JS CPU ≤ baseline with LODs on" now holds on both forest paths.
- **City, interleaved, after 0461** (ms p50 per round): fly no LOD 21.1, 22.3, 20.8 against LOD 17.9, 16.2, 16.6
  (mean 21.4 → **16.9**, −21 %); static 22.4, 20.8, 23.1 against 15.3, 14.9, 15.1 (22.1 → **15.1**, −32 %).
  Triangles: fly 6.9M → 1.4M, static 10.3M → 1.8M. All four gate paths now meet "JS CPU ≤ baseline".
- **Occlusion integrated (ADR 0460 T10) and measured.** Interleaved, LOD alone against LOD + the engine's occlusion
  (High tier, 256×128 buffer, main camera; ms p50 means, SwiftShader):

  | Path | Main-view triangles | CPU | p99 |
  |---|---|---|---|
  | city static (3 rounds) | 1.57M → 0.79M | 17.8 → 20.1 | similar |
  | city fly (3 rounds) | 1.06M → 0.56M | 21.3 → 23.4 | mixed |
  | forest static (2 rounds) | unchanged (nothing culled) | 32.7 → 28.1 (noise) | similar |
  | forest fly (2 rounds) | unchanged | 40.8 → 43.4 | 73 → 105 |

  It halves the city's main-view triangles at about 2.2 ms of CPU a view, against the record's estimate of about
  1.2 ms. In the forest nothing occludes (trees fail the width test, as designed), yet gathering candidates over 10k
  renderers still costs, and the fly-through's worst frames get worse. Next: profile the step and cache which
  renderers can occlude at all.
- **Merged master (2026-11-28).** Master took 0445–0458, so this build's records moved: LOD 0446 → 0459, occlusion
  0447 → 0460, auto-thin 0448 → 0461, ECS render scene 0449 → 0462, one winding 0450 → 0463. Earlier entries in this
  log use the old numbers.
- **Occlusion step tuned:** per-renderer occluder info cached (geometry, triangles, opacity, recomputed when meshes or
  material change), arrays reused, and no occludee gathering when nothing occludes. Profiled city static: the step goes
  from 2.09 to about 1.7 ms a frame, about 1 ms of it the wasm rasteriser. Re-measured, interleaved (ms p50):
  city static 16.5 → 17.9 and 16.7 → 20.2 (mean +2.5, unchanged within this machine's noise; triangles halved as
  before); forest fly 35.3 → 34.8 and 38.7 → 42.6 (mean +1.7, was +2.6), p99 61.9 → 60.7 and 66.4 → 76.5 (was 73 → 105).
  Still above the record's ~1.2 ms a view on SwiftShader; hardware numbers are the owner's.
- **T11b merged (editor debug tools).** The Scene toolbar's View menu: scene-view occlusion (it keeps one of the
  tier's `occlusionViews` while on, or the edit-mode main camera, selected first, would always use the only one),
  freeze, validator, LOD-level and occlusion debug views; the Inspector's effective role (one rule in
  `visibility/occlusion/role.ts`, which the service now uses too); diagnostics `occlusion` summed over the frame's
  views. `tests/e2e/occlusion.spec.ts`: 3 pass after one spec fix (a reload dropped the in-memory project). Found:
  occlusion runs only in Worlds with an `LODGroup`, because the visibility stage starts with the first one; a scene of
  plain MeshRenderers gets none. Raised with the owner.
