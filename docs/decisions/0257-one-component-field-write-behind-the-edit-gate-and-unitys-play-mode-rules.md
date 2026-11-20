# 0257. One component field write serves the Inspector, plugin sections and gizmos, behind the edit gate, with Unity's play-mode rules

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0026, 0124, 0138, 0147, 0162, 0231, 0237, 0242, 0243, 0245, 0247 (amends 0147: `SetField` leaves `myco/editor`, `editor.scene.writeField`, `beginFieldDrag` and `useFieldDrag` are new; amends 0247: Inspector, component, node and gizmo edits go through the gate, closing its open question; amends 0243: the Hierarchy and Inspector show the live World by default during play)

## Context

"Write one field of one component" had a dozen implementations, and three answers to "may I edit while playing?":

- **Plugin copies.** `plugins/audio/editor/inspectorWrite.ts` had its own `FieldTarget` (a name the glossary gives the Inspector's field target, ADR 0243), `writeField` and `dragGroup` (a `WeakMap` of open steps per scene). `physics/editor/colliderGizmo.ts` and `audio/editor/AudioReverbZoneGizmo.ts` had near-identical `fieldWriter`s that skipped values they had already written. `ParticleInspector.tsx`, `NavGroupSection.tsx`, `navBake.ts` (twice), `particleMigration.ts` (twice) and Tilemaps' `brush.ts` and `palette.ts` (three) built `SetField` by hand: 12 call sites, from `SetField` in the SDK. Only Tilemaps wrapped them in `editor.scene.edit`; Tilemaps alone skipped an unchanged value, by hand.
- **A visible bug.** With the scene document shown during play, the Occluder section's slider opened its drag through `beginEdit`, which the gate refused ("Stop playing to edit the scene."), while every `onInput` still wrote the document.
- **The core never asked.** `documentFieldTarget.drag` called `beginUndoStep` with no gate; `fieldEdits.ts`, `componentEdits.ts`, `nodeEdits.ts`, `inspectorEdits.ts`, the scene settings' preload list, the transform gizmo and the viewport tools' `edit`/`gesture` never checked play, while Hierarchy paste refused (ADR 0247's open question).
- **Play mode showed the document.** `WorldPicker` (`ui/RuntimeHierarchy.tsx`) defaulted to "Scene (editing)", so during play the Hierarchy and Inspector edited the saved scene unless a live World was picked (`runtimeInspect.ts`' `liveInspecting()`).

The owner decided to follow Unity: during Play the Hierarchy shows the running scene, Inspector and gizmo edits change the live objects and are discarded when play stops, and the saved scene can't be changed while playing.

## Decision

We will have one component field write, in `src/editor/componentField.ts`, and Unity's play-mode rules.

- **A place.** `ComponentPlace` is `{ scene, path, type, index? }` (a component in a scene document; `path` is `[id]` or `[instanceId, innerId…]`) or `{ node, type, index? }` (a component on a node of a live World).
- **`writeComponentField(place, field, value)`** → why not, or null. `value` is scene-file JSON. In a document it asks the edit gate first (ADR 0247; the reason goes to the status bar), refuses a gone node, skips a value equal to what the file stores where the write lands (`storedFieldValue`: the instance's override inside a prefab instance, else the node's own value), and executes `SetField` with the override target, joining the open undo step or making its own. On a live node it writes the running World as the loader would (`writeField`), node references by entity in that World, and skips an unchanged value.
- **`beginFieldDrag(place, label, fields?)`** → a `FieldDrag` (`open`, `end`, `cancel`) or null. In a document it is one undo step opened through the gate (null when refused, as during play); on a live node it remembers `fields` and `cancel` writes them back.
- **The SDK.** `editor.scene.writeField` and `editor.scene.beginFieldDrag` are these functions; `useFieldDrag(place, label)` (`ui/fieldDrag.ts`) gives an Inspector control the pointer handlers that hold one drag across its re-renders. `SetField` leaves `myco/editor`; `plugins.test.ts` forbids it in editor halves. Viewport tools keep `ViewportToolContext.gesture` for their drags and write through `writeField`.
- **Callers.** The Inspector's document field target (`fieldEdits.ts`' `setFieldEach`, so `setField`/`setFieldAxis`; `revertField` through `editStep`) and its live field target (non-reference fields; references keep `setLiveNodeRef`'s same-World check) write through it; both targets' drags are `beginFieldDrag`. The audio Occluder and Audio Source sections, the collider and reverb zone gizmos, the particle effect section and migration, the NavGroup section and nav bakes, and Tilemaps' brush and palette use `editor.scene.writeField`. The transform gizmo writes through it and opens its step through the gate. `inspectorWrite.ts` and both `fieldWriter` maps are deleted.
- **The gate everywhere in the document.** `componentEdits.ts` (add, remove, enable, reorder, remove missing), `nodeEdits.ts` (active, rename, revert name and active; Create Prefab, Apply and Revert All say the gate's reason in `whyNot`), `inspectorEdits.ts` (Worlds, tags), the preload list and the viewport tools' `edit` and `gesture` ask the gate. During play every scene document edit is refused with one wording: "Stop playing to edit the scene." (or "to create prefabs", "to revert overrides" where the action names itself).
- **Play mode shows the running game.** When play starts, `inspectPlayedWorld` (`runtimeInspect.ts`) picks the live World playing the edited scene (the first World with a scene loaded from its path, else the first World), so the Hierarchy and Inspector show and edit it; those edits die with the session, except what "Keep values" writes back on Stop (ADR 0124). The picker's other entry is "Scene file (read-only)"; the Inspector's document view then starts with the gate's reason in a `--warning` note ("Stop playing to edit the scene. The running game is in the live World."). The play status reads "Edits change the running game until you stop; the scene file is read-only."
- **Not built: a play-mode tint.** The read-only note and the picker default carry the state; a window tint would need its own theme tokens across every panel, and was left out.
- **Plugin sections stay document-only.** `InspectorSectionProps` is a document place, and the live Inspector shows field rows only, as before; the write takes a live place, so a section can move to it later.

## Alternatives considered

- **Allow document edits during play everywhere** (the other answer to the product question) — the edits would change a file while the game runs from an earlier copy of it, and the user decided for Unity's rule.
- **Gate inside `CommandStack.execute`** — ADR 0247 rejected it: the stack serves asset documents and tests outside play, and a refusal there comes too late for menus.
- **Keep `SetField` in the SDK beside `writeField`** — plugins would keep choosing between the two; the drift came from that.

## Consequences

**Positive**
- One play rule: the scene document is read-only during play wherever it is edited; the live World is what play mode edits, as in Unity.
- One write: overrides, unchanged values, drag steps and the gate are decided once; 12 plugin call sites and two gizmo copies collapse onto it.
- `componentField.test.ts` covers what plugins do (override, skip, drag step and cancel, play refusal, gone nodes, live writes).

**Negative / costs**
- Visible changes: during play the Hierarchy and Inspector open on the live World; document edits from the Inspector, gizmos and viewport tools are refused in play with the gate's status line; the play status line changed; a viewport tool's `edit` with no scene now reports "Open a scene first.".
- Public editor SDK change: `SetField` removed from `myco/editor`; `writeField`, `beginFieldDrag`, `useFieldDrag` and the place types added. Only first-party plugins used `SetField`.
- An unchanged value no longer records an undo step anywhere (before, the Inspector recorded one).

## Deprecates

Removed: `plugins/audio/editor/inspectorWrite.ts` (its `FieldTarget`, `writeField`, `dragGroup`); the `fieldWriter` written-value maps in `colliderGizmo.ts` and `AudioReverbZoneGizmo.ts`; the transform gizmo's `last` map; `SetField` from `myco/editor`; `FieldDrag` moved from `fieldTarget.ts` to `componentField.ts` (re-exported).

## Open questions

- Should plugin Inspector sections render for live nodes too, as Unity's custom inspectors do in play? They would need a live variant of `InspectorSectionProps`.

## References

- `src/editor/componentField.ts`, `src/editor/ui/fieldDrag.ts`, `src/editor/sdk/scene.ts`, `src/editor/fieldEdits.ts`, `src/editor/fieldTarget.ts`, `src/editor/runtimeInspect.ts`, `src/editor/playSession.ts`
- Tests: `src/editor/componentField.test.ts`, `nodeEdits.test.ts`, `componentEdits.test.ts`, `playSession.test.ts`, `plugins/plugins.test.ts`
