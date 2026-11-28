# Spike: generating mesh LODs at import with meshoptimizer

Feasibility spike, throwaway code. Question: can `.mycomesh` LOD levels be generated at model import, in the editor (browser / Tauri webview) **and** in the Node export CLI, with a maintained simplifier, driven by per-level `{ratio, error limit}` in the model sidecar? Everything below is **measured** unless marked `(est.)` (estimate) or `[U]` (unverified). Tables are generated from `results.json` by `make-readme.mjs`; re-run `node run.mjs` (about 2.5 min) and `node make-readme.mjs` to refresh.

Run environment of the numbers below: {{META}}. The machine was shared with other agents, so **timings are a smoke test** (the coordinator re-runs `run.mjs` on an idle machine). Quality, size and determinism numbers do not depend on load.

## Recommendation

**Use the npm package `meshoptimizer` 1.3.0 (MIT)** from the import pipeline: its simplifier wasm is embedded in a plain ES module, so the same import works unchanged in Node 22 (ESM and `require`) and in Chromium; no build step, no Rust. The Rust crate `meshopt` 0.7.0 wraps the very same C++ (vendored meshoptimizer 1.3), gives the same results, but needs our own wasm32 build that did not build out of the box (see 1).

It is fast enough to run synchronously at import: a 20k-triangle mesh gets a 3-level chain (50/25/12.5 %) in about 10-20 ms and the whole pipeline (weld, 3 levels, 2 sloppy proxies, cache/fetch optimisation of 4 levels) in about 35 ms; Sponza (262k triangles, 103 submeshes) in under 1 s. Browser and Node produce **bit-identical index buffers** ({{DETERMINISM}}).

What the data says about the design (details and tables below):

1. **Weld first, always.** De-indexed or per-quad vertex soup is not simplified at all (rock soup: 20480 triangles out for a 2560 target). Welding bit-identical vertices (all attributes) is enough; the simplifier handles UV seams and split normals itself, with no cracks. A position-only weld + remap back is not needed to avoid cracks.
2. **Targets are not always reachable; an error limit is what decides.** Closed organic meshes reach every ratio. Hard-edged / UV-seam-heavy / low-poly meshes stall (building stuck at 63 % of LOD0 for any error limit; Sponza reaches 38 % when asked for 12.5 %). `Permissive` unblocks seams (building reaches 12.5 % at about 1 % error; DamagedHelmet 12.5 % at 1.5 % instead of stopping at 20 % with 9.5 % error). Record "achieved vs requested" in the import report.
3. **The error limit is an estimate, not a bound.** Independent Hausdorff distance was 0.02x to 4.7x the requested absolute limit depending on the mesh (rock about 1x, tree 0.9-1.4x, Lantern up to 1.7x, DamagedHelmet 1.5-2.7x, Sponza 2.2-4.7x; FlightHelmet and terrain well under, 0.02-0.4x). Use it as a knob, derive transition heights from the *measured* error, not from the limit. In `attr` mode (normals/UV weighted) the limit applies to a combined position+attribute error, so it stops earlier than in `pos` mode.
4. **Submeshes: simplify per submesh, lock shared vertices, use `Sparse`.** Whole-mesh simplification loses the material ranges. Per-submesh without locks opens cracks at shared boundaries (166 new open edges on a two-material rock); `LockBorder` or `vertex_lock` on shared vertices removes them. With 103 submeshes the `Sparse` flag cut the 3-level chain on Sponza from 3.7 s to 0.4 s (measured during development, not part of `run.mjs`). A uniform ratio per submesh is harmful for small thin submeshes (Lantern max error 18 % vs 2.8 % whole-mesh): give each submesh an error limit / minimum triangle count.
5. **Storage: one shared vertex buffer is viable and 35-60 % smaller than separate buffers per level, if the vertex order is coarsest-first.** All levels together are x1.1-1.3 of LOD0 with a shared buffer vs x1.9-2.3 with separate buffers (x3.4+ when levels barely reduce vertices). Shared in LOD0 order costs up to 1.9x the cache-line misses at the coarsest level; ordering vertices by "last level that uses them" removes that (x1.00-1.03) for free.
6. **Skinned meshes: carry joints/weights through the index buffer (vertex data untouched).** 0 invalid joint indices, 0 weight sums off, by construction. Weights as simplifier attributes gave no consistent win (see 6).
7. **Transition heights** can be derived as `h = tolerance_px / (1080 * e)` from the measured max error `e` (fraction of bbox diagonal); a rock at 1.65 % error may switch to LOD3 below about 5.6 % screen height at 1 px tolerance.

## Files

| file | purpose |
|---|---|
| `run.mjs` | one command; expected duration at its top; writes `results.json` |
| `results.json` | all measured data (distribution, speed Node + Chromium, quality, sizes, skinning) |
| `bench.mjs`, `bench-node.mjs`, `bench-chromium.mjs`, `bench.html` | speed benchmark, the same module runs in Node and Chromium |
| `quality.mjs`, `quality-node.mjs` | quality / size / skinning experiments |
| `distribution.mjs` | package sizes (esbuild minify + gzip), Node 22 and Chromium smoke tests |
| `lib/` | mesh model, generators (rock/tree/building), OBJ + glTF readers, LOD pipeline, BVH metrics, optimiser, skin pose |
| `rust-wasm/` | the Rust `meshopt` crate built to wasm32 (`build.sh`, `check.mjs`) |
| `fetch-models.sh` | downloads the third-party glTF models to `/tmp/claude-0/lod-models` (not committed) |
| `tables.mjs`, `make-readme.mjs`, `README.template.md` | generate this README from `results.json` |

The pipeline in `lib/lod.mjs` is what an importer would call: `weld` -> per-submesh `simplifyWithAttributes` (normals weight 1.0, UV weight 0.5, `ErrorAbsolute` = limit x whole-mesh extent, `Sparse` and shared-vertex locks when there are several submeshes) -> `reorderMesh` per level.

## Test meshes

Procedural (deterministic seed, `lib/gen.mjs`): **rock** = icosphere level 5 (20480 tris) with 6-octave noise, smooth normals, spherical UVs with a split seam; **tree** = noisy tapered trunk cylinder (UV seam, hard cap edge) + 4 noisy foliage blobs, 2 material groups (bark, leaves); **building** = 20 storeys, 4 walls, inset windows (conforming quads, no T-junctions), flat normals per quad, window UV islands (a second variant with T-junctions is used in the seam test). `rock2mat` is the rock split into two material groups along a plane so that the groups share boundary vertices (used for the submesh test). Real: Khronos glTF-Sample-Assets DamagedHelmet, FlightHelmet, Lantern, Avocado, Sponza, CesiumMan and Fox (skinned), plus the repo's `samples/navigation/models/terrain.obj` and `samples/pirates/models/ship.obj`. glTF node transforms are ignored (error is relative anyway). "open edges" = edges used by one triangle after merging equal positions.

{{T:inputs}}

## 1. Which distribution

{{T:distribution}}

| | npm `meshoptimizer` | Rust crate `meshopt` |
|---|---|---|
| version / licence | 1.3.0 / MIT | 0.7.0 / MIT OR Apache-2.0 (rust-version 1.87) |
| meshoptimizer C++ inside | 1.3 (the wasm says "built from meshoptimizer 1.3") | 1.3 (`MESHOPTIMIZER_VERSION 1030` vendored) |
| maintained | tracks upstream: the 1.3.0 package is the current 1.3 release (author = upstream author) | version tracks upstream 1.3; last release date and commit activity [U] (could not read the GitHub release feed from this sandbox) |
| runs in Node 22 | yes: `import` and `require('meshoptimizer')` (require(esm)), `supported: true` | wasm module loads in Node (built here) |
| runs in Chromium | yes (Playwright Chromium 158), `supported: true` | wasm module not tried in a browser; no imports, so expected to work [U] |
| browser / Tauri webview other than Chromium | not tested [U] (no WebKit browser installed here) | not tested [U] |
| we must build wasm ourselves | no (embedded) | **yes**; out of the box `cargo build --target wasm32-unknown-unknown` failed on clang 18 (stub headers lack `floorf`, `log2f`, `ceilf`, `frexpf`, `ldexpf`; link needs `operator new/delete`). `rust-wasm/build.sh` works around both (macro defines to clang builtins + two shim functions) |
| size of what it ships | simplifier wasm 40,919 B decoded for `simplify`, `simplifyWithAttributes`, sloppy, prune, points, remesh; module 19,160 B min+gzip | our smoke build with **only** `simplify`: 55,120 B wasm, 23,631 B gzip (no attributes, sloppy, optimiser), so a full build would be larger |
| speed on the rock, `simplify` to 12.5 % | {{RUST_NPM_MS}} | {{RUST_MS}} (includes copying into wasm memory; same 2560 triangles) |

Recommendation: npm `meshoptimizer`. Nothing to build, one 26 KB (min+gzip) dependency for simplifier + `reorderMesh`, MIT. The editor can `import()` it lazily on first import; the CLI imports it directly. A pure-Rust crate `meshopt-rs` 0.1.2 (a port, `experimental` feature) also exists [U: not evaluated].

## 2. Speed

`run.mjs`: {{RUNS}} timed runs after one warm-up per task; each cell is **p50 / p99 / max in ms**; with 7 runs p99 equals max. Chain = 3 levels (50/25/12.5 % of LOD0, each simplified from the previous level). `attr` = `simplifyWithAttributes` (normals + UVs), `pos` = positions only, sloppy = `simplifySloppy` for occluder proxies at 5 % and 2 % of LOD0 (whole mesh, each from LOD0). kTri/s = LOD0 triangles / p50 of the attr chain. All outputs are checked (indices in range, counts multiple of 3, groups cover the buffer, no NaN in inputs).

### Node 22

{{T:speed:node}}

### Chromium (headless, via Playwright)

{{T:speed:chromium}}

Other timings (weld cost, skinned attribute chain, browser/Node ratio):

{{T:speedExtra}}

Notes: throughput is about 0.7-1.4 M LOD0 triangles/s for the attr chain and 1.1-2.3 M/s for positions only; the two sloppy proxies cost 1/5 to 1/13 of the attr chain. Cache/fetch optimisation of the 4 levels costs 0.6-1.0x of the attr chain (up to 2x on tiny meshes). Whole-pipeline time in Chromium is 0.9-1.3x of Node (noise at these sizes, load average was above 4 on 4 cores). Procedural meshes whose raw vertices are not welded (building: 20808 raw vs 11912 welded) pay a visible weld cost (5 ms).

## 3. Quality

Metrics, all against LOD0 (the welded original), as a fraction of LOD0's **bounding-box diagonal**: one-sided Hausdorff-style distance from 15000 area-weighted surface samples + up to 15000 vertices of the simplified mesh to the original (S->O) and of the original to the simplified mesh (O->S), nearest point via a BVH, mean and max. meshopt's own error is relative to the **maximum bbox extent** (`getScale` equals `maxExtent`, verified in `stats.mjs`), which is 0.59-0.8 of the diagonal for these meshes; the tables show it in both units. "Open-edge change" = open edges after minus before (position-welded): positive = cracks; negative = border edges that collapsed or T-junctions that disappeared. Normal deviation is the angle between interpolated vertex normals at a sample on the simplified surface and at its nearest point on the original; UV deviation is the distance in UV space (Sponza's UVs tile over several units, so its UV numbers are large).

### Chain 50/25/12.5 %, attribute-aware (no error limit)

{{T:levels:attr}}

### Chain, positions only

{{T:levels:pos}}

Targets are met for the closed, organic meshes (rock, tree, FlightHelmet, Avocado, terrain, CesiumMan up to 25 %). Not met: building (hard edges, stuck at 63 % of LOD0 with about zero error, nothing more can collapse), Sponza (hard-edged architecture, 114/169/301 % of target), DamagedHelmet and Lantern at 12.5 % (large error forced) and the very low-poly ship and Fox. When no error limit is given the simplifier may delete thin parts to chase the target (Lantern O->S max 18 %, CesiumMan 15 %). `meshopt err` in attr mode includes the attribute terms and is therefore much larger than the geometric Hausdorff; in pos mode it tracks it (rock: cumulative 1.73 % of extent = 1.14 % of diagonal vs measured max 1.04 %).

Chained (level N from level N-1) vs each level from LOD0:

{{T:chainVsDirect}}

Quality is the same within noise; chained is about 2x faster (next table, "time for 3 levels"), and its meshopt error is relative to the previous level.

### Error limit vs reach (ratio 12.5 %, positions only, one step from LOD0)

Limit given as a fraction of the maximum bbox extent (absolute error = limit x `getScale`). Cells: achieved triangles (percent of target; 100 % = reached, more = stopped by the limit or by topology).

{{T:errorLimit}}

Sidecar-style configuration, 3 levels `{ratio, limit}` = {50 %, 0.5 %}, {25 %, 1 %}, {12.5 %, 2 %}, positions only. "max / limit" compares the independently measured max Hausdorff with the limit converted to bbox-diagonal units: values above 1 mean the estimate was exceeded.

{{T:config}}

### Flags: LockBorder, Permissive, Prune, Regularize (ratio 12.5 %, error limit 2 %)

{{T:flags}}

* `LockBorder` keeps the open border exactly (terrain 280 of 280 border edges, border displacement 0) at about 1.5x the geometric error; on closed meshes it changes nothing. Without it terrain's border collapses from 280 to 25 edges.
* `Permissive` is the flag that lets hard-edged and seam-heavy meshes reach their target (building pos 6522 -> 1301 triangles). In attr mode the normal weight protects hard edges again, so it did not help there under a 2 % limit.
* `Prune` did nothing on these meshes under a 2 % limit. With **no** limit (error 1.0 = 100 %) it deleted the entire building (0 triangles; observed during development with `simplify` at a 12.5 % target, not in `results.json`), so it needs a real limit.
* `Regularize` costs geometric error (rock 1.00 % -> 1.05 % max, meshopt error 0.92 % -> 1.46 %) for more even triangles.

### Submesh boundaries (ratio 25 %, attr mode)

{{T:submesh}}

`rock2mat` is the controlled case (two material groups sharing 226 boundary vertices): simplifying each group independently opens 166 cracks; `LockBorder` (per group) or `vertex_lock` on vertices used by more than one group gives 0. Disjoint groups (tree) are unaffected. Whole-mesh simplification has no cracks but returns one index range, so material assignment is lost.

### Seams, split normals and welding (ratio 12.5 %, positions only unless stated)

Variants: **never welded** = fully de-indexed triangle soup; **raw** = vertices as imported; **welded** = bit-identical vertices merged (the default pipeline); **position weld** = vertices merged by position only, attributes dropped (an upper bound for what a "weld positions, remap back" scheme could reach; it is not usable as is because attributes cannot be recovered). "building (T-junctions)" is the same building without conforming edges.

{{T:seams}}

* The simplifier needs the vertex buffer to be welded (identical vertices share an index): soups and the building's per-quad vertices are not simplified at all.
* After welding, split normals and UV seams are handled by the simplifier itself: no new open edges on closed meshes (rock, with a UV seam, 0), so **no position remap is needed to avoid cracks**. The price is reach: seams are locked unless `Permissive` is set (helmet: 3187 triangles vs the 1932 target, Hausdorff 9.5 %; with `Permissive` 1931 triangles at 1.5 %, with lower normal and UV deviation).
* Position-only welding reaches the target everywhere except where the geometry itself blocks it, but loses the attributes.

### Sloppy proxies (occluders), each from LOD0

{{T:sloppy}}

At 5 % it reaches 79-100 % of the target (Fox 41 %) with 0.5-6 % max Hausdorff, which is fine for occluders; at 2 % tiny meshes collapse (ship and Fox to 0 triangles, Avocado keeps 4), so a floor of a few dozen triangles is needed. Normals and UVs are meaningless on these meshes (17-72 degrees mean normal deviation).

## 4. Screen-space meaning of the error

Let `D` be the object's bounding-box diagonal and `e` the error as a fraction of `D`. If the object covers a fraction `h` of the viewport height (taking its projected size as `h * H`, `H = 1080` px), a world-space error `e * D` projects to

```
error_px = e * h * H          (independent of FOV and distance)
LOD usable for h <= tol_px / (e * H)
```

For `e` relative to meshopt's `getScale` (max bbox extent), first multiply by `maxExtent / diag` (0.59-0.8 here). Unity's LODGroup defines its screen-relative height from the renderer bounds' size; whether that is the largest extent or the diagonal [U] changes `h` by up to x1.7, so calibrate against the engine's own definition.

{{T:screen}}

Transition heights derived from the **measured max Hausdorff** (diagonal fraction) of each attr-chain level, 1 px / 2 px tolerance (`1` = visually lossless at any size, error below 0.1 px):

{{T:transitions}}

Typical 1 px results: LOD1 (50 %) switches in below about 0.15-0.4 of the screen height, LOD2 below 0.05-0.2, LOD3 below 0.04-0.09; meshes with large forced error (helmet LOD3 9.5 %, Lantern 18 %) would only be valid below 1 % height, i.e. in practice not usable, which is exactly why those levels should be cut by an error limit instead of a ratio.

## 5. Vertex cache/fetch optimisation and storage

Optimisation cost (4 levels, `reorderMesh` per level, material ranges kept contiguous by optimising each submesh separately) is the "cache+fetch opt" column of the speed tables. Resulting ACMR (FIFO cache of 16, see the LOD3 column below) goes from 1.0-1.5 to 0.66-0.78 on smooth meshes; hard-edged meshes with per-quad vertices stay at 1.3-1.6 (building 1.55) because vertices cannot be shared.

Sizes: float32 vertex = 32 B (position, normal, UV; 56 B skinned), uint16 indices when the vertex count fits else uint32; the "16 B quantised" columns assume position 3x u16 (+pad), normal snorm8x4, UV u16x2 (est. layout, not an engine decision). Levels = LOD0 + 50/25/12.5 % (attr chain). "Separate" = each level has its own compact, optimised VB+IB. "Shared" = one VB (LOD0 order), per-level IB only.

{{T:sizes}}

Locality: LRU cache-line misses (128 lines of 64 B, vertices fetched in index order). "Coarsest-first" = same shared VB with vertices sorted by the last (coarsest) level that uses them, so each level's vertices form a prefix.

{{T:locality}}

All levels together cost x1.1-1.3 of LOD0 with a shared VB (Sponza x1.5 because its levels barely reduce) against x1.9-2.3 with separate buffers. A shared VB in LOD0 order makes the coarsest level incur 1.1-1.9x the cache-line misses of its own VB (ship 1.02, hard-edged building 1.13); coarsest-first ordering brings that back to x1.00-1.03 at no size cost, and LOD0 itself loses nothing (misses within +/-2 %). Mid levels (LOD1) are 0-8 % above their own VB. Not measured: lossless vertex/index compression (`encodeVertexBuffer` etc.) on top, and any GPU timing [U].

## 6. Skinned meshes

CesiumMan (19 joints) and Fox (24 joints). Joints and weights are per-vertex data that stay valid when only the index buffer changes (`simplify`, `simplifyWithAttributes` without update), so "carry through" is correct by construction; the test checks it and compares geometric error in the bind pose and under three seeded random poses (each joint rotated up to 35 degrees about its bind-pose origin, linear blend skinning, `lib/skin.mjs`; no joint hierarchy, mesh node transform ignored [U: how representative of real animation]). Variants: positions only; normals+UV; normals+UV+4 skin weights as extra attributes (weight 1.0); the same with `Regularize`.

{{T:skin}}

* Validity: 0 invalid joint indices and 0 weight sums off in every variant (`simplifyWithUpdate`, which moves vertices and would interpolate weights but not joint indices, was not tested [U]).
* Posed error is roughly the bind-pose error, and for CesiumMan at 25 % the posed max (2.2 %) is 4.6x the bind-pose max (0.48 %), so deformation does amplify error.
* Skin weights as attributes lowered the posed max for CesiumMan at 25 % (2.23 % -> 1.87 %) but raised mean error (0.16 % -> 0.22 %) and was neutral or worse for Fox: no consistent win; it also costs a wider attribute buffer (attr+skin chain in the extra speed table). `Regularize` did not help consistently either.
* 12.5 % of CesiumMan (590 triangles) is not a usable level (34 % error): limbs vanish. Same lesson as before: cap by error.

## What was not measured `[U]`

* Tauri webviews other than Chromium (WKWebView, WebKitGTK, WebView2): the wasm uses no imports and the package reports `supported`, but only Chromium 158 and Node 22 were run.
* Memory use, very large meshes (above 262k triangles), multi-threading / Worker offload, Windows.
* Morph targets, vertex colours and tangents as simplifier attributes; `simplifyWithUpdate`; the `Prune` flag with a realistic limit on meshes with floating debris.
* Lossless compression of the baked buffers, and GPU-side benefit of LODs.
* Rust crate: last release date, maintenance activity, behaviour in a browser, attribute-aware API in a full wasm build.
* Unity's exact LODGroup size definition.
