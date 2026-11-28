# 0447. Occlusion culling v1 is a CPU software depth buffer in a Rust wasm SIMD core

- **Status:** Proposed
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0050, 0055, 0056, 0108, 0128, 0129, 0130, 0169, 0274, 0276, 0326, 0370, 0432, 0446

## Glossary

- **Occlusion culling:** not drawing objects that are hidden behind other objects, even though they are inside the camera's view.
- **Occluder:** an object that hides things (a building, a wall, a hill). **Occludee:** an object tested for being hidden (a car, a prop, a house behind the hill). An object can be both.
- **Software occlusion buffer:** a small depth image (here 256×128 pixels) that the CPU draws the occluders into each frame. Each occludee's bounding box is then tested against it: if every pixel the box covers holds something nearer, the occludee is hidden.
- **Occluder stand-in (proxy):** a very coarse version of an occluder, from 0446's simplifier, drawn into the buffer instead of the real mesh.
- **Conservative:** the buffer may keep something that is hidden (a lost cull, which costs only time), but must never hide something that is visible (a *false occlusion*, which is a visible bug).
- **SIMD (simd128):** WebAssembly instructions that work on 4 numbers at once; the animation core (0370) already requires them.
- **Hi-Z:** the GPU way to do this later: a mip chain of the real depth buffer, tested by a compute shader.
- **PVS (potentially visible set):** visibility precomputed offline per region of a level; a possible later addition for static scenes.

## Context

**What exists.** Myco has no occlusion culling. Babylon culls by frustum only (`render/babylon/frameGraph.ts:596`). The engine keeps no renderer bounds of its own; 0446 adds them (`render/lod/bounds.ts`).

**What the owner chose (2026-11-28).** A CPU software occlusion buffer for v1:
- coarse occluders rasterised into a low-resolution depth buffer, with bounds tested against it;
- in Rust compiled to wasm with SIMD, like the animation core (`native/anim/`), as a new crate or workspace, never `native/nav/` (frozen);
- occluders from 0446's generated levels or simple stand-ins, plus a per-renderer occluder/occludee flag.

GPU Hi-Z belongs to the high-end pipeline (O24), and baked PVS is a later option.

**Measurements** (`spikes/occlusion-raster/`; Rust 1.97, raw wasm exports with simd128; timings from the coordinator's re-run on an idle 4-core Xeon at 2.1 GHz, 7 runs × 40 frames per job, p50 / p99. Counts and accuracy are exact and deterministic: native, Node and Chromium agree on all 98 compared jobs):

- **Prior art.** No maintained Rust crate does software occlusion. Intel's Masked Occlusion Culling is C++ and archived.
  - A conventional buffer (depth stored as 1/w with a coarse 8×8 minimum level, near- and guard-band clipping, backface culling, one thread, no tile binning) was enough. A masked buffer wasn't needed.
- **Cost per camera at 256×128, p50 / p99:**

  | Scene | Native | Chromium wasm | Native scalar |
  |---|---|---|---|
  | city, box occluders (12 triangles per building, 3k occludees) | 0.93 / 2.12 ms | 1.20 / 1.33 ms | 1.71 / 2.31 ms |
  | city, coarse occluders (about 100 triangles per building), uncapped | 3.51 / 5.57 ms | 3.89 / 6.64 ms | |
  | forest (2k occluders, 10k occludees) | 2.17 / 2.49 ms | 2.87 / 3.20 ms | |

  - SIMD makes rasterising 3× faster. Setup and the occludee test are still scalar.
  - Bigger buffers cost more: 320×180 is 1.09 ms and 512×256 is 1.57 ms (city boxes, native).
  - Wasm is 1.0–1.4× native, and Chromium is no slower than Node.
  - The JS-to-wasm boundary costs 0.002–0.1 ms per frame through typed-array views.
  - The module is 96 KB (37.6 KB gzip), including the spike's generators and reference.
- **Occluder cap** (coarse city, native): uncapped costs 3.51 ms, mostly per-occluder setup. Capping at 10k source triangles costs 1.07 ms and keeps 98 % of the culls; at 2k triangles, 0.57 ms and 92 %.
- **Accuracy at 256×128,** against a 1920×1080 reference:
  - **City:** the reference culls 97 % of the occludees inside the view. The buffer culls 89 % with **zero false occlusions**, using a 1-pixel dilation of each tested box and a 0.25-pixel coverage shrink. Without them there are up to 10 false occlusions per 8 frames, so both are required.
  - **Forest:** with the same safe settings, the buffer culls only 28 % of what the reference culls (9,641 of 34,909). Thin trunks are poor occluders, and making them safe removes most culls.
- **Two cameras** cost twice as much. A shadow cascade used as an occlusion camera culled 49 % of tested occludees in the city and 0.05 % in the forest, and is unproven for shadow correctness [U].
- **Temporal reuse:** reusing last frame's buffer is nearly free. It caused 0 false occlusions at a 1-frame delay and 7 per 15k at 4 frames, for a slow camera; fast rotation is untested [U]. The spike's reprojection halved the culls and isn't worth it.
- **Benchmark scenes** (`spikes/render-bench/`; Myco projects, 1280×720, High tier; method and caveats in 0446's Context). A pixel-exact oracle that hides objects with no visible pixels, measured from eye level:
  - **How much is hidden:** the forest hides 93.8 % of the 7,558 objects in view, and the city 97.3 % of 4,115. Along a moving path: forest 72–98 %, median 89 %; city 93–100 %.
  - **Savings:** drawn triangles −90 % (forest) and −96 % (city); JS CPU −38 % and −44 %; and in the city, together with the LOD oracle, −99 % triangles.
  - **Nothing visible is lost:** 0 silhouette pixels differ.
  - **These are upper bounds.** The oracle also removes hidden shadow casters, which this record never does. And the bench forest's foliage is solid geometry, whereas the CPU buffer, with thin occluders excluded, captured only 28 % of its reference's culls in the spike's trunk-and-rock forest.

## Decision

### 0. Sequencing and the go/no-go gate

Occlusion is built after 0446's LOD, and its engine integration goes ahead only if the after-LOD numbers justify it.
- The Rust crate (§1) is built in parallel with LOD.
- Before integration, the promoted benchmark runs the city with LOD on, against an oracle that hides objects from the main view only and keeps their shadow casters.
- **Gate:** the oracle must save at least twice the measured occlusion cost (about 1.2 ms) in JS CPU, or show a GPU triangle saving worth that cost on the Android floor.
- If it doesn't, the build stops after the crate and the result goes to the owner.

The spike's −38/−44 % savings were measured against a baseline without LOD and removed casters too. Against LOD-on, the oracle rows show about 3–6 ms of gain (forest 40.2 → 33.9 ms, city 27.7 → 24.3 ms, both with casters removed), so the margin is real but not large.

### 1. A new Rust workspace, `native/visibility/`

- **Crates:**
  - `vis-raster`: the buffer, clipping, rasteriser, coarse level and occludee tests. `no_std` with `alloc`, simd128 behind `cfg(target_feature)`, with a scalar reference used by tests (`cargo test`: SIMD and scalar outputs equal).
  - `vis-wasm`: the boundary.
  - `vis-bench`: Criterion benches over the spike's city and forest workloads.
- **Packaging follows the animation core's conventions** (`native/anim/build.mjs`): wasm-bindgen pinned for setup calls, raw typed-array views over linear memory for the per-frame data, `hash.json` with the source hash, the CI freshness check, and the export path's asset handling.
- **Build.** `npm run build:visibility` (`native/visibility/build.mjs`) builds into `src/engine/render/visibility/occlusion/wasm/`, which is committed, so the engine builds without Rust.
  - It uses the reproducible flags of `native/rustflags.mjs` (0432), a pinned toolchain (`rust-toolchain.toml`), and simd128 from `.cargo/config.toml`.
  - Its size tripwire is the first full build plus 20 %.
- **Rules.** It follows 0370's deterministic rules (no fast-math), rejects NaN and zero-scale matrices inside the core, and never shares code with `native/nav/`.

### 2. Who owns it: the engine's visibility stage

- **Owner.** Occlusion is part of 0446's engine-owned visibility stage (`render/visibility/`, core). That stage also owns bounds, frustum and LOD selection. The Meshes feature and the animation plugin's skinned feature read its per-view results, so occlusion hides skinned meshes without core importing a plugin (0135, 0140).
- **Loading.** The wasm core loads lazily the first time a view with occlusion on is drawn, so games that never use it don't download it. Loading never holds the first frame: the view draws unculled until the core is ready (0120).
- **Without SIMD** (or if loading fails), occlusion stays off with one warning, as in the animation core. There is no scalar fallback build: the Chrome 113 floor (0169) and current WebKit support SIMD.
- **The TS side** (`occlusion/core.ts`) owns the wasm memory views. Each frame, per view, it writes the occluder list and occludee bounds into wasm memory, then reads back one visibility bit per occludee.

### 3. What occludes and what is tested

- **`MeshRenderer.occlusion`** and `SkinnedMeshRenderer.occlusion` take one of these values:

  | Value | Occluder | Occludee |
  |---|---|---|
  | `"auto"` (default) | yes, when the mesh has occluder geometry, its material is opaque, and it passes the per-frame width test; no otherwise | yes |
  | `"occluder"` | yes, when it has occluder geometry and an opaque material | yes |
  | `"occludee"` | no | yes |
  | `"none"` | no | no: always drawn |

  - **Scripts can change it every frame,** for example a door that occludes when closed and doesn't when open.
  - **Skinned meshes are occludees only:** their bounds lag a frame and are dilated (0446 §3).
- **Width test, per frame, in screen space.** An occluder takes part only while its projected minimum width is at least 2 buffer pixels.
  - Walls, floors and terrain pass, because they are wide in two directions.
  - Poles, trunks and fences fail at a distance, which is what the forest measurement calls for.
  - This replaces a world-space "solid" rule, which would have excluded walls.
- **Occluder geometry** comes from the sidecar's `occluder` setting, beside 0446's `lod`. It applies whether or not the model has levels:
  - `"auto"` (default): the coarsest generated level when the model has levels; otherwise a `simplifySloppy` stand-in at about 5 % of the triangles, but only if the first wave's adversarial gate passes for sloppy stand-ins (below). If it doesn't, models without levels get no stand-in.
  - `"lod"`: the coarsest generated level only.
  - `"none"`.

  A mesh with at most 512 triangles (built-in cubes and planes, simple walls) occludes with itself. The stand-in is baked into `.mycomesh` (0446's `occluder` range, positions only). The editor warns when `"occluder"` is set on a renderer with no geometry to occlude with.
- **Keeping simplified occluders conservative.** A simplified occluder can poke past the real surface sideways or in depth, and a sloppy one can close a doorway. These rules apply:
  - Every stand-in's error is a sampled two-way Hausdorff distance measured at import (0446 §1), never meshoptimizer's estimate.
  - Its depth is pushed back by that error.
  - The coverage shrink is the larger of 0.25 pixels and the error's projected size in buffer pixels, so a stand-in that bulges sideways can't claim pixels the real surface doesn't cover.
  - Occluders whose bounds are within the near distance of the camera (the camera inside or beside one) are skipped.
- **The safety gate,** in the first wave:
  - The real stand-ins (coarsest levels and sloppy) are rasterised against a full-resolution reference.
  - The scenes are the city plus adversarial ones: a doorway, a thin wall, and the camera beside or inside a stand-in.
  - **Zero false occlusions is a gate, not an assumption.** The spike's zero came from exact box and prism occluders only.
- **Groups test once.** An `LODGroup` (0446) is tested once with its group bounds. If it is hidden, LOD selection skips it.

### 4. Per frame, per view

- **Which views:**
  - **Game cameras** with `Camera.occlusionCulling` on. This is a new field: default `true` for perspective cameras, `false` for orthographic ones.
  - **Render-texture cameras:** default off.
  - **The editor scene view:** when its View menu's "Occlusion culling" toggle is on (default off, so editing shows everything).
  - **Limit:** v1 runs occlusion for at most `occlusionViews` views per frame (tier field, default 1: the main camera).
  - **Never:** reflection-probe captures, shadow maps (an object hidden from the camera can still cast a visible shadow, so casters are never occlusion-culled), or the preview inset.
- **Steps:**
  1. Frustum-test occluders.
  2. Apply the width test, then pick the biggest on screen first, up to the tier's occluder triangle budget.
  3. Clear and rasterise.
  4. Build the coarse level.
  5. Test in-frustum occludees with a 1-pixel dilation and the coverage shrink above.
  6. Hand the hidden set to the visibility stage, which leaves those objects out of that view's object list. Thin batches also leave them out of that view's matrix buffer (0446 §3).
- **Back-off.** When a view's culled share stays under 10 % for 60 frames, its occlusion pauses for 60 frames, then retries for one. A forest then stops paying about 2.9 ms a view for little gain. A paused view draws everything, which is always correct.
- **Same-frame buffer.** v1 rasterises this frame's buffer before the view draws: about 1.2 ms (p99 1.3 ms) in Chromium wasm for a city view (spike), with no latency artefacts. Reusing last frame's buffer is a later optimisation (Open questions).
- **On the main thread** in v1. A worker needs shared memory, and with it COOP/COEP headers (Open questions).

### 5. Quality tiers

`QualityTier` gains three fields:
- `occlusionBuffer`: `"off"` | `"low"` (256×128) | `"high"` (320×180). Low `"off"`, Medium and High `"low"`, Ultra `"high"`. The Low tier runs on the device with the least CPU headroom, where about 3–4 ms a view (est.) is hard to afford.
- `occluderBudget`: source triangles rasterised per view. Medium and High 10,000, Ultra 20,000.
- `occlusionViews`: views per frame (default 1).

Automatic quality (0322) steps whole tiers, so it moves these too.

### 6. Editor and diagnostics

- **An occlusion debug view** in the scene view's View menu (shared with 0446's LOD colouring):
  - the chosen camera's buffer drawn as a grey depth image in a corner of the scene view;
  - culled renderers' bounds drawn as red boxes through the editor overlay (`EditorOverlay` lines, `render/editorViewport.ts:51`);
  - occluders tinted;
  - a readout: occluders and triangles rasterised, occludees tested, culled, and milliseconds.

  The buffer image comes from the core's own output through the diagnostics, not from reading internals.
- **The inspector** shows the effective role of `"auto"` beside the `occlusion` field (occluder and occludee, or occludee only), with the reason: no stand-in, transparent, or too narrow on screen.
- **Debugging tools:** a "freeze culling" toggle keeps the last visibility set while the camera flies, and a validator mode for QA re-renders culled objects in a colour, so a false occlusion is visible at once.
- **Diagnostics (0154):** `occlusion: { views, occluders, triangles, tested, culled, ms }`. The editor Profiler (0326) gets an Occlusion table.

### Path to a high-end pipeline

This is a constraint on the design, not a plan (open question O24):
- **The interfaces don't change.** The occluder/occludee roles, the per-view visibility bits and the per-view hook stay what a GPU path consumes.
- **GPU Hi-Z.** On WebGPU, a later path builds Hi-Z from the previous frame's real depth buffer and tests occludee bounds in a compute shader. It would use the standard two-phase scheme: draw what was visible last frame, build Hi-Z, re-test the rest. Its output is the same per-view visibility, then written into indirect draw arguments instead of enable flags.
- **What stays on the CPU.** The CPU buffer remains the WebGL2 and low-end path. It can also act as a first pass that keeps whole groups off the GPU.
- **Shared inputs.** Occluder stand-ins and conservative-error rules carry over to a GPU depth pre-pass of occluders.
- **Baked PVS** for static scenes would gate which renderers reach either path.

## RFC round (2026-11-28)

Five reviewers all approved with changes. Every point and its resolution is in `docs/rfc/0446-0447/README.md`. The changes to this record:
- **A go/no-go gate** after LOD, measured with LOD on and shadow casters kept (§0).
- **Ownership** moves from the Meshes plugin to the engine's visibility stage, so skinned meshes can be culled (§2).
- **Wall-friendly width test.** A per-frame screen-space width test replaces the "solid" rule, which excluded walls.
- **Occluder safety.**
  - Stand-ins use measured Hausdorff error for the coverage shrink and the depth push.
  - Occluders next to the camera are skipped.
  - Zero false occlusions became an adversarial first-wave gate.
- **The occluder setting** sits beside `lod` in the sidecar, with one definition.
- **Cost controls.**
  - The Low tier is off.
  - Occlusion runs by default only for perspective cameras, and for one view per frame.
  - A back-off pauses it where it culls little.
- **Skinned meshes** are occludees only. Transparent materials never occlude. `occlusion` is scriptable per frame.
- **Packaging** follows the animation core's conventions.

## Alternatives considered

- **GPU occlusion queries (Babylon's `occlusionType`):** one query per object, results a frame or more late, popping on fast cameras, and per-query overhead. On WebGPU they need query sets per pass. They don't help thin batches, and they make results depend on the backend.
- **Intel's Masked Occlusion Culling (port):** more accurate per pixel at the same resolution, but a much larger port (C++, archived). The simple buffer already culls 89 % of the occludees inside the view in the city with zero false occlusions.
- **The occlusion core in TypeScript:** no second wasm module, and the whole-frame SIMD gain is only 1.2–1.9× today, because setup and the occludee test are still scalar. But the raster stage gains 3× from SIMD, wasm runs at 1.0–1.4× native, and the owner chose Rust/wasm SIMD like the animation core. A TypeScript port wasn't measured.
- **Inside the animation core's module:** one fewer download, but unrelated systems would share a release and size gate, and games without animation would load it.
- **Shadow cascades as occlusion cameras:** they culled 49 % in the city and 0.05 % in the forest, and their correctness for shadow casters is unproven. Not in v1.
- **Baked PVS first:** costs nothing at run time, but needs a bake step, static scenes and a level-authoring workflow. A later option.

## Consequences

**Positive**
- **Big savings where it matters.** At street level the city hides 97 % of its objects (oracle), and the CPU buffer culls 89 % of those in view with zero false occlusions (spike, exact box occluders). Against a baseline without LOD, the oracle cut drawn triangles by up to 96 % and JS CPU by up to 44 %. Those figures include removing hidden shadow casters, which this record never does.
- **Targets for the build,** measured with LOD on, casters kept, with the promoted benchmark on the same machine:
  - occlusion ≤ 2 ms per view in Chromium on the reference machine;
  - city (auto) main-view triangles ≤ 40 % of the LOD-on figure;
  - city JS CPU, occlusion cost included, at least 10 % below the LOD-on figure;
  - zero false occlusions against the full-resolution reference, adversarial scenes included.
- **No authoring:** the default `"auto"` makes opaque, wide models occluders from the stand-ins 0446 already generates.
- **Conservative by construction,** and checked by a gate rather than assumed.

**Negative / costs**
- **About 1.2 ms of main-thread CPU per occlusion view** on the reference machine (est. 3–4 ms on the Android floor at 4× throttling, unmeasured; so the Low tier is off). Open scenes such as forests gain little: the back-off pauses it there, and cameras can turn it off.
- **Its value on top of LOD is modest:** about 3–6 ms of JS in the oracle rows. Hence the gate in §0.
- **Fewer occluders than a perfect scheme:** the width test and the conservative shrink give up some culls for safety.
- **A second wasm module** to build, pin and size-gate (about 40 KB gzip, est.).
- **One-frame correctness only:** a moving occluder works, because the buffer is rebuilt every frame, but CPU cost grows with the occluder budget.
- **Unverified here:** WebKit and the Tauri webviews on macOS and Linux, and the Android floor.

## Deprecates

Nothing.

## Open questions

- **Temporal reuse** of the previous frame's buffer (nearly free in the spike), after fast-rotation tests.
- **A worker thread** for the rasteriser (needs shared memory and cross-origin isolation in the player).
- **SIMD in setup and the occludee test,** the spike's next optimisations.
- **Baked PVS for static levels.**

## References

- `spikes/occlusion-raster/README.md` and `tables.md`; `spikes/render-bench/README.md`
- `docs/design/lod-occlusion/goal.md`
- Hasselgren, Andersson, Akenine-Möller, *Masked Software Occlusion Culling* (HPG 2016); github.com/GameTechDev/MaskedOcclusionCulling (Apache-2.0, archived)
