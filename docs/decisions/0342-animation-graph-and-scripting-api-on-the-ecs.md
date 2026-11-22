# 0342. Animation graphs, state machines, rigs, retargeting, motion matching and physical animation are driven through ECS components, a typed blackboard and a code-first Animator API

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0011, 0017, 0033, 0133, 0158, 0303, 0340, 0341, 0343; audio 0329 (playlists: Blend, Switch rules, Queue picks, stingers), audio 0331 (one catalogue, one parameter schema), audio 0336 (fade shapes, exit markers, bridges)

## Context

What each engine does best, and what goes wrong:

- **Unity's Animator Controller** becomes "transition spaghetti". Triggers stay set and fire late. Exit time and interruption rules are hidden. Code can't easily read what the Animator is doing. Animancer exists to play clips from code instead.
- **Unreal's AnimGraph** is the strongest evaluation model: a pose dataflow graph that state machines, blend spaces and layers live inside, fed by a gather phase. Its Montages and slots let gameplay fire one-shots without editing the state machine.
- **Godot's `StateMachine.travel()`** finds a path through the graph to a target state.
- **Final IK, Control Rig and Godot's SkeletonModifier3D** cover procedural adjustments. Godot's model, an ordered modifier stack, is the cleanest.
- **Unreal's Motion Matching and warping, and PuppetMaster's active ragdolls,** are the high end of locomotion.

**Myco's constraints:**
- Scripts are `GameBehavior`s over a hidden ECS (0007).
- There is no engine event or signal system: behaviours talk through method calls or data, and engine notifications are lifecycle hooks plus buffers (0017).
- The owner's decision (2026-11-22): every TypeScript part with behaviour, data or systems is built on the ECS stack (`@component` classes, `defineComponent`, `defineBuffer`, built-in systems registered through the plugin's runtime context).

**Reused from the audio playlists.** Audio's playlists (audio 0329, 0336) already solve the musical version of several animation problems:
- a 2D blend with Delaunay triangulation and hull projection;
- change rules that say *when* (now, at a boundary, at an Exit marker) and *how* (crossfade, cut, through a bridge);
- seeded random, shuffle and round-robin picks;
- stingers landed on their Hit point;
- one set of fade shapes.

This graph uses the same rules and words, so a designer who knows one knows the other. Behaviour messages already go through one World operation (0303). Records cited as *audio NNNN* are on the audio branch `ccr-8460d665-umr8or`, not yet merged. Their numbers clash with master's 0327–0334 and will change when that branch merges; the titles are the stable reference.

## Decision

### ECS components (the animation plugin's runtime half)

| Component | Data | Notes |
|---|---|---|
| `Skeleton` | skeleton asset, profile, retarget source | on the rig root; the pose itself lives in the core (0340), bones aren't nodes |
| `SkinnedMeshRenderer` | mesh, material slots, skeleton node, bounds mode | replaces `MeshRenderer` for skinned meshes; morph weights are animatable fields |
| `Skeleton2D` | bones (from the image sidecar, 0341) | drives skinned sprites |
| `Animator` | graph asset (optional), linked-graph overrides, parameter defaults, `updateMode` (`normal`/`unscaled`/`fixed`), `cullingMode`, LOD, `rootMotion` (`none`/`transform`/`characterController`/`rigidBody`), IK target node bindings, replicated state fields (0340) | one per animated hierarchy; its tracks bind relative to its node |
| `BoneAttachment` | skeleton node, bone, offset, `follow` (`position`/`rotation`/`both`) | a node that follows a bone; for weapons, props and hit volumes |
| `TimelineDirector` | timeline asset, bindings (track → node), play on start, wrap mode, time | plays a `*.timeline.json` |
| `Ragdoll` | per-bone body shape, mass, joint limits, motor strengths, `mode` (`off`/`ragdoll`/`powered`), blend | created from a skeleton in the editor (0343); bodies and joints go through the physics plugin's public interface |
| Tween data (`defineComponent("animation.Tweens", …)`) | handles into the core's tween table | added to the target's entity by `tween()`; removed when the entity's tweens end |

**Buffers (0017):**
- `AnimationEvents`: `{ node, animator, method, phase, args, clip, time }`.
- `AnimatorStateChanges`: `{ animator, layer, from, to }`.
- `RootMotion`: `{ node, delta }`. Filled for `rootMotion: "none"` too, so systems can consume it themselves.

**Built-in systems:**
- `animation.Gather`, `Evaluate`, `Apply` and `FixedEvaluate`, as ordered in 0340.
- `animation.Timeline`, before `Gather`.
- `animation.Ragdoll`, inside the fixed step, after `FixedEvaluate` and before the physics step.

All are registered with `registerEngineSystems`, so the System catalogue and Worlds panel (0032) show them.

### The graph (compiled to `myco.animgraph@1`, run by `anim-graph`)

- **A pose dataflow graph.** Every node outputs a pose (and its sync phase). The output node feeds the rig stack, then the result.
- **Sources:**
  - clip player (speed, start, loop, mirror);
  - blend space 1D and 2D, using audio Blend's rules (audio 0329): piecewise-linear 1D, Delaunay-triangulated 2D with barycentric weights, points outside projected onto the nearest hull edge, optional `follow: { glideMs }` input smoothing; plus sync groups and a speed parameter that scales by the sampled root speed;
  - pose database (motion matching);
  - pose snapshot (a frozen pose, e.g. for ragdoll get-up);
  - reference and bind pose.
- **Logic:**
  - **Random selector** (audio's Queue picks): `random` (weighted, avoiding the last N), `shuffle` or `roundRobin` over child sources, picked once per entry from the World's seeded generator. For idle variations and hit reactions, and replayable.
  - **State machine.** States hold sub-graphs. Transitions are listed per state in **explicit priority order**, each with:
    - a condition (an expression over parameters, `state.time`, `state.normalizedTime`, sync phase and curves);
    - **`when`**, in audio's Switch-rule words (audio 0329): `now`, `exit` (the next `exit` marker of the playing clip, else its end), `marker:<name>` (the next sync marker of that name), or a normalised time;
    - **`how`**: `crossfade` (duration plus a shape from the shared fade-shape set, audio 0336), `cut`, `inertialize`, or `bridge` (play a bridge clip or state between them, entering the target at the bridge's `exit` marker or end, as audio's transition entries do);
    - `canInterrupt` (by which transitions).
  
    Also: any-state transitions with their own priority, sub-machines, entry and exit.
  - **Chooser table** (Unreal): rows of conditions → a clip, blend space or database.
- **Mixing:** blend by weight, blend by enum or bool, additive (with a reference pose), layered blend by mask (bone-mask or profile-role assets, 0341), time scale, mirror (via the profile's left and right map).
- **Slots:** named insertion points where code plays one-shots over the graph (below). This is Unreal's slots and montages.
- **Linked graphs:** a node that runs another `*.animgraph.json` with its own parameters. It can be swapped per instance at runtime (weapon layers, Lyra's pattern; this also covers Unity's Override Controllers).
- **Sync groups:** members follow a leader's phase by `marker` tracks (feet), so blends never slide.
- **Notifies:** `event` tracks of every contributing clip fire when the clip's weight exceeds a threshold (default 0.5, per notify), or always for `"always"` notifies.
- **One node catalogue:** every graph and rig node declares its parameters once, in one schema (as audio's effect catalogue, audio 0331): name, kind, unit, range, default, animatable. The compiler, the core's node table, the graph editor's cards and third-party nodes (0340) all read it.
- **Rig stack** (`anim-rig`), an ordered list at the graph's output or at any point. Each entry has a weight that a parameter or curve can drive:
  - two-bone IK, chain IK (FABRIK, CCD), full-body IK (effectors for hands, feet, hips, head, centre of mass)
  - look-at and aim (with limits)
  - foot grounder (pelvis offset, foot pitch and roll from ground normals)
  - spring bones (chains with stiffness, damping, gravity, and colliders bound to bones)
  - copy, limit and damp constraints
  - distance and stride warping, orientation warping
  - motion warping (`warp("Vault", target, window)` from code)
  - retarget (below)
- **Retargeting:**
  - Clips authored on another skeleton play through **profile-based chain retargeting**: the source and target profiles map roles to bones, and the chains (spine, arms, legs, fingers, head) transfer rotations relative to each rest pose.
  - Root and IK goals are scaled by leg length.
  - An optional IK pass pins hands and feet to retargeted goals.
  - The same code also bakes retargeted clips offline (0343).
- **Motion matching:**
  - A pose database is baked from tagged clip ranges: features are bone positions and velocities plus the future and past trajectory, normalised, with per-feature weights.
  - At runtime the query is built from the current pose and a predicted trajectory (from `CharacterController` velocity and the desired-velocity parameter, spring-damped).
  - Searches run every N frames, or immediately on a large change.
  - Switches use **inertialization**.
  - Tags (e.g. `idle`, `start`, `pivot`) gate the search through parameters or chooser tables.
- **Physical animation:** `Ragdoll.mode`:
  - `ragdoll`: bodies simulate, and the pose reads back from them;
  - `powered`: joint motors drive bodies toward the animated pose with per-bone strengths, and a pinning strength holds the root (PuppetMaster).
  
  `blend` mixes the physical pose with the animated pose. Get-up uses a pose snapshot and a get-up state chosen by the pelvis facing.

### Scripting API (public, from `myco`)

```ts
const anim = this.node.getComponent(Animator);

anim.set("speed", 3.2);                    // typed: float | int | bool | vec2 | vec3 | quat | node
anim.request("Jump", { within: 0.2 });     // consumed by a transition, or expires; never stale
anim.travel("Crouch", { layer: "Base" });  // pathfind through the state machine (Godot)
anim.jump("Dead");                         // cut directly, no path
await anim.play("Slash", { slot: "UpperBody", fade: 0.1, section: "Combo1" }); // one-shot over the graph
anim.play(clip, { fade: 0.15 });           // no graph asset: an implicit single-layer graph (Animancer)
anim.crossfade(clip, 0.2, { layer: 1, mask: upperBodyMask });
anim.link("Weapon", swordGraph);           // swap a linked graph
anim.ik("LeftHand").target(this.grip, { weight: 1 });
anim.warp("Vault", { position, rotation }); // motion-warp window named in the clip
anim.state("Base");                        // { name, time, normalizedTime, weight, transitioningTo }
anim.layerWeight("UpperBody", 0.5);
anim.bone("Head").localRotation = q;       // override in lateUpdate; applied before attachments and upload
anim.onFinished;                           // the promise returned by play also resolves on interrupt, with a reason

tween(this.node.transform, "position", [0, 2, 0], { duration: 0.4, ease: "outBack" })
  .then(() => tween(this.node.getComponent(SpriteRenderer), "color", [1, 1, 1, 0], { duration: 0.2 }));
await sequence(t1, parallel(t2, t3));      // compiles to a small timeline

const dir = this.node.getComponent(TimelineDirector);
await dir.play();
```

- **Promises fit the existing `wait` style.** A `play` promise resolves with `{ reason: "finished" | "interrupted" | "stopped" }`.
- **Notifies call methods.** An `event` track names a method. After `Evaluate`, `animation.Apply` delivers it through the World's behaviour messages (0303, `World._sendMessage(nodes, method, e)`): each node once, active behaviours only, throws logged. Each behaviour of the Animator's node that defines it gets `method(e: AnimationEvent)`, as Unity's AnimationEvent does. A notify state calls it with `e.phase` = `"begin"`, `"tick"` and `"end"`. The same records go to the `AnimationEvents` buffer for systems. There is no event bus (0017).
- **Musical timing (optional, when the audio plugin is enabled):** `play`, `travel` and `request` accept `at: "beat" | "bar" | "exit"` with a music handle (`AudioPlaylistHandle`, audio 0329), and `align: "start" | "hit"`. `hit` lands the clip's `hit` marker on the boundary, as audio stingers do, for dance, rhythm and cutscene sync. The animation plugin reads the handle's music position through the public `Audio` API only. Without the audio plugin, `at` is refused with one warning.
- **No triggers.** `request` replaces them: a request lives for `within` seconds (default 0.25) and is consumed by the first transition that reads it.
- **Data path for systems:** user systems query `Animator` and call the same methods, or write parameters through `animatorParams(entity)`, a typed view into the blackboard row, for bulk updates (crowds).

### Replication (0033)

Parameters declare `replicate` and `predicted` in the graph asset's parameter list. Active states, slot plays and linked-graph choices are replicated fields of `Animator` (0340).

## Alternatives considered

- **Unity's model: a state machine at the top, blend trees inside, Playables separate.** Code and graph don't compose, and layers and one-shots fight the machine. A pose graph with state machines as nodes avoids this.
- **Triggers.** Familiar, but the main source of "my animation played late" bugs. Requests with a lifetime keep the convenience without the staleness.
- **An event bus for notifies.** Contradicts 0017. Method calls plus a buffer match collisions and triggers.
- **Graph logic in TypeScript, sampling in wasm.** Every transition check would cross the boundary per character. The whole graph runs in the core, and TypeScript only writes parameters.
- **Bones as nodes with per-bone components.** See 0340. `BoneAttachment` gives parenting without that cost.

## Consequences

**Positive**
- Code-first and graph-first projects use one runtime. A game can start with `anim.play(clip)` and add a graph later.
- State machines stay readable: ordered transitions, visible conditions, no stale triggers, and `travel()` instead of hand-wired paths.
- One-shots, weapon layers, IK, retargeting, matching and ragdolls compose in one graph.

**Negative / costs**
- A large public surface (`Animator`, `tween`, `TimelineDirector`, `BoneAttachment`, `Ragdoll`) to document and keep stable.
- Expressions in transition conditions need a small compiler to the core's bytecode (parsed in TypeScript in the editor and at load; evaluated in Rust).
- Physical animation couples to the physics plugin's joint-motor API, which has to grow motors, limits and pinning in Rapier's backend.

## Deprecates

Nothing.

## Open questions

- Whether transition conditions accept arbitrary TypeScript functions in code-built graphs (each would call out of wasm per evaluation), or only expressions.

## References

- `src/engine/core/registry.ts`, `src/engine/core/systems.ts`, `src/plugins/runtimeContext.ts`, `src/plugins/navigation/runtime/components.ts` (a plugin's components queueing commands for its systems).
- Unreal AnimGraph, Montages, Linked Anim Layers, Pose Search, Animation Warping. Godot AnimationNodeStateMachinePlayback.travel. Animancer. Final IK. PuppetMaster. Daniel Holden, "Learned Motion Matching" and inertialization (Bollo, GDC 2018).
