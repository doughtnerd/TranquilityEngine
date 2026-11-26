# 0378. The animation build's public, editor SDK and engine additions beyond 0370–0376, and the places where the built behaviour differs from their text, are recorded here

- **Status:** Accepted (each item is already built under 0370–0376, which the owner accepted as "build it all")
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0370, 0371, 0372, 0373, 0374, 0375, 0376 (names they don't list, and text the build doesn't match; each item below says which)
- **Related:** 0010, 0026, 0133, 0303, 0304, 0326, 0346

## Context

0370–0376 were accepted together and built in one run (`docs/design/animation/build-log.md`, decisions D92–D139 in `docs/design/animation/decision-log.md`). The build added public names (`myco`), editor SDK names (`myco/editor`, `src/editor/sdk/`) and engine or export surface the records don't name, and in some places shipped something other than what the record says. The decision log marked these "for the amendment record" (D117, D120, D126–D139), and the documentation pass (T80) listed the doc/code mismatches.

Accepted records aren't rewritten. This record lists every such item once, with the record it amends, why, and where it lives, so 0370–0376 plus this record describe what is built. Every item was checked against the code at `364a6adf`.

## Decision

The records 0370–0376 stay in force, read with the following changes.

### Scripting API (`myco`, amends 0371 and 0372)

| Name or behaviour | Amends | Why | Where |
|---|---|---|---|
| `Animator.travel()` returns `Promise<AnimatorTravelResult>` (exported from `myco`), `{ reason: "arrived" \| "unreachable" \| "interrupted" }`; it never rejects or hangs | 0372 (`travel` returned nothing) | Gameplay waits for a state as it waits for a play (D117) | `runtime/components/Animator.ts`, `runtime/types.ts` |
| `AnimatorPlayOptions.section` also takes `{ start, end? }` in clip seconds | 0372 (a section name only) | One-shots of a clip range without authoring cue markers (D117) | `runtime/types.ts` |
| `AnimatorJumpOptions.normalizedTime` (0–1): `jump` enters the state that far in (each clip player starts `normalizedTime × its length` in; a looping clip wraps, a one-shot clamps) | 0372 (`jump` entered at the start) | Replication re-enters a drifting ghost at the server's time; Unity's `Play(state, layer, normalizedTime)` (D140) | `runtime/types.ts`, `features/graph.ts` |
| `TweenField<T>` accepts dotted paths: a sub-path of a plain-object field (`"drive.targetRotation"`) or a MeshRenderer material property (`"material.color"`, a per-renderer override) | 0371 (tweens on animatable fields) | The same property paths tracks bind (D107, D114) | `runtime/types.ts` |
| `MeshRenderer.setMaterialProperty`, `getMaterialProperty` and `clearMaterialProperty` take an optional `slot`; a slot's colours are linear, and each overridden slot draws its own material clone | 0371 (material tracks bind `materials[slot].<prop>` but no API reached a slot) | Unity's per-material-index property blocks; model material tracks need it (D111, D120) | `src/engine/render/components.ts` |
| Crossfade gains musical timing: `AnimatorCrossfadeOptions extends AnimatorMusicTiming` (`at`, `music`, `align`) | 0372 (`play`, `travel` and `request` only) | A crossfade is a play with a fade (D139) | `runtime/types.ts`, `runtime/features/music.ts` |
| Musical timing: `travel` and `request` ignore `align: "hit"` (one warning); `exit` waits for the next Exit marker the playlist reports, so loop wraps and the music's end don't count; there is no default music (`music` is required with `at`); looping slot plays get no late-start shift | 0372 | What the audio API exposes today (D139) | `runtime/features/music.ts` |
| There is no `trigger` method, so nothing else takes `at`. 0372's "no triggers" stands; `request` is the only way to ask for a transition | 0372 (confirms) | D139 noted that `trigger` isn't covered; there is nothing to cover | `runtime/components/Animator.ts` |
| `AnimationEvent` is `{ node, animator, method, phase, args, clip, time }` with no `weight` | 0372 (confirms its field list: notifies fire by clip weight, but the weight isn't reported) | A notify's clip weight isn't reported; adding it is a public API change for a later record (D108) | `runtime/buffers.ts` |
| Timeline `event` tracks deliver no `AnimationEvent`: `TimelineDirector` skips them with one warning | 0371 (timelines list `event` tracks) | Timeline notifies need a delivery target the director doesn't have yet | `runtime/features/timeline.ts` |
| Only the first four named graph layers carry a run-time weight (`layerWeight`), and the base machine none (`MAX_LAYERS = 4`) | 0372 (`anim.layerWeight(name, w)` with no limit on layers) | The core's input row has four layer-weight words | `runtime/wasm/wire/core.ts`, `runtime/features/playback.ts` |

### Ragdoll (`myco`, amends 0375)

0375 names the `Ragdoll` component with per-bone shape, mass and joint settings, `mode`, `blend`, pinning strength and get-up. The build adds:

- **Methods:** `getUp(): Promise<AnimatorTravelResult>` (freeze the simulated pose into the graph's pose snapshot, travel to the get-up state the pelvis facing picks, turn the ragdoll off) and `body(bone): GameObject | null` (the node holding a bone's body while simulating, for forces and hit reactions).
- **Fields:** `strength` (global muscle strength), `pinStrength`, `pelvis`, `front` (the pelvis axis out of the belly), `getUpFromBack`, `getUpFromFront`, `physicalPoseNode`, `snapshotNode`, `blendParameter`, `autoGetUp`, `teleportDistance`; per bone (`RagdollBone`): `strength`, `pin`, `frame`, `swing`, `twist`, `stiffness`, `damping`, `maxForce`.
- **Exports:** `Ragdoll`, `RagdollBone`, `RagdollMode` and `RagdollShape` from `myco`.
- **Behaviour:** bodies live in a runtime container node under the active scene, one child per body (what `body()` returns), created in the rest pose and teleported to the animated pose a step later; pins blend velocity toward the goal (PuppetMaster); default density 985 kg/m³ (D126).

Where: `src/plugins/ragdoll/runtime/Ragdoll.ts`, `bodies.ts`; `src/myco.ts`.

### Editor (amends 0373)

Built behaviour that differs from 0373's text:

- **"Bake retargeted clip" writes a compressed `.anim.bin`** (`<clip>.<model>.anim.bin` in the target model's folder), not an `.anim.json`: there is no TypeScript decoder for authored keys (D128). The baked clip plays but isn't editable in the Animation window. `plugins/animation/editor/skeleton/retargetLogic.ts`.
- **The ragdoll builder's Test Drop needs a playing game:** it sets the live Ragdoll to `"ragdoll"` and saves nothing; while editing, the button is disabled and says to press Play (D132). The SDK has no start-play call. `plugins/ragdoll/editor/builder/testDropLogic.ts`.
- **Onion skin is frames plus a window overlay only:** ghost marks on the ruler and rows and sprite frames beside the playhead. There are no viewport ghosts of bones or sprites, because the renderer can't draw a node twice in one frame with another pose. `plugins/animation/editor/animationWindow/onionSkinLogic.ts`.
- **Record mode keys animatable component fields only:** there is no bone record mode and no data-component tracks. The scene document is unchanged while recording (D129).
- **The recorder's scrub writes the past pose into the live instance while paused** (saved and restored before the next evaluate) rather than drawing a ghost; re-evaluation runs in a scratch instance under its own World id; one Animator is recorded at a time (D131).
- **The Animation table joins Play Stats**, not the Profiler: 0326's table kit (`profilerTablesModel.ts`) no longer exists in the code. The table is registered through `registerPlayStatsTable` (D138).
- **The pose database's match debug view** draws from a `MatchDebugSource` (`setMatchDebugSource`, plugin-internal); the play session's source reads the core's match reports through `AnimationCore.setMatchDebug`/`matchDebug` for the selected Animators (D132, D140). `plugins/animation/editor/poseDatabase/poseDbDebug.ts`.
- **The Animation and Timeline windows preview the edited scene in place** through edit-mode activation (see Engine below), not a copy of the scene. BoneAttachments don't follow previewed bones; activation-track changes during a timeline preview aren't undone (D136).
- **Timeline bindings can't be set by dropping Hierarchy nodes**: the SDK has no node drop-target registry.

Editor SDK additions (`src/editor/sdk/`):

| Name | Kind | Why | Where |
|---|---|---|---|
| `ParameterCards` `fields` prop | component prop | A holder whose parameters are typed its own way (a graph's float, int, bool) replaces the kind select (D127) | `sdk/ParameterCard.tsx` |
| `registerImportSettingsSection` | contribution point | A plugin card in an asset kind's Import Settings, editing the kind's draft (bone map, clip import), since plugins may not import the meshes plugin's view (D128) | `sdk/plugins.ts` |
| `registerFieldAdornment`, `registerFieldWriteInterceptor` | contribution points | Key buttons beside Inspector fields, and record mode taking field writes instead of the document (D129) | `sdk/plugins.ts` |
| `registerSkeletonBones`, `registerNodeAssetDrop`, `registerAssetNodesAugment` | contribution points | Bone rows in the Hierarchy, a clip dropped on an Animator, and the skinned model drop (D112) | `sdk/plugins.ts` |
| `registerSpriteEditorTool` | contribution point | Sprite Editor tabs (Flipbooks, Bones) whose edits are steps on its history (D135) | `sdk/plugins.ts` |
| `registerPlayStatsTable` | contribution point | A titled table under a World's rows in Play Stats (D138) | `sdk/plugins.ts` |
| `DopeSheetGrid` with `DopeBar`, `DopeBarPart`, `DopeKey`, `DopeRow`, `DopeSelectMode`, `DopeSpan`; the multi-key `keyList` edits `copyKeysAt`, `pasteKeys`, `removeKeys`, `rippleKeys`, `scaleKeys`, `shiftKeys`, `SAME_X`, `CopiedKeys`, `KeysEdit` | exports | The dope sheet shared by the curve editor, the Animation window and the Timeline (clip bars, trim zones, blend spans; D129, D133) | `sdk/index.ts` → `ui/curves/` |
| `fitYRange`, `withCurveEnds`, `storedFieldValue` | exports | The Animation window imported them from editor internals, which plugins may not do (build log, T45t merge) | `sdk/index.ts` |
| `editor.scene.live()`, `editor.scene.playPaused`, `editor.scene.redrawPlay()` | surface (internal tier) | The live debugger follows the live selection and redraws a paused game after showing a past pose (D131) | `sdk/scene.ts` |
| `editor.assets.writeImportSettings` | surface | Writes a sidecar and tells the Inspector and pickers (D135) | `sdk/project.ts` |
| `LargePreview` `posed` prop, `assetNodesFor`, `PosedPreview` | exports | Posed asset previews: a World the plugin describes (D134) | `sdk/index.ts`, `ui/AssetPreview.tsx`, `posedPreview.ts` |
| `editorDebugLink()` with `ConnectedBuild`, `EditorDebugLink`, `ListenState` | export | The editor's one debug link; plugins read connected builds through it (D137) | `sdk/index.ts` → `debugLink/` |

Gaps the SDK still has: **no start-play call** (Test Drop needs one) and **no node drop-target registry** (Timeline bindings).

### Engine, plugins and export (amends 0370, 0374, 0376)

| Name or behaviour | Amends | Why | Where |
|---|---|---|---|
| `Engine._addFrameHook({ begin, end })`, internal (`@internal`, not public): `begin` after the input snapshot and before any World steps, `end` after | 0376 (the link's frame start) | The link is per Engine and lands before every World, so it isn't an ECS system (D137) | `src/engine/core/Engine.ts`, `src/engine/debugLink/host.ts` |
| `ctx.debugLink.topic(name, load)` takes a lazy loader (the topic's module is imported only when the link runs); editor halves have no `debugLink.topic`, they read through `editorDebugLink()` | 0376 (topics registered through runtime and editor contexts) | Release builds drop the link's chunks; the editor side has one link object | `src/plugins/runtimeContext.ts`, `src/engine/debugLink/topics.ts` |
| `ExportOptions.debugLink` (Node export, `--debug-link <port \| host:port \| ws://…>`) and `BuildOptions.debugLink` (`string \| true`) | 0376 (only `game.json` `debug` and a desktop flag) | The export's way to set `game.json` `debug: { link }` (D137) | `src/export/node.ts`, `src/export/webBuild.ts`, `src/export/main.ts` |
| `game.json` `debug: { link }` as 0376 says, plus the player's `files.json` `debug` list: only debug builds get the link's chunks; a web build also takes `?debug-link=`; default `ws://localhost:7790/myco-debug`; animation's sample record is `ANIM_FRAME = 0x40` | 0376 (details) | Release exports share the prebuilt player (D137) | `src/export/format.ts`, `src/engine/debugLink/config.ts` |
| **Only the desktop editor accepts a debug-link connection.** A browser page can't host a WebSocket server; the desktop editor listens through a native server ([0379](0379-the-desktop-editor-listens-for-the-debug-link-through-a-native-websocket-server.md)) | 0376 (the editor listens) | The desktop listener needs a new Rust crate dependency; queued as a follow-up | `src/editor/debugLink/link.ts`, `src/engine/net/Transport.ts` |
| `plugin.json` `animationNodes: [{ module, budget? }]`, validated leniently (bad entries dropped with a warning, never a refusal); budget default 1,000,000, maximum 50,000,000, plus 1,000 per call; games load only modules metered at export; npm plugins' node modules aren't shipped | 0370 (nodes "declared in its `plugin.json`", no section named) | Budgets read without running plugin code, like audio's section (D130) | `src/engine/animation/pluginNodes.ts` |
| `PosedPreviewSpec` and `ThumbnailRendererApi.previewPosed(spec, canvas)`, editor-only engine access (ADR 0026, `src/engine/editor/`), not `myco` | 0373 (live previews) | Posed previews run a live World the plugin describes (D134) | `src/engine/render/previewTypes.ts`, `src/engine/editor/index.ts` |
| `Animator`, `Skeleton`, `Skeleton2D` and `TimelineDirector` activate in edit mode (`_activatesInEditMode`, ADR 0026) and stay inert until a preview drives them: an edit-mode Animator has no core instance, a director loads and writes nothing, and no root motion, notifies, audio or control keys fire | 0373 (preview in the Editor World) | Without it neither window's preview moved the real editor scene (D136) | `runtime/components/*.ts`, `runtime/features/editPreview.ts` |
| An optional dependency's module is loaded with `import()` once it's active, never statically; a static value import needs a hard dependency. `src/plugins/plugins.test.ts` enforces it | 0374 (didn't say how the module is reached) | A static import would load the optional plugin even when it's off (D113) | `src/plugins/plugins.test.ts`, `runtime/features/events/audio.ts` |

**First-party only, not `myco`:** the animation runtime's `authoring.ts` facade (`boneWorldMatrixOf`, `defaultRagdollDescription`, `loadSkeletonBytes`, `readSkeletonInfo`, `SkeletonInfo`), which the ragdoll builder reads because plugins may not deep-import each other (D132).

**Internal names (not public API):** `EvaluateTap` and `AnimationWorldCore.taps` (the recorder's tap on a World's evaluate), and `CompiledAnimGraph.transitions` / `.conditions` (the compile's transition and condition path tables, which the debugger maps core indices through; D131). They may change without a record.

(Paths starting `runtime/` are under `src/plugins/animation/`; `sdk/`, `ui/` and `debugLink/` under `src/editor/`.)

## Alternatives considered

- **Edit 0370–0376 in place.** Simpler to read, but accepted records aren't rewritten in this repo; the history of what was decided before building would be lost.
- **One amendment per record.** Seven small records for one build; the items cross records (musical timing, previews, the debug link), so one list is easier to check.
- **Change the code to match the records** (drop the extra names, make the bake write `.anim.json`). The additions are used by the built tools and the differences have reasons (no TypeScript key decoder, no renderer double-draw); reverting would remove working features.

## Consequences

**Positive**
- 0370–0376 plus this record describe what is built; the guide (`docs/wiki/guide/animation.md`) and the records agree.
- The SDK additions are named public surface, so third-party editor plugins can rely on them.

**Negative / costs**
- Readers of 0370–0376 must read this record too; each of them points here in its status.
- Every SDK addition is now surface to keep stable.

## Deprecates

Nothing. 0373's "Bake retargeted clip writes an `*.anim.json`" and "The Profiler (0326) gets an Animation table" are replaced by the items above.

## Open questions

- `AnimationEvent.weight`, timeline notifies, viewport onion-skin ghosts, bone record mode, data-component tracks, an SDK start-play call and a node drop-target registry are each still to build; the ones that add public API need their own record.

## References

`docs/design/animation/decision-log.md` (D107–D139), `docs/design/animation/build-log.md` (T44–T80), `docs/wiki/guide/animation.md`, `src/myco.ts`, `src/plugins/animation/runtime/types.ts`, `src/editor/sdk/index.ts`, `src/editor/sdk/plugins.ts`, `src/editor/sdk/scene.ts`.
