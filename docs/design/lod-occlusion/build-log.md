# Build log: mesh LOD (0446) and occlusion culling (0447)

Coordinator's log of merges, checks and findings. Newest last.

## 2026-11-28

- **Owner decisions:** accepted both records; decision 1 opt-in LOD generation; decision 2 the owner runs real-hardware
  measurements later; decision 3 tolerant occlusion (false occlusions under 16 px at 1080p accepted).
- **First wave:** `spikes/lod-apply/` (per-view object lists 0.055 ms/view at 10k instances; shared vertex buffers 1.13x),
  `spikes/occlusion-safety/` (the rules as first written failed; sloppy stand-ins dropped; decided rules in 0447 §3).
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
