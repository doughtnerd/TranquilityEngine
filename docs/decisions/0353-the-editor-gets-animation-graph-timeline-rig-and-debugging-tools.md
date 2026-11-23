# 0353. The editor gets an Animation window, an animation graph editor, a Timeline, rig, retarget, pose database and ragdoll tools, and a live animation debugger

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** the architecture overview's non-goal "animation timeline … in the editor" (removed)
- **Related:** 0061, 0133, 0242, 0355, 0356, 0219, 0304, 0307, 0313, 0326, 0350, 0351, 0352; audio 0327 (the Audio Studio), audio 0332 (one curve editor), audio 0334 (takes), audio 0335 (one component kit)

## Context

All three engines are weak at debugging animation. Unreal's is the best of them: a live graph with weights, the pose watch, rewind debugger. Unity's Animator window shows the active state but not why a transition did or didn't fire. Godot shows little. Authoring quality is uneven too: Unreal's Sequencer and Control Rig are strong, Unity's Animation window and Timeline are adequate, and Godot's blend-tree editor is immature.

**What the editor has already:**
- Preact UI with an xyflow graph kit (`src/editor/graph/`), used for shader graphs.
- A `CurveEditor` (`src/editor/ui/CurveEditor.tsx`).
- A Sprite Editor with slices and undo (0040, 0115).
- Live orbitable previews (`ThumbnailRenderer.preview`, 0061).
- A Profiler table kit (0326).
- Storybook for components (0219).

**The audio branch adds more:**
- one shared curve editor (`src/editor/ui/curves/`, replacing `CurveEditor.tsx`; audio 0332);
- a component kit whose generic parts (dock, TreeView, curve editor, history popover, toasts, dialogs) live in the editor UI (audio 0335);
- **takes**: one file per recorded run holding what the game asked of audio, replayed against the current project, plus the profile (audio 0334).

On master, edits return a refused-or-next result applied as one labelled undo step (0307, 0313), and one parameter list module owns add, remove, rename, kind and range (0304). Records cited as *audio NNNN* are on the audio branch `ccr-8460d665-umr8or`, not yet merged. Their numbers clash with master's 0327–0334 and will change when that branch merges; the titles are the stable reference.

The overview lists "animation timeline … in the editor" as a non-goal. The owner has decided to build the whole animation system now, so the non-goal is removed.

## Decision

The editor half lives in `src/plugins/animation/editor/`, contributed through the editor SDK (0133). Views use the theme tokens (CLAUDE.md), have stories beside them (0219), and keep logic in `*Logic.ts` modules named distinctly from their views.

- **Animation window (dope sheet and curves):**
  - Edits `*.anim.json` clips and the tracks of a selected Animator's clip.
  - Rows per bound node, component and field; keys as diamonds; box select, move, scale, copy and paste; ripple.
  - The curve view is the shared curve editor (`src/editor/ui/curves/`, audio 0332), with `kind: "time"` lanes per bound field.
  - **Record mode:** changing an animatable field in the Inspector or with a gizmo writes a key at the playhead. The Inspector shows key buttons on animatable fields (0351).
  - Event, marker, audio and activation tracks have their own row editors.
  - Onion skin for sprites and bones.
  - Preview playback in the viewport without entering play mode, through the core in the Editor World.
- **Animation graph editor:**
  - Built on `src/editor/graph/` (xyflow). Pose nodes and pins, state machines as nested canvases, transitions drawn with their priority number.
  - A transition list panel per state: reorder, a condition editor (rows of parameter, operator and value, joined by all or any), blend settings and interruption.
  - A blend-space editor: 1D track and 2D plot with samples, triangulation and a draggable preview point.
  - The chooser table as a spreadsheet view; a linked-graph picker; mask panels;
  - **Parameters through the one parameter list module (0304)**, moved from `plugins/audio/editor/` into the editor SDK so audio and animation share it, with the shared parameter card;
  - **Node cards generated from the node catalogue's schema** (0352, including third-party nodes, 0350), as audio's effect cards are (audio 0338); rig-stack entries as a list with gizmos in the viewport (IK targets, pole vectors, spring-bone colliders, look-at limits).
- **Live debugger:**
  - In play mode, or on a selected Animator in a running build connected through the debug link (0356):
    - the graph highlights active nodes with weights and phases;
    - transitions show their condition's current value and why they're blocked (priority, interruption, exit time);
    - requests show their remaining lifetime;
    - the parameter panel is live and editable.
  - A **recorder** keeps the last N seconds (default 10) of parameters, states, slot plays and notifies per selected Animator, in memory. Scrub it to see the pose and graph at any frame. Poses are re-evaluated from the recorded inputs, which the deterministic core allows (0350).
  - **Animation joins takes (audio 0334).** A take of a run also records what the game asked of animation, in the same capture framing:

    | Record | Content |
    |---|---|
    | `ANIM_PLAY` | Animator, clip or slot, options |
    | `ANIM_PARAM` | every parameter change |
    | `ANIM_REQUEST`, `ANIM_TRAVEL`, `ANIM_LINK` | requests and linked-graph swaps |
    | `ANIM_IK` | IK target changes |
    | `ANIM_ROOT` | root and target poses at 30 Hz, changes only |
    | `ANIM_KEYFRAME` | each Animator's graph state every second, for seeking |

    The editor replays a take's animation requests against the current project, as the Studio replays audio, so a tuned transition can be judged on the exact run that looked wrong. One take holds both families when both plugins record.
  - The Profiler (0326) gets an Animation table.
- **Timeline window:** edits `*.timeline.json` with the same track editor. Bindings to scene nodes, `subclip`/`control`/`audio`/`activation` tracks, camera cuts, nested timelines, blend regions between clips, and scrubbing in edit mode.
- **Skeleton and retarget tools:**
  - The bone map editor (profile role → bone, auto-guess, mirror) in the model's Asset Inspector.
  - A chain editor for custom profiles.
  - A side-by-side retarget preview (source and target playing the same clip).
  - "Bake retargeted clip" writes an `*.anim.json`.
  - Bones show in the Hierarchy under the `Skeleton` as read-only virtual entries. Selecting one shows a bone gizmo and offers "Add BoneAttachment". The Inspector-target module (0242) gains a bone target, so bone selection goes through it like every other selection.
- **Clip import settings** in the model's Asset Inspector:
  - split takes on a timeline strip; loop with a pose-match indicator;
  - root-motion bone, axes and bake options; additive reference;
  - compression error with resulting size and maximum error (0351);
  - markers, events and curves on the source take;
  - a live preview (0061) on the model or any profile-compatible character.
- **Pose database tool:** pick clips and tag ranges; feature and weight settings; bake in the worker (0350) with progress; a debug view of the trajectory and the chosen pose in the viewport.
- **Ragdoll builder** (the `myco.ragdoll` plugin's editor half, 0355): generate bodies and joints from a skeleton (capsules by bone length, limits from the profile's joint ranges), then edit shapes and limits with gizmos. A test button drops the character in the viewport.
- **2D:**
  - flipbook from selected slices (Sprite Editor and Assets panel);
  - a 2D bone editor in the Sprite Editor: place bones, generate the mesh, paint weights with a brush and auto-weight.
  - Both use the Sprite Editor's undo history.
- **Edits and UI parts:**
  - Every animation edit a user can get refused returns the refused-or-next result (0307, 0313) and applies as one labelled undo step.
  - Limits come from each format's parse (0306).
  - Screens use the generic parts of the component kit (audio 0335).
- **Drop behaviour:**
  - Dropping a skinned model adds `Skeleton`, `SkinnedMeshRenderer`s and an `Animator` playing the first clip.
  - Dropping a clip on an Animator adds it (no graph) or offers to add a state.

## Alternatives considered

- **A separate node-graph library for animation graphs.** The owner keeps one UI library (Preact) and xyflow for graphs. The shader graph's kit is reused.
- **An Animation Studio as its own app (as audio 0327 made the Audio Studio).** Animation authoring needs the scene, the character and the viewport: record mode keys Inspector and gizmo changes, IK targets and colliders are edited in place. Audio authoring is file-centric, which is why that split works there. We share its parts instead (curve editor, component kit, takes).
- **Debugging by logging only.** Cheap, but it doesn't explain why a transition didn't fire, the most common question in every engine.
- **Leaving the timeline out (the old non-goal).** Contradicts the owner's decision to build the whole system. Cutscenes would also need a second mechanism.

## Consequences

**Positive**
- Every part of 0350–0352 can be authored and inspected in the editor.
- The recorder and "why not" transition display go beyond all three engines' debugging.

**Negative / costs**
- This is the largest editor addition since the shader graph: eight windows and tools, each needing stories, unit tests of their logic modules and e2e coverage, run by the coordinator on the merged result (CLAUDE.md).
- Record mode touches the Inspector and gizmos and needs care with undo grouping.

## Deprecates

- The overview's non-goal "animation timeline" (struck through with a link here when accepted).

## Open questions

None. The live connection to running builds is 0356.

## References

- Audio branch: `src/editor/ui/curves/`, `src/studio/components/`, the take format (audio 0334).
- `src/editor/graph/`, `src/editor/ui/SpriteEditor.tsx`, `src/engine/render/babylon/previews/ThumbnailRenderer.ts`, 0326's table kit.
- Unreal Rewind Debugger and Pose Watch; Unity Animation window and Timeline; Godot AnimationTree editor.
