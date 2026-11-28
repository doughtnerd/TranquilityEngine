# Spike: generating mesh LODs at import with meshoptimizer

Feasibility spike, throwaway code. Question: can `.mycomesh` LOD levels be generated at model import, in the editor (browser / Tauri webview) **and** in the Node export CLI, with a maintained simplifier, driven by per-level `{ratio, error limit}` in the model sidecar? Everything below is **measured** unless marked `(est.)` (estimate) or `[U]` (unverified). Tables are generated from `results.json` by `make-readme.mjs`; re-run `node run.mjs` (about 2.5 min) and `node make-readme.mjs` to refresh.

Run environment of the numbers below: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, linux 6.18.44-fc-v880, Node v22.23.5, Chromium 158.0.8127.36 (playwright 1.63.0), load average at start 4.23 / 3.67 / 2.67. The machine was shared with other agents, so **timings are a smoke test** (the coordinator re-runs `run.mjs` on an idle machine). Quality, size and determinism numbers do not depend on load.

## Recommendation

**Use the npm package `meshoptimizer` 1.3.0 (MIT)** from the import pipeline: its simplifier wasm is embedded in a plain ES module, so the same import works unchanged in Node 22 (ESM and `require`) and in Chromium; no build step, no Rust. The Rust crate `meshopt` 0.7.0 wraps the very same C++ (vendored meshoptimizer 1.3), gives the same results, but needs our own wasm32 build that did not build out of the box (see 1).

It is fast enough to run synchronously at import: a 20k-triangle mesh gets a 3-level chain (50/25/12.5 %) in about 10-20 ms and the whole pipeline (weld, 3 levels, 2 sloppy proxies, cache/fetch optimisation of 4 levels) in about 35 ms; Sponza (262k triangles, 103 submeshes) in under 1 s. Browser and Node produce **bit-identical index buffers** (identical for all 12 models, all modes).

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

| model | tris | raw verts | welded verts | position-welded verts | groups | open edges | bbox diag | skinned |
|---|---|---|---|---|---|---|---|---|
| rock | 20480 | 10337 | 10337 | 10242 | 1 | 0 | 4.35 |  |
| tree | 15728 | 8100 | 8100 | 7874 | 2 | 0 | 7.49 |  |
| building | 10404 | 20808 | 11912 | 5260 | 1 | 128 | 24.7 |  |
| DamagedHelmet | 15452 | 14556 | 14356 | 8661 | 1 | 1820 | 3.18 |  |
| FlightHelmet | 94722 | 55392 | 55392 | 47561 | 6 | 296 | 0.886 |  |
| Lantern | 5394 | 4145 | 4143 | 2705 | 3 | 32 | 16.7 |  |
| Avocado | 682 | 406 | 406 | 363 | 1 | 38 | 0.0808 |  |
| Sponza | 262267 | 192496 | 167291 | 110510 | 103 | 18662 | 2550 |  |
| CesiumMan | 4672 | 3273 | 3273 | 2338 | 1 | 0 | 1.91 | yes |
| Fox | 576 | 1728 | 434 | 290 | 1 | 0 | 105 | yes |
| terrain | 8128 | 4204 | 4204 | 4204 | 1 | 280 | 181 |  |
| ship | 464 | 953 | 953 | 273 | 4 | 6 | 5.4 |  |
| rock2mat | 20480 | 10337 | 10337 | 10242 | 2 | 0 | 4.35 |  |

## 1. Which distribution

| module (npm meshoptimizer 1.3.0, MIT) | file bytes | minified | minified + gzip -9 | decoded wasm |
|---|---|---|---|---|
| meshopt_simplifier.js | 67671 | 53621 | 19160 | 40919 |
| meshopt_encoder.js | 24363 | 20455 | 8139 | 14682 |
| meshopt_decoder.mjs | 29019 | 26254 | 7215 | 12259 |
| simplifier + encoder bundled |  | 74067 | 26411 |  |

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
| speed on the rock, `simplify` to 12.5 % | 8.38 ms median (npm) | 7.75 ms median (includes copying into wasm memory; same 2560 triangles) |

Recommendation: npm `meshoptimizer`. Nothing to build, one 26 KB (min+gzip) dependency for simplifier + `reorderMesh`, MIT. The editor can `import()` it lazily on first import; the CLI imports it directly. A pure-Rust crate `meshopt-rs` 0.1.2 (a port, `experimental` feature) also exists [U: not evaluated].

## 2. Speed

`run.mjs`: 7 timed runs after one warm-up per task; each cell is **p50 / p99 / max in ms**; with 7 runs p99 equals max. Chain = 3 levels (50/25/12.5 % of LOD0, each simplified from the previous level). `attr` = `simplifyWithAttributes` (normals + UVs), `pos` = positions only, sloppy = `simplifySloppy` for occluder proxies at 5 % and 2 % of LOD0 (whole mesh, each from LOD0). kTri/s = LOD0 triangles / p50 of the attr chain. All outputs are checked (indices in range, counts multiple of 3, groups cover the buffer, no NaN in inputs).

### Node 22

| model | LOD0 tris | chain x3 attr (ms) | chain x3 pos (ms) | sloppy 5%+2% (ms) | cache+fetch opt, 4 levels (ms) | whole pipeline incl. weld (ms) | kTri/s (attr chain) |
|---|---|---|---|---|---|---|---|
| rock | 20480 | 15.0 / 16.1 / 16.1 | 9.1 / 12.7 / 12.7 | 3.3 / 3.6 / 3.6 | 12.6 / 13.9 / 13.9 | 35.4 / 37.0 / 37.0 | 1361 |
| tree | 15728 | 11.5 / 15.6 / 15.6 | 7.1 / 7.5 / 7.5 | 1.6 / 1.7 / 1.7 | 11.4 / 14.3 / 14.3 | 27.8 / 30.7 / 30.7 | 1368 |
| building | 10404 | 9.4 / 10.4 / 10.4 | 5.4 / 6.0 / 6.0 | 1.4 / 1.5 / 1.5 | 8.4 / 8.6 / 8.6 | 22.2 / 27.2 / 27.2 | 1103 |
| DamagedHelmet | 15452 | 13.9 / 14.5 / 14.5 | 9.4 / 9.9 / 9.9 | 1.6 / 1.7 / 1.7 | 7.8 / 8.1 / 8.1 | 30.6 / 30.8 / 30.8 | 1115 |
| FlightHelmet | 94722 | 80.8 / 91.6 / 91.6 | 48.3 / 55.3 / 55.3 | 9.7 / 9.9 / 9.9 | 55.1 / 62.2 / 62.2 | 176.0 / 185.8 / 185.8 | 1173 |
| Lantern | 5394 | 4.7 / 5.1 / 5.1 | 3.0 / 3.2 / 3.2 | 0.6 / 0.7 / 0.7 | 3.1 / 5.2 / 5.2 | 9.7 / 11.0 / 11.0 | 1139 |
| Avocado | 682 | 0.5 / 1.1 / 1.1 | 0.3 / 0.3 / 0.3 | 0.1 / 0.1 / 0.1 | 0.4 / 0.5 / 0.5 | 1.1 / 1.2 / 1.2 | 1419 |
| Sponza | 262267 | 348.0 / 425.9 / 425.9 | 237.3 / 259.4 / 259.4 | 31.5 / 32.5 / 32.5 | 350.1 / 384.0 / 384.0 | 846.4 / 925.8 / 925.8 | 754 |
| CesiumMan | 4672 | 4.7 / 5.2 / 5.2 | 3.4 / 3.7 / 3.7 | 0.4 / 0.5 / 0.5 | 4.3 / 9.4 / 9.4 | 10.8 / 11.7 / 11.7 | 989 |
| Fox | 576 | 0.7 / 0.8 / 0.8 | 0.5 / 0.8 / 0.8 | 0.1 / 0.1 / 0.1 | 0.4 / 0.4 / 0.4 | 1.8 / 2.5 / 2.5 | 821 |
| terrain | 8128 | 5.7 / 5.8 / 5.8 | 3.8 / 4.5 / 4.5 | 0.7 / 1.0 / 1.0 | 4.1 / 4.4 / 4.4 | 11.9 / 14.4 / 14.4 | 1435 |
| ship | 464 | 0.4 / 0.4 / 0.4 | 0.3 / 0.3 / 0.3 | 0.0 / 0.1 / 0.1 | 0.8 / 1.1 / 1.1 | 1.4 / 1.9 / 1.9 | 1164 |

### Chromium (headless, via Playwright)

| model | LOD0 tris | chain x3 attr (ms) | chain x3 pos (ms) | sloppy 5%+2% (ms) | cache+fetch opt, 4 levels (ms) | whole pipeline incl. weld (ms) | kTri/s (attr chain) |
|---|---|---|---|---|---|---|---|
| rock | 20480 | 17.1 / 17.2 / 17.2 | 9.8 / 10.1 / 10.1 | 2.2 / 3.4 / 3.4 | 15.0 / 26.6 / 26.6 | 37.9 / 48.3 / 48.3 | 1198 |
| tree | 15728 | 12.6 / 14.0 / 14.0 | 7.7 / 9.0 / 9.0 | 1.7 / 1.8 / 1.8 | 12.1 / 13.6 / 13.6 | 28.0 / 28.5 / 28.5 | 1248 |
| building | 10404 | 10.1 / 13.6 / 13.6 | 5.2 / 6.1 / 6.1 | 2.2 / 2.2 / 2.2 | 11.1 / 13.7 / 13.7 | 28.8 / 33.1 / 33.1 | 1030 |
| DamagedHelmet | 15452 | 15.9 / 17.3 / 17.3 | 10.7 / 11.1 / 11.1 | 2.0 / 2.1 / 2.1 | 10.3 / 11.1 / 11.1 | 30.4 / 30.8 / 30.8 | 972 |
| FlightHelmet | 94722 | 82.4 / 84.4 / 84.4 | 48.4 / 48.7 / 48.7 | 10.4 / 10.7 / 10.7 | 62.3 / 65.2 / 65.2 | 181.5 / 187.3 / 187.3 | 1150 |
| Lantern | 5394 | 5.2 / 5.3 / 5.3 | 3.5 / 3.5 / 3.5 | 0.7 / 0.7 / 0.7 | 3.8 / 7.9 / 7.9 | 11.2 / 13.7 / 13.7 | 1037 |
| Avocado | 682 | 0.6 / 1.2 / 1.2 | 0.4 / 0.5 / 0.5 | 0.1 / 0.1 / 0.1 | 0.4 / 0.5 / 0.5 | 1.2 / 1.3 / 1.3 | 1137 |
| Sponza | 262267 | 376.5 / 416.8 / 416.8 | 231.9 / 277.6 / 277.6 | 33.5 / 33.8 / 33.8 | 406.5 / 471.6 / 471.6 | 881.0 / 964.0 / 964.0 | 697 |
| CesiumMan | 4672 | 4.6 / 4.7 / 4.7 | 3.4 / 3.8 / 3.8 | 0.5 / 0.6 / 0.6 | 3.8 / 7.8 / 7.8 | 10.1 / 12.6 / 12.6 | 1016 |
| Fox | 576 | 0.6 / 0.7 / 0.7 | 0.5 / 0.7 / 0.7 | 0.0 / 0.2 / 0.2 | 0.5 / 0.5 / 0.5 | 1.6 / 1.9 / 1.9 | 960 |
| terrain | 8128 | 5.8 / 6.2 / 6.2 | 3.7 / 3.7 / 3.7 | 0.6 / 0.7 / 0.7 | 4.1 / 4.3 / 4.3 | 12.2 / 21.2 / 21.2 | 1401 |
| ship | 464 | 0.4 / 0.5 / 0.5 | 0.3 / 1.7 / 1.7 | 0.0 / 0.1 / 0.1 | 0.8 / 0.9 / 0.9 | 1.6 / 1.7 / 1.7 | 1160 |

Other timings (weld cost, skinned attribute chain, browser/Node ratio):

| model | weld p50 node/chromium (ms) | attr+skin weights chain p50 node/chromium (ms) | Chromium / Node, whole pipeline p50 |
|---|---|---|---|
| rock | 2.2 / 2.7 |  | 1.07 |
| tree | 1.7 / 1.7 |  | 1.01 |
| building | 5.0 / 5.6 |  | 1.30 |
| DamagedHelmet | 2.3 / 4.5 |  | 0.99 |
| FlightHelmet | 11.1 / 12.2 |  | 1.03 |
| Lantern | 0.7 / 0.9 |  | 1.16 |
| Avocado | 0.1 / 0.1 |  | 1.12 |
| Sponza | 44.9 / 48.3 |  | 1.04 |
| CesiumMan | 1.2 / 1.3 | 5.8 / 5.8 | 0.93 |
| Fox | 0.3 / 0.2 | 0.8 / 0.7 | 0.91 |
| terrain | 1.9 / 1.8 |  | 1.03 |
| ship | 0.2 / 0.5 |  | 1.11 |

Notes: throughput is about 0.7-1.4 M LOD0 triangles/s for the attr chain and 1.1-2.3 M/s for positions only; the two sloppy proxies cost 1/5 to 1/13 of the attr chain. Cache/fetch optimisation of the 4 levels costs 0.6-1.0x of the attr chain (up to 2x on tiny meshes). Whole-pipeline time in Chromium is 0.9-1.3x of Node (noise at these sizes, load average was above 4 on 4 cores). Procedural meshes whose raw vertices are not welded (building: 20808 raw vs 11912 welded) pay a visible weld cost (5 ms).

## 3. Quality

Metrics, all against LOD0 (the welded original), as a fraction of LOD0's **bounding-box diagonal**: one-sided Hausdorff-style distance from 15000 area-weighted surface samples + up to 15000 vertices of the simplified mesh to the original (S->O) and of the original to the simplified mesh (O->S), nearest point via a BVH, mean and max. meshopt's own error is relative to the **maximum bbox extent** (`getScale` equals `maxExtent`, verified in `stats.mjs`), which is 0.59-0.8 of the diagonal for these meshes; the tables show it in both units. "Open-edge change" = open edges after minus before (position-welded): positive = cracks; negative = border edges that collapsed or T-junctions that disappeared. Normal deviation is the angle between interpolated vertex normals at a sample on the simplified surface and at its nearest point on the original; UV deviation is the distance in UV space (Sponza's UVs tile over several units, so its UV numbers are large).

### Chain 50/25/12.5 %, attribute-aware (no error limit)

| model | level | target tris | achieved | meshopt err (step / cumulative, of max extent) | Hausdorff max (S->O / O->S) | Hausdorff mean (S->O / O->S) | normal dev mean / p95 (deg) | UV dev mean (of 0..1) | new open edges |
|---|---|---|---|---|---|---|---|---|---|
| rock | 1 | 10240 | 10240 (100%) | 0.94% / 0.94% (0.62% of diag) | 0.50% / 0.62% | 0.05% / 0.07% | 3.24 / 9.24 | 0.0012 | 0 |
| rock | 2 | 5120 | 5120 (100%) | 1.83% / 2.77% (1.84% of diag) | 0.83% / 1.00% | 0.12% / 0.16% | 6.51 / 15.4 | 0.0031 | 0 |
| rock | 3 | 2560 | 2560 (100%) | 3.74% / 6.50% (4.32% of diag) | 1.49% / 1.65% | 0.21% / 0.27% | 10.9 / 25.9 | 0.0045 | 0 |
| tree | 1 | 7864 | 7864 (100%) | 1.34% / 1.34% (1.04% of diag) | 0.89% / 1.02% | 0.07% / 0.09% | 5.03 / 13.4 | 0.0037 | 0 |
| tree | 2 | 3932 | 3932 (100%) | 2.59% / 3.93% (3.04% of diag) | 1.31% / 1.96% | 0.17% / 0.22% | 10.3 / 25.3 | 0.0073 | 0 |
| tree | 3 | 1966 | 1966 (100%) | 4.85% / 8.78% (6.79% of diag) | 2.09% / 2.60% | 0.29% / 0.39% | 17 / 49.6 | 0.013 | 0 |
| building | 1 | 5202 | 6552 (126%) | 0.04% / 0.04% (0.03% of diag) | 0.00% / 0.00% | 0.00% / 0.00% | 0.006 / 0 | 6.7e-5 | -114 |
| building | 2 | 2601 | 6538 (251%) | 0.02% / 0.06% (0.05% of diag) | 0.00% / 0.00% | 0.00% / 0.00% | 0.006 / 0 | 6.7e-5 | -114 |
| building | 3 | 1301 | 6538 (503%) | 0.00% / 0.06% (0.05% of diag) | 0.00% / 0.00% | 0.00% / 0.00% | 0.006 / 0 | 6.7e-5 | -114 |
| DamagedHelmet | 1 | 7726 | 7725 (100%) | 0.60% / 0.60% (0.36% of diag) | 0.41% / 0.42% | 0.02% / 0.03% | 2.15 / 3.5 | 0.012 | -701 |
| DamagedHelmet | 2 | 3863 | 3860 (100%) | 5.51% / 6.12% (3.64% of diag) | 3.51% / 2.50% | 0.23% / 0.23% | 12.7 / 79.8 | 0.066 | -1226 |
| DamagedHelmet | 3 | 1932 | 3209 (166%) | 105.80% / 111.90% (66.51% of diag) | 9.11% / 9.52% | 0.70% / 0.66% | 22.8 / 93.6 | 0.14 | -1345 |
| FlightHelmet | 1 | 47361 | 47360 (100%) | 0.44% / 0.44% (0.36% of diag) | 0.20% / 0.22% | 0.00% / 0.01% | 1.91 / 4.96 | 0.0043 | -136 |
| FlightHelmet | 2 | 23681 | 23679 (100%) | 0.87% / 1.31% (1.06% of diag) | 0.45% / 0.46% | 0.02% / 0.04% | 7.45 / 24.2 | 0.02 | -203 |
| FlightHelmet | 3 | 11840 | 11829 (100%) | 2.41% / 3.72% (3.01% of diag) | 1.02% / 0.84% | 0.06% / 0.09% | 16.2 / 158 | 0.048 | -259 |
| Lantern | 1 | 2697 | 2696 (100%) | 4.16% / 4.16% (3.45% of diag) | 2.30% / 3.26% | 0.03% / 0.04% | 13.9 / 128 | 0.051 | -16 |
| Lantern | 2 | 1349 | 1396 (103%) | 180.00% / 184.10% (152.50% of diag) | 2.90% / 18.32% | 0.24% / 0.99% | 33.5 / 166 | 0.13 | -24 |
| Lantern | 3 | 674 | 892 (132%) | 20.85% / 205.00% (169.80% of diag) | 2.90% / 18.32% | 0.27% / 1.04% | 35.1 / 166 | 0.13 | -32 |
| Avocado | 1 | 341 | 341 (100%) | 1.06% / 1.06% (0.83% of diag) | 0.97% / 1.02% | 0.10% / 0.10% | 0.733 / 2.32 | 0.0045 | -23 |
| Avocado | 2 | 171 | 171 (100%) | 2.67% / 3.73% (2.90% of diag) | 1.94% / 2.02% | 0.30% / 0.32% | 1.75 / 4.95 | 0.012 | -27 |
| Avocado | 3 | 85 | 84 (99%) | 6.34% / 10.06% (7.83% of diag) | 5.09% / 5.19% | 0.81% / 0.88% | 4.45 / 15.4 | 0.038 | -32 |
| Sponza | 1 | 131141 | 149530 (114%) | 150.30% / 150.30% (106.10% of diag) | 3.35% / 1.61% | 0.01% / 0.01% | 43.9 / 180 | 2.5 | -6685 |
| Sponza | 2 | 65572 | 110897 (169%) | 1078.00% / 1229.00% (867.00% of diag) | 5.90% / 5.00% | 0.04% / 0.05% | 46.5 / 180 | 2.6 | -12269 |
| Sponza | 3 | 32787 | 98820 (301%) | 49.17% / 1278.00% (901.70% of diag) | 6.09% / 6.17% | 0.04% / 0.06% | 46.8 / 180 | 2.6 | -14181 |
| CesiumMan | 1 | 2336 | 2336 (100%) | 0.34% / 0.34% (0.27% of diag) | 0.41% / 0.34% | 0.01% / 0.01% | 0.597 / 2.25 | 0.00061 | 0 |
| CesiumMan | 2 | 1168 | 1168 (100%) | 1.94% / 2.27% (1.79% of diag) | 0.88% / 0.87% | 0.09% / 0.10% | 3.97 / 11.8 | 0.0036 | 0 |
| CesiumMan | 3 | 584 | 590 (101%) | 403.20% / 405.50% (319.20% of diag) | 5.00% / 14.89% | 0.97% / 2.73% | 37.4 / 91 | 0.073 | 0 |
| Fox | 1 | 288 | 288 (100%) | 14.47% / 14.47% (10.90% of diag) | 2.83% / 3.56% | 0.20% / 0.24% | 23.5 / 180 | 0.056 | 0 |
| Fox | 2 | 144 | 150 (104%) | 486.90% / 501.40% (377.80% of diag) | 5.50% / 11.32% | 1.45% / 1.87% | 55.4 / 167 | 0.11 | 0 |
| Fox | 3 | 72 | 150 (208%) | 0.00% / 501.40% (377.80% of diag) | 5.50% / 11.32% | 1.45% / 1.87% | 55.4 / 167 | 0.11 | 0 |
| terrain | 1 | 4064 | 4064 (100%) | 0.01% / 0.01% (0.00% of diag) | 0.01% / 0.01% | 0.00% / 0.00% | 0.0111 / 0.0403 | 0 | -198 |
| terrain | 2 | 2032 | 2031 (100%) | 0.01% / 0.02% (0.01% of diag) | 0.01% / 0.01% | 0.00% / 0.00% | 0.026 / 0.0764 | 0 | -253 |
| terrain | 3 | 1016 | 1016 (100%) | 0.04% / 0.06% (0.05% of diag) | 0.04% / 0.04% | 0.01% / 0.01% | 0.0843 / 0.23 | 0 | -264 |
| ship | 1 | 232 | 420 (181%) | 27.38% / 27.38% (21.04% of diag) | 0.00% / 9.40% | 0.00% / 0.21% | 0.0071 / 1.2e-6 | 6.7e-5 | 0 |
| ship | 2 | 116 | 420 (362%) | 0.00% / 27.38% (21.04% of diag) | 0.00% / 9.40% | 0.00% / 0.21% | 0.0071 / 1.2e-6 | 6.7e-5 | 0 |
| ship | 3 | 59 | 420 (712%) | 0.00% / 27.38% (21.04% of diag) | 0.00% / 9.40% | 0.00% / 0.21% | 0.0071 / 1.2e-6 | 6.7e-5 | 0 |

### Chain, positions only

| model | level | target tris | achieved | meshopt err (step / cumulative, of max extent) | Hausdorff max (S->O / O->S) | Hausdorff mean (S->O / O->S) | normal dev mean / p95 (deg) | UV dev mean (of 0..1) | new open edges |
|---|---|---|---|---|---|---|---|---|---|
| rock | 1 | 10240 | 10240 (100%) | 0.31% / 0.31% (0.20% of diag) | 0.34% / 0.32% | 0.03% / 0.04% | 6.92 / 19.8 | 0.00051 | 0 |
| rock | 2 | 5120 | 5120 (100%) | 0.54% / 0.85% (0.57% of diag) | 0.61% / 0.54% | 0.07% / 0.09% | 13.2 / 30.8 | 0.0019 | 0 |
| rock | 3 | 2560 | 2560 (100%) | 0.87% / 1.73% (1.15% of diag) | 0.95% / 1.04% | 0.13% / 0.16% | 19.3 / 43.1 | 0.0036 | 0 |
| tree | 1 | 7864 | 7864 (100%) | 0.41% / 0.41% (0.32% of diag) | 0.49% / 0.55% | 0.04% / 0.05% | 8.94 / 27.2 | 0.002 | 0 |
| tree | 2 | 3932 | 3932 (100%) | 0.76% / 1.17% (0.90% of diag) | 0.91% / 0.95% | 0.10% / 0.12% | 17.3 / 44.8 | 0.0062 | 0 |
| tree | 3 | 1966 | 1966 (100%) | 1.17% / 2.34% (1.81% of diag) | 1.32% / 1.33% | 0.19% / 0.21% | 24 / 55.6 | 0.012 | 0 |
| building | 1 | 5202 | 6535 (126%) | 0.04% / 0.04% (0.03% of diag) | 0.00% / 0.00% | 0.00% / 0.00% | 0.006 / 0 | 6.7e-5 | -109 |
| building | 2 | 2601 | 6521 (251%) | 0.02% / 0.06% (0.05% of diag) | 0.00% / 0.00% | 0.00% / 0.00% | 0.006 / 0 | 6.7e-5 | -109 |
| building | 3 | 1301 | 6521 (501%) | 0.00% / 0.06% (0.05% of diag) | 0.00% / 0.00% | 0.00% / 0.00% | 0.006 / 0 | 6.7e-5 | -109 |
| DamagedHelmet | 1 | 7726 | 7726 (100%) | 0.34% / 0.34% (0.20% of diag) | 0.31% / 0.44% | 0.02% / 0.03% | 2.95 / 9.08 | 0.012 | -618 |
| DamagedHelmet | 2 | 3863 | 3863 (100%) | 2.32% / 2.66% (1.58% of diag) | 1.89% / 1.81% | 0.19% / 0.21% | 12.1 / 72.4 | 0.053 | -1157 |
| DamagedHelmet | 3 | 1932 | 3207 (166%) | 13.56% / 16.22% (9.64% of diag) | 8.83% / 7.54% | 0.69% / 0.61% | 23.5 / 96.2 | 0.14 | -1345 |
| FlightHelmet | 1 | 47361 | 47361 (100%) | 0.07% / 0.07% (0.05% of diag) | 0.10% / 0.08% | 0.00% / 0.01% | 4.58 / 25.2 | 0.0027 | -93 |
| FlightHelmet | 2 | 23681 | 23680 (100%) | 0.19% / 0.25% (0.20% of diag) | 0.28% / 0.17% | 0.01% / 0.02% | 13.7 / 66.7 | 0.01 | -138 |
| FlightHelmet | 3 | 11840 | 11801 (100%) | 0.31% / 0.56% (0.46% of diag) | 0.73% / 0.45% | 0.02% / 0.05% | 20.1 / 75 | 0.027 | -196 |
| Lantern | 1 | 2697 | 2696 (100%) | 0.08% / 0.08% (0.07% of diag) | 0.14% / 0.17% | 0.00% / 0.00% | 23 / 123 | 0.036 | 0 |
| Lantern | 2 | 1349 | 1398 (104%) | 28.05% / 28.13% (23.31% of diag) | 2.90% / 18.32% | 0.24% / 0.98% | 34.3 / 163 | 0.13 | -12 |
| Lantern | 3 | 674 | 849 (126%) | 3.05% / 31.18% (25.83% of diag) | 2.90% / 18.32% | 0.27% / 1.02% | 35.1 / 165 | 0.13 | -25 |
| Avocado | 1 | 341 | 341 (100%) | 0.57% / 0.57% (0.44% of diag) | 0.63% / 0.79% | 0.05% / 0.06% | 1.69 / 6.6 | 0.0057 | -23 |
| Avocado | 2 | 171 | 171 (100%) | 1.19% / 1.76% (1.37% of diag) | 1.38% / 1.39% | 0.21% / 0.21% | 4.21 / 18.8 | 0.0092 | -27 |
| Avocado | 3 | 85 | 84 (99%) | 2.48% / 4.24% (3.30% of diag) | 2.71% / 2.76% | 0.58% / 0.61% | 12 / 59.6 | 0.019 | -30 |
| Sponza | 1 | 131141 | 149798 (114%) | 21.41% / 21.41% (15.11% of diag) | 3.35% / 1.61% | 0.01% / 0.01% | 44 / 180 | 2.5 | -3454 |
| Sponza | 2 | 65572 | 110608 (169%) | 27.25% / 48.67% (34.34% of diag) | 4.63% / 3.65% | 0.02% / 0.03% | 45.7 / 180 | 2.6 | -11643 |
| Sponza | 3 | 32787 | 98590 (301%) | 9.94% / 58.61% (41.35% of diag) | 5.82% / 4.76% | 0.04% / 0.04% | 46.4 / 180 | 2.6 | -13943 |
| CesiumMan | 1 | 2336 | 2336 (100%) | 0.07% / 0.07% (0.05% of diag) | 0.11% / 0.08% | 0.01% / 0.01% | 2.92 / 11.2 | 0.00047 | 0 |
| CesiumMan | 2 | 1168 | 1168 (100%) | 0.39% / 0.46% (0.36% of diag) | 0.53% / 0.52% | 0.06% / 0.07% | 10.8 / 32.4 | 0.003 | 0 |
| CesiumMan | 3 | 584 | 586 (100%) | 19.18% / 19.63% (15.45% of diag) | 4.82% / 28.63% | 0.95% / 3.58% | 36.6 / 77.8 | 0.059 | 0 |
| Fox | 1 | 288 | 288 (100%) | 0.85% / 0.85% (0.64% of diag) | 0.79% / 7.05% | 0.03% / 0.08% | 25.5 / 180 | 0.037 | 0 |
| Fox | 2 | 144 | 148 (103%) | 9.06% / 9.92% (7.47% of diag) | 5.79% / 11.32% | 1.43% / 1.96% | 59.7 / 145 | 0.13 | 0 |
| Fox | 3 | 72 | 146 (203%) | 1.09% / 11.00% (8.29% of diag) | 5.79% / 11.32% | 1.44% / 1.97% | 59.6 / 137 | 0.13 | 0 |
| terrain | 1 | 4064 | 4063 (100%) | 0.00% / 0.00% (0.00% of diag) | 0.01% / 0.01% | 0.00% / 0.00% | 0.0554 / 0.162 | 0 | -211 |
| terrain | 2 | 2032 | 2032 (100%) | 0.01% / 0.01% (0.01% of diag) | 0.01% / 0.01% | 0.00% / 0.00% | 0.12 / 0.339 | 0 | -236 |
| terrain | 3 | 1016 | 1016 (100%) | 0.02% / 0.03% (0.02% of diag) | 0.02% / 0.02% | 0.00% / 0.00% | 0.246 / 0.886 | 0 | -260 |
| ship | 1 | 232 | 420 (181%) | 10.78% / 10.78% (8.28% of diag) | 0.00% / 9.40% | 0.00% / 0.21% | 0.0071 / 1.2e-6 | 6.7e-5 | 0 |
| ship | 2 | 116 | 420 (362%) | 0.00% / 10.78% (8.28% of diag) | 0.00% / 9.40% | 0.00% / 0.21% | 0.0071 / 1.2e-6 | 6.7e-5 | 0 |
| ship | 3 | 59 | 420 (712%) | 0.00% / 10.78% (8.28% of diag) | 0.00% / 9.40% | 0.00% / 0.21% | 0.0071 / 1.2e-6 | 6.7e-5 | 0 |

Targets are met for the closed, organic meshes (rock, tree, FlightHelmet, Avocado, terrain, CesiumMan up to 25 %). Not met: building (hard edges, stuck at 63 % of LOD0 with about zero error, nothing more can collapse), Sponza (hard-edged architecture, 114/169/301 % of target), DamagedHelmet and Lantern at 12.5 % (large error forced) and the very low-poly ship and Fox. When no error limit is given the simplifier may delete thin parts to chase the target (Lantern O->S max 18 %, CesiumMan 15 %). `meshopt err` in attr mode includes the attribute terms and is therefore much larger than the geometric Hausdorff; in pos mode it tracks it (rock: cumulative 1.73 % of extent = 1.14 % of diagonal vs measured max 1.04 %).

Chained (level N from level N-1) vs each level from LOD0:

| model | build | tris at 12.5% | Hausdorff max | Hausdorff mean |
|---|---|---|---|---|
| rock | chained | 2560 | 1.65% | 0.27% |
| rock | each level from LOD0 | 2560 | 1.53% | 0.27% |
| tree | chained | 1966 | 2.60% | 0.39% |
| tree | each level from LOD0 | 1966 | 2.91% | 0.38% |
| DamagedHelmet | chained | 3209 | 9.52% | 0.70% |
| DamagedHelmet | each level from LOD0 | 3293 | 9.52% | 0.72% |
| terrain | chained | 1016 | 0.04% | 0.01% |
| terrain | each level from LOD0 | 1015 | 0.05% | 0.01% |

Quality is the same within noise; chained is about 2x faster (next table, "time for 3 levels"), and its meshopt error is relative to the previous level.

### Error limit vs reach (ratio 12.5 %, positions only, one step from LOD0)

Limit given as a fraction of the maximum bbox extent (absolute error = limit x `getScale`). Cells: achieved triangles (percent of target; 100 % = reached, more = stopped by the limit or by topology).

| model (target tris at 12.5%) | no limit | limit 2% | limit 1% | limit 0.5% | limit 0.2% | limit 0.1% |
|---|---|---|---|---|---|---|
| rock (2560) | 2560 (100%) | 2560 (100%) | 2560 (100%) | 5370 (210%) | 14782 (577%) | 19236 (751%) |
| tree (1966) | 1966 (100%) | 1966 (100%) | 2392 (122%) | 5348 (272%) | 10992 (559%) | 12944 (658%) |
| building (1301) | 6522 (501%) | 6522 (501%) | 6522 (501%) | 6522 (501%) | 6522 (501%) | 6522 (501%) |
| DamagedHelmet (1932) | 3187 (165%) | 3850 (199%) | 4570 (237%) | 6029 (312%) | 10159 (526%) | 12340 (639%) |
| FlightHelmet (11840) | 11833 (100%) | 11833 (100%) | 11833 (100%) | 11833 (100%) | 15435 (130%) | 27246 (230%) |
| Lantern (674) | 909 (135%) | 929 (138%) | 959 (142%) | 995 (148%) | 1224 (182%) | 1962 (291%) |
| Avocado (85) | 84 (99%) | 108 (127%) | 210 (247%) | 367 (432%) | 574 (675%) | 642 (755%) |
| Sponza (32787) | 100569 (307%) | 100941 (308%) | 101424 (309%) | 102416 (312%) | 106315 (324%) | 111731 (341%) |
| CesiumMan (584) | 592 (101%) | 690 (118%) | 768 (132%) | 962 (165%) | 1524 (261%) | 2050 (351%) |
| Fox (72) | 150 (208%) | 218 (303%) | 284 (394%) | 318 (442%) | 354 (492%) | 378 (525%) |
| terrain (1016) | 1015 (100%) | 1015 (100%) | 1015 (100%) | 1015 (100%) | 1015 (100%) | 1015 (100%) |
| ship (59) | 420 (712%) | 426 (722%) | 428 (725%) | 428 (725%) | 428 (725%) | 428 (725%) |

Sidecar-style configuration, 3 levels `{ratio, limit}` = {50 %, 0.5 %}, {25 %, 1 %}, {12.5 %, 2 %}, positions only. "max / limit" compares the independently measured max Hausdorff with the limit converted to bbox-diagonal units: values above 1 mean the estimate was exceeded.

| model | build | level (ratio, limit of max extent) | tris (target) | limit as % of bbox diag | Hausdorff max | max / limit | Hausdorff mean | time for 3 levels (ms, single run) |
|---|---|---|---|---|---|---|---|---|
| rock | each level from LOD0 | 1 (50%, 0.5%) | 10240 (10240) | 0.33% | 0.34% | 1 | 0.04% | 39.7 |
| rock | each level from LOD0 | 2 (25%, 1%) | 5120 (5120) | 0.66% | 0.73% | 1.1 | 0.09% |  |
| rock | each level from LOD0 | 3 (12.5%, 2%) | 2560 (2560) | 1.33% | 1.00% | 0.75 | 0.15% |  |
| rock | chained | 1 (50%, 0.5%) | 10240 (10240) | 0.33% | 0.34% | 1 | 0.04% | 10.3 |
| rock | chained | 2 (25%, 1%) | 5120 (5120) | 0.66% | 0.61% | 0.92 | 0.09% |  |
| rock | chained | 3 (12.5%, 2%) | 2560 (2560) | 1.33% | 1.04% | 0.78 | 0.16% |  |
| tree | each level from LOD0 | 1 (50%, 0.5%) | 7864 (7864) | 0.39% | 0.55% | 1.4 | 0.05% | 17.9 |
| tree | each level from LOD0 | 2 (25%, 1%) | 3932 (3932) | 0.77% | 0.97% | 1.3 | 0.12% |  |
| tree | each level from LOD0 | 3 (12.5%, 2%) | 1966 (1966) | 1.55% | 1.39% | 0.9 | 0.21% |  |
| tree | chained | 1 (50%, 0.5%) | 7864 (7864) | 0.39% | 0.55% | 1.4 | 0.05% | 9.18 |
| tree | chained | 2 (25%, 1%) | 3932 (3932) | 0.77% | 0.95% | 1.2 | 0.12% |  |
| tree | chained | 3 (12.5%, 2%) | 1966 (1966) | 1.55% | 1.33% | 0.86 | 0.21% |  |
| DamagedHelmet | each level from LOD0 | 1 (50%, 0.5%) | 7726 (7726) | 0.30% | 0.44% | 1.5 | 0.03% | 15.6 |
| DamagedHelmet | each level from LOD0 | 2 (25%, 1%) | 4578 (3863) | 0.59% | 0.95% | 1.6 | 0.11% |  |
| DamagedHelmet | each level from LOD0 | 3 (12.5%, 2%) | 3850 (1932) | 1.19% | 3.24% | 2.7 | 0.21% |  |
| DamagedHelmet | chained | 1 (50%, 0.5%) | 7726 (7726) | 0.30% | 0.44% | 1.5 | 0.03% | 13.2 |
| DamagedHelmet | chained | 2 (25%, 1%) | 4746 (3863) | 0.59% | 0.95% | 1.6 | 0.10% |  |
| DamagedHelmet | chained | 3 (12.5%, 2%) | 3880 (1932) | 1.19% | 1.92% | 1.6 | 0.20% |  |
| FlightHelmet | each level from LOD0 | 1 (50%, 0.5%) | 47361 (47361) | 0.40% | 0.10% | 0.24 | 0.01% | 93.5 |
| FlightHelmet | each level from LOD0 | 2 (25%, 1%) | 23679 (23681) | 0.81% | 0.30% | 0.37 | 0.02% |  |
| FlightHelmet | each level from LOD0 | 3 (12.5%, 2%) | 11833 (11840) | 1.62% | 0.56% | 0.35 | 0.05% |  |
| FlightHelmet | chained | 1 (50%, 0.5%) | 47361 (47361) | 0.40% | 0.10% | 0.24 | 0.01% | 53.6 |
| FlightHelmet | chained | 2 (25%, 1%) | 23680 (23681) | 0.81% | 0.28% | 0.34 | 0.02% |  |
| FlightHelmet | chained | 3 (12.5%, 2%) | 11801 (11840) | 1.62% | 0.73% | 0.45 | 0.05% |  |
| Lantern | each level from LOD0 | 1 (50%, 0.5%) | 2696 (2697) | 0.41% | 0.17% | 0.4 | 0.00% | 7.3 |
| Lantern | each level from LOD0 | 2 (25%, 1%) | 1435 (1349) | 0.83% | 1.07% | 1.3 | 0.04% |  |
| Lantern | each level from LOD0 | 3 (12.5%, 2%) | 929 (674) | 1.66% | 2.83% | 1.7 | 0.21% |  |
| Lantern | chained | 1 (50%, 0.5%) | 2696 (2697) | 0.41% | 0.17% | 0.4 | 0.00% | 4.23 |
| Lantern | chained | 2 (25%, 1%) | 1434 (1349) | 0.83% | 1.07% | 1.3 | 0.04% |  |
| Lantern | chained | 3 (12.5%, 2%) | 879 (674) | 1.66% | 2.43% | 1.5 | 0.15% |  |
| Sponza | each level from LOD0 | 1 (50%, 0.5%) | 150193 (131141) | 0.35% | 0.79% | 2.2 | 0.00% | 326 |
| Sponza | each level from LOD0 | 2 (25%, 1%) | 112965 (65572) | 0.71% | 3.29% | 4.7 | 0.01% |  |
| Sponza | each level from LOD0 | 3 (12.5%, 2%) | 100941 (32787) | 1.41% | 3.29% | 2.3 | 0.02% |  |
| Sponza | chained | 1 (50%, 0.5%) | 150193 (131141) | 0.35% | 0.79% | 2.2 | 0.00% | 218 |
| Sponza | chained | 2 (25%, 1%) | 111386 (65572) | 0.71% | 3.29% | 4.7 | 0.01% |  |
| Sponza | chained | 3 (12.5%, 2%) | 98946 (32787) | 1.41% | 3.29% | 2.3 | 0.02% |  |
| terrain | each level from LOD0 | 1 (50%, 0.5%) | 4063 (4064) | 0.35% | 0.01% | 0.019 | 0.00% | 6.83 |
| terrain | each level from LOD0 | 2 (25%, 1%) | 2031 (2032) | 0.71% | 0.01% | 0.014 | 0.00% |  |
| terrain | each level from LOD0 | 3 (12.5%, 2%) | 1015 (1016) | 1.41% | 0.03% | 0.019 | 0.00% |  |
| terrain | chained | 1 (50%, 0.5%) | 4063 (4064) | 0.35% | 0.01% | 0.019 | 0.00% | 4.11 |
| terrain | chained | 2 (25%, 1%) | 2032 (2032) | 0.71% | 0.01% | 0.019 | 0.00% |  |
| terrain | chained | 3 (12.5%, 2%) | 1016 (1016) | 1.41% | 0.02% | 0.015 | 0.00% |  |

### Flags: LockBorder, Permissive, Prune, Regularize (ratio 12.5 %, error limit 2 %)

| model | mode | flags | tris (target) | meshopt err | Hausdorff max | new open edges | border edges after/before |
|---|---|---|---|---|---|---|---|
| rock | pos | none | 2560 (2560) | 0.92% | 1.00% | 0 |  |
| rock | pos | LockBorder | 2560 (2560) | 0.92% | 1.00% | 0 |  |
| rock | pos | Permissive | 2560 (2560) | 0.91% | 0.96% | 0 |  |
| rock | pos | Prune | 2560 (2560) | 0.92% | 1.00% | 0 |  |
| rock | pos | Regularize | 2560 (2560) | 1.46% | 1.05% | 0 |  |
| rock | pos | Permissive+Prune | 2560 (2560) | 0.91% | 0.96% | 0 |  |
| rock | attr | none | 4766 (2560) | 1.99% | 1.21% | 0 |  |
| rock | attr | LockBorder | 4766 (2560) | 1.99% | 1.21% | 0 |  |
| rock | attr | Permissive | 4750 (2560) | 1.99% | 1.21% | 0 |  |
| rock | attr | Prune | 4766 (2560) | 1.99% | 1.21% | 0 |  |
| rock | attr | Regularize | 5156 (2560) | 1.99% | 1.21% | 0 |  |
| rock | attr | Permissive+Prune | 4750 (2560) | 1.99% | 1.21% | 0 |  |
| tree | pos | none | 1966 (1966) | 1.23% | 1.39% | 0 |  |
| tree | pos | LockBorder | 1966 (1966) | 1.23% | 1.39% | 0 |  |
| tree | pos | Permissive | 1966 (1966) | 1.20% | 1.47% | 0 |  |
| tree | pos | Prune | 1966 (1966) | 1.23% | 1.39% | 0 |  |
| tree | pos | Regularize | 1966 (1966) | 1.60% | 1.68% | 0 |  |
| tree | pos | Permissive+Prune | 1966 (1966) | 1.20% | 1.47% | 0 |  |
| tree | attr | none | 4486 (1966) | 1.99% | 1.49% | 0 |  |
| tree | attr | LockBorder | 4486 (1966) | 1.99% | 1.49% | 0 |  |
| tree | attr | Permissive | 4470 (1966) | 1.99% | 1.49% | 0 |  |
| tree | attr | Prune | 4486 (1966) | 1.99% | 1.49% | 0 |  |
| tree | attr | Regularize | 4754 (1966) | 1.99% | 1.57% | 0 |  |
| tree | attr | Permissive+Prune | 4470 (1966) | 1.99% | 1.49% | 0 |  |
| building | pos | none | 6522 (1301) | 0.04% | 0.00% | -108 | 20 / 128 |
| building | pos | LockBorder | 6624 (1301) | 0.04% | 0.00% | 0 | 128 / 128 |
| building | pos | Permissive | 1301 (1301) | 1.35% | 1.03% | -105 | 23 / 128 |
| building | pos | Prune | 6522 (1301) | 0.04% | 0.00% | -108 | 20 / 128 |
| building | pos | Regularize | 6488 (1301) | 1.33% | 0.00% | -116 | 12 / 128 |
| building | pos | Permissive+Prune | 1301 (1301) | 1.35% | 1.03% | -105 | 23 / 128 |
| building | attr | none | 6554 (1301) | 0.04% | 0.00% | -114 | 14 / 128 |
| building | attr | LockBorder | 6656 (1301) | 0.04% | 0.00% | 0 | 128 / 128 |
| building | attr | Permissive | 6551 (1301) | 0.04% | 0.00% | -113 | 15 / 128 |
| building | attr | Prune | 6554 (1301) | 0.04% | 0.00% | -114 | 14 / 128 |
| building | attr | Regularize | 6488 (1301) | 1.33% | 0.00% | -116 | 12 / 128 |
| building | attr | Permissive+Prune | 6551 (1301) | 0.04% | 0.00% | -113 | 15 / 128 |
| terrain | pos | none | 1015 (1016) | 0.02% | 0.03% | -255 | 25 / 280 |
| terrain | pos | LockBorder | 1016 (1016) | 0.03% | 0.04% | 0 | 280 / 280 |
| terrain | pos | Permissive | 1015 (1016) | 0.02% | 0.03% | -255 | 25 / 280 |
| terrain | pos | Prune | 1015 (1016) | 0.02% | 0.03% | -255 | 25 / 280 |
| terrain | pos | Regularize | 1015 (1016) | 1.00% | 0.17% | -231 | 49 / 280 |
| terrain | pos | Permissive+Prune | 1015 (1016) | 0.02% | 0.03% | -255 | 25 / 280 |
| terrain | attr | none | 1015 (1016) | 0.04% | 0.05% | -261 | 19 / 280 |
| terrain | attr | LockBorder | 1016 (1016) | 0.07% | 0.07% | 0 | 280 / 280 |
| terrain | attr | Permissive | 1015 (1016) | 0.04% | 0.05% | -261 | 19 / 280 |
| terrain | attr | Prune | 1015 (1016) | 0.04% | 0.05% | -261 | 19 / 280 |
| terrain | attr | Regularize | 1015 (1016) | 0.98% | 0.18% | -235 | 45 / 280 |
| terrain | attr | Permissive+Prune | 1015 (1016) | 0.04% | 0.05% | -261 | 19 / 280 |
| ship | pos | none | 426 (59) | 1.61% | 1.75% | 0 | 6 / 6 |
| ship | pos | LockBorder | 426 (59) | 1.61% | 1.75% | 0 | 6 / 6 |
| ship | pos | Permissive | 137 (59) | 1.97% | 9.41% | -3 | 3 / 6 |
| ship | pos | Prune | 426 (59) | 1.61% | 1.75% | 0 | 6 / 6 |
| ship | pos | Regularize | 426 (59) | 1.77% | 1.75% | 0 | 6 / 6 |
| ship | pos | Permissive+Prune | 137 (59) | 1.97% | 9.41% | -3 | 3 / 6 |
| ship | attr | none | 428 (59) | 0.03% | 0.00% | 0 | 6 / 6 |
| ship | attr | LockBorder | 428 (59) | 0.03% | 0.00% | 0 | 6 / 6 |
| ship | attr | Permissive | 424 (59) | 0.03% | 9.40% | 0 | 6 / 6 |
| ship | attr | Prune | 428 (59) | 0.03% | 0.00% | 0 | 6 / 6 |
| ship | attr | Regularize | 428 (59) | 0.51% | 0.00% | 0 | 6 / 6 |
| ship | attr | Permissive+Prune | 424 (59) | 0.03% | 9.40% | 0 | 6 / 6 |

* `LockBorder` keeps the open border exactly (terrain 280 of 280 border edges, border displacement 0) at about 1.5x the geometric error; on closed meshes it changes nothing. Without it terrain's border collapses from 280 to 25 edges.
* `Permissive` is the flag that lets hard-edged and seam-heavy meshes reach their target (building pos 6522 -> 1301 triangles). In attr mode the normal weight protects hard edges again, so it did not help there under a 2 % limit.
* `Prune` did nothing on these meshes under a 2 % limit. With **no** limit (error 1.0 = 100 %) it deleted the entire building (0 triangles; observed during development with `simplify` at a 12.5 % target, not in `results.json`), so it needs a real limit.
* `Regularize` costs geometric error (rock 1.00 % -> 1.05 % max, meshopt error 0.92 % -> 1.46 %) for more even triangles.

### Submesh boundaries (ratio 25 %, attr mode)

| model | strategy | shared verts | tris (target) | per-group ratio min..max | Hausdorff max | new open edges (cracks) |
|---|---|---|---|---|---|---|
| tree | whole mesh, one index range (materials lost) | 0 | 3932 (3932) | n/a (materials lost) | 1.76% | 0 |
| tree | per submesh, no lock | 0 | 3932 (3932) | 0.25..0.25 | 1.76% | 0 |
| tree | per submesh + LockBorder flag | 0 | 3932 (3932) | 0.25..0.25 | 1.76% | 0 |
| tree | per submesh + vertex_lock on shared vertices | 0 | 3932 (3932) | 0.25..0.25 | 1.76% | 0 |
| FlightHelmet | whole mesh, one index range (materials lost) | 0 | 23676 (23681) | n/a (materials lost) | 0.47% | -212 |
| FlightHelmet | per submesh, no lock | 0 | 23678 (23681) | 0.25..0.25 | 0.42% | -206 |
| FlightHelmet | per submesh + LockBorder flag | 0 | 23680 (23681) | 0.25..0.25 | 0.47% | 0 |
| FlightHelmet | per submesh + vertex_lock on shared vertices | 0 | 23678 (23681) | 0.25..0.25 | 0.42% | -206 |
| Lantern | whole mesh, one index range (materials lost) | 0 | 1340 (1349) | n/a (materials lost) | 2.82% | -32 |
| Lantern | per submesh, no lock | 0 | 1396 (1349) | 0.25..0.3 | 18.32% | -24 |
| Lantern | per submesh + LockBorder flag | 0 | 1396 (1349) | 0.25..0.3 | 18.32% | 0 |
| Lantern | per submesh + vertex_lock on shared vertices | 0 | 1396 (1349) | 0.25..0.3 | 18.32% | -24 |
| ship | whole mesh, one index range (materials lost) | 0 | 422 (116) | n/a (materials lost) | 9.40% | 0 |
| ship | per submesh, no lock | 0 | 420 (116) | 0.83..1 | 9.40% | 0 |
| ship | per submesh + LockBorder flag | 0 | 420 (116) | 0.83..1 | 9.40% | 0 |
| ship | per submesh + vertex_lock on shared vertices | 0 | 420 (116) | 0.83..1 | 9.40% | 0 |
| rock2mat | whole mesh, one index range (materials lost) | 226 | 5120 (5120) | n/a (materials lost) | 1.21% | 0 |
| rock2mat | per submesh, no lock | 226 | 5120 (5120) | 0.25..0.25 | 1.26% | 166 |
| rock2mat | per submesh + LockBorder flag | 226 | 5118 (5120) | 0.25..0.25 | 1.26% | 0 |
| rock2mat | per submesh + vertex_lock on shared vertices | 226 | 5118 (5120) | 0.25..0.25 | 1.26% | 0 |

`rock2mat` is the controlled case (two material groups sharing 226 boundary vertices): simplifying each group independently opens 166 cracks; `LockBorder` (per group) or `vertex_lock` on vertices used by more than one group gives 0. Disjoint groups (tree) are unaffected. Whole-mesh simplification has no cracks but returns one index range, so material assignment is lost.

### Seams, split normals and welding (ratio 12.5 %, positions only unless stated)

Variants: **never welded** = fully de-indexed triangle soup; **raw** = vertices as imported; **welded** = bit-identical vertices merged (the default pipeline); **position weld** = vertices merged by position only, attributes dropped (an upper bound for what a "weld positions, remap back" scheme could reach; it is not usable as is because attributes cannot be recovered). "building (T-junctions)" is the same building without conforming edges.

| model | input variant | verts | tris in | tris out (target = 12.5%) | Hausdorff max | normal dev mean (deg) | UV dev mean / p95 | open-edge change |
|---|---|---|---|---|---|---|---|---|
| rock | never welded (de-indexed soup) | 61440 | 20480 | 20480 (2560) | 0.00% |  |  | 0 |
| rock | as imported (raw) | 10337 | 20480 | 2560 (2560) | 1.00% |  |  | 0 |
| rock | welded, seams kept (default) | 10337 | 20480 | 2560 (2560) | 1.00% | 19 | 0.0036 / 0.005 | 0 |
| rock | welded + Permissive | 10337 | 20480 | 2560 (2560) | 0.96% | 18.9 | 0.0036 / 0.005 | 0 |
| rock | welded + Permissive, normals+uv weighted (attr mode) | 10337 | 20480 | 2560 (2560) | 1.61% | 11.8 | 0.004 / 0.0066 | 0 |
| rock | welded, attributes ignored by position weld (no remap back) | 10242 | 20480 | 2560 (2560) | 1.00% |  |  | 0 |
| building | never welded (de-indexed soup) | 31212 | 10404 | 10404 (1301) | 0.00% |  |  | 0 |
| building | as imported (raw) | 20808 | 10404 | 10404 (1301) | 0.00% |  |  | 0 |
| building | welded, seams kept (default) | 11912 | 10404 | 6522 (1301) | 0.00% | 0.006 | 6.7e-5 / 1.6e-8 | -108 |
| building | welded + Permissive | 11912 | 10404 | 1301 (1301) | 1.03% | 30.5 | 0.26 / 0.83 | -105 |
| building | welded + Permissive, normals+uv weighted (attr mode) | 11912 | 10404 | 1301 (1301) | 0.49% | 15 | 0.19 / 0.72 | -119 |
| building | welded, attributes ignored by position weld (no remap back) | 5260 | 10404 | 1300 (1301) | 0.49% |  |  | -98 |
| DamagedHelmet | never welded (de-indexed soup) | 46356 | 15452 | 15411 (1932) | 0.90% |  |  | -45 |
| DamagedHelmet | as imported (raw) | 14556 | 15452 | 3228 (1932) | 6.78% |  |  | -1332 |
| DamagedHelmet | welded, seams kept (default) | 14356 | 15452 | 3187 (1932) | 9.52% | 25.3 | 0.14 / 0.69 | -1347 |
| DamagedHelmet | welded + Permissive | 14356 | 15452 | 1931 (1932) | 1.47% | 14.7 | 0.1 / 0.56 | -1187 |
| DamagedHelmet | welded + Permissive, normals+uv weighted (attr mode) | 14356 | 15452 | 1931 (1932) | 2.17% | 13.1 | 0.08 / 0.58 | -1403 |
| DamagedHelmet | welded, attributes ignored by position weld (no remap back) | 8661 | 15452 | 1932 (1932) | 1.01% |  |  | -1194 |
| Fox | never welded (de-indexed soup) | 1728 | 576 | 576 (72) | 0.00% |  |  | 0 |
| Fox | as imported (raw) | 1728 | 576 | 576 (72) | 0.00% |  |  | 0 |
| Fox | welded, seams kept (default) | 434 | 576 | 150 (72) | 11.32% | 51.9 | 0.09 / 0.44 | 0 |
| Fox | welded + Permissive | 434 | 576 | 116 (72) | 53.70% | 81.1 | 0.2 / 0.52 | 0 |
| Fox | welded + Permissive, normals+uv weighted (attr mode) | 434 | 576 | 114 (72) | 57.15% | 38.8 | 0.17 / 0.42 | 0 |
| Fox | welded, attributes ignored by position weld (no remap back) | 290 | 576 | 122 (72) | 53.70% |  |  | 0 |
| building (T-junctions) | never welded (de-indexed soup) | 21612 | 7204 | 7204 (901) | 0.00% |  |  | 0 |
| building (T-junctions) | as imported (raw) | 11072 | 7204 | 6416 (901) | 0.00% | 0.006 | 6.7e-5 / 8.1e-9 | -48 |
| building (T-junctions) | welded, seams kept (default) | 11072 | 7204 | 6416 (901) | 0.00% | 0.006 | 6.7e-5 / 8.1e-9 | -48 |
| building (T-junctions) | welded + Permissive | 11072 | 7204 | 901 (901) | 1.59% | 17.6 | 0.2 / 0.82 | -3191 |
| building (T-junctions) | welded + Permissive, normals+uv weighted (attr mode) | 11072 | 7204 | 900 (901) | 2.37% | 15.6 | 0.18 / 0.73 | -2896 |
| building (T-junctions) | welded, attributes ignored by position weld (no remap back) | 4420 | 7204 | 1616 (901) | 0.49% |  |  | -3248 |

* The simplifier needs the vertex buffer to be welded (identical vertices share an index): soups and the building's per-quad vertices are not simplified at all.
* After welding, split normals and UV seams are handled by the simplifier itself: no new open edges on closed meshes (rock, with a UV seam, 0), so **no position remap is needed to avoid cracks**. The price is reach: seams are locked unless `Permissive` is set (helmet: 3187 triangles vs the 1932 target, Hausdorff 9.5 %; with `Permissive` 1931 triangles at 1.5 %, with lower normal and UV deviation).
* Position-only welding reaches the target everywhere except where the geometry itself blocks it, but loses the attributes.

### Sloppy proxies (occluders), each from LOD0

| model | target | tris (target) | meshopt err | Hausdorff max (S->O / O->S) | Hausdorff mean | normal dev mean (deg) | UV dev mean |
|---|---|---|---|---|---|---|---|
| rock | 5.00% | 889 (1024) | 2.54% | 2.90% / 2.87% | 0.47% | 27.9 | 0.024 |
| rock | 2.00% | 287 (410) | 4.43% | 4.68% / 5.37% | 0.91% | 37.5 | 0.031 |
| tree | 5.00% | 682 (786) | 4.37% | 4.12% / 3.88% | 0.69% | 42.3 | 0.092 |
| tree | 2.00% | 266 (315) | 4.89% | 3.94% / 16.94% | 1.61% | 51 | 0.1 |
| building | 5.00% | 488 (520) | 2.19% | 0.60% / 1.67% | 0.23% | 34.6 | 0.33 |
| building | 2.00% | 200 (208) | 2.52% | 0.95% / 1.75% | 0.31% | 35.9 | 0.34 |
| DamagedHelmet | 5.00% | 632 (773) | 6.59% | 3.91% / 5.70% | 0.78% | 45.4 | 0.27 |
| DamagedHelmet | 2.00% | 247 (309) | 5.81% | 4.38% / 10.64% | 1.41% | 50.4 | 0.33 |
| FlightHelmet | 5.00% | 4050 (4736) | 1.84% | 1.78% / 4.54% | 0.31% | 43.8 | 0.17 |
| FlightHelmet | 2.00% | 1541 (1894) | 2.54% | 2.37% / 10.88% | 0.59% | 56.5 | 0.22 |
| Lantern | 5.00% | 265 (270) | 1.89% | 2.22% / 4.87% | 0.27% | 54.1 | 0.21 |
| Lantern | 2.00% | 75 (108) | 6.38% | 4.42% / 10.61% | 1.63% | 61.8 | 0.25 |
| Avocado | 5.00% | 34 (34) | 7.59% | 6.30% / 10.63% | 2.04% | 16.8 | 0.15 |
| Avocado | 2.00% | 4 (14) | 15.70% | 10.46% / 19.44% | 9.66% | 96.9 | 0.49 |
| Sponza | 5.00% | 11085 (13113) | 0.61% | 0.46% / 1.58% | 0.04% | 72.5 | 4.5 |
| Sponza | 2.00% | 4116 (5245) | 1.36% | 0.80% / 3.29% | 0.06% | 72.4 | 4.6 |
| CesiumMan | 5.00% | 186 (234) | 3.64% | 2.66% / 9.25% | 0.80% | 30 | 0.12 |
| CesiumMan | 2.00% | 72 (93) | 3.52% | 3.19% / 14.26% | 1.56% | 35.2 | 0.18 |
| Fox | 5.00% | 12 (29) | 9.64% | 5.85% / 32.40% | 6.47% | 60.7 | 0.14 |
| Fox | 2.00% | 0 (12) | 100.00% | - / - | - | - | - |
| terrain | 5.00% | 390 (406) | 0.15% | 0.79% / 3.13% | 0.17% | 1.01 | 0 |
| terrain | 2.00% | 162 (163) | 0.23% | 3.02% / 3.98% | 0.23% | 1.37 | 0 |
| ship | 5.00% | 0 (23) | 100.00% | - / - | - | - | - |
| ship | 2.00% | 0 (9) | 100.00% | - / - | - | - | - |

At 5 % it reaches 79-100 % of the target (Fox 41 %) with 0.5-6 % max Hausdorff, which is fine for occluders; at 2 % tiny meshes collapse (ship and Fox to 0 triangles, Avocado keeps 4), so a floor of a few dozen triangles is needed. Normals and UVs are meaningless on these meshes (17-72 degrees mean normal deviation).

## 4. Screen-space meaning of the error

Let `D` be the object's bounding-box diagonal and `e` the error as a fraction of `D`. If the object covers a fraction `h` of the viewport height (taking its projected size as `h * H`, `H = 1080` px), a world-space error `e * D` projects to

```
error_px = e * h * H          (independent of FOV and distance)
LOD usable for h <= tol_px / (e * H)
```

For `e` relative to meshopt's `getScale` (max bbox extent), first multiply by `maxExtent / diag` (0.59-0.8 here). Unity's LODGroup defines its screen-relative height from the renderer bounds' size; whether that is the largest extent or the diagonal [U] changes `h` by up to x1.7, so calibrate against the engine's own definition.

| error (fraction of mesh size D) | px of error when object fills the viewport height (1080p) | LOD can be used below screen height (1 px tolerance) | ... (2 px tolerance) |
|---|---|---|---|
| 0.05% | 0.54 | >= 1 (always) | >= 1 (always) |
| 0.10% | 1.08 | 0.926 | >= 1 (always) |
| 0.20% | 2.16 | 0.463 | 0.926 |
| 0.50% | 5.4 | 0.185 | 0.37 |
| 1.00% | 10.8 | 0.0926 | 0.185 |
| 2.00% | 21.6 | 0.0463 | 0.0926 |
| 5.00% | 54 | 0.0185 | 0.037 |

Transition heights derived from the **measured max Hausdorff** (diagonal fraction) of each attr-chain level, 1 px / 2 px tolerance (`1` = visually lossless at any size, error below 0.1 px):

| model | LOD1 (50%) | LOD2 (25%) | LOD3 (12.5%) |
|---|---|---|---|
| rock | err 0.62% -> 0.15 / 0.3 | err 1.00% -> 0.092 / 0.18 | err 1.65% -> 0.056 / 0.11 |
| tree | err 1.02% -> 0.091 / 0.18 | err 1.96% -> 0.047 / 0.095 | err 2.60% -> 0.036 / 0.071 |
| building | err 0.00% -> 1 / 1 | err 0.00% -> 1 / 1 | err 0.00% -> 1 / 1 |
| DamagedHelmet | err 0.42% -> 0.22 / 0.44 | err 3.51% -> 0.026 / 0.053 | err 9.52% -> 0.0097 / 0.019 |
| FlightHelmet | err 0.22% -> 0.42 / 0.84 | err 0.46% -> 0.2 / 0.4 | err 1.02% -> 0.091 / 0.18 |
| Lantern | err 3.26% -> 0.028 / 0.057 | err 18.32% -> 0.0051 / 0.01 | err 18.32% -> 0.0051 / 0.01 |
| Avocado | err 1.02% -> 0.091 / 0.18 | err 2.02% -> 0.046 / 0.092 | err 5.19% -> 0.018 / 0.036 |
| Sponza | err 3.35% -> 0.028 / 0.055 | err 5.90% -> 0.016 / 0.031 | err 6.17% -> 0.015 / 0.03 |
| CesiumMan | err 0.41% -> 0.22 / 0.45 | err 0.88% -> 0.1 / 0.21 | err 14.89% -> 0.0062 / 0.012 |
| Fox | err 3.56% -> 0.026 / 0.052 | err 11.32% -> 0.0082 / 0.016 | err 11.32% -> 0.0082 / 0.016 |
| terrain | err 0.01% -> 1 / 1 | err 0.01% -> 1 / 1 | err 0.04% -> 1 / 1 |
| ship | err 9.40% -> 0.0099 / 0.02 | err 9.40% -> 0.0099 / 0.02 | err 9.40% -> 0.0099 / 0.02 |

Typical 1 px results: LOD1 (50 %) switches in below about 0.15-0.4 of the screen height, LOD2 below 0.05-0.2, LOD3 below 0.04-0.09; meshes with large forced error (helmet LOD3 9.5 %, Lantern 18 %) would only be valid below 1 % height, i.e. in practice not usable, which is exactly why those levels should be cut by an error limit instead of a ratio.

## 5. Vertex cache/fetch optimisation and storage

Optimisation cost (4 levels, `reorderMesh` per level, material ranges kept contiguous by optimising each submesh separately) is the "cache+fetch opt" column of the speed tables. Resulting ACMR (FIFO cache of 16, see the LOD3 column below) goes from 1.0-1.5 to 0.66-0.78 on smooth meshes; hard-edged meshes with per-quad vertices stay at 1.3-1.6 (building 1.55) because vertices cannot be shared.

Sizes: float32 vertex = 32 B (position, normal, UV; 56 B skinned), uint16 indices when the vertex count fits else uint32; the "16 B quantised" columns assume position 3x u16 (+pad), normal snorm8x4, UV u16x2 (est. layout, not an engine decision). Levels = LOD0 + 50/25/12.5 % (attr chain). "Separate" = each level has its own compact, optimised VB+IB. "Shared" = one VB (LOD0 order), per-level IB only.

| model | tris | verts | LOD0 only (KiB) | separate VB+IB per level | shared VB (LOD0 order) + IB per level | ratio separate / shared (32 B vtx) | ratio separate / shared (16 B quantised vtx) |
|---|---|---|---|---|---|---|---|
| rock | 20480 | 10337 | 443 | 833 KiB (x1.88) | 548 KiB (x1.24) | 1.88 / 1.24 | 1.88 / 1.37 |
| tree | 15728 | 8099 | 345 | 653 KiB (x1.89) | 426 KiB (x1.23) | 1.89 / 1.23 | 1.89 / 1.37 |
| building | 10404 | 11912 | 433 | 1461 KiB (x3.37) | 548 KiB (x1.26) | 3.37 / 1.26 | 3.31 / 1.47 |
| DamagedHelmet | 15452 | 14356 | 539 | 1210 KiB (x2.24) | 626 KiB (x1.16) | 2.24 / 1.16 | 2.2 / 1.27 |
| FlightHelmet | 94722 | 55392 | 2286 | 4461 KiB (x1.95) | 2772 KiB (x1.21) | 1.95 / 1.21 | 1.94 / 1.34 |
| Lantern | 5394 | 4143 | 161 | 351 KiB (x2.18) | 190 KiB (x1.18) | 2.18 / 1.18 | 2.14 / 1.3 |
| Avocado | 682 | 406 | 17 | 32 KiB (x1.91) | 20 KiB (x1.21) | 1.91 / 1.21 | 1.9 / 1.34 |
| Sponza | 262267 | 167291 | 8301 | 18997 KiB (x2.29) | 12511 KiB (x1.51) | 2.29 / 1.51 | 2.26 / 1.74 |
| CesiumMan | 4672 | 3273 | 206 | 432 KiB (x2.09) | 230 KiB (x1.12) | 2.09 / 1.12 | 2.06 / 1.23 |
| Fox | 576 | 434 | 27 | 59 KiB (x2.18) | 31 KiB (x1.13) | 2.18 / 1.13 | 2.16 / 1.25 |
| terrain | 8128 | 4204 | 179 | 334 KiB (x1.86) | 221 KiB (x1.23) | 1.86 / 1.23 | 1.87 / 1.37 |
| ship | 464 | 953 | 33 | 126 KiB (x3.88) | 40 KiB (x1.23) | 3.88 / 1.23 | 3.87 / 1.42 |

Locality: LRU cache-line misses (128 lines of 64 B, vertices fetched in index order). "Coarsest-first" = same shared VB with vertices sorted by the last (coarsest) level that uses them, so each level's vertices form a prefix.

| model | verts used by LOD3 | LOD3 LRU line misses, own VB | shared VB, LOD0 order | shared VB, coarsest-first order | LOD3 distinct 64 B lines: shared / coarsest-first / minimum | ACMR before -> after (LOD3) | LOD0 misses: own vs coarsest-first VB | LOD1 misses own / shared / coarsest-first |
|---|---|---|---|---|---|---|---|---|
| rock | 1309 | 742 | 1418 (x1.91) | 760 (x1.02) | 1266 / 655 / 655 | 1.031 -> 0.6668 | 6248 vs 6250 | 3121 / 4544 / 3378 |
| tree | 1064 | 532 | 1031 (x1.94) | 532 (x1.00) | 1009 / 532 / 532 | 1.099 -> 0.6648 | 4811 vs 4821 | 2271 / 3359 / 2381 |
| building | 9736 | 4923 | 5578 (x1.13) | 4940 (x1.00) | 5490 / 4868 / 4868 | 1.757 -> 1.552 | 6439 vs 6541 | 4922 / 5572 / 4938 |
| DamagedHelmet | 4821 | 2411 | 3428 (x1.42) | 2411 (x1.00) | 3427 / 2411 / 2411 | 1.572 -> 1.511 | 7284 vs 7291 | 4247 / 5744 / 4253 |
| FlightHelmet | 8548 | 4310 | 7652 (x1.78) | 4314 (x1.00) | 7584 / 4274 / 4274 | 1.222 -> 0.7826 | 32124 vs 32062 | 15758 / 21676 / 16121 |
| Lantern | 1151 | 576 | 860 (x1.49) | 576 (x1.00) | 860 / 576 / 576 | 1.419 -> 1.29 | 2085 vs 2081 | 1226 / 1591 / 1227 |
| Avocado | 58 | 29 | 53 (x1.83) | 29 (x1.00) | 53 / 29 / 29 | 1.024 -> 0.7381 | 203 vs 203 | 103 / 159 / 103 |
| Sponza | 61009 | 36234 | 42826 (x1.18) | 36480 (x1.01) | 36463 / 30505 / 30505 | 0.8836 -> 0.7963 | 92677 vs 92368 | 54223 / 66823 / 54867 |
| CesiumMan | 717 | 628 | 881 (x1.40) | 641 (x1.02) | 861 / 628 / 628 | 2.627 -> 1.327 | 3115 vs 3121 | 1692 / 2239 / 1763 |
| Fox | 137 | 120 | 178 (x1.48) | 120 (x1.00) | 178 / 120 / 120 | 2.087 -> 0.92 | 380 vs 381 | 217 / 305 / 222 |
| terrain | 516 | 300 | 504 (x1.68) | 308 (x1.03) | 446 / 258 / 258 | 1.461 -> 0.6614 | 2885 vs 2862 | 1193 / 1752 / 1259 |
| ship | 919 | 460 | 469 (x1.02) | 460 (x1.00) | 469 / 460 / 460 | 2.188 -> 2.188 | 477 vs 478 | 460 / 469 / 460 |

All levels together cost x1.1-1.3 of LOD0 with a shared VB (Sponza x1.5 because its levels barely reduce) against x1.9-2.3 with separate buffers. A shared VB in LOD0 order makes the coarsest level incur 1.1-1.9x the cache-line misses of its own VB (ship 1.02, hard-edged building 1.13); coarsest-first ordering brings that back to x1.00-1.03 at no size cost, and LOD0 itself loses nothing (misses within +/-2 %). Mid levels (LOD1) are 0-8 % above their own VB. Not measured: lossless vertex/index compression (`encodeVertexBuffer` etc.) on top, and any GPU timing [U].

## 6. Skinned meshes

CesiumMan (19 joints) and Fox (24 joints). Joints and weights are per-vertex data that stay valid when only the index buffer changes (`simplify`, `simplifyWithAttributes` without update), so "carry through" is correct by construction; the test checks it and compares geometric error in the bind pose and under three seeded random poses (each joint rotated up to 35 degrees about its bind-pose origin, linear blend skinning, `lib/skin.mjs`; no joint hierarchy, mesh node transform ignored [U: how representative of real animation]). Variants: positions only; normals+UV; normals+UV+4 skin weights as extra attributes (weight 1.0); the same with `Regularize`.

| model | ratio | variant | tris | bad joint idx | weight sums != 1 | bind-pose Hausdorff max / mean | posed (3 random poses) Hausdorff max / mean |
|---|---|---|---|---|---|---|---|
| CesiumMan | 0.25 | positions only (carry joints/weights through the index buffer) | 1168 | 0 | 0 | 0.48% / 0.06% | 2.23% / 0.16% |
| CesiumMan | 0.25 | normals+uv attributes (carry skin data) | 1168 | 0 | 0 | 1.18% / 0.08% | 2.05% / 0.16% |
| CesiumMan | 0.25 | normals+uv+skin weights as attributes | 1168 | 0 | 0 | 1.80% / 0.20% | 1.87% / 0.22% |
| CesiumMan | 0.25 | normals+uv+skin weights, Regularize | 1168 | 0 | 0 | 1.84% / 0.22% | 1.86% / 0.23% |
| CesiumMan | 0.125 | positions only (carry joints/weights through the index buffer) | 592 | 0 | 0 | 34.02% / 7.53% | 34.98% / 7.45% |
| CesiumMan | 0.125 | normals+uv attributes (carry skin data) | 588 | 0 | 0 | 28.63% / 3.40% | 28.59% / 3.44% |
| CesiumMan | 0.125 | normals+uv+skin weights as attributes | 592 | 0 | 0 | 34.02% / 8.71% | 34.98% / 8.56% |
| CesiumMan | 0.125 | normals+uv+skin weights, Regularize | 582 | 0 | 0 | 28.63% / 4.25% | 28.59% / 4.28% |
| Fox | 0.25 | positions only (carry joints/weights through the index buffer) | 152 | 0 | 0 | 11.32% / 1.79% | 10.91% / 1.93% |
| Fox | 0.25 | normals+uv attributes (carry skin data) | 158 | 0 | 0 | 13.78% / 2.00% | 12.36% / 2.30% |
| Fox | 0.25 | normals+uv+skin weights as attributes | 154 | 0 | 0 | 11.32% / 1.49% | 10.82% / 2.07% |
| Fox | 0.25 | normals+uv+skin weights, Regularize | 154 | 0 | 0 | 11.32% / 1.60% | 10.82% / 2.14% |
| Fox | 0.125 | positions only (carry joints/weights through the index buffer) | 150 | 0 | 0 | 11.32% / 1.82% | 10.99% / 2.06% |
| Fox | 0.125 | normals+uv attributes (carry skin data) | 158 | 0 | 0 | 11.32% / 1.79% | 11.15% / 2.21% |
| Fox | 0.125 | normals+uv+skin weights as attributes | 154 | 0 | 0 | 13.78% / 2.14% | 12.47% / 2.43% |
| Fox | 0.125 | normals+uv+skin weights, Regularize | 156 | 0 | 0 | 13.78% / 1.80% | 12.14% / 2.25% |

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
