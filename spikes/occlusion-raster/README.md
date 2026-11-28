# Occlusion culling v1: CPU software occlusion buffer (feasibility spike)

Rust, scalar reference plus a 4-wide path (wasm `simd128`, SSE natively), built native and to WebAssembly. Measures the hot path and culling accuracy; it is not an engine API design. Everything lives in `spikes/occlusion-raster/`; nothing else in the repo is touched or depends on it (navigation stays frozen).

- Run: `node spikes/occlusion-raster/run.mjs` (about 5-10 min idle; `--quick` is a 1 min smoke run, `--no-chromium` skips the browser). It writes `results.json` and `tables.md` (all tables, generated).
- Layout: `crates/occ` (rasteriser, selection, test, workloads, oracle, tests), `crates/occ-wasm` (raw exports), `crates/occ-bench` (native bench), `harness.mjs` (same code in Node and Chromium), `page.html`, `run.mjs`.
- Tests (`cargo test --release -p occ`, run by `run.mjs`): the SIMD path gives a **bit-identical depth buffer and visibility** to the scalar reference for 3 scenes x 3 resolutions x 3 frames; the hierarchical test equals the pixel-by-pixel test; native, Node wasm and Chromium wasm produce identical visibility hashes and accuracy counts on all 98 compared jobs.

**Evidence status.** The numbers below are from one run on a shared 4-core Xeon 2.1 GHz with load average ~5 (other agents), so timings are smoke-level (p99/max especially). Counts (culls, triangles, accuracy) are deterministic and exact. `(est.)` = not measured; `[U]` = unverified claim. The coordinator should re-run `run.mjs` on an idle machine.

## Design

- Depth convention ("reverse-W"): a pixel stores `1/w` (perspective) or `2 - z` (orthographic). Larger is nearer, 0 means empty, cleared to 0. Linear in screen space, no near/far dependence, good float precision. Intel's MOC also stores 1/w.
- Buffer: `f32` per pixel plus a coarse level of 8x8 tiles holding the **min** over the tile (the farthest depth that covers the whole tile; 0 if any pixel is empty). The coarse level is built after rasterisation (SIMD column-min).
- Rasteriser: per triangle, bounding box clamped to the screen, edge functions and a depth plane evaluated per pixel centre, 4 pixels per step with an early-out per row (each edge function is monotone in x). No tile binning: single thread, a 128 KB buffer fits in L2, so binning only adds a pass `[U]`; stages are split as select / setup (transform, clip, cull, edge setup into a triangle list) / raster.
- Clipping: triangles are clipped against the near plane and a 1.5x guard band in clip space (Sutherland-Hodgman), so screen coordinates stay small. Back faces and degenerate triangles are culled.
- Occluder selection per camera: sphere frustum test, optional screen-size threshold (fraction of the screen the bounding sphere's projection covers), optional triangle cap (biggest first, greedy fill).
- Occludee test: 8 AABB corners to clip space; all corners outside one plane means "outside frustum" (not counted); any corner behind the near plane means visible; otherwise screen rect (outward rounded, optionally dilated by `dilate` px) and nearest depth `max(1/w)`; hidden iff nearest < stored * (1 - 1e-3) for every pixel of the rect, read through the coarse level where the rect covers whole tiles.
- Coverage: centre sampling by default. `shrink` (0.25, 0.5) writes a pixel only if that fraction of it is inside the triangle (0.5 means the whole pixel; inner-conservative).
- Oracle: all occluders in the frustum at 1920x1080 with the scalar rasteriser; each occludee's projected rect tested pixel by pixel, no dilation, no epsilon. Note: this is "the best any rect test can do at 1080p", not exact box visibility.
- wasm-bindgen: not used. The module has raw `extern "C"` exports and no imports; the hot path is plain numbers and pointers into linear memory. The engine would add bindgen glue for setup only, as `native/anim` does (pin 0.2.130) `[U]` size effect of that glue (est. a few KB). Release profile as `native/anim` plus `strip = true`. No fast-math (not available in stable rustc); no FMA anywhere (that is what makes SIMD and scalar bit-identical).

### Simple buffer vs MOC-style masked buffer

Prior art: Intel's MaskedOcclusionCulling (C++, Apache-2.0; **archived by Intel**, README says no further support) uses hierarchical tiles of 32 samples with two depth layers plus a coverage mask per tile, decoupling coverage from depth, and needs width a multiple of 8, height of 4. No maintained Rust crate for software depth-raster occlusion culling was found (crates.io search: only Umbra-tome readers `tenebrae*`, GPU depth-pyramid helpers; GitHub: `nical/rectangle_occlusion` (2D rectangles, last push 2021) and `VisibilityEngine2D` (2D)). A Rust port would be ours to write and maintain `[U]` (search was keyword-based).

Recommendation: **the simple per-pixel buffer is enough for v1.** Measured, the rasteriser is only 25-40% of frame time at 256x128 (city-box 0.35 of 0.91 ms native); the rest is setup (transform/clip/edge setup) and the occludee test, which a masked buffer does not remove. MOC's advantages (cheap large triangles at 1080p, less overdraw cost, fewer bytes per pixel) matter at much higher resolutions or triangle counts than the budgets below `[U]` (MOC itself not run here). Revisit only if resolution must go above ~512x256 or occluders above ~20k triangles.

## Results (key tables; all tables in `tables.md`, raw data in `results.json`)

### 1. Frame cost, one camera, p50 ms (p99 in brackets), 256x128, simd path

| scene | native | Node wasm simd | Chromium wasm simd | native scalar path | Chromium scalar path |
|---|---|---|---|---|---|
| city-box (1024 bldg, 12 tris, 3000 occludees) | 0.91 (1.27) | 1.23 (1.96) | 1.07 (3.12) | 1.71 | 1.82 |
| city-coarse (~100 tris/bldg) | 3.51 (6.04) | 3.15 (5.86) | 3.68 (4.08) | 4.78 | 4.91 |
| forest (2000 occluders, 10k occludees) | 2.36 (2.61) | 3.07 (5.43) | 2.57 (3.47) | 2.93 | 3.54 |

Stage split, city-box 256x128 native simd: clear 0.002, select 0.010, setup 0.23, raster 0.35, mip 0.004, test 0.30 ms. Scalar path: raster 1.06, mip 0.086. SIMD gain on the raster stage is 3.0x (native), 2.8x (Chromium wasm: 1.05 to 0.43 ms); on the whole frame 1.9x city-box, 1.4x city-coarse, 1.2-1.4x forest, because setup (scalar) and the occludee test dominate there. The setup stage (city-coarse 2.35 ms for 71k source triangles) and the test (forest 0.8 ms native, 1.4 ms wasm for 10k occludees) are the next things to optimise (SIMD corner/clip setup, per-instance back-face rejection) `[U]`.

Resolution (native simd, total p50): city-box 0.91 / 1.09 / 1.57 ms for 256x128 / 320x180 / 512x256; city-coarse 3.51 / 3.98 / 4.75; forest 2.36 / 2.77 / 3.23. Wasm simd is about 1.0-1.4x native; Chromium is within noise of Node (no browser penalty visible; p99 is noisier). A wasm module built without simd128 is no faster than the simd module's scalar path.

Triangles (256x128 means over 8 frames): city-box 8,576 source triangles of 714 instances in frustum, 5,720 back-facing, **2,501 rasterised**; city-coarse 71,750 source, 38,039 back-facing, 14,167 rasterised; forest 32,032 source, 19,818 back-facing, 3,896 rasterised (most of the rest cover no pixel centre: thin trunks).

JS to wasm boundary (typed-array views over linear memory, Chromium/Node p50): writing 1,024 occluder matrices (48 KB) is 0.001 ms with `set()` and 0.008-0.014 ms in a JS loop; 3,000 AABBs 0.001 / 0.014-0.021 ms; forest 2,000 + 10,000 (336 KB) 0.002 / 0.018-0.035 and 0.004 / 0.06-0.12 ms; reading 10k visibility bytes 0.002-0.011 ms; 1000 trivial wasm calls 0.002-0.003 ms. The boundary is below 5% of the frame; nothing per-call is marshalled. (Camera is 16 floats, not separately timed.) Chromium timer was cross-origin isolated (5 us), so sub-10 us values are quantised.

### 2. Accuracy vs the 1080p oracle (8 frames; in-frustum occludees)

| scene | buffer | oracle culled | buffer culled, centre sampling, dilate 1 | lost culls | **false occluded** (dilate 1 / dilate 0) |
|---|---|---|---|---|---|
| city-box (of 15,829) | 256x128 | 15,353 (97.0%) | 14,507 (91.6%) | 846 | **0** / 10 |
| city-box | 320x180 | 15,353 | 14,845 | 508 | **0** / 8 |
| city-box | 512x256 | 15,353 | 15,051 | 302 | **0** / 4 |
| city-coarse | 256x128 | 15,333 | 14,508 | 827 | 2 / 8 |
| city-coarse | 512x256 | 15,333 | 15,038 | 295 | **0** / 6 |
| forest (of 46,659) | 256x128 | 34,909 (74.8%) | 30,789 | 4,893 | **773** / 1,599 |
| forest | 512x256 | 34,909 | 33,170 | 2,279 | **540** / 904 |

Coverage rule at 256x128 (dilate 1): shrink 0.25 gives **0** false occluded on both cities (city-box culled 14,077, city-coarse 13,970; lost culls rise by ~50%); shrink 0.5 (inner-conservative) gives 0 everywhere, including the forest, at the price of a forest cull count of 5,228 of 34,909 (it ignores thin trunks entirely) and city 13,346-13,516.

False "visible" (lost culls) is harmless: 5-6% of cullable occludees at 256x128 on the cities. False "occluded" is not zero in every configuration, and I do not claim it is: **it is caused by sub-pixel occluders under centre sampling.** A trunk 0.1 m wide at 50 m covers a quarter of a 256x128 pixel, but a covered pixel centre marks the whole pixel as occluding, and occludees behind the gaps are culled although the 1080p oracle sees them. The 1-pixel rect dilation only repairs seams and silhouette edges of large occluders (it removes the city's false occlusions), not this. Options, all measured: inner-conservative coverage (exact, loses most forest culls), a larger buffer (forest false occluded 773 to 540 at 512x256, not zero), or not using thin objects as occluders (a screen-size threshold removes some). For a v1 that must never pop: **dilate 1 plus shrink 0.25, and treat thin objects (trees, poles) as non-occluders** or accept ~1.7% false occluded in forest-like scenes (the unit test `centre_sampling_is_exact_on_city_only` pins this behaviour). The forest oracle culls 75% of in-frustum occludees; the buffer reaches 66% (centre) or 11% (inner-conservative), so "poor culling" in forests is real once made conservative.

### 3. Occluder selection (256x128, native simd, p50 ms; culls with dilate 1, centre sampling)

| scene | setting | tris rasterised | buffer culled / oracle culled | false occluded | native p50 | Node wasm p50 |
|---|---|---|---|---|---|---|
| city-coarse | no limit | 14,167 | 14,508 / 15,333 | 2 | 3.51 | 3.15 |
| city-coarse | cap 20k | 4,905 | 14,480 | 2 | 1.53 | 1.50 |
| city-coarse | cap 10k | 2,537 | 14,266 | 2 | 0.84 | 1.36 |
| city-coarse | cap 5k | 1,195 | 13,856 | 2 | 0.78 | 0.99 |
| city-coarse | cap 2k | 386 | 13,323 | 2 | 0.58 | 0.83 |
| city-coarse | min area 1% of screen | 4,144 | 14,477 | 2 | 1.27 | 1.61 |
| forest | no limit | 3,896 | 30,789 / 34,909 | 773 | 2.36 | 3.07 |
| forest | cap 10k | 1,293 | 25,037 | 454 | 1.53 | 2.17 |
| forest | cap 5k | 795 | 20,495 | 278 | 1.16 | 1.55 |
| forest | min area 0.2% | 1,968 | 28,827 | 735 | 1.77 | 2.37 |

(The cap counts source triangles of selected instances, after frustum culling, biggest-first.) In the city a cap of 10k source triangles keeps 98% of the cull count at 24% of the cost (the biggest buildings do the work); 2k still keeps 92%. In the forest culls fall almost linearly with the cap, because many medium occluders each hide a little. Both tables: 4 min-area thresholds in `tables.md`.

### 4. Wasm size

Release `occ_wasm.wasm`: simd128 **96,157 B (37,633 B gzip)**; scalar-only build 96,565 B (37,264 B). This includes the spike's workload generators, the 1080p oracle, temporal code and `std` allocation/HashMap; the engine-side core (rasteriser, setup, selection, test) is probably about half (est.).

### 5. Two cameras (256x128, native p50 ms)

| scene | cam A (main) | cam B persp side view | A+B | cam B ortho sun cascade | A+B |
|---|---|---|---|---|---|
| city-box | 0.89 | 0.48 | 1.36 | 0.21 | 0.95 |
| city-coarse | 3.38 | 1.47 | 4.84 | 0.65 | 3.88 |
| forest | 1.95 | 0.94 | 2.86 | 1.79 | 4.23 |

Cost is the sum of the two single-camera costs (A+B is within 5% of A plus B; the buffer is cleared and rebuilt per camera), so it is linear in cameras, and each camera costs what its content costs (a camera seeing 233 instances is cheaper than the main one at 715). Is a shadow cascade a sensible occlusion camera? Mechanically it works (orthographic: depth `2-z`, near clip on z; false occluded 0 in the city). Usefulness depends on the scene: in the city the cascade culled 478 of 975 tested occludees (49%), in the forest 17 of 32,392 (0.05%; light looks down through trunks) for 1.8 ms. Semantics also differ: an occludee hidden from the light is only a skippable shadow caster if it also doesn't cast onto visible receivers, which this test does not know `[U]` (needs care: caster-vs-light occlusion is only valid if nothing visible is shadowed by it; this was not studied). I would not include a cascade in v1.

### 6. Temporal options (smoke; native, 256x128)

Fresh frame 0.96 ms (city-box) / 2.17 ms (forest). "Reproject": redraw last frame's 8x8 tiles as quads at each tile's farthest-covering depth into the new camera (1,024 triangles at most), then test: 0.39 / 0.87 ms. Camera moves 0.6 m per path frame.

| scene | age | variant | buffer culled (oracle) | false occluded |
|---|---|---|---|---|
| city-box | 1 frame | stale buffer, no reprojection | 14,359 (15,182) | 0 |
| city-box | 1 frame | tile reprojection | 8,239 | 0 |
| city-box | 4 frames | stale | 14,320 | 7 |
| city-box | 12 frames | stale | 14,149 | 12 |
| city-box | 12 frames | tile reprojection | 5,199 | 0 |
| forest | 1 frame | stale | 29,740 (34,192) | 965 (fresh: 850) |
| forest | 12 frames | stale | 30,898 | 3,203 |
| forest | 1 frame | tile reprojection | 6,515 | 121 |

Using last frame's buffer unchanged costs nothing (no occluder rasterisation: the test only, ~0.3 ms) and, for a slow camera, is almost as good as fresh in the city: 0 new false occlusions at 1 frame, 7 per 15k at 4 frames, growing with camera speed (pop risk = disocclusion at silhouettes; mitigate with dilate and a speed-scaled rect expansion `[U]`). Coarse tile reprojection halves the culls (tiles are flattened to their farthest depth) so it is not worth it as built; a per-pixel reprojection with hole filling was not tried. Rendering this frame's buffer first costs the full frame (0.9-3.5 ms) on the main thread but has no latency risk. Rotation (fast camera turns) was not tested; stale buffers will pop much more there (est.).

## Recommendation

1. **Simple per-pixel max-depth buffer (this design), not a masked buffer**, for v1.
2. **256x128** by default (city-box 0.9 ms native, 1.1-1.2 ms wasm; lost culls 5-6%); **320x180** if budget allows (lost culls 3%); 512x256 buys little for 1.7-2x cost, except it cuts forest false-occlusions by a third.
3. **Occluder budget: cap about 10k source triangles per camera after frustum culling, biggest first** (0.8-1.4 ms wasm, ~98% of city culls), plus a screen-size threshold of ~0.2-1% of the screen. Author occluders as 12-100 triangle proxies; thin objects (trees, poles, rails) should not be occluders unless inner-conservative coverage is acceptable.
4. Conservativeness settings: test rect dilated by 1 px, coverage shrink 0.25 (0 false occluded on both city workloads), epsilon 1e-3; or shrink 0.5 where "never wrong" outweighs the culls.
5. Run it in wasm with simd128: expect ~1.2-1.4x native, no extra browser penalty, boundary cost negligible. Budget about 1-2 ms of main-thread time per camera for a city-like scene (0.9-3.5 ms measured here, shared machine), and consider reusing last frame's buffer for slow cameras.
6. Open work not done: SIMD in the setup stage and the occludee test (now the bulk), moving-occluder world-sphere update beyond the uniform-scale assumption, per-pixel reprojection, multi-threading.

Known limits of this spike: synthetic workloads (boxes and prisms), one camera path, 8 accuracy frames per job, the oracle is rect-based at 1080p, not exact box visibility; occluder spheres assume uniform scale; a shared noisy machine.
