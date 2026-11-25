# Animation

Skeletal, property, sprite and procedural animation, all on one track model and one engine-owned evaluator (a Rust/WebAssembly core, [ADR 0370](../../decisions/0370-animation-evaluates-on-an-engine-owned-rust-wasm-simd-core.md)). The `myco.animation` plugin gives you `Skeleton`, `SkinnedMeshRenderer`, `Skeleton2D`, `Animator`, `BoneAttachment` and `TimelineDirector`, plus the free functions `tween`, `sequence`, `parallel` and `animatorParams`. Ragdolls are a second plugin, `myco.ragdoll` (needs Physics). Physics and Audio are optional for animation: without Physics there is no character-controller root motion, grounder or predicted root motion; without Audio there is no musical timing and no audio keys.

For how fast it is, and how it compares with Babylon.js's own animation, see [Animation performance](animation-performance.md).

The records behind it: [0370](../../decisions/0370-animation-evaluates-on-an-engine-owned-rust-wasm-simd-core.md) (the core, skinning, budgets), [0371](../../decisions/0371-one-property-track-format-for-clips-timelines-and-tweens.md) (tracks, assets, import), [0372](../../decisions/0372-animation-graph-and-scripting-api-on-the-ecs.md) (graphs and the API), [0373](../../decisions/0373-the-editor-gets-animation-graph-timeline-rig-and-debugging-tools.md) (editor tools), [0374](../../decisions/0374-plugins-can-name-optional-dependencies.md) (optional dependencies), [0375](../../decisions/0375-ball-joints-gain-swing-twist-limits-and-a-rotation-drive-and-ragdolls-are-their-own-plugin.md) (ball joints and ragdolls), [0376](../../decisions/0376-a-debug-link-connects-running-builds-to-the-editor-and-the-studio.md) (the debug link). What is built and what is not: [implementation status](../../architecture/implementation-status.md). Gaps are marked **Not built** below; everything else here is built and tested.

The core needs WebAssembly `simd128` (see [minimum versions](audio-minimum-versions.md)); without it the plugin warns once and nothing animates.

## Import a skinned model

Drop a model onto the scene (or the Hierarchy). The editor adds a `Skeleton` on the root, a `SkinnedMeshRenderer` per skinned mesh and an `Animator` whose `defaultClip` is the first clip, as one undo step. Dropping a clip on an Animator sets its `defaultClip` (refused while the Animator has a graph; use **Add as state** in the graph editor).

| Format | Skins | Clips | Notes |
| --- | --- | --- | --- |
| glTF / GLB | yes, 4 influences per vertex (8 with `influences: 8`) | TRS, `weights` (morphs), `STEP`/`LINEAR`/`CUBICSPLINE` | Morph targets with tangents; `KHR_node_visibility` becomes activation tracks |
| FBX | yes, 4 influences (the loader's limit) | animation stacks become clips | Blend shapes become morphs |
| OBJ | no | no | Static meshes only |

**`KHR_animation_pointer`** is supported: channels become property tracks on material values (colour, metallic, roughness, emissive, and so on), `KHR_texture_transform`, `KHR_lights_punctual` and camera fields. Pointers the importer cannot map give one warning per file listing them. An animated texture transform stays live on the surface instead of being baked into UVs.

Sub-assets you can reference: `asset:models/hero.glb#Skeleton`, `asset:models/hero.glb#Anim/Run`, `asset:models/hero.glb#Body` (a mesh).

### Clip import settings

Select the model; the Inspector's **Animation Clips** card edits the `animation` section of its `.meta.json` sidecar: split a take into clips on the take strip, loop (with a pose-match indicator), root-motion bone and axes (`x`, `y`, `z`, `yaw`; `bakeIntoPose` keeps the motion in the pose), additive reference (`first` or `Clip#frame`), compression error (millimetres, default 0.1) with the resulting size, and markers, events and curves on the source take.

```jsonc
// hero.glb.meta.json
{ "format": "myco.import@1",
  "animation": {
    "influences": 4,
    "boneMap": { "Hips": "mixamorig:Hips" },      // profile role -> bone; empty: guessed on import
    "clips": { "Take 001": [
      { "name": "Walk", "from": 0, "to": 1.2, "loop": true,
        "rootMotion": { "bone": "Hips", "axes": ["x", "z", "yaw"] },
        "markers": [{ "time": 0.3, "kind": "sync", "name": "L" }],
        "events": [{ "time": 0.3, "method": "footstep", "args": ["L"] }] } ] } } }
```

A take with no `clips` entry becomes one clip of its own name. The **Bone Map** and **Retarget** cards sit beside it (see [Retargeting](#retargeting-and-profiles)).

Clips compile to a compressed `.anim.bin` in `.myco/anim/` (a worker, cached by content); an export compiles every referenced clip and skeleton. Project Settings > Animation sets the default compression, with per-folder and per-sidecar overrides and a platform override at each level.

## Animator basics

`Animator` is one per animated hierarchy; tracks bind relative to its node. Without a `graph` asset it runs an implicit single-layer graph that your code plays clips on (Animancer's model). With a graph it runs the graph and code sets parameters and plays one-shots in slots.

```ts
import { Animator, GameBehavior } from "myco";

export class Hero extends GameBehavior {
  private anim!: Animator;
  start() { this.anim = this.node.getBehavior(Animator)!; }

  async slash() {
    await this.anim.play("asset:models/hero.glb#Anim/Slash", { fade: 0.1, loop: false });
    this.anim.crossfade("asset:models/hero.glb#Anim/Idle", 0.2);
  }
}
```

| Call | Does |
| --- | --- |
| `play(clip, options?)` | Play a clip. `options`: `fade`, `speed` (negative plays backward), `loop`, `normalizedTime`, `layer` (implicit graph), `slot` and `section` (graph one-shots) |
| `crossfade(clip, seconds, options?)` | Fade to `clip`. `options`: `layer`, `mask` (an avatar mask asset), `speed`, `loop` |
| `stop({ layer?, slot?, fade? })` | Stop one layer, one slot, or (with neither) everything |
| `layerWeight(layer, w)` | A layer's weight, 0 to 1 |
| `state(layer = 0)` | `{ name, time, normalizedTime, weight, transitioningTo }` as of the last evaluation |
| `onFinished` | The latest play's promise |

`clip` is a clip asset path or a clip named in the graph. **Promises** never reject and never hang: `play`, `crossfade` and a timeline's `play` resolve with `{ reason: "finished" | "interrupted" | "stopped" }` (a looping play resolves only when stopped or interrupted; a destroyed Animator resolves `stopped`).

**Layers and masks.** On the implicit graph `layer` is an index (0 is the base). `crossfade(clip, 0.2, { layer: 1, mask: "asset:masks/upper.mask.json" })` plays the clip on the upper body of layer 1; `layerWeight(1, 0.5)` blends the layer. A mask (`*.mask.json`) lists bones or profile roles with weights; an entry is recursive by default:

```json
{ "format": "myco.mask@1",
  "entries": [{ "role": "Spine", "weight": 1 }, { "bone": "LeftHand", "weight": 0.5, "recursive": false }] }
```

In a graph, `state("Base")` and `travel(…, { layer: "Base" })` address the machine at the graph's output; a layer is addressed by name. Only the first 4 named layers have a run-time weight (`layerWeight` ignores others with a warning; the base machine has none).

**Creating one in code:**

```ts
const hero = GameObject.create("Hero");
hero.addComponent(Skeleton, { skeleton: "asset:models/hero.glb#Skeleton" });
const anim = hero.addComponent(Animator, { defaultClip: "asset:models/hero.glb#Anim/Idle" });
```

**Other Animator fields:** `updateMode` (`normal`, `unscaled`, `fixed` for physics-driven characters), `cullingMode` (`always`, `whenVisible` freezes the pose while playheads advance, `rootMotionOnly`), update-rate LOD (`lodMetric`: `off`, `distance` or `screenSize`; `lodEvery2`, `lodEvery4`, `rigCullDistance`, `lodSearchMultiplier`) and `rootMotion` (see [Root motion](#root-motion-and-networking)).

**Bones and attachments.** `BoneAttachment` makes a node follow a bone (`skeleton`, `bone`, `offsetPosition`, `offsetRotation`, `follow`: `position`, `rotation` or `both`), for weapons and hit volumes. To override a bone for one frame, write it in `lateUpdate()` (write again every frame to keep it):

```ts
lateUpdate() { this.anim.bone("Head").localRotation = this.look; }
```

## Clips and property tracks

A clip (`*.anim.json`, `myco.anim-source@1`) holds tracks, and every track kind works in clips and timelines. You can key **any animatable field**: a `@field` is animatable by default when it is a number, vector, quaternion, colour, boolean, enum or asset reference, and not for strings, arrays and plain objects (a field opts in or out with `@field(..., { animatable })`; a plain-object field can expose sub-paths such as `drive.targetRotation`). Physics body kinds and similar fields are opted out.

| Track | Keys |
| --- | --- |
| `bone` | translation, rotation, scale of a named bone |
| `float`, `vec2`, `vec3`, `vec4`, `color` | the engine `Curve` (linear, step, smooth, Bézier) per component |
| `quat`, `discrete` | rotation of a field; bool, enum or asset (a sprite slice, a material) |
| `morph` | a morph target's weight by name |
| `event` | a notify `{ time, method, args }`, or a notify state with `end` |
| `audio` | an audio playlist or clip with parameters |
| `activation` | a node on or off over a range |
| `subclip`, `control` | another clip; particle play/stop, camera cut, slot play |
| `marker` | `sync`, `exit`, `hit`, `cue` points |
| `curve` | a named float the graph reads (drives blend weights, IK weights, material values) |

```jsonc
{ "format": "myco.anim-source@1", "duration": 0.8, "loop": true, "tracks": [
  { "kind": "vec3", "target": { "nodePath": "Body/Sword", "component": "engine.Transform", "field": "position" },
    "curves": [[[0, 0], [0.8, 1, "smooth"]], [], [[0, 0]]] },
  { "kind": "event", "keys": [{ "time": 0.3, "method": "footstep", "args": ["L"] }] },
  { "kind": "marker", "keys": [{ "time": 0, "kind": "sync", "name": "L" }, { "time": 0.8, "kind": "exit" }] } ] }
```

`nodePath` is relative to the Animator's node. A track whose target is missing stays unbound with one warning per clip and node. Binding happens once per clip and Animator, so there are no string lookups per frame.

**Events (notifies).** An `event` key calls the named method on the behaviours of the Animator's node (each node once, active behaviours only); a notify state calls it with `e.phase` of `"begin"`, `"tick"` and `"end"`. By default a notify fires while its clip's weight is above 0.5 (`threshold`), or always with `always: true`. The same records go to the `AnimationEvents` buffer:

```ts
import { AnimationEvents, GameBehavior, type AnimationEvent } from "myco";

class Feet extends GameBehavior {
  footstep(e: AnimationEvent) { /* e.args is ["L"]; e.phase is "instant"; e.clip, e.time */ }
  lateUpdate() { for (const e of AnimationEvents.read()) { /* every notify this frame */ } }
}
```

There is no event bus. `AnimatorStateChanges.read()` gives `{ animator, layer, from, to }` for state-machine changes. A notify has no `weight` field yet (**Not built**).

**Markers** are `sync` (named points for phase sync, such as `"L"` and `"R"`), `exit` (where a transition may leave), `hit` (the impact point a play can align to) and `cue` (a named point; also the boundaries of `section`s).

**Audio keys** play through `Audio.play` at the track's node, with `params` as the playlist's local parameters; the clip's weight scales the volume. They need the Audio plugin.

## The Animation window

Open it by double-clicking a `*.anim.json`, from the Add Panel dialog, or with the **◆** button on an Animator's Inspector card. It is a dope sheet (rows per bound node, component and field; keys as diamonds; box select, move, scale, copy and paste across tracks, ripple) with a curve view on the shared curve editor, row editors for event, marker, audio and activation tracks, and a **Preview** button that plays the clip on the selected Animator in the scene view without entering Play.

- **Record mode.** Turn on **● Record**: changing an animatable field of a node under the Animator, in the Inspector or with a gizmo, writes a key at the playhead instead of changing the scene. A drag is one undo step. A field no track can drive is left to the scene.
- **Key buttons.** Animatable fields in the Inspector show a key button beside them: click to add a key at the playhead; click again on a keyed field to remove it. A field that is animated but has no key at the playhead shows as "animated".
- **Add property…** adds tracks for the selected node's animatable fields (sub-paths included); **Add track** adds event, marker, audio and activation rows.
- Onion-skin frames show as a strip in the window. **Not built:** onion-skin ghosts in the scene view, bone record mode, and tracks for data components.

## Tweens

`tween` animates one field of a Transform or component. It is a one-track clip evaluated in the core, starts at the next animation update, and is awaitable:

```ts
import { GameBehavior, Light, Quaternion, parallel, sequence, tween } from "myco";

class Pulse extends GameBehavior {
  async start() {
    await tween(this.node.transform!, "position", [0, 2, 0], { duration: 0.4, ease: "outBack" });
    const light = this.node.getBehavior(Light)!;
    const fade = tween(light, "intensity", 0, { duration: 0.2 });
    const grow = tween(this.node.transform!, "scale", [2, 2, 2], { duration: 0.2 });
    const spin = tween(this.node.transform!, "rotation", Quaternion.identity, { duration: 0.4 });
    await sequence(fade, parallel(grow, spin));   // pass tweens before they start
  }
}
```

- **Fields:** any animatable field of the component, a Transform's `position`, `rotation` and `scale`, or a dotted path: a sub-path of a plain-object field, or `"material.color"` / `"material.metalness"` on a `MeshRenderer` (a per-renderer override). A field that cannot be driven warns once and the tween ends at once as `stopped`.
- **Options:** `duration`, `from` (default: the value when it starts), `relative` (`to` is added to the start), `ease`, `delay`, `loops` (-1 loops forever), `loopMode` (`"restart"` or `"yoyo"`), `time` (`"scaled"`, `"unscaled"`, `"fixed"`) and `speed`.
- **Easing:** `"linear"`, or `in`/`out`/`inOut` plus `Sine`, `Quad`, `Cubic`, `Quart`, `Quint`, `Expo`, `Circ`, `Back`, `Elastic` or `Bounce` (`"outQuad"` by default); or any engine `Curve` over 0 to 1.
- **Handle:** `isPlaying`, `pause()`, `resume()`, `stop()`. `await` gives `{ reason: "finished" | "stopped" | "destroyed" }`.
- **Destroyed targets fail silently:** destroy the node or remove the component and the tween ends without an error; the promise resolves with `reason: "destroyed"`, so awaiting code never hangs.

`sequence` and `parallel` compile to a small timeline; a tween that has started cannot join a group. Systems can query the `Tweens` data component to find what is being tweened.

## Timelines

A timeline (`*.timeline.json`, `myco.timeline@1`) is a clip used across many nodes: the same tracks (no `bone` tracks), with `nodePath` relative to the director. Overlapping `subclip` keys on one track crossfade. Add a `TimelineDirector` and point it at the file:

```ts
const dir = this.node.getBehavior(TimelineDirector)!;   // timeline, playOnStart, wrapMode: hold | loop | none
await dir.play();            // { reason: "finished" | "interrupted" | "stopped" }
dir.pause();                 // keep the playhead; play() continues
dir.playhead = 2.5;          // seek: no events fire for the skipped span
dir.stop();                  // back to 0
```

A track that animates a node other than its path's is a binding (`bindingTracks` / `bindingNodes`, edited in the Timeline window). Control keys do `particlePlay`, `particleStop`, `cameraCut` and `slotPlay` (play a clip in a character's slot).

The **Timeline window** (double-click a timeline, or the **Timeline window** button on the director) shows tracks grouped by bound node with binding pickers, clips as bars (move, trim, split, duplicate, ease handles), blend regions where clips overlap, animation, subclip, activation, audio, control and camera-cut tracks, markers, a breadcrumb into nested timelines (3 levels), and play, scrub and loop in the editor. **Not built:** event (notify) keys in timelines are skipped with one warning; dropping Hierarchy nodes onto a binding, editing `bindingTracks` in the Inspector and moving clips across tracks.

## Animation graphs

A graph (`*.animgraph.json`, `myco.animgraph-source@1`) is a pose dataflow graph: every node outputs a pose, state machines and blend spaces live inside it, and code only writes parameters. It is compiled when it loads and runs entirely in the core. Open one in the **Animation Graph** panel: a canvas for pose nodes, state machines as nested canvases, a transition list per state (reorder, condition rows, `when` and `how`, fade-shape preview, interrupts), a blend-space editor, a chooser table, a linked-graph picker, layers and masks, a rig-entry list, and compile problems by path. Every edit is one undo step.

**Parameters** are typed (`float`, `int`, `bool`, `vec2`, `vec3`, `quat`, `node`), with a default, and may be `replicate`d, `predicted` or `computed`.

```ts
anim.set("speed", 3.2);                       // checked against the declared kind
anim.request("Jump", { within: 0.2 });        // a request lives 0.25 s by default and is consumed by the first transition that reads it, or expires
anim.compute("canVault", () => this.ledgeAhead());   // filled once per frame before evaluation; null stops it
const p = animatorParams(this.node)!;         // crowds: look the index up once
const ix = p.indexOf("speed"); p.set(ix, 2);
```

There are no triggers: `request` replaces them, so nothing fires late. `Animator.parameters` sets starting values per instance.

**State machines.** States hold sub-graphs; transitions are listed per state **in priority order** (highest first), and `anyState` transitions are checked before a state's own. A transition has:

- `if`: `{ all: [...] }` or `{ any: [...] }` of comparisons: `{ param, op, value }`, `{ operand: "stateTime" | "normalizedTime" | "syncPhase", op, value }`, `{ curve, op, value }`, or `{ request }`. `op` is one of `== != < <= > >=`.
- `when`: `"now"` (default), `"exit"` (the next `exit` marker of the playing clip, else its end), `"marker:<name>"`, or a normalised time.
- `how`: `"crossfade"` (default; `duration` and `shape`: `linear`, `smoothstep`, `easeIn`, `easeOut`), `"cut"`, `"inertialize"` or `"bridge"` (play a bridge node between).
- `interrupt`: `"never"`, `"any"`, or the ids of the transitions that may interrupt it.

```ts
const where = await anim.travel("Crouch");   // shortest path through the machine
// where.reason: "arrived" | "unreachable" (no path, with a warning) | "interrupted"
anim.jump("Dead");                           // cut straight there, no path, no blend
```

**Blend spaces** (`blendSpace1D`, `blendSpace2D`): samples at coordinates over float parameters (`x`, `y`), Delaunay-triangulated in 2D with points outside projected to the hull; `glideMs` smooths input changes, `sync` makes the samples follow the heaviest one's phase, `speedScale` plays at the rate that matches a `speed` parameter to the samples' root speed. **Other nodes:** `clipPlayer`, `random` (weighted, shuffle or round-robin from the World's seeded generator, so replays match), `chooser` (rows of condition to result), `blend2`, `blendEnum`, `blendBool`, `layer`, `additive`, `timeScale`, `mirror`, `inertialize`, `poseSnapshot`, `referencePose`, `bindPose`.

**Slots** are named insertion points for one-shots over the graph (Unreal's slots and montages):

```ts
await anim.play("asset:clips/combo.anim.json", { slot: "UpperBody", fade: 0.1, section: "Combo1" });
// section: a cue-marker name, or { start, end } in clip seconds
anim.stop({ slot: "UpperBody", fade: 0.2 });
```

An unknown slot or section warns and the play resolves `stopped`. Without a slot, `play` on an Animator that has a graph is refused with a warning.

**Sync groups and markers.** A `syncGroup` node makes every clip player under it follow the heaviest one's phase by `sync` markers (`L`, `R`), so blends never slide feet. A transition's `when: "exit"` waits for an `exit` marker.

**Linked graphs.** A `linked` node runs another graph with its own parameters. Swap it per instance:

```ts
anim.link("Weapon", "asset:graphs/axe.animgraph.json");   // the node's name; null restores its default
```

`Animator.linkedGraphNodes` and `linkedGraphs` set the swap in the scene.

## Rigs, IK and warping

A graph's rig nodes run after the pose they take as input: `twoBoneIk`, `ccd`, `fabrik`, `fullBodyIk`, `lookAt`, `aim`, `grounder` (rays per foot, pelvis offset), `springChain`, `copy`, `limitRotation`, `limitPosition`, `damp`, `strideWarp`, `orientationWarp`, `motionWarp` and `distanceMatch`. Their weights can be driven by a parameter or curve. The grounder needs Physics (it reads last frame's ray hits); a one-frame-old hit is normal for grounders.

An IK node names a goal slot in its `target` parameter. Aim the goal from code, or bind it in the scene with `Animator.ikTargets` and `ikTargetNodes`:

```ts
anim.ik("LeftHand").target(this.grip, { weight: 1, hint: this.elbow });   // a node is followed every frame; a Vector3 holds a world position
anim.ik("LeftHand").target(null);                                        // back to the graph's own target
```

The `hint` goes to the slot named `<goal>Pole` when the graph has one. Beyond `weight`, `target` takes `rotation` and `rotationWeight`.

**Motion warping** bends root motion so a window of a clip ends at a target. The window is a `motionWarp` node (opened by a cue marker or explicit times); name it by the node's id, name or start marker:

```ts
anim.warp("Vault", { position: ledge, rotation: facing });   // a node is also accepted and followed
anim.warp("Vault", null);                                    // the clip's own root motion plays
```

Only the yaw of `rotation` is matched. Rig stacks switch off past `rigCullDistance`, and reset on teleports.

## Retargeting and profiles

A **skeleton profile** (`*.skelprofile.json`, `myco.skelprofile@1`) maps named roles to bones (with a left/right `mirror`, joint `range`s and chains such as spine, arm and leg), and a built-in **Humanoid** profile covers the usual roles. In a model's Import Settings the **Bone Map** card picks the profile and maps role to bone (auto-guessed by name, mirror, required-role warnings; **Apply** saves the guess); a profile asset opens in a chain editor.

To play clips made for another rig, put a `retarget` node in the graph (its `map` names the source skeleton or profile, `source` is the graph that plays on the source rig) and/or set `Skeleton.retargetSource`, which overrides the source side per character:

```ts
hero.addComponent(Skeleton, { skeleton: "asset:models/hero.glb#Skeleton", retargetSource: "asset:mocap/actor.glb#Skeleton" });
```

The target side is the Animator's own `Skeleton` and its `profile` (empty: the Humanoid). Chains transfer rotations relative to each rest pose; the root is scaled by leg length (`rootX/Y/Z`: `scaled`, `unscaled`, `locked`); goals can pin hands and feet. The **Retarget** card previews source and target side by side and has **Bake retargeted clip**, which writes `<clip>.<target>.anim.bin` (a compiled clip, not an `.anim.json`).

## Motion matching and pose databases

A pose database (`*.posedb.json`, `myco.posedb-source@1`) lists clips with tagged time ranges and a feature schema (bone positions and velocities, future trajectory samples, custom features). The **Pose Database** tool edits it (tagged ranges on a strip, features, weights, normalisation) and **Bake** writes `x.posedb.bin` beside it in a worker; the runtime loads the baked file. A `poseDatabase` node in the graph searches it every `interval` updates (or at once when the trajectory cost passes `force`), switches with an inertialised blend (`blend`) and respects tag filters (`requiredTags`, `excludedTags`, `anyTags`, or a `matchTags` node in a chooser row).

The trajectory comes from graph parameters the node names: `position`, `yaw` and `velocity` are filled each frame (from the `CharacterController` when Physics is on, else from the node's own motion); `desiredVelocity` and `desiredYaw` are yours:

```ts
anim.set("desiredVelocity", new Vector3(input.x * 4, 0, input.z * 4));
```

A KD-tree is the default search (`bruteForce` gives the same result). **Not built:** the viewport debug view of the trajectory and matched frame has no data source yet; mirrored clips and custom features are not in the bake.

## Root motion and networking

`Animator.rootMotion` says where a clip's extracted root motion goes: `"none"`, `"transform"` (the node), `"characterController"` or `"rigidBody"` (kinematic; both need Physics). Every mode fills the `RootMotion` buffer, so a system can apply it itself:

```ts
lateUpdate() { for (const r of RootMotion.read()) if (r.node === this.node) this.velocity = r.delta.position; }
```

Set `updateMode: "fixed"` for physics-driven characters: they evaluate before the physics step.

**Replication.** An Animator on a `Replicated` node carries four compact fields (states, slot plays, linked-graph choices, replicated parameters; 255 bytes each). Mark a parameter `replicate` (and `predicted` for a predicted character) in the graph. Interpolated ghosts apply a state change at the interpolation tick; predicted characters play root-motion one-shots through `animation.PredictedRootMotion` (a fixed-step system, registered only with Physics), which re-runs for re-simulated ticks. Servers with no rendering run `rootMotionOnly` unless a `BoneAttachment` follows the skeleton. See [Multiplayer](multiplayer.md). **Not built:** jumps at the server's normalised time, linked-graph time sync, replication of implicit-graph plays, per-bone server evaluation.

## 2D

- **Flipbooks.** Select slices in the Assets panel and choose **Create Flipbook**, or use the Sprite Editor's Flipbooks tab or the image's **Flipbooks** card. A flipbook is stored in the image sidecar (`flipbooks: { run: { slices: [...], fps: 10, loop: true } }`) and plays as the clip `sheet.png#Flip/run` on an Animator, stepping `SpriteRenderer.sprite`:

  ```ts
  sprite.addComponent(Animator);   // no Skeleton needed
  await anim.play("asset:images/sheet.png#Flip/once");
  ```

- **2D bones and weights.** The Sprite Editor's **Bones** tab places bones, builds a mesh from the slice outline, auto-weights by distance or envelope, and has a weight brush; Apply writes `skin` into the sidecar. A `Skeleton2D` (`bones`: the slice that declares them) plays bone tracks like a 3D skeleton; several slices can share one 2D skeleton by bone name, for cut-out characters. **Not built:** flip and size on skinned sprites.

## Ragdolls

The `myco.ragdoll` plugin adds `Ragdoll` (exported from `myco`) to a node with a Skeleton and an Animator. Each listed bone gets a rigid body and a ball joint with swing and twist limits to its parent bone; an empty `bones` list uses a default from the skeleton.

- **Generate.** The ragdoll builder (Inspector card of `Ragdoll`) has **Generate from Skeleton** (capsules by bone length, limits from the profile's joint ranges), a per-bone table (shape, mass, swing, twist, drive, strength, pin) and gizmos with handle drags.
- **Test Drop.** Press Play first, select the character, and press **Test Drop**: it sets the live `mode` to `"ragdoll"` without saving it; **Reset** puts it back. It cannot start Play for you.
- **Modes.** `"off"` (the animation), `"ragdoll"` (limp under gravity) and `"powered"` (joint drives turn each body toward the animated pose, scaled by `strength`; root bodies are pinned by `pinStrength`).
- **Graph.** The simulated pose comes back through a `physicalPose` node; a `physicsBlend` node blends it over the animation, reading the parameter named by `blendParameter` (default `ragdollBlend`; written each step from `blend`). Get-up needs a `poseSnapshot` node and two Base-machine states, `GetUpFromBack` and `GetUpFromFront` (names in `getUpFromBack` and `getUpFromFront`).
- **Get up.**

```ts
const ragdoll = this.node.getBehavior(Ragdoll)!;
ragdoll.mode = "ragdoll";            // hit by the truck
// later
const r = await ragdoll.getUp();     // { reason: "arrived" | "unreachable" | "interrupted" }
ragdoll.body("Head");                // the node holding that bone's body, for forces; null while not simulating
```

`getUp()` picks the get-up state from the pelvis's facing (`pelvis`, `front`) and turns the ragdoll off; with `autoGetUp`, setting `mode` from `"ragdoll"` to `"off"` does the same. A character that moves farther than `teleportDistance` in one step resets its bodies to the animation. Ball joints themselves gained `swing {y, z}` and a rotation `drive` for this ([ADR 0375](../../decisions/0375-ball-joints-gain-swing-twist-limits-and-a-rotation-drive-and-ragdolls-are-their-own-plugin.md); scene format 5 migrates the old `swingLimit`).

## Third-party graph nodes

A plugin can add graph and rig nodes as a sandboxed wasm module with its own memory and no imports, written with the `anim-plugin-sdk` Rust crate (`native/anim/crates/anim-plugin-sdk`; a sample is in `native/anim/examples/plugin-sample`). Declare it in `plugin.json`:

```json
{ "name": "acme", "version": "1.0.0", "sdk": "^1.0.0",
  "animationNodes": [{ "module": "nodes/sway.wasm", "budget": 200000 }] }
```

- **Schema.** The module describes its node kinds and parameters (name, kind, unit, range, default, animatable) and the graph editor builds cards from it. In a graph, a node gives `module` and `node` and then its parameters by name; a parameter given a graph parameter's name becomes a binding when the module marks it animatable.
- **Budget.** The loader meters the module and gives each node instance `budget` units of fuel per evaluation, plus a fixed 1,000 per call (default 1,000,000, at most 50,000,000). A module not listed in `animationNodes` runs with the default budget and a warning. Exports meter and ship the declared modules.
- **Faults.** A trap (including running out of fuel) passes the node's first input pose through and reports once per node instance (a warning, and the **Node faults** row of the profiler). The module is never allowed to stall the frame. A bad entry in `animationNodes` is dropped with a message; it never refuses the plugin.

## Musical timing

With the Audio plugin, `play`, `crossfade`, `travel` and `request` can wait for a music boundary:

```ts
const music = Audio.play("audio/town.playlist.json");
anim.play(dance, { at: "bar", music, align: "hit" });   // the clip's `hit` marker lands on the bar
anim.crossfade(idle, 0.2, { at: "beat", music });
```

`at` is `"beat"`, `"bar"` or `"exit"` (the next exit marker the playlist reports) and `align` is `"start"` (default) or `"hit"`. A play released a little after its boundary starts that far into its clip, so frames coarser than beats stay in time. Without the Audio plugin, without a `music` handle, or with music that has no beat grid, `at` is refused with one warning and the action happens at once; if the music stops while an action waits, it is released at once. A clip without a `hit` marker aligns its start with one warning. See [Interactive music](interactive-music.md).

## Debugging

- **Live debugger.** While the game plays in the editor, the **Animation Graph** panel follows an Animator (the **Debugged Animator** selector in its **Live debugger** bar; its default, **Follow selection**, follows the selected node). It shows active nodes with weights and phases, the current and target state, each transition coloured by what blocks it with the reason (priority, interruption, exit time, the condition's current value) and the remaining life of requests. The parameters are live and editable (they go through `Animator.set`).
- **Recorder.** The recorder keeps the last 10 seconds by default (a selector changes it). Drag the slider to scrub: poses are re-evaluated exactly from the recorded inputs, and the game view redraws while paused; **Live** follows the game again. Ragdoll physics rows are not replayed.
- **Debug link.** The link lets the editor inspect a running build (a browser tab, a desktop app, another machine). Export with debugging on: `npm run export -- <projectDir> --debug-link 7790` (a port, `host:port` or a full `ws://` address; the Export dialog's **Debugging** checkbox does the same, and `game.json` gets `debug: { link }`). A desktop build also takes `--debug-link <address>` at launch, a web build `?debug-link=<address>`. The build connects out to the editor (default `ws://localhost:7790/myco-debug`); the link sends only what the editor subscribes to, applies `set`, `travel` and `jump` commands at the next frame start, asks before accepting a build from another machine, and listens on the LAN only if you turn that on in Settings > General > Debug link. A release export contains none of the link's code. **Not built:** the browser and desktop editors cannot accept a connection yet (only Node can listen), so no shipped editor shows a linked build today.
- **Profiler table.** The **Animation** table in the Play Stats panel shows the frame total with gather and apply, evaluate time, instances (active, culled), LOD skipped, evaluated bones, skinned meshes, core memory, third-party node fuel and faults. It has no per-Animator rows or skinning time yet. For a sense of scale, the budget scene (100 characters, 80 bones, a locomotion graph with a slot, a grounder and look-at) measured about 2.8 ms per frame in a shared four-core container, above the 0370 tripwire of 1.5 ms; that tripwire is not a limit, and the numbers are in the [build log](../../design/animation/build-log.md).
- **Takes.** Takes that record what the game asked of animation (`ANIM_*` records, replayed in the editor) are coming; the engine has no animation take source yet.

## Glossary

The terms below are also in the project [glossary](../../../GLOSSARY.md#animation-adr-03700376).

- **Clip:** a set of tracks over time (`*.anim.json`, an imported `model.glb#Anim/Run`, or a flipbook).
- **Track / key:** one animated thing (a bone, a field, notifies) / one value at a time on it.
- **Marker:** a named point in a clip: `sync`, `exit`, `hit` or `cue`.
- **Notify:** an `event` key that calls a method on the Animator's behaviours; a **notify state** has a begin, ticks and an end.
- **Layer / mask:** a graph or implicit-graph layer blended by weight, restricted to bones by a `*.mask.json`.
- **Slot:** a named place in a graph where code plays a one-shot clip over the graph.
- **Sync group:** nodes whose clips follow the heaviest one's phase by `sync` markers.
- **Blend space / chooser:** a 1D or 2D blend over parameters / a table of condition rows that picks a source.
- **Linked graph:** a node that runs another graph, swappable per instance.
- **Rig / profile / retarget:** the rig stack of IK and solvers / a role-to-bone map / playing clips from one skeleton on another.
- **Pose database:** baked frames of tagged clip ranges that motion matching searches.
- **Root motion:** movement extracted from a clip and applied to the character.
- **Inertialization:** removing the pop of a switch by decaying the pose difference instead of crossfading.
- **Fuel:** the instruction budget a third-party node gets per evaluation.
- **Take:** an imported animation stack, cut into clips (built); a recorded run of what the game asked of animation (coming).
