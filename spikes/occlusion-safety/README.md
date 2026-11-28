# Occlusion safety gate (ADR 0460 §3): do simplified occluders ever hide a visible object?

First-wave spike. Question: with the conservativeness rules of ADR 0460 §3, do coarse **stand-in** occluders (meshoptimizer levels and `simplifySloppy`) give **zero false occlusions** against a 1080p reference built from the **original** meshes, on adversarial scenes?

- Run: `node spikes/occlusion-safety/run.mjs` (about 3 min on 4 shared cores; `--quick` is about 1.5 min, every 6th camera frame). It writes `results.json` (all aggregates, per scene and per path, plus import-cost measurements) and `tables.md` (all tables). Counts are deterministic (checked twice, identical); only the import timings vary.
- Layout: `lib/geom.mjs` (procedural welded meshes), `lib/scenes.mjs` (scenes, occludees, camera paths), `lib/standins.mjs` (meshoptimizer 1.3.0 stand-ins, Hausdorff, per-triangle error; uses `../lod-simplify/lib/metrics.mjs` read-only), `build-scenes.mjs` (writes `out/scenes.bin`), `crates/safety` (Rust: setup with the rules, 1080p oracle, measurement loop; depends on `../occlusion-raster/crates/occ` by path, unmodified), `report.mjs`. `cargo test` checks that with every rule off the setup path gives the spike's depth buffer **bit for bit** (5 cameras x 2 resolutions, including near-plane and guard-band clipping), and that the rules only ever move depth away and shrink coverage.

## Method

- **Scenes** (all deterministic; 8 occluders, ~7,500 occludees, 26 camera paths x 30 frames = 780 frames, 567k in-frustum occludee-frames per cell):
  - `bldg`: three hollow buildings 14x8 m, 7-12 m high: window recesses, through windows at eye height, front doorways (1.1x2.2 m), side/back doors; 4.3k-7k triangles each. Paths: street, straight at a doorway, oblique to a doorway, low (0.4 m), high (14 m), far (75 m).
  - `walls`: thin wall 10x3x0.2 m, L-shaped wall, low wall 0.9 m (camera sees over it), all tessellated (580-980 tris). Paths: orbit, grazing, high, low, far, around and inside the L, over the low wall, crouching.
  - `hill`: 80x80 m heightfield, 12.8k tris, ridge at 5 m. Paths: walk up, low (0.4 m above ground), high, crest.
  - `beside`: one building; the camera walks 0.12-0.5 m beside the facade, crosses the **doorway threshold** in and out, and stands **inside** (sweeping 360 degrees at 1.7 m and 0.4 m).
  - Occludees: small boxes (0.2-1.6 m) scattered *around* every silhouette, doorway line of sight, window and low-wall edge, so every path has boxes that are just visible, just hidden, and far behind. Props inside rooms are visible through doors and windows.
- **Stand-ins** per occluder: `simp12` (`simplify` to 12.5 %, `Permissive`), `simp5` (chained from that to 5 %: the coarsest level), `sloppy5` (`simplifySloppy`, 5 % of the original), plus `orig` as a control (the original mesh through the same 256x128 pipeline: false occlusions there are the buffer's own resolution limit, not the stand-in's).
- **Error**: two-way Hausdorff over 15,000 surface + up to 15,000 vertex samples per direction (`lod-simplify` metrics, BVH), as a fraction of bbox diagonal.
- **Oracle** (stricter than the spike's rect oracle): the original meshes rasterised at 1920x1080, then each occludee box's own front faces rasterised against that buffer pixel by pixel: *visible iff any silhouette pixel is nearer*. A false occlusion = buffer says hidden, oracle sees at least one pixel. "(n)" in tables = cases with **at least 16 visible pixels at 1080p**; the rest are 1-8 pixel slivers.
- **Buffer**: the spike's depth buffer, centre sampling, test with 1 px rect dilation and 1e-3 depth epsilon, hierarchical test (the spike's accuracy configuration), 256x128 and 320x180.
- **Rules** (all implemented per camera and per frame): (b) every vertex pushed back by the error along the view ray (in clip space, so screen position is unchanged); (c) coverage shrink `max(0.25 px, projected error px)` on every triangle edge (the spike's `inner` metric, so 0.5 = whole pixel); (d) skip occluders whose bounds are within k x near (0.1 m) of the camera, or a fixed radius; (e) projected-min-width >= 2 buffer px.
- Culls kept = (buffer culls that the oracle agrees with) / (oracle culls), summed over all frames. Unsafe baseline (no rules) keeps 85-89 %.

## Results (256x128; 320x180 is within a few percent, see `tables.md`)

Cells: false occlusions (those with >= 16 visible 1080p pixels) / culls kept.

| rule set | orig | simp12 | simp5 (coarsest) | sloppy5 |
|---|---|---|---|---|
| (a) none | 1449 (896) / 88.6% | 1476 (919) / 88.6% | 22306 (21049) / 85.6% | 23912 (22790) / 78.9% |
| (b) push back by error | 1449 (896) / 88.6% | 1476 (919) / 88.6% | 21438 (20259) / 83.8% | 21909 (20879) / 76.5% |
| (c) shrink max(.25 px, E px), all edges | **0** / 11.5% | 2 (0) / 23.1% | 581 (577) / 10.6% | 36 (36) / 2.6% |
| (c') shrink 0.25 px constant | **0** / 11.5% | 4 (2) / 31.9% | 8609 (8536) / 42.9% | 10375 (10246) / 38.6% |
| (d) near 1x / 2x near (bounds) | 1433 (894) / 61.6% | 1433 (894) / 61.6% | 16587 (15370) / 59.0% | 18419 (17359) / 54.2% |
| (d) radius 1 m / 3 m (bounds) | 1381 / 55.9%, 1373 / 50.5% | same | 14668 / 54.1%, 12456 / 49.3% | 17291 / 50.4%, 15053 / 45.8% |
| (e) width >= 2 px | 1437 (888) / 88.6% | 1464 (911) / 88.6% | 22294 (21041) / 85.6% | 23900 (22782) / 78.9% |
| **FULL = b+c+d(2x near)+e (ADR as written)** | **0** / 6.6% | 2 (0) / 19.1% | **78 (76)** / 8.8% | **26 (26)** / 2.0% |
| FULL with d = 1 m | 0 / 3.8% | 2 (0) / 15.7% | 2 (0) / 8.3% | 5 (5) / 1.6% |
| FULL with d = 3 m | 0 / 2.5% | 0 / 13.0% | 2 (0) / 7.4% | 0 / 1.5% |
| FULL + grazing-aware push (e/max(cos,.2)) | 0 / 6.6% | 2 (0) / 19.1% | 78 (76) / 8.8% | 20 (20) / 2.0% |
| **FULL + hole trim 0.5 %** | 0 / 6.6% | 2 (0) / 19.1% | **2 (0)** / 13.1% | **2 (0)** / 5.0% |
| FULL + hole trim 1 % | 0 / 6.6% | 2 (0) / 19.1% | 2 (0) / 13.4% | 3 (0) / 7.8% |
| hole trim 0.5 % alone | 1449 / 88.6% | 1476 / 88.6% | 83 (53) / 48.0% | 111 (60) / 32.8% |
| (c) on silhouette edges only | 377 (142) / 84.8% | 355 (138) / 83.4% | 3088 (3036) / 50.3% | 40 (37) / 13.7% |
| PROPOSED: silhouette-only shrink max(.5 px,E) + trim 0.5 % + grazing push + per-triangle near 2x err + errors x2 | 179 (48) / 82.0% | 73 (5) / 79.3% | 6 (0) / 39.5% | 7 (1) / 14.6% |

The 2 remaining cases of "FULL + hole trim" are the same two 1-pixel slivers of `walls/thin-low` (camera 0.4 m high, a box visible by one 1080p pixel at the wall's edge; they exist for the exact mesh too in other rule sets). 320x180: FULL 79 (77) simp5, 27 (26) sloppy5; FULL + trim 0.5 %: 2 (0), 2 (0).

### Per scene, simp5, 256x128: false occlusions (>= 16 px) / culls kept

| rule set | bldg | walls | hill | beside |
|---|---|---|---|---|
| none | 13492 (12290) / 81% | 20 (11) / 84% | 63 (42) / 94% | 8731 (8706) / 87% |
| FULL (ADR) | 0 / 1.0% | 2 (0) / 39% | 0 / **0.0%** | **76 (76)** / 3.0% |
| FULL + trim 0.5 % | 0 / 8.1% | 2 (0) / 39% | 0 / 0.2% | 0 / 11.5% |
| per-triangle near + sil-only shrink + errors x2 | 0 / 13.9% | 5 (0) / 80% | 1 (0) / 65% | 0 / 18.1% |

Far path (`bldg/far`, 75 m): unsafe baseline keeps 52 % with 2700 false occlusions; FULL keeps 1 %, FULL + trim 2 %. Where the error projects to under a pixel the rules no longer cost much only for *exact* stand-ins (thin walls); window-riddled buildings stay near zero (see per-path tables in `tables.md`).

### Stand-in error and import cost (`tables.md` has every occluder)

| | 5.9k-tri building | 12.8k-tri terrain | 580-tri wall |
|---|---|---|---|
| `simp12` error (% diag) | 0.00 (planar collapse is exact) | 0.16 | 0.00 |
| `simp5` error | 3.4-5.3 (doorways and windows close) | 0.28 | 0.00 (exact box) |
| `sloppy5` error | 3.2-8.7 | 2.49 | 1.9 |
| Hausdorff, 15k+15k samples, two-way, incl. stand-in BVH | 170-360 ms | ~80 ms | 45-100 ms |
| per-triangle error pass for hole trim (spacing 0.5 % diag) | 1.0-3.8 s | 0.12 s | 0.1-0.3 s |
| 100k-sample re-measurement | within 3.2 % of the 15k value on all 24 stand-ins (largest: sloppy 4.74 vs 4.89 %) | | |

Per stand-in the Hausdorff measurement costs 0.05-0.36 s in JS (Node 22) on this machine, i.e. about 0.5-0.9 s for a window-riddled building with its three stand-ins (the 100k re-measurement is not counted); the hole-trim pass costs seconds per building [U: a wasm/Rust port would be about 10x faster, not measured]. The simplification itself is 2-11 ms per mesh for all three stand-ins together, so error measurement is the import cost. Sampled error is a sampled estimate; 100k samples agreed to 3 %.

## Findings

1. **Why exact stand-ins were "safe" before and coarse ones are not.** Two failure modes appear, both invisible to a Hausdorff-pushed-back-by-error rule:
   - *Closed holes.* `simp5` fills doorways and through windows (error 3-5 % of the diagonal, 0.6-0.9 m). Pushing depth back by 0.9 m does not help for a box 3 m behind the door, and the coverage shrink acts at silhouette edges, not inside a face. Everything visible through the doorway is falsely culled (`bldg/door`, `bldg/door-oblique`, `beside/threshold-in` are the worst paths with the rules off). Same for `sloppy5`.
   - *The near rule is too short.* 2 x near is 0.2 m, but the stand-in's error is 0.6-1.5 m: a camera 0.5 m beside a facade or on a doorway threshold sits *inside* the stand-in's error envelope. FULL leaves 76 material false occlusions in `beside/beside-into` and `threshold-in` (simp5) and 26 (sloppy5, also bldg/door). A 1 m radius fixes simp5 (2 slivers), 3 m fixes sloppy5 too, but any fixed radius is a guess; the principled radius is distance <= k x the occluder's own error.
2. **Cost: the rule set that is safe is nearly useless in these scenes.** Even for the *original* meshes FULL keeps only 6.6 % of the oracle's culls, because the (c) shrink is applied to every triangle edge: on a tessellated mesh the seams between triangles lose their coverage. With real stand-in error E of several pixels the whole triangle disappears. Silhouette-only shrink (interior edges between two front faces keep their coverage) restores 58-85 % of culls but is **not sound**: thin front-facing neighbours (window reveals, sub-pixel windows at distance) let a pixel centre inside a face claim a pixel whose far side holds visible interior (orig mesh: 179 false occlusions, 48 of 16+ px, even at shrink 0.5 px).
3. **Silhouette shift is not bounded by Hausdorff.** On the heightfield at grazing angles a stand-in within 0.3 m of the surface can move the silhouette further than the projected error (contour-generator shift about sqrt(2 R e) on a smooth ridge) [U: not derived rigorously]: with errors x1 `hill/low` leaked boxes with a median of 125 visible pixels (simp5). A safety factor of 2 on the errors removed it (11 -> 0 material for simp5); one 16+ px case remains for sloppy5 (`hill/crest`, 1 case) [U: factor 2 is empirical on four terrain paths].

## Verdict for ADR 0460

- **Does the full rule set reach zero false occlusions for coarsest-level stand-ins?** **No.** simp5, 256x128: 78 false occlusions (76 with >= 16 px), 76 of the 78 in `beside/beside-into` (48) and `beside/threshold-in` (28), i.e. camera beside the facade or on the doorway threshold; 79/77 at 320x180. For simp12 it is 2 one-pixel slivers (0 material); the exact-mesh control is 0. It reaches zero only in a degenerate way (6.6-19 % of culls kept for exact and simp12 stand-ins, 8.8 % for simp5).
- **Sloppy stand-ins?** **No, and drop them.** 26 false occlusions (all >= 16 px) under the full rules, in `bldg/door` (5) and `beside/beside-into` (21) at 256x128; errors are 2-8.7 % of the diagonal (larger than simp5), they close every opening, and after the fixes below they keep only 5 % of the oracle's culls versus 13 % for simp5. Models without levels should get no stand-in (or an authored one); `occluder: "auto"` should not fall back to sloppy.
- **Extra rules that fix it (zero material false occlusions on all stand-in types, both resolutions; only 1-pixel slivers remain):**
  1. **Hole trimming at import**: measure the error *per stand-in triangle* (forward direction, lattice spacing <= 0.5 % of the bbox diagonal so a hole twice the tolerance cannot hide between samples), drop triangles whose error exceeds 0.5 % of the diagonal, and use each remaining triangle's own error for push and shrink. This is what makes coarse levels safe: FULL 78 -> 2 (0 material) for simp5 and 26 -> 2 (0) for sloppy.
  2. **Error-scaled near rule**: skip an occluder (better: a triangle) when the camera is within near + 2 x its error, not a fixed 2 x near. Per-triangle distance also stops the terrain being switched off: the bounds rule skips the heightfield *always* (the camera is inside its bounds), killing every `hill` cull (0.0 % kept); the per-triangle rule keeps 65 % there.
  3. **A safety factor of 2 on the errors** where silhouettes can graze (terrain), see finding 3.
- **Cost in culls of the safe set:** versus the unsafe baseline (85-89 % of oracle culls) the sound version (FULL + trim) keeps 13 % (simp5) / 5 % (sloppy) / 19 % (simp12). The cheaper, *unsound* silhouette-shrink variant (PROPOSED, last table row) keeps 40 % (simp5) / 79 % (simp12) / 15 % (sloppy) with 0 / 5 / 1 material false occlusions, and 48 for the exact mesh, so it is not a fix. The cost comes mainly from the all-edge shrink on tessellated stand-ins and from stand-ins that lose their windows to trimming, not from the width test (free) or the depth push (1-2 points).
- **Recommended ADR change.** (1) Replace "within the near distance" by "within max(near, 2 x error)", per triangle or per sub-bounds; never per whole terrain. (2) Add import-time hole trimming and gate each level on it, so a level is accepted only if enough of it survives (coarsest level of a window-riddled building does not; simp12 does). (3) Treat the 0.25 px floor as insufficient: it is not conservative at silhouettes with thin neighbours; real inner-conservative coverage needs a union-aware rasteriser or occluders authored as inner (eroded) proxies [U: not built here]. (4) Keep the gate as a regression test: this spike's scenes, oracle and rules are the test, and a stand-in level or rule change must keep material false occlusions at zero.

## Caveats

- Near-field, adversarial: cameras are 0.1-15 m from occluders (plus two 60-75 m paths). Culls-kept numbers are worst cases for window-riddled geometry; with exact box stand-ins (the walls scene) the proposed set keeps 25-98 % per path. A city of simple boxes is not what this measures.
- "False occlusion" counts occludee-frames; 1-8 px cases are slivers at the oracle's own sampling limit (the oracle samples pixel centres at 1080p) and are listed but not treated as failures; "material" = >= 16 px is my threshold [U].
- Buffer parameters (dilate 1, eps 1e-3) are the spike's; dilation 2 helped the unsound variants only partly (see `tables.md`). 320x180 is not safer than 256x128 at equal rules.
- Wall times are secondary and from a shared machine; the measurement loop itself is not a performance claim.
