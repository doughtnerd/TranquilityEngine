# RFC 0459/0460: user persona review (solo dev, 8 years Unity)

What I read: 0459 and 0460 in full (the files sit in the main checkout, not on this branch's tree), `docs/design/lod-occlusion/goal.md`, the `spikes/lod-simplify` and `spikes/render-bench` READMEs, `src/plugins/meshes/editor/ModelImportSettings.tsx` (11-60 plus the material rows), `src/editor/ui/Inspector.tsx` 465-580, and `docs/wiki/guide/` (listing, `transforms.md`, `editor.md:121`).

**0459 (LOD): approve with changes.** The generate-at-import plus `LODGroup` shape is what I'd want. Top concerns: (1) hard-edged models, which is every building and interior, stall unless I know to tick `permissive`; (2) import cost is paid on every editor open, with no disk cache; (3) foliage (alpha cards, wind, vertex colours, no impostor) isn't addressed, and forests are my main use.

**0460 (occlusion): approve with changes.** Top concerns: (1) the "solid" rule (`0460:91`) excludes walls, so interiors and towns, which gain most, get no occluders under `"auto"`; (2) default-on at about 1.2 ms (est. 3-4 ms on Android, unmeasured) while forests cull only 28 % (`0460:50`); (3) skinned and vertex-animated bounds can cause false occlusion, the one bug I can't tolerate.

## Issues

1. **Walls aren't occluders (blocking, 0460).** "Solid" means smallest extent >= 10 % of largest (`0460:91`). A 10 x 3 x 0.2 m wall is 2 %. The 512-triangle rule (`0460:94`) only supplies geometry; the solid test still gates `"auto"`. Interiors are walls and floors. Change: judge a slab by its largest face area, and exclude only things thin in two axes (poles, trunks). Show the rejection reason in the inspector (`0460:136` promises this).
2. **Hard edges stall by default (major, 0459).** A building stops at 63 % of LOD0 (`0459:57`, `0459:239`). `permissive: false` (`0459:84`) is the default, so my first town ships LODs that save little, with only a panel hint. Change: if a level misses its target, retry once with permissive and report "reached 12 %, error 1 %"; keep the switch as an override.
3. **Foliage and wind (major, 0459).** Attribute weighting covers normals and UVs only (`0459:79`). Wind weights in vertex colours and alpha-cutout leaf cards simplify badly, and no billboard/impostor level exists, which is what a tree needs below about 2 % height. Change: weight colours, name billboard levels as the first follow-up, and ship a documented "tree" preset (3 levels, last cull at 0.03).
4. **Editor-open cost (major, 0459).** Generation runs in the editor's model load and is cached per session only (`0459:100-102`). 150 asset-store models at tens of ms is seconds on every project open; Sponza-class costs 0.85 s. Change: write generated levels to a cache under `.myco/` keyed by file and settings; don't leave it as an open question (`0459:249`).
5. **No before/after at import (major, 0459).** `ModelImportSettings.tsx:11-60` is plain rows. The record adds level rows and reached triangles (`0459:194-196`) but no preview. I want to flip LOD0..N in the import inspector with a pixel-error slider; the scene-view preview (`0459:193`) needs the model placed first.
6. **Shadows vanish or coarsen (major, 0459).** Casters use the first view's level, and a group culled by LOD casts no shadow (`0459:145`). A small prop culled below 1 % height can still cast a long evening shadow; a tall tree just outside the frustum shadows into view. Change: LOD-culled and off-screen groups keep casting at the coarsest level unless a field says otherwise, and say what happens off-screen.
7. **Vanishing objects (major, 0459).** The default last threshold culls below 1 % of screen height (`0459:124`), and h uses the diagonal, not Unity's largest extent (`0459:126`). Mountains and long thin poles will behave unlike Unity. Change: a clear "never cull" option, no default cull for large models, and a "culled by LOD" count in the Stats panel.
8. **False occlusion from bounds (major, 0460).** Occludees use renderer bounds (`0459:141` for skinned). Wind or displacement shaders, ragdolls and animation that leaves its bounds will flicker out. Change: per-renderer `boundsPadding`, and a debug mode listing objects culled after being visible last frame.
9. **Occlusion default and cost (minor, 0460).** `Camera.occlusionCulling` defaults on (`0460:107`, `0460:183`) though open scenes gain little and the Android figure is an estimate (`0460:170`). Change: self-disable per camera when the cull ratio stays under about 10 % for 2 s (logged), or default off until Android is measured.
10. **Moving occluders and portals (minor, 0460).** Doors, lifts and glass only get `"none"`. A closed door occludes; an open one must not. Change: document scripting `occlusion` per frame, and make transparent materials occludee-only by default.
11. **Crossfade costs (minor, 0459).** Fading batches split (`0459:163`) and fade time is fixed per group. Show draw-call growth while fading in the Stats readout.
12. **Scene clutter (minor, 0459).** Placing a model auto-adds an `LODGroup` (`0459:127`) shown through the generic `ComponentCard` (`Inspector.tsx:471-514`, sections at `:578`). A forest means hundreds of identical groups; multi-select edit (`paths`) helps, but prefab overrides need a stated rule.
13. **Docs (minor).** `editor.md:121` lists only Scale, Up Axis and Normals; guide pages are one topic per file (`animation.md`). Ship `docs/wiki/guide/lod-and-occlusion.md` plus a "why is my object missing" checklist like `why-no-sound.md`.

## My workflow with this

- **Import.** I drop a Blender house and an asset-store tree pack. Levels appear on first inspect. I want a report ("3 levels, 100 / 41 / 12 %, error 0.4 %") and a flip-through preview before Apply. If the house stalls at 63 %, I won't know why (issue 2).
- **Place.** Dragging into the scene adds an `LODGroup`. The LOD bar with draggable dividers and a camera marker (`0459:188-193`) beats Unity's.
- **Tune.** I fly the scene view with LOD colouring. The scene view's occlusion default is off (`0460:107`), so I see a different world than the player; I want one "preview as game" toggle.
- **Debug.** An object vanishes. I need one panel saying why for the selected node (LOD cull, occlusion, frustum, layer). The debug views (`0460:129-137`) are good, but a per-object reason is the real fix.
- **Ship to Android.** The record admits 10k instanced objects are far beyond the floor (`0459:52`). I need a per-platform LOD bias profile and a device-run budget readout (triangles, draws) before trusting defaults. `.mycomesh` grows 1.1-1.3x, which hurts web download size.

## What I'd miss from Unity

Billboard/impostor levels (SpeedTree); baked occlusion with portals and areas (interiors); per-renderer culling distance; authored LOD import (`_LOD0` names), since my Blender art arrives with LODs; the Scene-view LOD stats overlay. `lodBias` per tier matches Unity's LOD Bias, good.

## Defaults

- LOD on by default above 2,000 triangles: yes, with a visible "LOD generated" badge on the asset.
- `permissive` automatic (issue 2); `pixelError` 1 and fade on at 0.3 s are fine.
- Last-level cull 0.01 is too eager for big things (issue 7).
- Occlusion `"auto"` is right only after issue 1. `Camera.occlusionCulling` should self-disable in open scenes (issue 9).

## Cheaper alternatives

- Keep crossfade (popping is what players notice), but drop the `lodMaxLevel` and `lodCrossfade` tier fields; `lodBias` does most of the job.
- Skip the occlusion depth-image inset in v1; the red culled boxes and the readout answer "why".
- Defer `Animator.lodMetric: "lodGroup"` (`0459:182`); the distance metric works.
- Skip the Ultra 320x180 buffer; the gain over 256x128 is small.

## Questions for the author

1. Did any wall or floor in the test city pass the 10 % rule, or were all occluders spike-generated boxes?
2. Is a visible shadow ever lost to LOD culling or off-screen groups (`0459:145`)? `0460:108` says occlusion never removes casters.
3. Who owns impostors, and what do trees do between LOD3 and cull until then?
4. Can the export CLI print the import report, so CI catches a model whose levels stalled?
5. Who measures Android, and what number blocks acceptance (`0460:170`)?
