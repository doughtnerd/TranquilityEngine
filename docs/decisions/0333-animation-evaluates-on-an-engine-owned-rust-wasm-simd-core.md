# 0333. Animation is a first-party plugin whose evaluation runs on an engine-owned Rust/WebAssembly SIMD core

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0075 (animation is neither Babylon's system nor a copy of it; Babylon only uploads bone matrices and morph weights)
- **Related:** 0010, 0011, 0017, 0033, 0065, 0133, 0157, 0334, 0335, 0336

## Context

Myco has no animation. glTF skins, animations and morph targets are dropped with one warning (0088), FBX skinning is missing (0044), and sprites can't flip through slices (0040). 0075 left "copy Babylon's animation system or write our own" to its own record, and 0159 left "can this field be animated" to the same record.

A comparison of Unity (Mecanim, Playables, Animation Rigging, Timeline), Unreal (AnimGraph, Montages, Control Rig, IK Retargeter, Motion Matching, warping, Sequencer, ACL) and Godot (AnimationPlayer property and method tracks, AnimationTree, `travel()`, SkeletonModifier3D, SkeletonProfile), plus their best plugins (Animancer, Final IK, PuppetMaster, MxM, PrimeTween, ALS, Kawaii Physics), led to one design in four records:

- **0333 (this one):** where evaluation runs and how it reaches the ECS, the renderer and the network.
- **0334:** the data. One property-track format for clips, timelines and tweens, plus importers and compression.
- **0335:** the animation graph and the scripting API on the ECS.
- **0336:** the editor tools.

**The owner's decisions (2026-11-22):**
1. The core is Rust compiled to WebAssembly with SIMD, by default. There is no TypeScript evaluator.
2. Everything in the four records gets built. Nothing is deferred to a later milestone.
3. Every TypeScript part that holds behaviour, data or systems is built on the engine's ECS: `@component` classes, data components, buffers and built-in systems (0017, `src/plugins/runtimeContext.ts`).

**Why not Babylon's animation:** it animates Babylon objects. That breaks 0010 (our graph is authoritative), can't run on the headless server (0033, `src/server/`) where root motion and hit sockets are needed, and has no pose graph, IK, retargeting or motion matching.

**Precedent:** navigation (0065, `native/nav/`) and audio (0157, `native/audio/`) already run on engine-owned Rust cores with committed wasm. 0157 measured wasm within ±3% of native in V8, JavaScriptCore and SpiderMonkey, and found `simd128` accepted by every target engine.

**Measurements:** none yet for animation. The budgets below are tripwires to check against the first build, not measurements.

## Decision

We will build animation as a **first-party plugin**:

| Part | Location |
|---|---|
| Runtime half (TypeScript) | `src/plugins/animation/runtime/` |
| Editor half | `src/plugins/animation/editor/` |
| Rust core (a Cargo workspace) | `native/anim/` |
| Committed wasm | `src/plugins/animation/runtime/wasm/` |

Public types are exported from `myco` like physics and navigation. No Rust, wasm or Babylon types appear in them (0010).

### Crates (in dependency order)

- **`anim-math`:** SoA quaternion, vector and transform maths on `glam` with `core::arch::wasm32` `simd128` (4 lanes). Deterministic rules as in nav: no `mul_add`, no relaxed SIMD, no libm trig in hot paths.
- **`anim-format`:** binary layouts (`myco.anim@1` clips, `myco.skel@1` skeletons, `myco.animgraph@1` compiled graphs, `myco.posedb@1` pose databases). Flat, little-endian, `repr(C)`, 4-byte aligned, so TypeScript reads them as typed-array views without copying.
- **`anim-compress`:** the compressor from 0334: uniform sampling, range reduction, a bit rate per track chosen against an object-space error bound, as ACL does. It is used by the editor's worker and by exports, never at runtime.
- **`anim-sample`:** decompress and sample clips into SoA local poses; sample generic property tracks; sample discrete and event tracks over a time window.
- **`anim-pose`:** blend, additive, masked layered blend, local to model space, root-motion extraction, sync-marker phase maths.
- **`anim-graph`:** runs compiled graph programs (0335). State machines (transitions, requests, `travel` pathfinding), blend spaces 1D and 2D (triangulated), slots, linked graphs, sync groups, notify windows, chooser tables.
- **`anim-rig`:** the post-process rig stack:
  - IK: two-bone, FABRIK, CCD, full-body IK (a FABRIK-based solver over chains with a centre of mass)
  - look-at and aim
  - foot grounder (raycast results are passed in, see below)
  - spring bones (verlet with collision spheres and capsules)
  - copy, limit and damp constraints
  - distance, stride, orientation and motion warping
- **`anim-retarget`:** skeleton profiles, chain mapping, rest-pose compensation, runtime and offline retargeting.
- **`anim-match`:** motion matching. Feature extraction and normalisation, a KD-tree plus brute-force SIMD search over the pose database, trajectory prediction, inertialization blending. Baking the database also lives here.
- **`anim-physics`:** physical-animation drive targets. From a pose and a ragdoll description it computes joint motor targets and strengths per bone, and blends ragdoll poses back in. It computes targets only; simulation stays in the physics plugin.
- **`anim-wasm`:** the boundary.

### Build

- `npm run build:anim` runs `cargo build --target wasm32-unknown-unknown --release` with `-C target-feature=+simd128`, then `wasm-bindgen --target web` (glue for setup calls only), and writes into `src/plugins/animation/runtime/wasm/`.
- The output is committed. Only changes to `native/anim/` need the toolchain (pinned in `rust-toolchain.toml`, `wasm-bindgen-cli` pinned in `Cargo.toml`, as in nav).
- A source hash is embedded in the wasm, and `npm test` fails when the committed wasm is stale (0157's check).
- A **size gate** in `native/anim/build.mjs` is set from the first full build plus 20%. It is a tripwire (CLAUDE.md): raise it and log why rather than cut features.
- The crate also compiles natively, for `cargo test` and benchmarks (`cargo bench`, criterion).
- **No `simd128`, no animation.** Every engine Myco targets supports it (0157). A load failure warns once and leaves Animators frozen at their bind pose. There is no scalar or TypeScript fallback.

### Instances and threads

- **One module instance per page, shared by every World.** Worlds, the editor viewport and play mode are namespaces in it, so a clip or skeleton is loaded once (0157's model).
- **The dedicated server loads the same wasm in Node** (0033), because root motion, sockets and hit volumes are gameplay.
- **Lazy loading:** the module loads the first time a World has an Animator, a Tween or a timeline (0065's lazy loading). Games without animation never download it.
- **Single-threaded on the calling thread.** wasm threads need nightly `build-std` (stable Rust is pinned) and COOP/COEP headers, which plain web exports can't promise.
- **The core is still written as jobs.** It is a flat list of character evaluations with no shared mutable state between them, so a threaded runner would only change the runner (see Open questions).
- **Pose-database baking and clip compression run in a Web Worker** with their own instance, so the editor stays responsive.

### Memory and the boundary

- **All animation state lives in wasm memory:**
  - per-instance graph state (state machine nodes, playheads, transition and inertialization buffers)
  - local and model poses (SoA)
  - property-track outputs
  - notify records
  - tween state
- **Per frame, TypeScript makes a fixed number of calls, never one per character:**
  1. `write_inputs` copies blackboard parameter rows, Animator ECS fields, IK target transforms and raycast results into input views.
  2. `evaluate(world, dt_scaled, dt_unscaled)` runs every due instance.
  3. Output views are read:
     - bone matrices (model space, 3×4 floats)
     - root-motion deltas
     - property outputs (a value column per binding)
     - notify and state-change records
     - grounder raycast requests for the next frame
- **Handles are index plus generation**, as in audio, so a handle to a destroyed Animator is a no-op.
- **Assets:**
  - Clips, skeletons, compiled graphs and pose databases are copied into a pooled arena on load and released when the asset is released, or between editor play sessions.
  - Growth happens only in load calls, never inside `evaluate`.
  - `evaluate` never allocates.

### Frame order (amends nothing in 0011; adds built-in systems)

| Step (0011) | Animation systems |
|---|---|
| 4. fixed steps | `animation.FixedEvaluate`: Animators with `updateMode: "fixed"` (physics-driven and predicted characters) evaluate before the physics step; root motion is applied to `CharacterController` or kinematic `RigidBody` targets; ragdoll drive targets are pushed to the physics plugin |
| 5. after `update()` scripts | `animation.Gather` (blackboard and targets → inputs), `animation.Evaluate`, `animation.Apply` (property outputs → ECS columns, root motion for `"normal"` mode, notify dispatch, 0335) |
| 6. `lateUpdate()` | scripts see this frame's pose and may override bones through the API (0335), as Unity's LateUpdate does |
| 7. transform propagation | `BoneAttachment` nodes follow their bone (model-space bone × skeleton node's world matrix) |
| 8. render sync | the animation render hook uploads bone matrices and morph weights to Babylon (below) |

- The rig stack's grounder needs ground hits, so it reads the hits of rays requested last frame. `animation.Gather` casts them through the physics plugin's public ray API, never Rapier (0010). A one-frame-old hit is standard in grounders (Final IK does the same).
- IK targets that are nodes are read at their world transform from the previous propagation, plus the current local change of the target itself.

### Rendering

- **Skinned meshes stay engine-side data:** the `SkinnedMeshRenderer` component (0335) holds a mesh, a skeleton reference and bind matrices.
- **The Babylon backend only:**
  - uploads the bone matrices to a Babylon skeleton or bone texture (GPU skinning, 4 or 8 weights);
  - sets morph target weights (`MorphTargetManager`);
  - renders the result.
  
  Babylon's own `Animation`, `AnimationGroup` and `Skeleton.beginAnimation` are never used.
- Shadow casters, previews (0061) and thumbnails draw skinned meshes through the same path.
- **2D bones:** sprite skinning deforms a slice mesh (0334). It is drawn by a skinned quad-batch path in `render/babylon/quadBatches.ts`, with the bone palette as a uniform array.

### LOD and culling

- **Per Animator:**
  - `cullingMode`: `always`, `whenVisible` (pose frozen, playheads advance), or `rootMotionOnly`;
  - an update-rate LOD by screen size or distance: every 1, 2 or 4 frames, interpolating between poses;
  - the rig stack and spring bones switch off past a distance;
  - motion matching search drops to every N frames.
- **Server Worlds** evaluate only what gameplay reads: root motion, bones that `BoneAttachment`s or hit volumes use, and notifies. Bone matrices for skinning are not produced.

### Networking (0033)

- **Poses are never sent.** What replicates:
  - blackboard parameters marked `replicate`
  - the active state per layer, with its normalised time
  - slot plays (clip, start tick, sections)
  - linked-graph selections
  
  These are fields of the Animator component and use 0033's replication, quantisation and interpolation.
- **Clients re-evaluate.** Interpolated ghosts evaluate at the interpolated tick.
- **Predicted ghosts:** `updateMode: "fixed"` Animators on predicted ghosts are rolled back with their predicted fields. The core snapshots and restores an instance's graph state (a fixed-size blob per instance) for re-simulation.
- Determinism (no FMA, no relaxed SIMD) keeps root motion identical between client and server on the same inputs.

### Budgets (tripwires, checked by `cargo bench` and a profiler counter)

| Scenario | Budget on the reference machine (the 0157 machine) |
|---|---|
| 100 characters, 80 bones, a state machine with a 2D blend space, an upper-body slot, two-bone IK on both feet and a look-at | ≤ 1.5 ms per frame on the main thread |
| Motion matching, 20 characters, 30-minute database | ≤ 0.6 ms per frame |
| 1,000 property tweens | ≤ 0.2 ms per frame |

The editor's Profiler (0326) gets an Animation table: instances evaluated, skipped by LOD, time per stage.

## Alternatives considered

- **TypeScript evaluator, wasm later.** It would ship sooner, but there would be two implementations or a rewrite. The owner chose wasm by default.
- **Babylon's animation system, or a copy of it (0075's option).** It works on Babylon objects, isn't headless, and has no graph, IK, retargeting or matching. Copying it would give us the weakest part to start from.
- **`ozz-animation-rs` (MPL-2.0, 0.11.0) for sampling and blending.** Its SoA design is the model we follow, but as far as its documentation shows it loads archives built by ozz's C++ offline tools and has no builder of its own. Its clips are bones only, so not our generic property tracks. It would add MPL files to an MIT engine. We take the design and not the crate.
- **ACL (C++) compiled to wasm.** That is the best compression available, but it needs a C++ toolchain beside Rust in the build. We implement its approach (uniform sampling, variable bit rate per track, object-space error) in `anim-compress`.
- **wasm threads now.** Faster with many characters, but it needs nightly Rust and cross-origin isolation for every export. The job-shaped core keeps that open.
- **Bones as scene nodes (Unity).** Bones would be easy to parent and inspect, but every bone would be an entity, transform propagation would run over thousands of nodes, and the pose would cross the boundary each frame. Bones stay in the skeleton (Godot), with `BoneAttachment` for parenting (0335).

## Consequences

**Positive**
- One evaluator for the browser, Tauri and the server. Root motion and hit sockets are the same everywhere.
- SIMD SoA evaluation from day one, so the costs that make Unity and Godot slow with many characters are designed out.
- The same structure as nav and audio: committed wasm, a staleness check, a size tripwire, and native `cargo test`.

**Negative / costs**
- A third Rust workspace to maintain, so engine contributors touching animation need Rust.
- Everything is built before anything ships (owner's decision). It is a large build: the plan should run it in waves with reviews.
- No fallback: a browser without `simd128` gets no animation, only a warning.
- Two copies of each asset while loading (the file bytes and the arena copy) until the bytes are released.

## Deprecates

- 0088's warning "skins, animations, morph targets … ignored". They are imported (0334).
- The "Missing: animation" entries in implementation status for 0004/0075, 0044, 0088 and 0040 become this plugin's rows.

## Open questions

- **A threaded runner** when the page is cross-origin isolated and a stable-Rust path to wasm threads exists. It would change only the runner, but it needs its own record.
- **GPU compute skinning on WebGPU** for very large crowds, versus Babylon's vertex-shader skinning.

## References

- `native/nav/` and 0065 (workspace, committed wasm, lazy loading); `native/audio/` and 0157 (wasm vs native numbers, `simd128` support, staleness hash, size gate).
- `src/plugins/runtimeContext.ts` (`registerComponents`, `registerEngineSystems`); `src/engine/core/systems.ts` (phases, ordering).
- ACL: nfrechette/acl (compression approach). ozz-animation (SoA runtime design). Unreal Animation Blueprint threading (gather then evaluate).
