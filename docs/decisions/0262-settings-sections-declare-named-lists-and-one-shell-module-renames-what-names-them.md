# 0262. Settings sections declare their named lists, and one shell module renames what names them

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** 0116 in part (its layer rename)
- **Related:** 0097, 0116, 0133, 0148, 0151, 0158, 0162, 0166, 0253

## Context

A settings section keeps lists of names in `project.json` that scenes, prefabs and asset files refer to by name. Renaming an entry should rename those references. ADR 0116 did it for physics and sorting layers only, in the shell:

- `src/editor/layerRename.ts` knew physics: a `LayerKind` of `"physics" | "sorting"`, a `/Collider/` regex to tell collider types (it missed `engine.CharacterController` and `engine.CharacterController2D`, which have a `layer` field too), and a diff hard-wired to the two lists for undo and redo.
- `projectSettingsModel.layersOf` imported the engine's `resolvePhysicsSettings` only for that diff (ADR 0253).
- The Physics plugin's section reached the shell through an internal-tier import (`PhysicsSettingsSection.tsx -> editor/layerRenameEdit`, `plugins.test.ts`).
- Audio names are referenced the same way. `AudioSource.output` and `AudioReverbZone.output` name a bus, `AudioOccluder.material` names an acoustic material, and an event file names buses (`bus`, a music track's or stinger's `bus`, an aux send's key in `sends`) and parameters (automation, `switch`/`blend` nodes, `musicSwitch`, a region's `while`). `renameBus`, `renameParameter` and `renameMaterial` rewrote only `project.json`, so a rename silently orphaned every source, zone, occluder and event that named the old name.
- `audio.occlusion.layers` names physics layers, and a Tilemap layer's `sortingLayer` names a sorting layer. Neither followed a rename.

Navigation answered the same question differently: its areas and agent types have uuids (`navSettingsModel.ts`), and references hold the uuid, so a rename touches nothing else.

## Decision

We will add one shell module, **settings names** (`src/editor/settingsNames.ts`), which renames what names an entry of any **named list**. Sections declare their lists as data.

- **A named list** (`NamedList`) has an `id` (`"audio.buses"`), a `noun` for messages (`"bus"`), `names(draft)` (where the names live in the settings draft, in order) and its references:
  - `fields`: component fields that hold a name, as `{ component?, field }`. `component` is one type or several (absent: any component). `field` is a path in the component's data, where `*` steps into every item of a list (`"layers.*.sortingLayer"`). Prefab overrides of the field are found from the same declaration.
  - `assets`: files of an asset format, as `{ extensions, rename(json, from, to) }`. `rename` is pure and returns the same value when nothing changed.
  - `settings(draft, from, to)`: references elsewhere in the settings draft, outside the list's own edit (another section's key).
- **Who declares:** `ProjectSettingsSectionContribution.names` (the section that owns the list), and `registerNameReferences({ id, list, fields?, assets?, settings? })` for references a different plugin owns. The shell declares its own sorting layers. A list whose section isn't registered has no renames, and references to it are ignored.
- **What the module does:** it compares the draft before and after an edit, undo or redo. A list of the same length with exactly one name changed, unique and non-empty on both sides, is a rename. Adds, removes, reorders and duplicates are not. For an edit it finds the users (scenes, prefabs and the open scene's document by `fields`, asset files by `assets`). If there are any, it asks first, listing them, as the physics layer rename did ("Rename and update"). Cancelled, the edit is dropped and the field goes back. Then it applies `settings` references to the draft that is pushed, so they undo with it. After the move it rewrites the files: files on disk at once, the open scene as one undo step. Undo and redo of the panel's step find the reverse rename the same way and move the references back.
- **Where it plugs in:** two hooks of the project section spec (ADR 0151). `editing(project, before, next)` returns the draft to push, or null to cancel (a promise while it asks). `moved(project, before, after)` replaces `stepped` and runs after an edit too, not only after undo and redo. So every edit route renames references: the panel's built-in categories, a plugin's section through `props.set`, and `editor.project.settings.edit`. Views call `set` with the renamed draft and no rename code of their own. The project file loop of ADR 0148 (`editProject` in `assetReferences.ts`) moves to `projectFileEdits.ts`, and both modules use it.
- **The declarations:**
  - Shell: `render.sortingLayers`, every component's `sortingLayer`.
  - Physics: `physics.layers`, the `layer` field of each collider and character controller type (listed, not matched by name).
  - Tilemaps: `render.sortingLayers` in `engine.Tilemap`'s `layers.*.sortingLayer`.
  - Audio: `audio.buses` (`AudioSource.output`, `AudioReverbZone.output`, event files' buses); `audio.materials` (`AudioOccluder.material`); `audio.parameters` (event files, except an event whose own parameter has that name, since a local parameter hides a global one); and references to `physics.layers` in `audio.occlusion.layers`.
- **Names, not uuids, for new lists that scripts or the engine look up by name.** Buses (`mixer.resolveOutput`), parameters (`Audio.setParameter`), layers (`LayerMask`) and materials are found by name at run time and typed by people in scripts, so a name is the identity. A uuid would need a runtime lookup table, and a script would still use the name. Navigation keeps uuids: its areas are referenced from baked chunk data that is costly to rewrite, and scripts don't name them. A new list uses uuids only for that case: many references in baked or generated data, and no name in scripts.
- **Scripts are not rewritten.** As before, a script that quotes the old name keeps it.

## Alternatives considered

- **Each plugin calls the shell's rename from its own view** (today's physics path, extended to audio). Each view would copy the confirm, file rewrite and undo wiring, and the shell would keep a closed union of list kinds. The declaration lets the shell do it once.
- **Declare the list on the component field** (a field option naming the list, instead of `choices`). It is more exact and covers script components, but it changes the engine's public field options. Sections already own their lists (0151, 0253), so the declaration lives with them.
- **Uuids for every list**, as navigation does. This needs a migration of every project and scene, and scripts would still look entries up by name.
- **Rename only on the edit, not on undo and redo.** Undo would then leave scenes naming a list entry that no longer exists. ADR 0116 already moved references on undo.

## Consequences

**Positive**
- Renaming a bus, an acoustic material or a global parameter no longer orphans sources, zones, occluders and events. Physics layers still ask first and rewrite scenes. Character controllers, Tilemap layers and occlusion layers now follow too.
- Locality: the rename policy (detect, find, ask, rewrite, undo) is one module with one test over a fake project. Each plugin tests only its declaration.
- Leverage: a new list gets safe renames by declaring data.
- The `/Collider/` regex, `LayerKind`, the shell's import of physics settings (`layersOf`) and the internal-tier entry `PhysicsSettingsSection.tsx -> editor/layerRenameEdit` are gone.

**Negative / costs**
- Every settings edit compares each declared list before and after, which means parsing the audio section twice. It runs once per edit, not per frame.
- Undoing a rename rewrites files that were already saved (as in 0116).
- Two more SDK members (`names` on the section contribution, `registerNameReferences`).

## Deprecates

`src/editor/layerRename.ts` and `src/editor/layerRenameEdit.ts` (`LayerKind`, `LayerRename`, `layerUsers`, `renameLayerReferences`, `layerRenamesBetween`, `updateLayerReferences`, `renameLayerEdit`), `projectSettingsModel.layersOf`, and the project section spec's `stepped` hook (now `moved`). All removed. Their tests move to `settingsNames.test.ts` and the plugin declaration tests.

## Open questions

- Snapshots and graphics tiers are named lists too, but no scene or asset file names them today. They can declare a list when something does.

## References

- Architecture review 2026-11-20, pass 3, candidate 1.
- `src/editor/settingsNames.ts`, `src/editor/projectFileEdits.ts`, `src/editor/projectSettingsSection.ts`.
