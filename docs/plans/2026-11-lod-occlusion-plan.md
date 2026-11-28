# Build plan: mesh LOD (0459) and occlusion culling (0460)

The accepted records 0459 and 0460 own the design, and the RFC README (`docs/rfc/0459-0460/README.md`) owns the
provisional task table: its IDs W0–W8 and person-week figures come from the senior engineer's review. This plan owns
order, file ownership, gates and test cadence. Every number below that isn't measured is an estimate.

## State at planning (2026-11-28)

- **Branch:** `claude/lod-occlusion-design`, pushed, based on master 6a0740ca. Master's newest record is 0444. 0445 is taken on unmerged branch `ccr-1e2a6237-n83y8a` (Rapier). These records are 0459 and 0460, both Accepted.
- **Spikes** live in `spikes/lod-simplify/`, `spikes/lod-crossfade/`, `spikes/lod-select/`, `spikes/occlusion-raster/` and `spikes/render-bench/`. First-wave spikes `spikes/lod-apply/` and `spikes/occlusion-safety/` are running.
- **Navigation is frozen.** Never touch `native/nav/`, `src/engine/nav/`, `src/plugins/navigation/` or the navigation samples.
- **Toolchain in this container:**
  - cargo 1.97; the anim toolchain pin 1.99.1 is installed on demand by rustup;
  - the wasm32 target, wasm-bindgen-cli 0.2.130, Node 22;
  - Playwright Chromium (SwiftShader, WebGL2 only, no WebGPU);
  - no Android emulator.

## Shippable

Every merge into the branch passes `npm run typecheck`, `npm test`, and the e2e specs the coordinator runs on the merged
result. Until a milestone's flip task, new behaviour is opt-in:
- no model has levels until its sidecar asks for them;
- no scene has an `LODGroup` until one is added;
- occlusion stays off until §0's gate passes and its flip task turns on the defaults (`Camera.occlusionCulling`, the tier fields).

Existing scenes draw exactly as today throughout. The pixel diff of the samples before and after each milestone is part of
its exit check.

**Budget gates are tripwires, not limits** (CLAUDE.md):
- The wasm size gate in `native/visibility/build.mjs`, the per-view time targets and the benchmark targets are project tripwires. Exceeding one is raised and logged in `docs/design/lod-occlusion/build-log.md`, never "fixed" by cutting quality.
- No real platform limit applies to this work.

## Milestones

| Milestone | Tasks | Exit check (a person can run it) |
|---|---|---|
| **M1: LOD, hard switches** | W0, T1–T7 | A forest scene in the editor: tick "Generate LODs" on a model, place it, see the LOD bar and the level change as the scene camera moves. `npm run test:e2e` green. The promoted benchmark meets 0459's targets (triangles, JS CPU ≤ baseline, draws, GPU memory). An exported build of the bench scene loads cold and draws levels (shipped-form smoke). |
| **M2: crossfade, skinned levels, rig LOD** | T8, T9 | Levels blend instead of popping (the pixel check finds no holes during a fade). A skinned character switches levels, and its Animator rate follows. Bench JS CPU ≤ M1. |
| **M3: occlusion** | T3 (from wave 1), gate G, T10, T11 | The gate measurement is logged. If it passes: the city camera culls hidden props with zero false occlusions against the reference, adversarial scenes included; the debug view shows the buffer; the exported build loads the wasm lazily. If it fails: the crate stays unwired and the result goes to the owner. |
| **M4: docs and the re-run** | T12 | `docs/wiki/guide/lod-and-occlusion.md` exists; `implementation-status.md` rows are updated; the benchmark is re-run against baseline and reported. |

## Tasks, files and waves

| ID | Source | Lead (model) | Files it owns | Depends on |
|---|---|---|---|---|
| **W0** | W0 | coordinator, Sonnet spikes | `spikes/lod-apply/`, `spikes/occlusion-safety/` | — |
| **T1** import pipeline | W1 | Opus lead; Sonnet leaf for the worker and cache | `src/engine/scene/lod/**` (new: `generate.ts`, `hausdorff.ts`, `remap.ts`, `worker.ts`, `cache.ts`, tests), `src/engine/scene/importSettings.ts`, `src/engine/scene/models.ts`, `src/engine/scene/bakedModel.ts`, `src/export/webBuild.ts` (bake path only) | W0 |
| **T2** visibility core and `LODGroup` | W2 | Opus | `src/engine/render/visibility/**` (new: `bounds.ts`, `select.ts`, `views.ts`, `service.ts`, `lodMember.ts`, tests), `src/engine/render/components.ts` (`LODGroup`, `MeshRenderer.occlusion`, `Camera.occlusionCulling`), `src/engine/core/graphics.ts` (tier fields), `src/engine/index.ts` (exports) | W0 |
| **T3** Rust visibility crate | W5 | Sonnet lead (port of the spike) | `native/visibility/**`, `src/engine/render/visibility/occlusion/wasm/**` (generated) | W0 safety gate result |
| **T4** benchmark and triangle stats | W8 part | Sonnet | `tests/e2e/render-bench.spec.ts`, `tests/e2e/render-bench/**` (generator, from `spikes/render-bench/gen`), `src/engine/render/babylon/BabylonRenderer.ts` (only the `stats.triangles` line, `:826`) | — |
| **T5** Babylon application | W3 | Opus | `src/engine/render/babylon/meshes.ts`, `meshBatches.ts`, `materials.ts` (`meshOf`), `frameGraph.ts`, `feature.ts`, `probes.ts`, `shadowCulling.ts`, `BabylonRenderer.ts` (visibility wiring) | T1 types, T2, W0 apply result |
| **T6** editor: import panel, LOD bar, tier settings | W7 part | Sonnet lead; Haiku leaves for theme tokens and settings rows | `src/plugins/meshes/editor/ModelImportSettings.tsx` (+ logic module), `src/editor/ui/lodBar/**` (new inspector section), `src/editor/ui/inspectorSections.builtin.ts`, `src/editor/theme.ts`, `src/editor/ui/editor.css`, `src/editor/projectSettingsModel.ts`, `src/editor/ui/ProjectSettingsPanel.tsx` | T1, T2 types |
| **T7** the editor adds groups, plus M1 e2e | W7 part | Sonnet | `src/editor/` placement code (the drop-model command), `tests/e2e/lod.spec.ts` | T5, T6 |
| **T8** crossfade | W4 | Opus | `src/engine/render/babylon/lodFade.ts` (new), `meshBatches.ts`, `meshes.ts` (fade state), `warmUp.ts` | M1 merged |
| **T9** skinned levels and rig LOD | W8 part | Sonnet | `src/plugins/animation/runtime/components/SkinnedMeshRenderer.ts`, `Animator.ts`, `features/playback/view.ts`, `src/plugins/animation/runtime/features/skinning/**`, `src/engine/render/babylon/skinnedMeshes.ts` | M1 merged |
| **G** occlusion gate | 0460 §0 | coordinator | `docs/design/lod-occlusion/build-log.md` | M1, T3 |
| **T10** occlusion integration | W6 | Opus | `src/engine/render/visibility/occlusion/core.ts` (+ tests), `src/engine/render/visibility/service.ts` (occlusion step), diagnostics types | G passed |
| **T11** editor debug views and preview | W7 part | Sonnet | `src/engine/render/renderPolicy.ts` (`lodPreview`), `src/engine/render/editorViewport.ts` (debug overlays), `src/editor/` View menu, Profiler table, `tests/e2e/occlusion.spec.ts` | T10, M2 |
| **T12** docs, status, re-run | W8 part | coordinator, Haiku leaf for the guide draft | `docs/wiki/guide/lod-and-occlusion.md`, `docs/architecture/implementation-status.md`, build log | everything |

### Waves

| Wave | Tasks in parallel | Hotspot check |
|---|---|---|
| 1 | T1, T2, T3, T4 | Disjoint: T4 touches only `BabylonRenderer.ts:826`, which T5 rewrites in wave 2 (rework accepted: a one-line conflict). `package.json` gets the `meshoptimizer` dependency and the `build:visibility` script from the coordinator before the wave (single writer). |
| 2 | T5, T6 | T5 owns `src/engine/render/babylon/**` and T6 owns `src/editor/**` and `src/plugins/meshes/editor/**`: disjoint. T6 codes against T1 and T2's merged types. |
| 3 | T7 | Alone (needs T5 and T6). M1 closes. |
| 4 | T8, T9, then G | T8 owns `render/babylon/{lodFade,meshBatches,meshes,warmUp}.ts`; T9 owns animation-plugin files plus `render/babylon/skinnedMeshes.ts`: disjoint. M2 closes. |
| 5 | T10, then T11 | T11 needs T10's diagnostics. M3 closes. |
| 6 | T12 | — |

### Contracts

| Contract | Lands | Lets run in parallel |
|---|---|---|
| `LodLevels` on a derived `ModelMesh` (level `data`, `error`, `occluder` range, bounds), typed in `src/engine/scene/lod/types.ts` | Coordinator writes the stub before wave 1 | T2 and T5 code against levels before T1's generator exists |
| `VisibilityResult` per view (`Uint8Array` levels, hidden bits, `ViewKey`) and `LodMember`, in `src/engine/render/visibility/types.ts` | Coordinator writes the stub before wave 1 | T5, T6, T9, T10 |
| Occlusion core boundary (`occlusion/core.ts` signature over the wasm) | Coordinator writes the stub before wave 1 | T3 and T10 |

### Single-writer files (coordinator only)

`package.json`, `package-lock.json`, `docs/README.md`, `docs/architecture/implementation-status.md`, the two records,
`docs/design/lod-occlusion/build-log.md`, `src/engine/scene/lod/types.ts`, `src/engine/render/visibility/types.ts`.

## Critical path (estimates)

- **Pure dependency chain:** W0 (0.5) → T2 (2.5) → T5 (3.5) → T7 (1) → T8 (2) → G → T10 (2) → T11 (1.5) → T12 (1) ≈ 14 person-weeks.
- **Staffing queue for the strongest model:** T1, T2, T5, T8 and T10 are all Opus-led. Run in series, they alone come to 12.5 person-weeks.
- **Start early:** T1 and T2 run side by side in wave 1. T3 starts in wave 1 because it is off the critical path until G.

## Test cadence

- **Per task (agents):** `npm run typecheck` and Vitest on the touched tests; `cargo test` for T3. Agents never run Playwright (CLAUDE.md).
- **Per wave (coordinator):** the full `npm test`, `npm run build`, and `npm run test:e2e` on the merged result.
- **Per milestone:** the `@slow` benchmark spec; the samples' pixel diff before and after; the exported-build cold-load smoke.
- **Concurrency:** at most two tasks running builds or browsers at once on this 4-core container.

## Pilot (wave 1)

Measure:
- each lead's first-pass success (typecheck plus tests green on the first hand-back);
- the coordinator's time on stubs and briefs;
- how far the leaves' files stayed inside their lists.

If T1 or T2 needs more than one revision round, the leaves for T6 move to Sonnet.

## Owner-only items

- Decision 1 (project-wide LOD default) and decision 2 (real-hardware runs) in the records.
- GPU-time and Android-floor sign-off: the runner `tests/e2e/render-bench.spec.ts` with `E2E_GPU=1` on the owner's GPU machine, and the exported bench on the Pixel 8 emulator. The emulator can't sign GPU memory or real thermal behaviour.
