# Animation build: plan

Builds accepted records [0340](../../decisions/0340-animation-evaluates-on-an-engine-owned-rust-wasm-simd-core.md)–[0347](../../decisions/0347-audio-packages-are-named-biopak.md).

- **The records own the requirements.** This plan owns the order, the task IDs, file ownership and the gates. If a task and a record disagree, the record wins and the plan gets fixed.
- **Before working:** every agent reads [ground-rules.md](ground-rules.md).
- **Logs:** decisions made during the build go in [decision-log.md](decision-log.md); measurements and wave results go in [build-log.md](build-log.md).

## State at planning (checked 2026-11-22)

- **Branch:** `ccr-d1d28632-2asa2r`, based on `origin/master` at `87afe97a` plus the record commits. Records 0340–0347 are Accepted, and the records they amend are marked (0040, 0044, 0075, 0088, 0090, 0133, 0305, the overview's non-goal).
- **Animation code:** none exists. glTF skins, animations and morphs are dropped with a warning (`scene/gltf.ts`).
- **Audio branch:** `origin/ccr-8460d665-umr8or` is not merged. Master has moved on, so the branch will need a rebase or merge.
  - Its records 0327–0339 clash in number with master's 0327–0334.
  - The owner says it merges **before** the parts of this build that use it (gate **A**, below).
- **On master already:**
  - `core/curve.ts` (no Bézier keys yet), and the audio core's evaluator in `native/audio/crates/audio-core/src/automation.rs`;
  - `plugins/audio/editor/parameterList.ts` (0304) and `World._sendMessage` (0303);
  - the particle GPU runners (`render/particles/gpu/webgpuRun.ts`, `webgl2Run.ts`) and KSL (`render/shaderSource/`, 0250);
  - the physics joint types (`engine/physics/types.ts`: motors and springs on hinges and sliders only).
- **Plugin manifests** have hard `dependencies` only (`src/plugins/manifest.ts`). The catalogue (`src/plugins/catalogue.ts`) lists 14 first-party plugins.
- **Machine:** 4 cores, 15 GB RAM, about 59 GB of disk free.
  - Rust 1.99.1 (pinned by audio) with `wasm32-unknown-unknown` added, and `wasm-bindgen-cli` 0.2.130 (nav's pin) installed.
  - `node_modules` installed with `npm ci`.

## What every merge must satisfy (shippable)

- **Checks:** `npm run typecheck`, `npm test` and `cargo test` in `native/anim/` are green. Committed wasm matches its source: the coordinator rebuilds it at each wave merge.
- **Nothing that worked stops working.**
  - Projects without animation never load the animation wasm; that's lazy loading (0340).
  - Skinned models keep rendering as static meshes until the skinning task lands (M1).
  - The particles' generated WGSL and GLSL stay byte-identical through the executor refactor (T15).
- **No default flips.** Animation is a new plugin, so there's no old path to switch over. The one migration-like change is BioPak (T74), which only renames the audio package file.
- **Budgets are tripwires** (CLAUDE.md, 0340):
  - the wasm size gate;
  - the per-frame budgets (1.5 ms for 100 characters; 0.6 ms for motion matching; 0.2 ms for 1,000 tweens);
  - pose-database size.
  
  None is a task's acceptance criterion or a gate. They are measured, logged in the build log, and raised with a reason when passed. There are no real platform limits in this build.

## Gate A: the audio branch merges

Tasks marked **[A]** start only after the audio branch is merged into master and master is merged into this branch. They use the audio branch's:
- Bézier curves and shared curve editor (audio 0332);
- takes (audio 0334);
- component kit (audio 0335);
- playlist handles (audio 0329);
- packages (audio 0337).

Everything else is independent of it.

## Milestones and exit checks

| # | Milestone | Tasks | Exit check (a person can run it) |
|---|---|---|---|
| M0 | Foundations and contracts | T01–T06 | `npm run build:anim` builds and the staleness test passes; the animation plugin shows in Project settings > Plugins; the smoke spec runs (an empty scene with an Animator reports "core loaded") |
| M1 | Skeletal playback | T10–T18 | Drop a skinned `.glb` in the editor, press Play: it animates, with shadows. The same in an exported web build opened cold in a browser. `samples/playground3d` still renders |
| M2 | Tracks, sprites, tweens, timelines | T20a, T21–T24 | A clip keys a light's intensity and a material colour; a sprite flipbook plays; `await tween(...)` works in a script; a timeline drives two nodes |
| M3 | Graph | T30–T34 | A graph asset with a locomotion blend space, a jump request and an upper-body slot runs from a script; `travel()` works; a networked client sees the same state (two-World test) |
| M4 | Procedural | T40–T44 | Foot IK on uneven ground, look-at, spring bones; a clip retargeted between two profile-mapped skeletons; motion matching over a small database; a powered ragdoll falls and gets up |
| M5 | Editor tools | T50a, T51–T56 | Author a clip in the Animation window with record mode; build a state machine in the graph editor; debug it live in Play; edit a timeline; map bones and retarget; build a ragdoll; make a flipbook and a 2D bone rig |
| M6 | Debug link | T60 | A desktop or web build started with `--debug-link` appears in the editor's connected-builds menu; the animation debugger inspects it |
| M7 | After gate A | T70–T74 | Value curves with Bézier keys play; curve lanes in the Animation window; a play waits for the music's next bar; a take replays animation requests; audio packages export as `.biopak` |
| M8 | Finish | T80–T82 | User guide, implementation status rows, e2e specs green, budgets measured in the build log |

**Every milestone's exit includes the shipped-form smoke:** an exported web build, served with `node serve.mjs` and opened cold, with no editor state.

**Objective detectors** for things a person would judge by eye:
- **Pose correctness:** bone matrices compared with `anim-offline` within stated tolerances.
- **Skinning:** captures diffed against a reference capture, with a pixel threshold.
- **Foot sliding:** the planted foot's world-space drift per stance, from the `marker` tracks, under a threshold.

## Tasks

Estimates are agent-days, **estimated** (no animation actuals yet; calibrated after the pilot wave).
- **Leads:** **S** = strongest model (Opus), **M** = mid model (Sonnet), **L** = leaf (Haiku, filling a skeleton to a quoted spec).
- **Rust** marks tasks that build `native/anim/`. At most two run at once.

### M0: Foundations and contracts

| ID | Task | Lead | Est. | Depends | Records |
|---|---|---|---|---|---|
| T01 | **Plugin skeleton and API contract.** See below. | S | 1.5 | — | 0340, 0342 |
| T02 | **Rust workspace and boundary contract.** See below. | S, Rust | 1.5 | — | 0340 |
| T03 | **Format contracts.** See below. | S | 1.5 | — | 0341, 0342 |
| T04 | Optional plugin dependencies (0344): `optionalDependencies` in the manifest, `order.ts`, `pluginSet.ts`, `enabled.ts`, `ctx.plugins.isActive`, re-activation on toggle, tests | M | 1 | — | 0344 |
| T05 | `@field` `animatable` (0341): option and defaults by type in `registry.ts`; opt-outs on built-ins where animating breaks invariants (physics body type, collider shape kind); tests | M | 0.5 | — | 0341 |
| T06 | Smoke spec `tests/e2e/animation.spec.ts`, grown each milestone (coordinator-run) | Coordinator | 0.5 | T01 | — |

- **T01, plugin skeleton and API contract:**
  - `src/plugins/animation/{manifest.ts, runtime/, editor/}`.
  - **Every component class with its fields:** `Skeleton`, `SkinnedMeshRenderer`, `Skeleton2D`, `Animator`, `BoneAttachment`, `TimelineDirector`, and the tween data component.
  - **Every public method declared,** delegating to `runtime/features/<feature>.ts` stubs that throw "not built". Features: `playback`, `graph`, `ik`, `warp`, `tweens`, `timeline`, `bones`.
  - **Buffers declared:** `AnimationEvents`, `AnimatorStateChanges`, `RootMotion`.
  - **Built-in system names and phases declared** in `runtime/systems.ts`, delegating to `runtime/stages/<stage>.ts`.
  - The `myco` exports, added once (`src/myco.ts`), and the catalogue entry.
- **T02, Rust workspace and boundary contract:**
  - `native/anim/`: workspace, `rust-toolchain.toml` (1.99.1), every crate from 0340 as a stub with its own `Cargo.toml`, and workspace dependencies (`glam`, `wasm-bindgen =0.2.130`).
  - `build.mjs` (`npm run build:anim`), the source-hash staleness test, and the size gate (initial value: first build plus 20%).
  - **`anim-wire` families**, one file each: `core`, `tracks`, `graph`, `rig`, `match`, `tween`, `timeline`, `physics`. A generator writes `runtime/wasm/wire/<family>.ts`, with a round-trip test.
  - **`anim-wasm` module stubs**, one file per feature, with the `mod` lines written once.
  - The TS loader: lazy, one instance per page, Node too.
- **T03, format contracts:**
  - The `myco.anim-source@1` parse and write (TS, lenient, limits declared once, references rewritten through an asset kind, 0314).
  - The `*.animgraph.json`, `*.timeline.json`, `*.mask.json`, `*.skelprofile.json` and `*.posedb.json` types, parses and asset kinds, with limits.
  - The `myco.anim@1`, `myco.skel@1`, `myco.animgraph@1` and `myco.posedb@1` binary header layouts in `anim-format`, with a TS header reader.
  - The node catalogue schema type, and the `boneMap` guess stub (`runtime/retarget/boneMap.ts`, returns `{}`).

### M1: Skeletal playback

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T10 | `anim-math` (SoA quat, vec, transform on `glam` with `simd128`; deterministic rules) and `anim-offline`'s scalar f64 reference for the same operations; property tests comparing them | S, Rust | 2 | T02 |
| T11 | `anim-compress` (uniform sampling, constant and default tracks, range reduction per 16-frame segment, bit-rate search against object-space error with virtual vertices) and `anim-sample` bone tracks; error report; tests against `anim-offline` | S, Rust | 3 | T10, T03 |
| T12 | `anim-pose`: blend, additive, masked layered blend, local to model, root-motion extraction, sync-phase maths | M, Rust | 1.5 | T10 |
| T13 | `anim-wasm` v1: asset arena (clips, skeletons), instance table (index plus generation), `write_inputs`/`evaluate`/outputs (bone matrices 3×4, root deltas) for a clip player and crossfades; TS host `AnimationCore` (the World service) | S, Rust | 2 | T11, T12 |
| T14 | **Import** (see below) | S | 3 | T03 |
| T15 | **GPU kernel executor:** generalise `render/particles/gpu/webgpuRun.ts` and `webgl2Run.ts` into `render/gpuKernels/` (KSL kernel over N items, inputs, outputs, WebGPU and WebGL2 backends); particles move onto it with byte-identical generated shaders (test) | S | 2 | — |
| T16 | **Skinning** (see below) | S | 3 | T15, T13 (bone matrix layout from T02 wire) |
| T17 | **ECS integration** (see below) | S | 2.5 | T13, T01 |
| T18 | **Editor M1** (see below) | M | 2 | T14, T17 |

- **T14, import:**
  - glTF skins, skeleton, clips (TRS, `STEP`/`LINEAR`/`CUBICSPLINE`), morph targets, `KHR_animation_pointer` (the full mapping table from 0341, with one warning for unmapped pointers), `KHR_node_visibility`;
  - FBX skins, stacks and blend shapes through `FBXLoader`;
  - 4 influences by default, 8 by sidecar, normalised;
  - the sidecar `animation` section (clips, root motion, additive, compression, markers, events, curves, `profile`, `boneMap` through the T03 stub, `influences`);
  - baked models (0090) carry skin and morph data;
  - fixtures: a Blender export and a Mixamo-style FBX built from CC0 assets.
- **T16, skinning:**
  - the KSL `mycoSkin` function (morph deltas, then 4- or 8-influence skinning of position, normal and tangent);
  - WebGPU dispatch into a vertex storage buffer; WebGL2 through the executor (spike: float textures with vertex pulling versus transform feedback, measured and logged);
  - `SkinnedMeshRenderer` render sync drawing the skinned buffer for every pass; 2D skinned quads through the quad-batch path;
  - the KSL JS output tested against `anim-offline`.
- **T17, ECS integration:**
  - `Skeleton`, `SkinnedMeshRenderer`, `Animator` code-first (`play`, `crossfade`, `state`, `layerWeight`, promises with reasons) and `BoneAttachment`;
  - stages `Gather`, `Evaluate`, `Apply` and `FixedEvaluate` in the frame order from 0340;
  - root motion modes; lazy load; server mode (no skinning output); culling and update-rate LOD;
  - tests through the public API on a headless World.
- **T18, editor M1:**
  - dropping a skinned model adds `Skeleton`, `SkinnedMeshRenderer`s and an `Animator` (`modelNodeEntries`);
  - bones as read-only Hierarchy entries, with a bone target in `inspectorTarget.ts` (0242) and a bone gizmo with "Add BoneAttachment";
  - clip preview in the Asset Inspector through the thumbnail renderer's live preview.

### M2: Tracks, sprites, tweens, timelines

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T20a | **Property tracks without curves** (see below) | S, Rust | 3 | T17 |
| T21 | Sprites: image-sidecar `flipbooks` to `#Flip/` clips; `SpriteRenderer.sprite` animatable; 2D bone data in slices (`skin`); `Skeleton2D` runtime driving the T16 2D skinning | M | 2 | T20a, T16 |
| T22 | **Tweens** (see below) | M, Rust | 2 | T20a |
| T23 | `TimelineDirector` runtime: `*.timeline.json` bindings, `subclip`, `control` (particle play and stop, camera cut, nested slot), `activation`, `audio` tracks (0158 events now; playlists after A), wrap modes, `play()` promise | S, Rust | 2.5 | T20a |
| T24 | Live texture transforms for animated materials (0341: not baked into UVs when animated); material, light and camera fields animatable through the render sync | M | 1.5 | T14, T20a |

- **T20a, property tracks without curves:**
  - the binding table to ECS columns, with the bulk scatter in `Apply`;
  - `discrete`, `activation`, `morph`, `event`, `marker`, `subclip` and `control` kinds in `anim-sample`;
  - `event` delivery through `World._sendMessage` (0303) plus the `AnimationEvents` buffer, with notify states;
  - value tracks (`float`… `color`, `quat`, `curve`) sampled **linearly from uniformly resampled data** until T70 adds the engine-curve evaluator.
  
  That's not rework: the compiled clip already stores resampled values (0341's compression samples every track uniformly), so T70 changes only the editor-side source curves and the runtime curve tracks of tweens and timelines.
- **T22, tweens:**
  - the core tween table, the ECS data component, `tween()`, `sequence()` and `parallel()`;
  - Penner easings by name (custom engine-curve easing after A, T70);
  - loops (restart, yoyo), time scales, and destroyed targets (resolve `"destroyed"`).

### M3: Graph

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T30 | **Graph compiler (TS):** `*.animgraph.json` to `myco.animgraph@1`; the node catalogue (one parameter schema per node, the catalogue file); structured conditions; root curves extracted from root-motion clips for prediction (0340); problems with paths | S | 2.5 | T03 |
| T31 | **`anim-graph` runtime** (see below) | S, Rust | 5 | T30, T20a |
| T32 | Animator graph API: `set`, `request`, `travel`, `jump`, slot `play` with sections, `link`, `state`, `compute` (computed parameters run in `Gather`), `bone()` overrides in lateUpdate, `animatorParams(entity)` view, the `AnimatorStateChanges` buffer | M | 2 | T31 |
| T33 | **Networking** (see below) | S | 2.5 | T31, T32 |
| T34 | Profiler Animation table (0326 kit) and counters: instances evaluated and skipped, time per stage | M | 1 | T17 |

- **T31, `anim-graph` runtime:**
  - state machines: priority transitions, `when`/`how` with `bridge`, inertialization, requests with lifetimes, `travel` pathfinding, `jump`, any-state, sub-machines;
  - blend, additive and masked layers; slots; linked graphs swappable at runtime; chooser tables; the seeded random selector;
  - blend spaces 1D and 2D;
  - sync groups and markers; notify weights.
  - **Leaves:**
    - L31a: Delaunay triangulation, barycentric weights and hull projection as a pure function in `anim-graph/src/triangulate.rs`, to the audio Blend rule in 0342;
    - L31b: inertialization (Bollo's quintic) in `anim-pose/src/inertialize.rs`, with tests from quoted values.
- **T33, networking:**
  - replicated `Animator` fields (parameters marked `replicate`, active states with normalised time, slot plays, links);
  - interpolated ghosts evaluate at the interpolated tick;
  - the hybrid predicted root motion: the `animation.PredictedRootMotion` system samples root curves and moves the `CharacterController` with physics queries;
  - server gameplay-only evaluation;
  - a two-World test.

### M4: Procedural

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T40 | **`anim-rig`** (see below) | S, Rust | 4 | T31 |
| T41 | **`anim-retarget`** (see below) | S, Rust | 3 | T31, T14 |
| T42 | **`anim-match`** (see below) | S, Rust | 4 | T31 |
| T43 | `BallJoint` swing and twist limits and target-rotation drive (0345): types, `Joint.ts`, the backend interface, `physics-rapier` mapping (first confirm per-axis motors on spherical joints, else the generic joint), joint gizmo cone and twist arc; tests | M | 2 | — |
| T44 | **`myco.ragdoll` plugin runtime** (see below) | S | 3 | T43, T31 |

- **T40, `anim-rig`:**
  - solvers: two-bone, FABRIK, CCD, full-body IK, look-at and aim with limits;
  - the grounder, with ray requests and responses cast by `Gather` through the physics plugin's public ray API;
  - spring bones with colliders;
  - copy, limit and damp constraints;
  - distance, stride, orientation and motion warping;
  - `Animator.ik()` and `warp()`; weights driven by parameters and curves.
  - **Leaves:**
    - L40a: two-bone IK in `anim-rig/src/two_bone.rs`;
    - L40b: CCD in `ccd.rs`;
    - L40c: look-at and aim in `look_at.rs`.
    
    Each fills a skeleton to a quoted spec, tested against `anim-offline`.
- **T41, `anim-retarget`:**
  - the built-in Humanoid profile;
  - chain retargeting with rest-pose compensation, root and goal scaling, optional IK pinning;
  - `guessBoneMap` filled into the T03 stub (name heuristics);
  - runtime retarget node; the offline bake function.
- **T42, `anim-match`:**
  - feature extraction and normalisation, KD-tree plus SIMD brute force, trajectory prediction (spring-damped), tags;
  - the database bake in a Web Worker;
  - inertialized switches; chooser integration;
  - the pose database node;
  - tests on a small synthetic database (no large database, owner 2026-11-22).
- **T44, `myco.ragdoll` plugin runtime:**
  - `src/plugins/ragdoll/runtime/`: the `Ragdoll` component and fixed-step systems;
  - body and joint generation from the skeleton;
  - `anim-physics` drive targets into `drive.targetRotation`; the physical pose back as the graph input;
  - pinning and blend; get-up from a pose snapshot.

### M5: Editor tools

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T50a | Animation window: dope sheet (rows per binding, keys, box select, move, scale, copy, ripple), record mode (Inspector and gizmo changes write keys; key buttons on animatable fields), event, marker, audio and activation rows, onion skin, edit-mode preview through the core. **Curve lanes are T71 [A]** | S | 4 | T20a, T05 |
| T51 | Graph editor on `src/editor/graph/` (xyflow): see below | S | 5 | T30, T32 |
| T52 | Live debugger: graph overlay (active nodes, weights, phases), why-not transitions, request lifetimes, live editable parameters; the in-memory 10 s recorder with scrub (re-evaluation from inputs) | S | 3 | T51 |
| T53 | Timeline window: tracks and bindings, clips with blend regions, control, subclip, activation and audio tracks, camera cuts, nested timelines, edit-mode scrub | M | 3 | T23, T50a |
| T54 | Skeleton and retarget tools (bone map editor with auto-guess and mirror, chain editor, side-by-side retarget preview, Bake retargeted clip) and clip import settings (take strip, loop pose-match indicator, root motion, additive reference, compression error with size and maximum error) | M | 3 | T41, T14 |
| T55 | Pose database tool (clips, tags, features, bake with progress, trajectory and chosen-pose debug view) and the ragdoll builder (`src/plugins/ragdoll/editor/`: generate from skeleton and profile ranges, edit shapes and limits with gizmos, test drop) | M | 3 | T42, T44 |
| T56 | 2D tools: flipbook from selected slices (Sprite Editor and Assets panel); 2D bone editor in the Sprite Editor (place bones, generate mesh, paint weights, auto-weight) on its undo history | M | 3 | T21 |

- **T51, graph editor contents:**
  - pose nodes, nested state-machine canvases, transitions with priority numbers;
  - the transition list with condition rows; the blend space editor; the chooser table;
  - linked-graph picker and masks;
  - parameters through `parameterList.ts`, moved into the editor SDK;
  - node cards generated from the catalogue; rig-stack entries with viewport gizmos;
  - refused-or-next edits (0307, 0313).

### M6: Debug link

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T60 | **Debug link (0346)** (see below) | S | 3 | — |

- **T60 contents:**
  - `src/engine/debugLink/`: session, envelope, topic registry, pulled subscriptions with rate limits; over `net/transport/`, never `net/session.ts`; WebRTC for remote devices;
  - `src/editor/debugLink/`: listener, accept prompt, connected-builds menu;
  - `game.json` `debug`, `--debug-link`; stripped from release exports (test);
  - the animation topic used by T52.

### M7: After gate A

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T70 [A] | `myco-curve` crate (`native/common/curve/`): the engine-curve evaluator moved out of `audio-core/src/automation.rs` (Bézier included), audio depending on it, one parity test against `core/curve.ts`; animation's source value curves, tween custom easing and runtime curve tracks evaluated through it | S, Rust | 2 | A, T20a, T22 |
| T71 [A] | Curve lanes in the Animation window and the Timeline through the shared curve editor (`src/editor/ui/curves/`); generic kit parts (audio 0335) where screens use them | M | 2 | A, T50a, T53 |
| T72 [A] | Musical timing: `at: beat \| bar \| exit`, `align: hit` against an `AudioPlaylistHandle`; audio as an optional dependency (T04) | M | 1.5 | A, T04, T32 |
| T73 [A] | Takes: `ANIM_*` records in the take recorder and reader, editor replay of animation requests against the current project | S | 2.5 | A, T32, T52 |
| T74 [A] | BioPak rename (0347): `.biopak`, `BIOPAK01`, `myco.biopak@1`, names in the UI and report, refusal of `MYCOPAK1`; mark audio 0337 "amended by 0347" | M | 1 | A |

### M8: Finish

| ID | Task | Lead | Est. | Depends |
|---|---|---|---|---|
| T80 | User guide `docs/guide/animation.md`; implementation-status rows for 0340–0347; glossary terms | M | 1.5 | all |
| T81 | e2e specs: animation smoke (grown), editor flows (record a key, build a state, debug live), exported-build smoke cold-loaded; WebKit run | Coordinator | 2 | all |
| T82 | Benchmarks against the 0340 budgets (tripwires) on this machine, logged; the size gate reviewed | M | 1 | all |

**Not in this build** (owner, 2026-11-22):
- a character sample project and a large pose database;
- mixed-asset packages (a later record);
- the shared expression language (later, with audio);
- worker threads.

## Critical path (estimates)

- **Pure dependency chain:** T02 (1.5) → T10 (2) → T11 (3) → T13 (2) → T17 (2.5) → T20a (3) → T31 (5) → T40 or T42 (4) → T52 via T51 (5 + 3). About **31 days**, estimated.
  - **Start early:** T10 right after T02 (the Rust spine); T15 in wave 1 (it isn't on the spine but blocks T16); T30 as soon as T03 lands (it feeds T31).
- **Staffing queue:** the strongest model isn't one person here; agents run in parallel. The real queue is **Rust builds, capped at two concurrent on 4 cores**. In order: T02, T10, T11, T12, T13, T20a, T22, T23, T31, T40, T41, T42, then T44's `anim-physics`, then T70. That's about 37 Rust-days, which at two at a time is about 19 days, shorter than the pure chain.
  - **Tasks sitting on the queue only because of the cap:** T12 (it waits behind T11's builds) and T22/T23 (behind T20a).
- **Gate A** sits outside both chains. M7 can't start until the audio branch merges.

## Waves

Concurrency: at most four agents, at most two of them building Rust. No agent runs Playwright; the coordinator runs e2e at wave ends (CLAUDE.md).

| Wave | Tasks | Rust | Notes |
|---|---|---|---|
| W0 (pilot) | T01, T02, T03, T04, T05 | T02 | contracts first; T06 by the coordinator after merge |
| W1 | T10, T14, T15, T43 | T10 | T43 and T60 are independent fillers |
| W2 | T11, T12, T30, T60 | T11, T12 | |
| W3 | T13, T16, T34 | T13 | T16 can start on the executor with the wire's bone layout before T13 lands |
| W4 | T17, T18-prep, T21-data, T24-prep | — | T18, T21, T24 split: data and parse parts now, runtime parts after T17 and T20a |
| W5 | T20a, T22 | T20a, T22 | T22 starts its TS half first, then its Rust half after T20a's merge |
| W6 | T23, T31, T18, T24 | T23, T31 | |
| W7 | T32, T21, T50a, T41 | T41 | |
| W8 | T33, T40, T42, T51 | T40, T42 | |
| W9 | T44, T52, T53, T54 | T44 (anim-physics) | |
| W10 | T55, T56, T80 (draft), T82 | — | |
| W11 [A] | T70, T71, T72, T73, T74 | T70 | after gate A |
| W12 | T80, T81, coordinator e2e and shipped smoke | — | |

## Hotspots and rework (audit)

| File or area | Touched by | Fix |
|---|---|---|
| `native/anim/Cargo.toml` (workspace) | every Rust task | **single writer:** T02 lists every crate and workspace dependency; later tasks edit only their crate's `Cargo.toml` and report new workspace dependencies to the coordinator |
| `native/anim/Cargo.lock` | every Rust task | tasks commit it; the coordinator regenerates it on a merge conflict (`cargo build` after taking either side) |
| committed wasm and generated wire TS | every Rust task | **coordinator-only:** tasks build locally and don't commit `runtime/wasm/`; the coordinator runs `npm run build:anim` and commits at each wave merge |
| `anim-wasm/src/lib.rs` | T13, T20a, T22, T23, T31, T40–T42, T44 | **seam:** T02 writes every `mod` line and a stub file per feature; tasks fill their own file |
| `anim-wire` records | same | **seam:** one file per family (T02); a task adds records only to its family |
| `Animator.ts` methods | T17, T32, T40 (ik, warp) | **seam:** T01 declares every method delegating to `features/<feature>.ts`; tasks fill their feature file |
| `runtime/systems.ts` | T17, T20a, T33, T44 | **seam:** stages in `stages/<stage>.ts`; system list written once by T01 (T44's systems live in the ragdoll plugin) |
| `src/myco.ts` exports | T01, later API | **single writer:** T01 exports every public name once; later additions go through the coordinator |
| `src/plugins/catalogue.ts` | T01, T44 | coordinator adds `animation` (W0) and `ragdoll` (W9) |
| `scene/gltf.ts`, `models.ts`, `bakedModel.ts`, `importSettings.ts` | T14, T41 (bone map), T24 (texture transform) | T14 owns them. Bone-map guessing goes through the T03 stub that T41 fills (no edit to import files). T24 changes only the material side (`render/babylon/materials.ts`), reading a flag T14 records per material ("animated texture transform") |
| `render/particles/gpu/*` | T15 | T15 alone; particles keep byte-identical shaders |
| `render/babylon/` mesh sync | T16, T24 | different waves (W3, W6) and different files (`skinnedMeshes.ts` new vs `materials.ts`) |
| `src/editor/inspectorTarget.ts` | T18 | T18 only; T50a's key buttons go in the field renderer, not the target |
| `plugins/audio/editor/parameterList.ts` → SDK | T51 | T51 moves it in one commit, with audio's imports updated; no other task in W8 touches audio editor files |
| Physics plugin files | T43 | T43 only; T44 lives in `src/plugins/ragdoll/` |
| `docs/README.md`, `implementation-status.md`, `docs/design/animation/*`, `package.json` | — | **coordinator-only**; T02's `build:anim` script is a named grant |

## Contracts

| Contract | Lands | Lets run in parallel |
|---|---|---|
| Component classes, method stubs, buffers, system names, `myco` exports (T01) | W0 | T17, T18, T21, T22, T23, T32, T40 against fixed signatures |
| Wire families and the wasm module stubs (T02) | W0 | every Rust task, and T16 (bone matrix layout) |
| Source formats, asset kinds, binary headers, catalogue schema, boneMap stub (T03) | W0 | T14, T30, T41, T50a, T51, T53 |
| `AnimationCore` host interface (T13) | W3 | T17 |
| Node catalogue file (T30) | W2 | T31, T51 |
| Debug link topic API (T60) | W2 | T52 |
| `render/gpuKernels/` executor interface (T15) | W1 | T16 |

## Test cadence

- **Per task:** `npm run typecheck`, the touched tests (`npx vitest related <files> --run`), and `cargo test -p <crate>` for touched crates.
- **Wave end (coordinator):**
  - full `npm test`, `cargo test` for the workspace, `npm run build:anim` plus the staleness test, `npm run build`;
  - `npm run test:e2e` (the default suite) and the animation smoke;
  - deterministic gates (offline-reference tolerances, byte-identical particle shaders).
- **Milestone end:** `test:e2e:slow`, WebKit, the shipped-form smoke (exported build, cold load), and benches logged.

## Pilot wave (W0): measures

- Leaf and mid first-pass success: checks green on the first report without coordinator fixes.
- Lead time per contract task: hours from brief to merge.
- Rust build times in a fresh worktree (cold and incremental), and disk per worktree `target/`.
- Tokens per model.

**If W0 falls short:**
- **Contracts reopened in W1:** add a contract-review step before each wave.
- **Rust builds over 10 minutes cold:** share a `CARGO_TARGET_DIR` per wave.
- **Mid tasks need heavy fixes:** move M tasks to S.
