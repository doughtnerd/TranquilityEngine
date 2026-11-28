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

### 1. A new Rust workspace, `native/visibility/`

- **Crates:**
  - `vis-raster`: the buffer, clipping, rasteriser, coarse level and occludee tests; `no_std` with `alloc`, simd128 behind `cfg(target_feature)`, with a scalar reference used by tests.
  - `vis-wasm`: the boundary, raw `extern "C"` exports over linear memory, without wasm-bindgen, as in the spike.
  - `vis-bench`: Criterion benches over the spike's city and forest workloads.
- **Build.** `npm run build:visibility` (`native/visibility/build.mjs`) builds the wasm into `src/plugins/meshes/runtime/occlusion/wasm/`, which is committed, so the engine builds without Rust.
  - It uses the reproducible flags of `native/rustflags.mjs` (0432), a pinned toolchain (`rust-toolchain.toml`), simd128 from `.cargo/config.toml`, and a source hash.
  - Its size tripwire is the first full build plus 20 %.
- **Rules.** It follows 0370's deterministic rules (no fast-math) and never shares code with `native/nav/`.

### 2. Who owns it: the Meshes plugin

- **Owner.** Occlusion only culls `MeshRenderer`s and `SkinnedMeshRenderer`s, so it lives in the `myco.meshes` plugin (`src/plugins/meshes/runtime/occlusion/`).
- **Loading.** The module loads lazily the first time a view with occlusion on is drawn, so games that never use it don't download it.
- **Without SIMD,** occlusion stays off with one warning, as the animation core does. The Chrome 113 floor (0169) supports SIMD.
- **The TS side** (`occlusion/core.ts`) owns the wasm memory views. Each frame, per view, it writes the occluder list and occludee bounds into wasm memory, then reads back one visibility bit per occludee.

### 3. What occludes and what is tested

- **`MeshRenderer.occlusion`** and `SkinnedMeshRenderer.occlusion` take one of these values:

  | Value | Occluder | Occludee |
  |---|---|---|
  | `"auto"` (default) | yes, when the mesh has occluder geometry and its bounds are large and solid; no otherwise | yes |
  | `"occluder"` | yes | yes |
  | `"occludee"` | no | yes |
  | `"none"` | no | no: always drawn |

  - **"Solid"** means the smallest bounds extent is at least 10 % of the largest. Thin things (trees, poles, fences) don't occlude, because the forest measurement shows they cost more than they save.
- **Occluder geometry,** in order:
  1. the model's occluder stand-in from import (0446's `lod.occluder`): `"auto"` is the coarsest generated level, or a `simplifySloppy` stand-in at about 5 % of the triangles when the model has no levels; `"lod"` is always the coarsest level;
  2. the mesh itself, if it has at most 512 triangles (built-in cubes and planes, simple walls);
  3. otherwise none: the renderer is never an occluder, and the editor warns when it is set to `"occluder"`.

  The stand-in is baked into `.mycomesh` (0446's `occluder` range, positions only).
- **Keeping simplified occluders conservative.** A simplified occluder can poke slightly past the real surface, so two rules apply:
  - its depth is pushed back by its measured error (0446 measures every level's error);
  - an occluder whose error would cover more than half a buffer pixel at its distance uses a finer level, or is skipped.

  Together with the coverage shrink, this keeps false occlusions at zero. The rule is tested in the benchmark scenes against a full-resolution reference.
- **Groups test once.** An `LODGroup` (0446) is tested once with its group bounds. If it is hidden, LOD selection skips it.

### 4. Per frame, per view

- **Which views:** game cameras with `Camera.occlusionCulling` on (new field, default `true`), render-texture cameras the same way, and the editor scene view when its View menu's "Occlusion culling" toggle is on (default off, so editing shows everything).
  - **Never:** reflection-probe captures (rare and far from the camera), shadow maps (an object hidden from the camera can still cast a visible shadow, so casters are never occlusion-culled), or the preview inset.
- **Steps:**
  1. Frustum-test occluders.
  2. Pick the biggest on screen first, up to the tier's occluder triangle budget, skipping occluders under 0.5 % of the screen's height.
  3. Clear and rasterise.
  4. Build the coarse level.
  5. Test in-frustum occludees with a 1-pixel dilation and a 0.25-pixel coverage shrink.
  6. Hand the hidden set to the mesh feature, which applies it in that view's `fit(camera)` hook (0446 §3).
- **Same-frame buffer.** v1 rasterises this frame's buffer before the view draws: about 1 ms in browser wasm for a city view (spike), with no latency artefacts. Reusing last frame's buffer is a later optimisation (Open questions).
- **On the main thread** in v1. A worker needs shared memory, and with it COOP/COEP headers (Open questions).

### 5. Quality tiers

`QualityTier` gains two fields:
- `occlusion`: the buffer size, `"off"` | `"low"` (256×128) | `"high"` (320×180). Low tier `"low"`, Medium and High `"low"`, Ultra `"high"`.
- `occluderBudget`: source triangles rasterised per view. Low 4,000, Medium and High 10,000, Ultra 20,000.

Automatic quality (0322) steps whole tiers, so it moves these too.

### 6. Editor and diagnostics

- **An occlusion debug view** in the scene view's View menu (shared with 0446's LOD colouring):
  - the chosen camera's buffer drawn as a grey depth image in a corner of the scene view;
  - culled renderers' bounds drawn as red boxes through the editor overlay (`EditorOverlay` lines, `render/editorViewport.ts:51`);
  - occluders tinted;
  - a readout: occluders and triangles rasterised, occludees tested, culled, and milliseconds.

  The buffer image comes from the core's own output through the diagnostics, not from reading internals.
- **The inspector** shows the effective role of `"auto"` beside the `occlusion` field: occluder and occludee, or occludee only, with the reason (thin, no stand-in).
- **Diagnostics (0154):** `occlusion: { views, occluders, triangles, tested, culled, ms }`. The editor Profiler (0326) gets an Occlusion table.

### Path to a high-end pipeline

This is a constraint on the design, not a plan (open question O24):
- **The interfaces don't change.** The occluder/occludee roles, the per-view visibility bits and the per-view hook stay what a GPU path consumes.
- **GPU Hi-Z.** On WebGPU, a later path builds Hi-Z from the previous frame's real depth buffer and tests occludee bounds in a compute shader. It would use the standard two-phase scheme: draw what was visible last frame, build Hi-Z, re-test the rest. Its output is the same per-view visibility, then written into indirect draw arguments instead of enable flags.
- **What stays on the CPU.** The CPU buffer remains the WebGL2 and low-end path. It can also act as a first pass that keeps whole groups off the GPU.
- **Shared inputs.** Occluder stand-ins and conservative-error rules carry over to a GPU depth pre-pass of occluders.
- **Baked PVS** for static scenes would gate which renderers reach either path.

## Alternatives considered

- **GPU occlusion queries (Babylon's `occlusionType`):** one query per object, results a frame or more late, popping on fast cameras, and per-query overhead. On WebGPU they need query sets per pass. They don't help thin batches, and they make results depend on the backend.
- **Intel's Masked Occlusion Culling (port):** more accurate per pixel at the same resolution, but a much larger port (C++, archived). The simple buffer already culls 89 % of the occludees inside the view in the city with zero false occlusions.
- **The occlusion core in TypeScript:** no wasm, but the rasteriser's hot loop gains 3× from SIMD (spike), and wasm runs at 1.0–1.4× native.
- **Inside the animation core's module:** one fewer download, but unrelated systems would share a release and size gate, and games without animation would load it.
- **Shadow cascades as occlusion cameras:** they culled 49 % in the city and 0.05 % in the forest, and their correctness for shadow casters is unproven. Not in v1.
- **Baked PVS first:** costs nothing at run time, but needs a bake step, static scenes and a level-authoring workflow. A later option.

## Consequences

**Positive**
- **Big savings where it matters.** At street level the city hides 97 % of its objects (oracle), and the CPU buffer culls 89 % of those in view with zero false occlusions (spike). Drawn triangles fall by up to 96 %, and JS CPU by up to 44 % (oracle).
- **Targets for the build,** re-measured with the same harness on the same machine:
  - city (auto) triangles ≤ 15 % of baseline;
  - occlusion ≤ 2 ms per view in Chromium on the reference machine;
  - city JS CPU, occlusion cost included, at least 20 % below baseline;
  - zero false occlusions in the pixel check against the oracle.
- **No authoring:** the default `"auto"` makes large solid models occluders from the stand-ins 0446 already generates.
- **Conservative by construction:** zero false occlusions in the measured cities, and the rules are tested against a full-resolution reference.

**Negative / costs**
- **About 1 ms of main-thread CPU per occlusion view** on the reference machine (est. 3–4 ms on the Android floor at 4× throttling, unmeasured). That is wasted in open scenes such as forests, where it culls little, so cameras can turn it off.
- **A second wasm module** to build, pin and size-gate (about 40 KB gzip, est.).
- **One-frame correctness only:** a moving occluder works, because the buffer is rebuilt every frame, but CPU cost grows with the occluder budget.
- **Unverified here:** WebKit and the Tauri webviews on macOS and Linux, and the Android floor.

## Deprecates

Nothing.

## Open questions

- **Temporal reuse** of the previous frame's buffer (nearly free in the spike), after fast-rotation tests.
- **A worker thread** for the rasteriser (needs shared memory and cross-origin isolation in the player).
- **Whether `Camera.occlusionCulling` should default off,** given that open scenes gain little (recommended: on, as the cost is about 1 ms).
- **SIMD in setup and the occludee test,** the spike's next optimisations.
- **Baked PVS for static levels.**

## References

- `spikes/occlusion-raster/README.md` and `tables.md`; `spikes/render-bench/README.md`
- `docs/design/lod-occlusion/goal.md`
- Hasselgren, Andersson, Akenine-Möller, *Masked Software Occlusion Culling* (HPG 2016); github.com/GameTechDev/MaskedOcclusionCulling (Apache-2.0, archived)
