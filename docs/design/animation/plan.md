# Animation build: plan

Builds accepted records [0370](../../decisions/0370-animation-evaluates-on-an-engine-owned-rust-wasm-simd-core.md)–[0377](../../decisions/0377-audio-packages-are-named-biopak.md).

- **The records own the requirements.** This plan owns the order, the task IDs, file ownership and the gates. If a task and a record disagree, the record wins and the plan gets fixed.
- **Before working:** every agent reads [ground-rules.md](ground-rules.md).
- **Logs:** decisions go in [decision-log.md](decision-log.md); measurements and wave results go in [build-log.md](build-log.md).
- **Revision 2** (2026-11-22) follows the owner's ordering decision and an independent review. Its findings are answered in the last section.

## Owner ordering (2026-11-22)

The audio branch (`origin/ccr-8460d665-umr8or`) is mid-build and changes about 1,300 files, including several this build would edit. So:

- **Phase R, now:** the **Rust core only** (`native/anim/`), plus its generated wire files in a new folder. It touches no existing file except the coordinator's `package.json` script line.
- **Gate A:** the audio branch merges into master, and master is merged into this branch.
- **Phase B, after gate A:** the TypeScript, ECS, render, import, editor, physics and debug-link work, on top of the audio branch's curves, curve editor, component kit, takes, playlists and edit results.

## State at planning (checked 2026-11-22)

- **Branch:** `ccr-d1d28632-2asa2r`, with `origin/master` merged at `1773b414`. That brings in 0333 (WebRTC transport) and 0334 (snapshot parts).
- **Records:** 0370–0377 are Accepted. 0375's context was corrected: `BallJoint` already has `useLimits`, `twistLimits` and a scalar `swingLimit` (`physics/runtime/Joint.ts:180-197`), so 0375 is a migration to elliptical swing plus a new drive.
- **Animation code:** none exists. glTF skins, animations and morphs are dropped with a warning.
- **Audio branch, as of planning** (per its implementation status):
  - 0332 (curves) is built;
  - 0334 (takes), 0329 (playlists) and 0336 are partly done;
  - **0337 (packages) and 0338 (third-party effects) are not started.**
  
- **Facts the Phase B tasks depend on:**
  - `World._sendMessage` takes only lifecycle hook names (`Component.ts:185`), so animation events must widen it (T20t).
  - `propagateTransforms` is private to `World` (`World.ts:824`), so BoneAttachment needs an internal hook (T17).
  - Dropping a model is in the meshes plugin (`plugins/meshes/editor/modelNodes.ts`).
  - The 0326 profiler table kit and `editResult.ts`/`applyEdit` (0307) are inside the audio plugin's editor, which another plugin can't import.
  - Adding a plugin means editing `catalogue.ts`, `plugins/runtime.ts` and `plugins/editor.ts` together, or the build fails.
- **Machine:** 4 cores, 15 GB RAM, about 59 GB disk; Rust 1.99.1 with `wasm32-unknown-unknown`; `wasm-bindgen-cli` 0.2.130; `node_modules` installed.

## What every merge must satisfy (shippable)

- **Checks:** `npm run typecheck`, `npm test`, and `cargo test` in `native/anim/`.
- **Committed wasm matches its source after every task merge,** not only at wave ends:
  - a Rust task commits its own wire family's generated TypeScript (each task owns one family, so there's no conflict);
  - the coordinator rebuilds and commits the `.wasm` and `hash.json` right after merging each Rust task.
- **Nothing that worked stops working.**
  - Projects without animation never load the animation wasm (lazy loading).
  - Skinned models keep rendering static until T16.
  - Particle shaders stay byte-identical through T15.
- **Migrations:**
  - **BallJoint `swingLimit` → `swing`** (T43), a component field migration with a test on a saved scene;
  - **moving `editResult.ts` and `parameterList.ts` into the editor SDK** (T07), with every audio import updated in the same commit.
- **Budgets are tripwires** (CLAUDE.md, 0370): the wasm size gate, per-frame budgets and pose-database size. They are never acceptance criteria or gates. Agents report a reason when one is passed, and the coordinator copies it into the build log.

## Gates

- **A:** the audio branch merged into master, then master into this branch. Phase B starts with B0, a coordinator reconciliation that re-checks this plan's file list against the merged tree.

## Phase R: the Rust core (now)

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T02 | **Workspace and boundary** (see below) | S | 1.5 | — |
| T03r | **Binary formats in `anim-format`** (see below) | S | 1 | T02 |
| T10 | **`anim-math`** (see below) | S | 2 | T02 |
| T11 | **`anim-compress` and `anim-sample`** (see below) | S | 3.5 | T10, T03r |
| T12 | **`anim-pose`** (see below) | M | 2 | T10 |
| T13r | **`anim-wasm` v1 and the minimal graph** (see below) | S | 2.5 | T11, T12 |
| T20r | **Track kinds in `anim-sample`** (see below) | S | 2 | T11 |
| T31 | **`anim-graph` complete** (see below) | S | 5 | T13r, T20r |
| T22r | **Tweens and timelines in the core** (see below) | M | 2 | T20r, T13r |
| T40 | **`anim-rig`** (see below). Split: solvers done early (no graph needed); the rig node family and `rig` wire family follow T31 | S | 4 | T31 (node half) |
| T41 | **`anim-retarget`** (see below). Split like T40: solvers first, node family after T31 | S | 3 | T31 (node half) |
| T42 | **`anim-match`** (see below). Split like T40: search and bake first, database node after T31 | S | 4 | T31 (node half) |
| T44r | **`anim-physics`** (see below) | M | 1.5 | T31 |
| T45 | **Third-party nodes, Rust side (0370)** (see below) | S | 3 | T31 |
| T82r | **`anim-bench`** (see below) | M | 1 | T40, T42 |

- **T02, workspace and boundary:**
  - `native/anim/` workspace with `rust-toolchain.toml` (1.99.1) and every crate from 0370 as a stub with its own `Cargo.toml`;
  - workspace dependencies: `glam`, `wasm-bindgen =0.2.130`;
  - `build.mjs` (run as `node native/anim/build.mjs`; the coordinator adds `build:anim` to `package.json`);
  - the embedded source hash with a Vitest staleness test in the new `src/plugins/animation/runtime/wasm/`, and the size gate (first build plus 20%);
  - **seams:**
    - `anim-wire`: one file per family (`core`, `tracks`, `graph`, `rig`, `match`, `tween`, `timeline`, `physics`, `plugin`, `debug`), with a generator writing `src/plugins/animation/runtime/wasm/wire/<family>.ts` and a round-trip test per family;
    - `anim-wasm`: one module file per feature, with the `mod` lines written once;
    - `anim-offline`: one module per reference area (`math`, `sample`, `pose`, `rig`, `retarget`, `match`);
    - `anim-graph`: one module per node family (`sources`, `logic`, `mixing`, `slots`, `sync`, `rig`, `retarget`, `matching`, `physics`, `plugin`), with a dispatch table written once.
- **T03r, binary formats in `anim-format`:** layouts and readers and writers for:
  - `myco.anim@1`: compressed tracks, uncompressed raw-clip form for preview before compression, root curve section, key lists for discrete and event kinds;
  - `myco.skel@1`: bones, parents, rest pose, inverse bind, profile roles, joint ranges;
  - `myco.animgraph@1`: the program, the node table by family, the parameter table;
  - `myco.posedb@1`.
  
  All flat, little-endian, `repr(C)`, 4-byte aligned. Round-trip tests.
- **T10, `anim-math`:** SoA quaternion, vector and transform maths on `glam` with `simd128`, under the deterministic rules. `anim-offline/math` is the scalar f64 reference. Property tests compare the two with stated tolerances.
- **T11, `anim-compress` and `anim-sample`:**
  - uniform sampling; constant and default tracks dropped;
  - range reduction per 16-frame segment;
  - bit-rate search against object-space error with virtual vertices for **bone tracks**, and absolute error for **generic property tracks**;
  - an error report;
  - root-curve extraction (translation and yaw) into the root curve section;
  - bone-track sampling.
  - Tests against `anim-offline/sample`.
- **T12, `anim-pose`:**
  - blend, additive and masked layered blend;
  - local to model space;
  - root-motion extraction and sync-phase maths;
  - mirror through a left/right map;
  - leaf **L12a**: inertialization (Bollo's quintic) in `inertialize.rs`, to quoted values;
  - tests against `anim-offline/pose`.
- **T13r, `anim-wasm` v1 and the minimal graph:**
  - the init record and the memory-needed reply;
  - the asset arena (load and release; growth only in load calls);
  - the instance table (index plus generation);
  - `write_inputs`, `evaluate` and outputs (3×4 bone matrices, root deltas);
  - **the minimal `anim-graph` interpreter** (clip player, crossfade, layer), so `play()` without a graph asset is an implicit single-layer graph from day one (0372), not a separate path;
  - instance state snapshot and restore;
  - LOD fields (update every N frames with interpolation; rig off past a distance);
  - `cargo test` plus a Node test through the generated wire.
- **T20r, track kinds in `anim-sample`:** `discrete`, `activation`, `morph`, `event` and notify-state windows, `marker`, `subclip`, `control`, `audio`, and value tracks sampled from resampled data. Output columns per binding.
- **T31, `anim-graph` complete:**
  - **state machines:** priority transitions, `when`/`how` with `bridge`, inertialization, requests with lifetimes, `travel` pathfinding, `jump`, any-state, sub-machines;
  - **sources:** pose snapshot, reference and bind pose;
  - **mixing:** blend by weight, enum and bool; additive; masked layers; mirror;
  - slots with sections; linked graphs swappable at runtime; chooser tables; the seeded random selector;
  - **blend spaces 1D and 2D**, with `follow.glideMs` and the root-speed parameter;
  - sync groups and markers; notify weights;
  - computed-parameter slots;
  - **debug state** (`anim-graph/src/debug.rs` plus the `debug` wire family): transition blockers, request lifetimes, node weights, for T52;
  - leaf **L31a**: Delaunay, barycentric weights and hull projection in `sources/triangulate.rs`, to audio Blend's rule (0372).
- **T22r, tweens and timelines in the core:** the tween table (Penner easings by name, loops, time scales, a destroyed flag) and timeline sampling (multi-binding tracks, `subclip`/`control`/`activation`/`audio`, wrap modes). `sequence`/`parallel` compile to a timeline program.
- **T40, `anim-rig`:**
  - two-bone (leaf **L40a**), FABRIK, CCD (leaf **L40b**), full-body IK;
  - look-at and aim with limits (leaf **L40c**);
  - the grounder, with ray requests and responses;
  - spring bones with colliders;
  - copy, limit and damp constraints;
  - distance, stride, orientation and motion warping;
  - per-entry weights.
  
  Tests against `anim-offline/rig`.
- **T41, `anim-retarget`:** the built-in Humanoid profile with joint ranges and a per-bone mirror axis-flip table (D18; `anim-pose::mirror` applies it); chain retargeting with rest-pose compensation, root and goal scaling and IK pinning; `guess_bone_map` (name heuristics, in Rust, so TypeScript only calls it); the runtime node; the offline bake.
- **T42, `anim-match`:** features and normalisation, KD-tree plus SIMD brute force, spring-damped trajectory prediction, tags, the database bake, search every N frames or on a large change, inertialized switches, the database node. A small synthetic database.
- **T44r, `anim-physics`:** joint drive targets and strengths per bone from a pose and a ragdoll description; physical-pose blend input.
- **T45, third-party nodes, Rust side:**
  - `anim-plugin-sdk`: a C ABI with pose and parameters in and pose out, and a Rust SDK;
  - the core's calls through an imported host function;
  - fault passthrough with a report;
  - `anim-meter`: an instruction-budget (fuel) pass that rewrites a module at load. It is compiled into the editor's loader wasm in Phase B.
- **T82r, `anim-bench`:** criterion benches for the 0370 budgets. Results are logged as tripwires.

## Phase B: after gate A

### B0 findings (2026-11-23, after merging master with the Audio Studio at `22410cbb`)

- **Curves:** `core/curve.ts` has Bézier keys. The shared curve editor is `src/editor/ui/curves/` (`CurveEditorDialog`, `CurvePlot`, `CurveField`, `DopeSheet`, `keyList`); `CurveEditor.tsx` is gone. The Rust evaluator is still `native/audio/crates/audio-core/src/automation.rs` (T70 moves it).
- **Edit results:** two copies of the refused-or-next module exist: `src/editor/ui/localisation/editResult.ts` and `src/plugins/audio/editor/editResult.ts`. T07 makes one SDK module and points both at it.
- **Parameters:** `src/plugins/audio/editor/parameterList.ts` and `ParameterCard.tsx` (T07 moves them); the Studio has `ParameterPanel`/`ParameterRow` in `src/studio/components/`.
- **Component kit:** audio-specific parts in `src/studio/components/`; generic parts in the editor UI (T50–T56 use those).
- **Audio playlist pieces animation reuses:** fade shapes `src/engine/audio/playlist/fadeShapes.ts` (T30 maps D53's ids onto them), 2D blend weights `src/engine/audio/playlist/blendWeights.ts` (same rule as L31a), `AudioPlaylistHandle` exported from `myco` (T72).
- **Packages:** `.mycopak` is built (`src/engine/audio/packaging/format.ts`); 0377 is withdrawn, nothing to do.
- **Takes and the profiler:** located by T73 and T34 at their start (the Studio's take and profiler code moved during the merge).
- **Baseline:** full Vitest run on the merged tree logged in the build log before B-W1 merges.


| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| B0 | Reconcile: merge, re-check the "State" facts and every file named below against the merged tree, update this plan | Coordinator | 0.5 | A |
| T04 | **Optional dependencies (0374)** (see below) | M | 1 | B0 |
| T05 | **`@field` `animatable`** (see below) | M | 0.5 | B0 |
| T07 | **Editor SDK moves** (see below) | M | 1 | B0 |
| T15 | **`render/gpuKernels/` executor** (see below) | S | 2 | B0 |
| T01 | **Plugin skeleton and contract** (see below) | S | 2 | T04, T05 |
| T03t | **TypeScript formats** (see below) | S | 2 | T01 |
| T13t | **Host and loader** (see below) | S | 1.5 | T01, T13r |
| T14 | **Import** (see below) | S | 3 | T03t |
| T19 | **Clip compile pipeline** (see below) | S | 2.5 | T03t, T14, T11 |
| T16 | **Skinning** (see below) | S | 3 | T15, T13t |
| T17 | **ECS integration** (see below) | S | 2.5 | T13t |
| T20t | **Property tracks on the ECS** (see below) | S | 2 | T17, T20r |
| T18 | **Editor M1** (see below) | M | 2.5 | T17, T07 |
| T17b | **Animators without a Skeleton** (see below) | S | 1 | T20t |
| T18b | **Posed asset previews** (see below) | S | 1.5 | T18, T54 |
| T21 | **Sprites** (see below) | M | 2 | T20t, T16 |
| T22t | **Tweens and timelines on the ECS** (see below) | M | 2.5 | T20t, T22r |
| T24 | **Live texture transforms** (see below) | M | 1.5 | T14, T20t |
| T30 | **Graph compiler (TS)** (see below) | S | 2.5 | T03t, T31 |
| T32 | **Animator graph API** (see below) | M | 2 | T30, T17 |
| T33 | **Networking** (see below) | S | 2.5 | T32 |
| T34 | **Profiler table** (see below) | M | 1 | T17, B0 |
| T40t | **Rig on the ECS** (see below) | M | 1.5 | T32, T40 |
| T41t | **Retarget on the ECS** (see below) | M | 1 | T32, T41, T14 |
| T42t | **Matching on the ECS** (see below) | M | 1.5 | T32, T42 |
| T43 | **Ball joints (0375)** (see below) | M | 2 | B0, T05 |
| T44 | **`myco.ragdoll` runtime** (see below) | S | 3 | T43, T32, T44r |
| T45t | **Third-party nodes, TS side** (see below) | S | 2 | T30, T45 |
| T50 | **Animation window** (see below) | S | 4 | T20t, T05, T07 |
| T51 | **Graph editor** (see below) | S | 5 | T30, T32, T07 |
| T52 | **Live debugger** (see below) | S | 3 | T51 |
| T53 | **Timeline window** (see below) | M | 3 | T22t, T50 |
| T54 | **Skeleton, retarget and clip import tools** (see below) | M | 3 | T41t, T19 |
| T55 | **Pose database tool and ragdoll builder** (see below) | M | 3 | T42t, T44 |
| T56 | **2D tools** (see below) | M | 3 | T21 |
| T60 | **Debug link (0376)** (see below) | S | 3 | B0, T52 |
| T72 | **Musical timing** (see below) | M | 1.5 | T04, T32 |
| T73 | **Takes** (see below) | S | 2.5 | T32, T52 |
| T70 | **`myco-curve` and the Bézier evaluator** (see below) | S | 2 | B0, T20t, T22t |
| T80 | **User guide** (see below) | M | 1.5 | all |
| T81 | **e2e specs** (see below) | Coordinator | 2 | all |
| T82 | **Benches through the shipped player** (see below) | M | 1 | all |

- **T04, optional dependencies (0374):**
  - `optionalDependencies` in the manifest; `order.ts`, `pluginSet.ts` and `enabled.ts`; editor halves; `thirdParty.ts`;
  - `ctx.plugins.isActive`; re-activation on toggle;
  - the Plugins-category message; one warning for a version out of range;
  - tests.
- **T05, `@field` `animatable`:** the option and its defaults by type; opt-outs on built-ins (physics body type, collider shape kind); tests.
- **T07, editor SDK moves:** `editResult.ts`/`applyEdit` (0307), `parameterList.ts` (0304) and `ParameterCard.tsx`, plus the profiler table kit (0326) if gate A left it in the audio plugin, move from the audio plugin's editor into the editor SDK. Audio's imports are updated in the same commit, and tests move with them.
- **T15, `render/gpuKernels/` executor:** generalise both particle runners. Particles move onto it with byte-identical shaders, by test.
- **T01, plugin skeleton and contract:**
  - `src/plugins/animation/`: a manifest with **optional dependencies on physics and audio**;
  - every component class with its fields (using `animatable`): `Skeleton`, `SkinnedMeshRenderer`, `Skeleton2D`, `Animator`, `BoneAttachment`, `TimelineDirector`, and the tween data component;
  - every public method declared, delegating to `runtime/features/<feature>.ts`;
  - buffers;
  - systems in `runtime/systems.ts`, with `Gather` split into one sub-step file per feature (`stages/gather/<feature>.ts`) and `Apply` likewise;
  - **registration seams:** `runtime/features/<x>/register.ts` (World services, render features) and `editor/<tool>/register.ts` (windows, asset kinds, inspectors), called from `activate()` written once;
  - **the ragdoll contribution point** (drive targets, physical-pose input, pose snapshot) in the runtime context;
  - `myco` exports, written once.
  
  The coordinator adds the catalogue, `plugins/runtime.ts` and `plugins/editor.ts` entries at merge.
- **T03t, TypeScript formats:**
  - parses and writes for `myco.anim-source@1`, `*.animgraph.json`, `*.timeline.json`, `*.mask.json`, `*.skelprofile.json` (with joint ranges) and `*.posedb.json`;
  - lenient, limits declared once;
  - asset kinds with reference rewriting for **every** kind (0314), registered through T01's `editor/formats/register.ts`;
  - a TS reader for the binary headers.
- **T13t, host and loader:**
  - the lazy loader, one instance per page, Node too;
  - the `AnimationCore` World service over T13r's wire;
  - "no `simd128`: warn once, Animators stay at bind pose";
  - asset release between editor play sessions.
- **T14, import:**
  - glTF skins, skeleton, clips, morphs, the full `KHR_animation_pointer` table with one warning for the rest, `KHR_node_visibility`;
  - FBX skins, stacks and blend shapes;
  - influences: 4 by default, 8 by sidecar;
  - the sidecar `animation` section (clips, root motion, additive, compression, markers, events, curves, mirror, `retargetSource`, `profile`, `boneMap` through Rust `guess_bone_map`, `influences`) in `importSettings.ts`;
  - a per-material "animated texture transform" flag;
  - model sub-assets (`model.glb#Anim/<name>`, `#Skeleton`) satisfy `animclip` and `skeleton` asset fields (through the meshes model kind or a core field rule; T03t follow-up);
  - baked models carry skins and morphs;
  - CC0 fixtures.
- **T19, clip compile pipeline (0370, 0371):**
  - compression in a Web Worker with its own instance;
  - compiled clips content-keyed in `.myco/anim/`;
  - settings inheritance: project profile → folder rule → sidecar → platform;
  - raw-clip playback until the compile finishes;
  - exports bake every referenced clip to `*.anim.bin` (the build writer, 0296).
- **T16, skinning:**
  - the KSL `mycoSkin` function on the executor;
  - WebGPU through a vertex storage buffer;
  - WebGL2 spike (float textures with vertex pulling, or transform feedback), measured and logged;
  - `SkinnedMeshRenderer` sync for every pass; 2D skinned quads;
  - JS output tested against `anim-offline`.
- **T17, ECS integration:**
  - `Skeleton`, `SkinnedMeshRenderer`, `Animator` code-first (`play`, `crossfade`, `state`, `layerWeight`, promises) and `BoneAttachment`;
  - the stages in 0370's order;
  - root motion modes (`characterController` and `rigidBody` only when physics is active);
  - an internal post-propagation hook in `World.ts` for BoneAttachment, recorded in the decision log;
  - server mode; culling and LOD;
  - headless tests through the public API.
- **T20t, property tracks on the ECS:**
  - the binding table and bulk scatter;
  - one warning per clip and node for missing targets;
  - `World._sendMessage` widened to named methods for animation events (internal tier), plus the `AnimationEvents` buffer;
  - `audio` track plays through audio's public API when audio is active.
- **T18b, posed asset previews:** the thumbnail renderer's live preview hosts a preview World with the animation core so clip previews (T18), retarget side-by-side and clip import previews (T54) pose the model at the playhead.
- **T17b, Animators without a Skeleton:** the core accepts an instance with no skeleton (zero bones: tracks, notifies, root curve and graph logic only), and the Animator creates one when no Skeleton is found, so clips can animate lights, materials and other fields alone (T20t gap).
- **T18, editor M1:**
  - drop behaviour: a contribution point in `plugins/meshes/editor/modelNodes.ts` that the animation editor fills (`Skeleton`, `SkinnedMeshRenderer`s, an `Animator` playing the first clip);
  - dropping a clip on an Animator adds it or offers a state;
  - bones in the Hierarchy with a bone target in `inspectorTarget.ts` and a bone gizmo;
  - clip preview in the Asset Inspector.
  - editor picking of GPU-skinned meshes (scene-view clicks): pick by bounds or keep rest positions for picking (T16 follow-up).
- **T21, sprites:**
  - flipbooks and slice `skin` in `importSettings.ts`;
  - `SpriteRenderer.sprite` animatable;
  - `Skeleton2D`, with several slices sharing one skeleton.
- **T22t, tweens and timelines on the ECS:** `tween()`, `sequence()` and `parallel()`; `TimelineDirector`; control tracks (particles, camera cut, nested slot); playlist audio tracks.
- **T24, live texture transforms:** live texture transforms for animated materials; material, light and camera fields through the render sync.
- **T30, graph compiler (TS):**
  - the **node catalogue as one file per node family** (`graphNodes/<family>.ts`) with a compiler registry, so T40t–T45t each add a family file;
  - structured conditions; problems with paths.
- **T32, Animator graph API:** `set`, `request`, `travel`, `jump`, slot `play` with sections, `link`, `state`, `compute`, `bone()` overrides, the `animatorParams` view, `AnimatorStateChanges`.
- **T33, networking:**
  - replicated fields; interpolated ghosts;
  - `animation.PredictedRootMotion` (physics active);
  - server gameplay-only evaluation;
  - a two-World test.
- **T34, profiler table:** the Animation table wherever B0 finds the profiler (editor SDK kit or Studio Profiler), through its public kit.
- **T40t, rig on the ECS:** `Animator.ik()` and `warp()`; grounder rays through the public physics ray API (physics active); rig LOD by distance; the rig node family file.
- **T41t, retarget on the ECS:** retarget node family; profile assets at runtime.
- **T42t, matching on the ECS:** the pose database node family; the bake worker; trajectory input from `CharacterController`.
- **T43, ball joints (0375):**
  - `swingLimit` → `swing {y, z}` with the field migration;
  - the drive;
  - the backend interface and Rapier mapping (confirm per-axis motors at `rapier3d.ts:143` first);
  - hinge and slider `spring.targetPosition` animatable, via sub-path animatability in `registry.ts` (`animatable: ["targetPosition"]` on the `spring` field; D86);
  - the gizmo cone and twist arc.
- **T44, `myco.ragdoll` runtime:** `src/plugins/ragdoll/runtime/`: the component, fixed-step systems, generation, the drive through the contribution point, pose readback, get-up. The coordinator adds the plugin's three registration entries.
- **T45t, third-party nodes, TS side:** `plugin.json` node declarations; loading, fuel pass and instantiation; host glue; node family cards generated from the schema; tests with a sample node module.
- **T50, Animation window:**
  - the dope sheet **built on the audio branch's `DopeSheet`/`keyList` and the shared curve editor** (no parallel implementation);
  - curve lanes;
  - record mode with key buttons on animatable fields;
  - event, marker, audio and activation rows;
  - onion skin; edit-mode preview;
  - component-kit parts.
- **T51, graph editor:**
  - pose nodes, state machines, the transition list with condition rows;
  - the blend space editor, chooser table, linked graphs, masks;
  - parameters through the SDK parameter list and card;
  - catalogue-generated cards; rig gizmos;
  - refused-or-next edits.
- **T52, live debugger:** the graph overlay from `debug` wire records; why-not transitions; live parameters; the in-memory 10 s recorder with scrub.
- **T53, Timeline window:** tracks, bindings, blend regions, control/subclip/activation/audio tracks, camera cuts, nested timelines, scrub.
- **T54, skeleton, retarget and clip import tools:**
  - the bone map editor (auto-guess, mirror), chain editor, retarget preview, bake;
  - clip import settings: the take strip, loop pose-match indicator, root motion, additive reference, compression report;
  - markers, events and curves on the source take;
  - live preview on any profile-compatible character.
- **T55, pose database tool and ragdoll builder:** the pose database tool; the ragdoll builder (`src/plugins/ragdoll/editor/`).
- **T56, 2D tools:** flipbooks from slices; the 2D bone editor with weights on the Sprite Editor's history.
- **T60, debug link (0376):**
  - `src/engine/debugLink/` over `net/transport/` (WebSocket, WebRTC);
  - pulled topics; commands at next frame start;
  - take-record encoding (audio 0348);
  - `src/editor/debugLink/` with the accept prompt, connected-builds menu and LAN toggle in Preferences;
  - `game.json` `debug`, `--debug-link`; stripped from release exports (test);
  - the animation topic for T52.
  
  The Studio may reuse it; that isn't required by 0376.
- **T72, musical timing:** `at: beat | bar | exit` and `align: hit` against `AudioPlaylistHandle` (audio active).
- **T73, takes:** `ANIM_*` records in the take recorder and reader; editor replay against the current project.
- **T70 also carries** the core follow-ups found in Phase B: a normalised-time field on the graph family's `JUMP` (T33), a per-bone server evaluation flag (T17/T33), swapping a playing raw clip for its compiled one (T19).
- **T70, `myco-curve` and the Bézier evaluator:**
  - `native/common/curve/` is moved out of `audio-core/src/automation.rs`, and audio depends on it, with a parity test against `core/curve.ts`;
  - animation source value curves, tween custom easing and runtime curve tracks use it;
  - **the coordinator rebuilds and commits audio's wasm, hash and metered wasm** and logs any audio gate change.
  - follow-ups collected from Phase B merges: the JUMP node's normalised-time field; a per-bone server evaluation flag; swapping a raw clip for its compiled one in place; `AnimationCore` wrapping the core's existing `match_debug_write`/`match_debug` (with a per-instance debug flag) and setting T55's `MatchDebugSource`; a custom `Skeleton.profile` in ragdoll generation; mirrored clips and custom features in `posedb_bake`.
- **T80, user guide:** `docs/wiki/guide/animation.md`; glossary.
- **T81, e2e specs:** animation smoke (capture-based); editor flows; cold-loaded exported build; WebKit.
- **T82, benches through the shipped player:** benches through the shipped player; size gate review; logged as tripwires.

**Not in this build** (owner, 2026-11-22): a character sample project and a large pose database; mixed-asset packages; the shared expression language; worker threads.

## Milestones and exit checks

| # | Milestone | Tasks | Exit check |
|---|---|---|---|
| R1 | Core playback | T02, T03r, T10–T13r | `node native/anim/build.mjs` builds; `cargo test` green; a Node test loads the wasm, loads a test clip, evaluates, and the bone matrices match `anim-offline` within tolerance |
| R2 | Core complete | T20r, T22r, T31, T40–T42, T44r, T45, T82r | `cargo test` green; benches logged; a Node test runs a state machine with a blend space, a slot and IK through the wasm |
| B1 | Skeletal playback in the engine | B0, T04, T05, T07, T15, T01, T03t, T13t, T14, T19, T16, T17 | Drop a skinned `.glb` in the editor, press Play: it animates with shadows. The same in an exported web build opened cold. `samples/playground3d` still renders; particle shaders byte-identical |
| B2 | Tracks, sprites, tweens, timelines, graph | T20t, T18, T21, T22t, T24, T30, T32, T33, T34 | Clip keys a light and a material; a flipbook plays; `await tween`; a timeline drives two nodes; a graph with a blend space, request and slot runs; a two-World client matches |
| B3 | Procedural and physics | T40t–T42t, T43, T44, T45t | Foot IK, look-at, spring bones; retarget between two skeletons; matching on a small database; a powered ragdoll falls and gets up; a sample third-party node runs under fuel |
| B4 | Editor, debug link, audio integration | T50–T56, T60, T72, T73, T70 | The M5 author-and-debug flows in the editor; a build with `--debug-link` inspected live; Bézier curve lanes; a play on the next bar; a take replays animation |
| B5 | Finish | T80–T82 | Guide, status rows, e2e green, benches logged |

**Every B milestone's exit includes the shipped-form smoke:** an exported web build, served with `node serve.mjs` and opened cold.

**Detectors:**
- poses against `anim-offline`;
- skinning by capture diff against a reference;
- foot sliding by planted-foot drift per stance from `marker` tracks.

The smoke spec observes only public surface: captures and the editor UI (CLAUDE.md, 0330).

## Waves

At most four agents, at most two building Rust. No agent runs Playwright or Storybook tests; the coordinator does at wave ends.

| Wave | Tasks | Rust |
|---|---|---|
| R-W0 | T02 | T02 |
| R-W1 | T03r, T10 | both |
| R-W2 | T11, T12 | both |
| R-W3 | T13r, T20r | both |
| R-W4 | T31, T22r | both (T22r's timeline part waits for nothing in T31) |
| R-W5 | T40, T41 | both |
| R-W6 | T42, T45 | both |
| R-W7 | T44r, T82r | both |
| *gate A* | B0 | — |
| B-W1 | T04, T05, T07, T15 | — |
| B-W2 | T01, T43 | — |
| B-W3 | T03t, T13t | — |
| B-W4 | T14, T16, T17 | — |
| B-W5 | T19, T20t, T30 | — |
| B-W6 | T18, T21, T22t, T32 | — |
| B-W7 | T24, T33, T34, T40t | — |
| B-W8 | T41t, T42t, T44, T45t | — |
| B-W9 | T50, T51, T56 | — |
| B-W10 | T52, T53, T54, T55 | — |
| B-W11 | T60, T70, T72, T73 | T70 |
| B-W12 | T80, T82 | — |
| B-W13 | T81 and the shipped smoke | — |

## Critical path (estimates)

- **Phase R pure chain:** T02 (1.5) → T10 (2) → T11 (3.5) → T13r (2.5) → T31 (5) → T40/T42 (4) → T82r (1). About **19.5 days**, estimated.
- **Phase B pure chain:** B0 (0.5) → T04 (1) → T01 (2) → T13t (1.5) → T17 (2.5) → T20t (2) → T30 (2.5) → T32 (2) → T51 (5) → T52 (3) → T60/T73 (3). About **25 days**, estimated.
- **Staffing:** Rust is capped at two concurrent tasks, and every Phase R wave runs exactly two. So Phase R's length is its chain. Phase B has no Rust except T70, so its length is its chain plus the wait for gate A.
- **Start early:** T15 and T43 in the first B waves (off the chain, but they unblock T16 and T44).

## Hotspots and seams

| File or area | Touched by | Fix |
|---|---|---|
| `native/anim/Cargo.toml`, `Cargo.lock` | Rust tasks | T02 writes every crate and workspace dependency; tasks edit only their crate's `Cargo.toml`; the coordinator resolves lock conflicts by rebuilding |
| committed `.wasm`, `hash.json` | Rust tasks | coordinator after each Rust task merge |
| generated wire TS | Rust tasks | each task commits only its own family's file |
| `anim-wasm/src/lib.rs`, `anim-graph` dispatch, `anim-offline` | Rust tasks | T02's per-feature, per-family and per-area module seams |
| `anim-graph` node families | T31, T40, T41, T42, T44r, T45 | one module per family (T02); T31 owns `sources`, `logic`, `mixing`, `slots` and `sync` |
| `Animator.ts`, `systems.ts`, `stages/gather`, `stages/apply`, `activate()`, editor `index.ts` | many B tasks | T01's feature, stage and registration seams |
| graph node catalogue and compiler | T30, T40t–T45t | one family file each; registry written once by T30 |
| `catalogue.ts`, `plugins/runtime.ts`, `plugins/editor.ts` | T01, T44 | coordinator, all three together |
| `src/myco.ts` | T01, later | single writer: T01; later through the coordinator |
| `importSettings.ts` | T14 (models), T21 (images), T54/T56 (they write sidecars through the parse) | different waves (B-W4, B-W6, B-W9/10) |
| `World.ts`, `Component.ts` | T17 (post-propagation hook), T20t (named messages) | different waves (B-W4, B-W5) |
| `plugins/meshes/editor/modelNodes.ts` | T18 | T18 adds a contribution point; nothing else touches it |
| physics plugin files | T05 (opt-outs, B-W1), T43 (B-W2) | different waves |
| audio editor files | T07 (B-W1), T70 (audio-core, B-W11) | different waves |
| `docs/README.md`, `implementation-status.md`, `docs/design/animation/*`, `package.json` | — | coordinator; implementation-status rows updated **at each wave merge** from the reports |

## Contracts

| Contract | Lands | Lets run in parallel |
|---|---|---|
| Crate, module, family and area seams; wire families (T02) | R-W0 | every Rust task |
| Binary formats (T03r) | R-W1 | T11, T13r, T19, T03t |
| Minimal graph program (T13r) | R-W3 | T31 extends it, T17 plays through it |
| Graph debug records (T31) | R-W4 | T52 |
| Editor SDK edit results and parameter list (T07) | B-W1 | T18, T50, T51 |
| `gpuKernels` executor (T15) | B-W1 | T16 |
| Plugin skeleton, seams, ragdoll contribution point (T01) | B-W2 | every later B task |
| TS formats and asset kinds (T03t) | B-W3 | T14, T19, T30, T50, T53 |
| Node catalogue registry (T30) | B-W5 | T40t–T45t, T51 |

## Test cadence

- **Per task:** typecheck, the touched Vitest tests, `cargo test -p` for touched crates.
- **After each task merge (coordinator):** rebuild and commit the wasm for Rust tasks; typecheck; `npm test`.
- **Wave end:** full `npm test`; workspace `cargo test`; `npm run build`; `npm run test:e2e` and the animation smoke; deterministic gates; **`npm run test:stories` in waves that add views (B-W6 on)**; implementation-status rows.
- **Milestone end:** `test:e2e:slow`, WebKit, the shipped-form smoke, benches logged.

## Pilot (R-W0, R-W1): measures

- First-pass success (green on the first report); hours per task.
- Cold and incremental `cargo build` times and `target/` size per worktree.
- Tokens per model.

**If R-W0/R-W1 fall short:** seams reopened → add a seam-review step; cold builds over 10 minutes → shared `CARGO_TARGET_DIR`; mid tasks need heavy fixes → move them to S.

## Review findings (revision 2) and how they're answered

An independent review of revision 1 found 50 items. They are answered by:

- **The phase split, findings 1.12 and 5.1:** the audio branch's overlapping files are only touched after gate A.
- **Seams and placement:**
  - registration seams and coordinator-owned plugin entries (1.1–1.3);
  - Gather and Apply sub-steps (1.4, 1.7);
  - node-family seams in Rust and TypeScript (1.5, 3.12);
  - `anim-offline` areas (1.6);
  - `debug.rs` and the debug wire family for T52 (1.8);
  - the physics and import rows corrected (1.9, 1.10);
  - `World.ts` and `Component.ts` named (1.11).
- **Rework removed:**
  - `play()` runs through the minimal graph from T13r (2.1);
  - T50 builds on the audio dope sheet and curve editor (2.2, 2.3);
  - T51 uses the moved card (2.4);
  - T34 goes where B0 finds the profiler (2.5);
  - T60 comes after T52 and gate A (2.6);
  - curve runtime is noted as T70's change (2.7);
  - raw-clip form in T03r (2.8);
  - the ball-joint migration made explicit, and 0375 corrected (2.9).
- **Ordering:**
  - every dependency now sits in an earlier wave (3.1–3.5);
  - optional dependencies on physics and audio declared in T01 after T04 (3.6, 3.7);
  - edit results moved first (3.8);
  - the ragdoll contribution point (3.9);
  - T05 before T01 and T43 (3.10);
  - master merged for WebRTC (3.11).
- **Coverage:**
  - T45/T45t for third-party nodes (4.1);
  - T19 for the clip pipeline (4.2);
  - generic property-track compression and root curves in T11 (4.3, 4.4);
  - the missing graph pieces in T31 (4.5);
  - slot sections and sidecar fields (4.6);
  - drop behaviour (4.7);
  - clip import items (4.8);
  - 0376 items, with Studio reuse marked optional (4.9);
  - 0370 items in T13r and T13t (4.10);
  - 0374 items (4.11);
  - 0375 springs and profile joint ranges (4.12);
  - 0371 warnings, rewriting and shared 2D skeletons (4.13);
  - T74 (BioPak) later dropped: 0377 withdrawn by the owner (2026-11-23).
- **Facts:** the audio and master state (5.2, 5.4), `_sendMessage` (5.5), the profiler (5.6), the critical path recomputed (5.7), and the inconsistencies (5.8, 5.9).
- **Cadence:**
  - status rows at each wave (6.1);
  - Storybook runs by the coordinator (6.2);
  - wasm committed after each Rust task merge, with the wire file per family (6.3);
  - audio wasm in T70 (6.4);
  - a public-surface smoke (6.5);
  - size-gate reasons copied to the build log (6.6).
