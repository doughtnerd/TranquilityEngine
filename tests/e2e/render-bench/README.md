# Render benchmark scenes

The scene generator behind `tests/e2e/render-bench.spec.ts` (ADRs 0446 and 0447): a forest (4,000 trees, 6,000 rocks) and a
city (576 buildings, 5,000 props), in `auto` and `thin` instancing variants. It is the deterministic generator of
`spikes/render-bench/` promoted: same seeds, same procedural meshes, same placement, so numbers stay comparable with the spike's.

Nothing here is committed as an asset. `scenes.ts` builds each project's files (project.json, materials, OBJ + MTL models, the
scene) in memory at test time and the spec passes them to `openEditor(page, { files })`.

| file | what |
| --- | --- |
| `geom.ts` | seeded noise and procedural geometry (spheres, cylinders, grid boxes), OBJ writer |
| `meshes.ts` | the tree, rock, building and prop meshes, and the material table |
| `scenes.ts` | the scenes, their variants (`BENCH_SCENES`) and their project files |

## Adding the LOD and occlusion variants

`scenes.ts` has `TODO(lod)` and `TODO(occlusion)` markers where they go: a `lod` flag on `Variant` (an `LODGroup` beside each
`MeshRenderer`, model sidecars with `lod` levels, the simplified `_lod1..3` OBJs), an `occlusion` flag, and the extra entries in
`BENCH_SCENES`. The spec needs no change: it measures whatever `BENCH_SCENES` lists.

## Running

`npm run test:e2e:slow -- render-bench` writes `test-results/render-bench.json` (p50 / p99 / max of draw calls, triangles and frame
ms per scene). `RENDER_BENCH_ONLY`, `_SAMPLES`, `_STEP` and `_WARMUP` are described at the head of the spec. Software GL draws a
frame of these scenes in seconds, so lower the sample count there; on a GPU the defaults are fine.
