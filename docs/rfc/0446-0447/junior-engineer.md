What I read: ADR 0446 and 0447 (with glossaries), `docs/design/lod-occlusion/goal.md`, CLAUDE.md, and the existing code (`render/components.ts`, `plugins/meshes/editor/ModelImportSettings.tsx`, `Animator.ts`, `GameObject.ts`). The records are not in this worktree (master 6a0740ca); I read them from `claude/lod-occlusion-design` at 76649d0b.

**Verdicts**
- **0446: approve with changes.** The model is clear. The import/LODGroup contract has two contradictions and a naming trap (Issues 1, 2, 3).
- **0447: approve with changes.** The occluder rules contradict 0446 on the stand-in (Issue 1). Everything else is readable.

**Top 3 concerns**
1. Objects disappear with no visible reason: the default last transition culls below 1% of screen height, and `"auto"` occlusion hides objects silently.
2. The occluder stand-in rules are specified two different ways.
3. Key terms and the `lodMaxLevel` direction are ambiguous for someone without rendering background.

## Issues

1. **blocking. The meaning of `lod.occluder: "auto"` contradicts itself.** 0446 §1 says `"auto"` is "a sloppy stand-in" and `"lod"` is "the coarsest level". 0447 §3 says `"auto"` is "the coarsest generated level, or a `simplifySloppy` stand-in at about 5 % … when the model has no levels". Someone implementing the sidecar cannot tell which geometry occludes. Change: pick one definition and put it in 0446's JSON comment and 0447 §3 verbatim.

2. **major. Stand-in generation is undefined for models with `lod: null`.** 0446 says `lod` null means no levels and no pipeline. The `occluder` key lives inside `lod`, and step 4 runs only in the levels pipeline. 0447 still says an `"auto"` stand-in is built "when the model has no levels". A 1,500-triangle house (under the 2,000 default) gets neither a level nor a stand-in. Change: state whether `null` models get a stand-in, and move `occluder` out of `lod` if they do.

3. **major. `lodMaxLevel` reads backwards.** 0446 §5 calls it the "finest level a tier may draw: Low 1, others 0". The name says "max", and the value gives Low no LOD0 at all while other tiers may draw only LOD0, so no tier ever draws a coarse level. Change: rename to `lodMinLevel`, or define it as the coarsest allowed level and recheck the values.

4. **major. `LODGroup.levels` has no default for meshes with no levels.** 0446 §2 says "from import". A builtin cube, or any model under 2,000 triangles, has no import levels. "I added an LODGroup and nothing changes" is the likely result. Change: define `levels: []` as "draw level 0, never cull", and have the inspector say "no levels: drawing LOD0 only".

5. **major. Distant objects vanish by default.** The last transition defaults to 0.01, so anything under 1% of screen height is culled, with no distance check. A scene-view zoom-out makes props disappear. Change: default `levels` on editor-placed props to a final 0 (never cull), or show a "culled by LOD" state on the renderer.

6. **major. `currentLevel === -1` does not say why.** 0446 §2 says it is "-1 when culled". Culled by LOD, outside the frustum, or hidden by occlusion (0447) look identical. Change: a `cullReason` enum, or a field separate from `currentLevel`.

7. **major. A saved `forceLevel` silently overrides LOD.** It is a scene field, and "debugging" is the only documented use. Change: the inspector shows a warning badge whenever it is not -1.

8. **minor. Glossary `Error` mixes the limit and the measured value.** The sidecar `error` is a limit, while transitions use the measured error. Glossary also says h is "Unity's LODGroup measure" and then says it differs from Unity by up to 1.7×. Change: separate "error limit" and "measured error" in the glossary, and rewrite the h line.

9. **minor. Scene view has LOD on but occlusion off.** The editor view can cull distant props that the game would still draw. Change: note this in the Editor section and in the View-menu tooltip.

10. **minor. Quality-tier and Animator side effects are not surfaced.** Adding an `LODGroup` silently sets `lodMetric` to `"lodGroup"` on Animators (0446 §6), and auto-quality changes LOD bias. Change: list each side effect in the inspector's change log or a toast.

## What was unclear

- **LOD (level of detail):** defined, good. Add: "more triangles near, fewer far, same object."
- **Transition height / h:** "screen-relative height" needs one example: "a 1 m rock 20 m away on a 1080p screen is about h = 0.05."
- **Batch / thin batch / auto batch:** defined, but "culled as a whole" needs "one box test for all instances."
- **Frame plan (0129), probe capture, shadow cascade, render-texture camera, tier:** used without definition.
- **Conservative (0447):** "may keep something hidden, never hides something visible." Good; add a concrete example.
- **Dilation / coverage shrink:** no plain meaning. I'd want "make the test box a pixel bigger, and count a pixel covered only if most of it is inside."
- **Hi-Z, PVS, guard band, SIMD, wasm:** Hi-Z and PVS are defined; "guard band" and "SIMD" are not, for a non-graphics engineer.

## Using it

Script (assumes `GameObject.getComponent` exists; the records don't show it):

```ts
const rock = world.find("Rock");                   // a model root with an LODGroup from the editor
const group = rock.getComponent(LODGroup);
group.levels = [0.15, 0.09, 0.05, 0];              // 0 = never cull (proposed)
group.fade = "none";
rock.getComponent(MeshRenderer).occlusion = "occludee";
if (group.currentLevel === -1) { /* culled: which reason? see Issue 6 */ }
```

Editor, as I understand it: import a model. The Import Settings card gains an LOD section (ratio and error rows, switches, pixel error). Apply bakes it. Drag the model into the scene and its root gets an `LODGroup`. The inspector shows a colour bar per level with draggable dividers. Click a segment to preview that level in the scene view. The View menu toggles occlusion and a debug view. The current `ModelImportSettings.tsx` has Scale, Up Axis, Facing, Normals, Pivots and materials (lines 11–58), and nothing LOD-related. `MeshRenderer` (`render/components.ts:344`) and `Camera` (`:159`) have no `occlusion` or `occlusionCulling` yet.

## Tasks I could take

- **Low risk:** LOD colour tokens in `theme.ts` and `editor.css`; LOD rows in `ModelImportSettings.tsx`, following the `import-row` pattern; `LODGroup` field declarations with defaults; unit tests of the h and pixel-error formulas.
- **Medium:** `render/lod/select.ts` (pure TS, frustum and 4% hysteresis, unit tests); `Camera.occlusionCulling` field; `QualityTier` fields in `core/graphics.ts` with the auto-quality step.
- **Not for me:** Babylon integration (`BabylonMeshes`, `afterView`, thin-batch compaction), the GLSL/WGSL crossfade plugin, shadow fade, the Rust/SIMD occlusion core and its wasm size gate, the `.mycomesh` v5 layout, and the Animator coupling.

## Debugging

I'd need, for every renderer in the inspector: the group's level, h against its thresholds, and a single `culledBy` reason (LOD, frustum, occluder id, forceLevel, tier cap, or none). Also:
- a warning when a group has no levels;
- a badge when `forceLevel` is set;
- sidecar state: `lod: null`, `levels: N`, or stale bake;
- a list of skipped occluders with their reason (0447's "skipped" rule is silent);
- `RenderStats.triangles` non-zero (it is 0 today, `BabylonRenderer.ts:826`);
- a one-time console warning when SIMD is missing and occlusion turns off;
- an "LOD-culled ghosts" toggle in the scene view.

## Questions for the author

1. Which definition of `lod.occluder: "auto"` stands (Issue 1)?
2. Do `lod: null` models get an occluder stand-in (Issue 2)?
3. What does an empty `levels` mean (Issue 4)?
4. Is `lodMaxLevel` the finest or coarsest allowed level (Issue 3)?
5. Do models imported before this feature get levels? Is there a re-import button, or do they stay flat?
6. Does occlusion cost zero when a view has no occluders, or always about 1.2 ms (0447 Consequences)? That matters for default-on.
7. Are shadow pops at the fade midpoint visible enough to need a note in the crossfade docs?
