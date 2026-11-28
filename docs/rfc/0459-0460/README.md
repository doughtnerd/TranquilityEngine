# RFC round: 0459 (LOD) and 0460 (occlusion), 2026-11-28

Five reviewers read both Proposed records, the spike READMEs and the code: an architect (Opus), a senior engineer
(Sonnet), a junior engineer (Haiku), a user persona (a solo Unity developer, Sonnet) and a premise challenger (Sonnet).
All five said "approve with changes" for both records. Their reviews are the other files in this folder. The
coordinator checked each code claim against the code before acting on it; checks are noted below.

"A" = architect, "S" = senior engineer, "J" = junior engineer, "U" = user persona, "P" = premise challenger.

## Taken

| Point | Who | Change |
|---|---|---|
| Per-view hiding in `fit` runs after the geometry pass (AO, DoF) and the view's cull (`frameGraph.ts:596-621, 644`) | A1, P1 | Checked. 0459 §3: each view's cull task gets its own object list from an engine visibility stage; no toggling, no `afterView` hook |
| One shared thin buffer rewritten per pass is proven on WebGL2 only; WebGPU may see the last write | A2 | 0459 §3: one thin source mesh and matrix buffer per pass, sharing geometry |
| Simplified occluders' safety rule is unproven: meshoptimizer's error isn't a bound and uses largest extent, not the diagonal; depth push doesn't stop sideways bulge; sloppy closes doorways | A3, S11, P12 | Checked (`spikes/lod-simplify/README.md:141`). 0459 §1 measures sampled Hausdorff error; 0460 §3 shrink ≥ projected error, near-camera skip, and a first-wave adversarial gate |
| Drawable and batch churn on fades and level changes (`meshes.ts:181`, `meshBatches.ts:199,213`) | A4 | 0459 §3 "No churn": pools, delayed batch disposal, fade batches at warm-up |
| ×1.1–1.3 storage is disk only: `meshOf` uploads per Babylon mesh (`materials.ts:404`) | A5, S1 | Checked. 0459 §1: shared vertex buffers per model mesh, GPU-memory target ≤ 1.3× |
| Oracle CPU savings came from `setActive(false)`; toggling unmeasured at 10k | A6, S4 | Per-view lists replace toggling; first-wave spike measures lists, `customLODSelector` and toggling at 10k; targets re-derived |
| Occlusion in the Meshes plugin can't hide skinned meshes or feed core selection | A7, S7 | 0459 §3 / 0460 §2: engine-owned `render/visibility/`; `LodMember` interface for members |
| "Solid" rule excludes walls, floors, terrain | A8, U1 | Checked (10×3×0.2 m wall = 2 %). 0460 §3: per-frame projected width ≥ 2 buffer pixels |
| Probes render outside the frame graph and would capture every level (`probes.ts:122, 208`) | A9 | Checked. 0459 §3: probe `renderList` filtered by its own selection |
| Heights must come from measured, not estimated, error; units | A10, A13 | 0459 §1 step 3, §2 |
| `fit(camera)` carries no view identity | A11 | `ViewKey`, `fitView(view)` |
| `currentLevel` and rig LOD computed in the renderer break headless Worlds and lag a frame | A12, S6 | 0459 §3: a World service selects the main view in the simulation, before the animation gather |
| No draw-call target; oracle thresholds aren't the defaults | A15, A16, P2, P4 | 0459 targets: draws ≤ 3× and ≤ 300; re-measure with real defaults |
| The CPU win comes from the cull, not levels ("LOD, no cull" 66.2 vs 52.6 ms) | P3, S5 | Checked (`spikes/render-bench/README.md:128`). Target is now JS CPU ≤ baseline with LODs on |
| Remap claim wrong: welding and reordering permute every stream; weld equality must cover all streams | S2 | Checked (`models.ts:262-270`). 0459 §1 pipeline and unit tests |
| Hook sequence contradicts itself | S3 | Superseded by per-view object lists and per-cascade caster lists |
| Default-on can't work through sidecars (written only on Apply, `importSettings.ts:542`) | S8, P8 | Checked. Opt-in per model; a project-wide default goes to the owner (decision 1) |
| Generation blocks the main thread; disk cache parked | S9, U4 | 0459 §1: worker, disk cache keyed by source hash and settings; games never generate |
| `levels` default ambiguous; builtins have none | S10, J4 | Empty `levels` = automatic, derived live; no member levels = LOD0, never cull |
| Batch identity of a level | S14 | Levels are cached derived `ModelMesh`es |
| LOD0 is rewritten | S15 | Stated, consumers audited |
| Tier names: `occlusion` collides; `lodMaxLevel` reads backwards | S16, J3 | `occlusionBuffer`, `lodFirstLevel` |
| Promote the benchmark into the repo | S18 | Targets use a `tests/e2e` `@slow` benchmark reading `RenderStats` |
| `lod.occluder` "auto" defined two ways; no home for models without levels | J1, J2 | `occluder` sits beside `lod`; one definition in 0460 §3 |
| "Why is it gone?" has no answer | J6, U7 | `lodGroup.visibility`: drawn / lodCulled / offScreen / occluded |
| `DitheredTileFadeMaterialPlugin` rejected on wrong facts | P5 | Checked: it supports instances, thin instances and WGSL, but compiles `discard` unconditionally (`:367`). Reason corrected; its Bayer include reused |
| `customLODSelector` route unspiked | P6 | In the first-wave spike; taken if it wins |
| Sequencing: hard switch first, crossfade after | P7, S (estimate) | 0459 §4; estimate waves |
| LOD-culled groups lose long shadows | P9, U6 | Culled groups cast at their coarsest level up to `shadowDistance` |
| Occlusion's value on top of LOD is modest; savings included casters | P10, P11 | 0460 §0 go/no-go gate measured with LOD on and casters kept; targets restated against LOD-on |
| Occlusion default tax on Low tier; open scenes | S12, P14, U9, A (performance) | Low tier off; perspective cameras only; render textures off; one view per frame; back-off |
| Skinned and displaced bounds risk false occlusion | U8, A (failure modes) | Skinned meshes are occludees only, with dilated bounds |
| Doors and glass | U10 | `occlusion` scriptable per frame; transparent materials never occlude |
| Vertex colours (wind) not weighted | U3 | Colours weighted in simplification |
| NaN matrices, load failure, tier change, fade reversal, freeze culling, validator | A (failure modes) | 0459 §4, 0460 §1, §2, §6 |
| Wasm packaging differs from anim | S13 | Follows anim's conventions |
| A saved `forceLevel` silently overrides LOD | J7 | 0459 §7: the inspector warns while it isn't -1 |

## Taken with changes

| Point | Who | What we did instead |
|---|---|---|
| Ship v1 as bounds + selection + thin compaction, then hard LOD, defer crossfade, skinned meshes and rig LOD | P7 | Kept all of it in v1, because the owner asked for crossfade and the rig-LOD tie. Ordered as waves: hard switch first, crossfade and skinned meshes later |
| Scalar fallback wasm | S13 | Not built: the floor and current WebKit have SIMD. Occlusion off with a warning otherwise |
| Temporal reuse on Low | A | Kept as an open question; Low tier is off instead |

## Not taken

| Point | Who | Why |
|---|---|---|
| Do occlusion in TypeScript (whole-frame SIMD gain is only 1.2–1.9×) | P13 | The owner chose Rust/wasm SIMD like the animation core. The raster stage gains 3×, and setup and the test stages are where the next SIMD work goes. The go/no-go gate (0460 §0) covers the value question |
| Default last transition other than 0.01 | J5, U7 | Unity's default cull is also 1 %; the LOD bar shows the "Culled" segment, and `visibility` reports `lodCulled`. Kept, tunable |
| Impostors in v1 | U3 | Out of v1 scope; open question in 0459 |

## Estimate (provisional)

From the senior engineer's task table (`senior-engineer.md`, "Milestones and estimate"), calibrated against estimates, not actuals:
W0 spikes 0.5, W1 import 2.5, W2 core and visibility stage 2.5, W3 Babylon application 3.5, W4 crossfade 2, W5 Rust crate 3
(parallel), W6 occlusion integration 2 (after the gate), W7 editor 3, W8 animation, docs, e2e, status 1.5. That's 20.5
person-weeks; with a reserve of a third, **about 27 (range 22–32)**. The revisions above add the visibility stage and per-pass thin
meshes (est. +1, inside the reserve).
