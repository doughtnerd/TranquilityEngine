# 0371. One property-track format serves skeletal clips, property animation, sprite flipbooks, timelines and tweens; models import skins, clips and morphs

- **Status:** Accepted, amended by 0378 (`TweenField` dotted paths, `setMaterialProperty` slots; timeline `event` tracks not delivered), amended by 0420 (the tween table and sequences live in `myco-tween`)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0088 and 0044 (skins, animations and morph targets are imported, not dropped), 0040 (model sidecars gain animation settings; images gain flipbooks and 2D bones), 0090 (baked models carry skins and morphs; clips bake beside them)
- **Related:** 0010, 0158, 0159, 0306, 0314, 0370, 0372, 0373; audio 0342 (sample markers), audio 0346 (one curve model), audio 0351 (per-platform conversion, packages)

## Context

Unity animates almost any serialized property with curves. Godot goes further: a track targets any property path on any node, and there are method, audio, bezier, sub-animation and expression tracks. Unreal's clips are bone-centric, with curves on the side. The engines that split "skeletal clips", "property animation", "timelines" and "tweens" into separate systems end up with several curve editors and several event models.

**Today in Myco:**
- Models load through three.js loaders and are baked (`scene/models.ts`, `scene/gltf.ts`, 0090). Skins, clips and morphs are dropped with one warning.
- Sidecars (`*.meta.json`, `myco.import@1`) carry model `scale`, `upAxis`, `normals` and `materials`.
- Images carry named slices.
- `@field` carries `replicate`, `predicted`, `quantize`, `choices`, `kind`, `hidden` and `description` (0159), which left "can this field be animated" to this record.
- From the Audio Studio work (now on master), the engine curve (`core/curve.ts`) gains Bézier keys, with one Rust evaluator and one shared curve editor (audio 0346). Samples carry note, exit, hit and cue markers (audio 0342). Export settings inherit profile → folder rule → sidecar → platform, are cached by content hash, and can ship in loadable packages (audio 0351).

Records cited as *audio NNNN* are the Audio Studio records, merged to master on 2026-11-23 and renumbered then (0327–0346 → 0341–0360); the numbers here are the new ones.

## Decision

We will use **one track model** for everything that changes over time. A clip, a timeline and a tween all sample the same track kinds through the same binding, in the Rust core (0370).

### Bindings

- **A track's target** is `nodePath` (relative to the Animator's node, as Godot's `root_node`), plus `component` id and `field` path. Example: `Body/Sword` + `engine.MeshRenderer` + `material.emissive`.
- **Bone tracks** target a bone of the Animator's skeleton by name.
- **Binding happens once per (clip, Animator)** into a binding table: each track gets an output column in wasm and a destination ECS column. `animation.Apply` (0370) scatters columns into ECS storage in bulk. No string lookups happen per frame.
- **A missing target** leaves that track unbound and gives one warning per clip and node, as missing slices do.
- **Animatable fields (completing 0159):** `@field(type, { animatable })`.
  - The default is `true` for `Number`, the vector, quaternion and colour types, `Boolean`, enums with `choices`, and asset references.
  - The default is `false` for strings, arrays and plain objects.
  - `animatable: false` opts a field out, for example a physics body's `type`.
  - Built-in components set it where animating would break invariants.
  - The Inspector's key buttons (0373) appear only on animatable fields.

### Track kinds

| Kind | Values | Interpolation |
|---|---|---|
| `bone` | translation, rotation, scale per bone | linear translation and scale; normalised lerp rotation (slerp option per clip) |
| `float`, `vec2`, `vec3`, `vec4`, `color` | numbers | **the engine curve** (`core/curve.ts`, audio 0346): linear, step, smooth, easeIn, easeOut and Bézier keys with handles, one curve per component; evaluated by the shared `myco-curve` crate (0370) |
| `quat` | rotation of a node field | nlerp or slerp |
| `discrete` | bool, enum, asset reference (a sprite slice `asset:sheet.png#run_3`, a material, a mesh) | step |
| `morph` | morph target weights by name | linear |
| `event` | notifies: `{ time, method, args }` and states `{ start, end, method, args }` (0372) | — |
| `audio` | an audio event or clip (0158) with parameters | — |
| `activation` | node active on and off ranges | step |
| `subclip` | another clip or timeline with start, offset, speed, blend in and out | — |
| `control` | a particle effect play and stop, a camera cut, a nested Animator's slot play | — |
| `marker` | the sample marker vocabulary (audio 0342): `sync` (named, e.g. `"L"`, `"R"`, for phase sync), `exit` (where a transition may leave, 0372), `hit` (the impact point a play can be aligned to), `cue` (a named point scripts can seek to) | — |
| `curve` | a named float exposed to the graph as a parameter source (Unreal's anim curves, Unity's float curves); drives material values, IK weights, blend weights | the engine curve |

### Assets

| Asset | File | Notes |
|---|---|---|
| Authored clip | `*.anim.json` (`myco.anim-source@1`) | text, diff-friendly, one track per line block; made in the editor (0373) |
| Imported clip | `model.glb#Anim/Run` | a reference into a model, like `#Mesh` today; settings in the model's sidecar |
| Compiled clip | `*.anim.bin` (`myco.anim@1`, 0370) | compressed; made by the editor's worker into `.myco/anim/` (content-keyed like thumbnails, 0061) and by exports beside the source, as 0090 bakes models |
| Skeleton | `model.glb#Skeleton` | bones, parents, rest pose, inverse bind matrices; compiled to `myco.skel@1` |
| Skeleton profile | `*.skelprofile.json` | bone roles and chains; a built-in **Humanoid** profile (Godot's `SkeletonProfileHumanoid` roles plus finger and twist chains) |
| Timeline | `*.timeline.json` | tracks on many nodes (paths relative to the timeline's director node) plus `control` and `subclip` tracks (0372, 0373) |
| Animation graph | `*.animgraph.json` | 0372 |
| Pose database | `*.posedb.json` (sources, tags, features) + `*.posedb.bin` baked | 0372 |
| Avatar mask | `*.mask.json` | bone set with weights, or profile roles |

- **References and limits:** the animation asset kinds read and rewrite their own references on moves (0314). Format limits (tracks per clip, keys per curve, states per machine, nesting depth) are declared once in each parse (0306), as audio's playlist limits are.

### Model import (amends 0088, 0044, 0090)

- **glTF:**
  - skins: joints and inverse bind matrices. **4 influences per vertex by default** (the default in Unity, Godot and Blender's glTF export), 8 when the model sidecar sets `influences: 8` (`JOINTS_0`/`JOINTS_1`). Weights are normalised, and extra influences are dropped smallest first;
  - animations (TRS channels to bone or node tracks, `weights` to morph tracks, `STEP`/`LINEAR`/`CUBICSPLINE`);
  - morph targets (positions, normals, tangents);
  - **`KHR_animation_pointer`** (owner, 2026-11-22: supported, as is now standard for glTF tools) maps channels to property tracks for every glTF property the importer brings in:
    - **material values:** base colour, metallic, roughness, emissive colour and strength, alpha cutoff, normal scale, occlusion strength, and the physical layers' factors (clearcoat, sheen, transmission, volume, IOR, specular, iridescence, anisotropy, dispersion where imported);
    - **texture transforms** (`KHR_texture_transform` offset, scale, rotation). These are baked into UVs today (0088), so a material whose transform is animated keeps it as a live material value instead;
    - **lights** (`KHR_lights_punctual`): colour, intensity, range, spot inner and outer angles;
    - **cameras:** vertical field of view, near and far planes, orthographic size;
    - **node visibility** (`KHR_node_visibility`) as `activation` tracks;
    - node transforms and morph weights, as plain channels already do.
    
    Pointers to anything else give one warning per file, listing them. Animating a shared material changes every mesh using it, as glTF defines.
- **FBX:** through three's `FBXLoader` output (skinned meshes, bones, animation stacks as clips, blend shapes).
- **OBJ:** no animation.
- **Baked models (0090)** add skin weights, joint indices, morph deltas and the skeleton. Exports bake every referenced clip to `*.anim.bin`.
- **Sidecar `animation` section** (model sidecars, `myco.import@1`):
  - `profile` (a skeleton profile reference) and `boneMap` (profile role → bone name), auto-filled by name heuristics on import (Godot's bone-map guessing) and edited in 0373;
  - `clips`: per source take, any number of `{ name, from, to, loop, rootMotion: { bone, axes, bakeIntoPose }, additive: { reference: "first" | clip#frame }, compression: { error (mm, default 0.1), maxRate }, markers, events, curves, mirror }`. This is Unity's clip splitting and Unreal's per-sequence settings in one place;
  - `retargetSource`: the profile pose the clip was authored in, for runtime retargeting (0372).

### Compression (`anim-compress`, 0370)

- Every track is **uniformly sampled** at the clip's rate (default 30 Hz; source keys are resampled).
- **Constant tracks** collapse to one value; **default tracks** (equal to the rest pose) are dropped.
- **Range reduction** per track and per segment (16 frames per segment).
- **Bit rate** per track per segment, chosen from {0, 3–16, 19, 23, raw} so the **object-space error** of virtual vertices at a shell distance per bone (default 3 cm, from bone length) stays under `compression.error`. This is ACL's method.
- Generic property tracks use the same range and bit-rate scheme with an absolute error from the field's `quantize` (0159) or `1e-4`.
- `discrete`, `event`, `marker`, `audio`, `activation`, `control` and `subclip` tracks are stored as sorted key lists, uncompressed.
- **Settings inherit** as audio export settings do (audio 0351): project profile → folder rule → model sidecar per clip → platform override. Compiled clips are cached by content hash.
- The compressor reports per-clip size and maximum error. The Asset Inspector (0373) shows both, and a test fails if a fixture's error exceeds its bound.

### Sprites and 2D (amends 0040)

- **Flipbooks:**
  - a `discrete` track over a sheet's slices, made in one step from a slice selection (0373);
  - image sidecars gain `flipbooks: { name: { slices: [...], fps, loop } }` as a shortcut that compiles to a clip `image.png#Flip/Run`.
  - `SpriteRenderer.sprite` is animatable, so any clip can flip it.
- **2D bones:**
  - an image sidecar's slice gains `skin: { bones: [{ name, parent, position, rotation, length }], mesh: { vertices, triangles }, weights }`;
  - the mesh comes from the slice's opaque outline (the auto-slice islands, simplified) plus interior points; weights are painted or computed automatically by bone distance (0373);
  - a `Skeleton2D` (0372) drives it with bone tracks like 3D;
  - several slices can share one 2D skeleton (a cut-out character).

### Tweens

- A tween is a one-track clip built in code: target binding, from/to or by, duration, an easing (the standard Penner set by name, or any engine curve), delay, loops (restart and yoyo), time scale (scaled, unscaled or fixed).
- Tweens run in the core like any track (0370) and are ECS data on the target's entity (0372).
- Sequences and parallel groups compile to a small timeline.

## Alternatives considered

- **Separate systems for skeletal clips, property animation and tweens (Unity's legacy, DOTween beside Mecanim).** Each would be simpler alone, but there would be three event models, three time bases and two curve editors.
- **Keyframe-reduction compression (curve fitting, Unity's "Optimal").** Smaller for smooth curves, but its error is hard to bound in object space and decoding is slower. ACL showed uniform sampling with variable bit rate wins on both speed and size for games.
- **Binary-only authored clips.** Smaller, but they don't merge in git. The text source stays, and binary is compiled from it.
- **Spine and Rive importers.** Out of scope: the engine handles no format that needs a licence (owner, 2026-11-22).
- **Bone tracks only (Unreal).** Properties would need a second mechanism, as in Unreal's curves and Sequencer.

## Consequences

**Positive**
- One curve and dope-sheet editor and one event model for clips, timelines, tweens and sprites.
- Any animatable field of any component, including plugin components, can be keyed without extra code.
- Imported characters animate immediately. Sidecars keep clip splits and root-motion settings in the project like other import settings.

**Negative / costs**
- Generic property tracks crossing into ECS storage cost a scatter per bound column per frame. This is bounded by binding once, but it isn't free for thousands of tracks.
- FBX animation depends on three's `FBXLoader` fidelity (pre and post rotations, take timing). Fixtures must cover Mixamo-style and Blender exports.
- The compressor's bit-rate search makes the editor's first preview of a long clip slow. It runs in the worker, and the raw clip plays until it finishes.

## Deprecates

- The 0088 warning for skins, animations and morph targets.
- 0040's "Missing: sprite animation over slices".

## Open questions

- **Loadable packages:** audio's packages stay audio-only (0377, which would have renamed them, is withdrawn). A package of mixed assets (clips, skeletons, pose databases, models) gets a different name and convention in its own record, after this build. Until then clips and pose databases load as individual assets.

## References

- `src/engine/scene/gltf.ts`, `models.ts`, `bakedModel.ts`, `importSettings.ts`; `src/engine/core/registry.ts` (`@field`); `core/curve.ts` (audio branch); audio 0342, 0332, 0337.
- glTF 2.0 skins and animations; `KHR_animation_pointer`. ACL compression papers (Frechette). Godot `SkeletonProfileHumanoid`, Unity clip import settings, Unreal anim curves and sync markers.
