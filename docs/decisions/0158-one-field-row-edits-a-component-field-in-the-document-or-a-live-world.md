# 0158. One field row edits a component field, in the edited document or in a live World, through a field target

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0033, 0042, 0124, 0131, 0152 (amends 0022/0124's live Inspector: every field type is editable live)

## Context

- **Two switches over the same field kinds.** `ui/Inspector.tsx` (1293 lines) rendered a field with `FieldEditorView`, a switch over ADR 0042's `FieldEditor` kinds, plus its own inputs (`NumberInput`, `TextInput`, `VectorInput`, `ColorInput`, `NodeRefInput`, `ObjectInput`, `ChoiceInput`, `ListInput`, `ScrubLabel`). `ui/RuntimeInspector.tsx` had a second switch (`LiveField`) with its own `LiveNumber`, `LiveText`, `LiveNodeRef` and a copy of `humanize`. The live one had drifted: `quaternion`, `choice`, `list` and `object` fields fell through to read-only JSON (a rotation or a body type couldn't be changed on a live node), labels didn't scrub, asset fields had no suggestions, plugin field choices (0152) weren't offered, and an unset vector showed Auto with no Set.
- **Widgets mixed with node logic.** About 500 lines of `Inspector.tsx` were generic widgets, between the node header's override logic, prefab buttons, component reordering and the Worlds menu.
- **Logic held in views.** `ComponentMenu` held the Worlds rule (a node's own setting is dropped when the new one equals what it inherits, and left alone when it already has it) with its own list comparison, untested; `inspectorEdits` tested only `componentWorlds` and `setComponentWorlds`. `Inspector.tsx` and `fieldEdits.ts` each had a private `inGroup` that wraps `beginGroup`/`endGroup`. The three prefab buttons repeated the read-only tooltip, `try`, info status and `errorStatus`.

## Decision

**A field target.** New `src/editor/fieldTarget.ts` (no UI) defines what a field row edits: one component field on one or more nodes.

```ts
interface FieldTarget {
  readonly info: ComponentInfo;                       // the active node's component
  state(field: FieldValue): FieldState;               // each node's value, mixed, overridden
  set(field: FieldValue, value: unknown): string | null;              // editor form → stored; why not, or null
  setAxis(field: FieldValue, axis: number, n: number): string | null; // one axis, each node's others kept
  revert(field: FieldValue): void;                    // prefab overrides only
  drag(label: string): () => void;                    // a scrub drag as one step; returns its end
  readonly nodes: NodeRefs;                           // choices(): { key, label, depth }[], keyOf(value), missing
}
```

Values arrive in the editors' form (numbers, strings, `Color`, axis arrays, a node choice's key, plain objects, list items) and each adapter converts them with `toSceneJSON`:

- **`documentFieldTarget(scene, paths, infos)`** writes through `fieldEdits` (`setField`, `setFieldAxis`, `revertField`): overrides on prefab instances, one undo step across the selected nodes, mixed values from `fieldState`, a drag as one undo group. Node choices are the document's nodes, keyed by id.
- **`liveFieldTarget(node, info, afterEdit)`** writes the running World through `writeField`, as the loader would. Node choices are the World's nodes keyed by entity; a single reference goes through `setLiveNodeRef` (same-World check, ADR 0032), list items resolve their keys in the same World. Values are never mixed or overridden; a drag is just its writes.

**One field-row module.** New `src/editor/ui/fieldRows.tsx` renders a field row for any target: `FieldRow` (label that scrubs numbers, revert ↺, contributed choices from 0152), the value switch, and every input. Both inspectors render it; `TextInput` and `AssetLists` are exported for the node header and the live view. Inputs show the current value until focused and keep their draft while focused, so the live view's 250 ms refresh doesn't overwrite typing; a field is written only when its text changed (blurring an unedited `0.333` no longer rewrites a `0.33333`).

**Live reach.** Live editing now covers every 0042 kind: numbers, booleans, strings, asset paths (with suggestions), colors, vectors (Set on an unset one), quaternions (as Euler degrees), node references, plain objects, choices (static, project-setting and plugin-supplied) and lists. What stays read-only live, and why: fields the editor can't classify (`unknown`) show JSON, as in the document; fields another editor owns (0131's hidden fields, such as a ParticleSystem's embedded effect) show their value as JSON, because that editor (an inspector section) isn't shown live and the scene Inspector hides them; prefab override marks and revert don't apply to a live World. A reference can't point into another World (0032).

**Worlds for several targets.** `inspectorEdits.setWorldsFor(scene, targets, next, label)` is the menu's operation: one undo step; a target whose inherited Worlds equal `next` loses its own setting, one that already has `next` (in any tag order, `sameWorlds`) is untouched, the others get `next`. It reads every target's setting before writing, since a write rebuilds an instance's live nodes. `worldsSettingOf(doc, target)` (with the `WorldsTarget` type) replaces the card's inline computation. `ComponentMenu` only renders.

**Groups and prefab buttons.** `CommandStack.group(label, body)` runs `body` between `beginGroup` and `endGroup`; the two `inGroup` copies go. The prefab buttons move to `ui/PrefabActions.tsx` and share `SavingButton`, whose `run(project)` returns the status message (read-only tooltip, `try`, info status and `errorStatus` in one place).

## Alternatives considered

- **Keep two switches, port the missing cases to the live one.** Fixes today's drift and leaves the next field kind to drift again.
- **Make the live view write through the document** (a temporary document of the live node). The live World has no file; node references and runtime-made nodes have no document ids.
- **A field-editor contribution per kind.** No plugin needs to supply widgets yet (0152 chose a choices point for the same reason).

## Consequences

**Positive**
- Live editing reaches rotations, choices, lists and objects; live labels scrub, asset fields suggest, plugin choices appear.
- One switch and one `humanize`; `Inspector.tsx` loses the widgets and prefab buttons.
- Headless tests for both adapters (`fieldTarget.test.ts`), the Worlds rule (`inspectorFields.test.ts`) and `CommandStack.group` (`document/history.test.ts`); `playdebug.spec.ts` changes a choice field live.
- `Inspector.tsx` goes from 1293 to about 600 lines, `RuntimeInspector.tsx` from 384 to about 190.

**Negative / costs**
- Live writes go through the scene-file form (`toSceneJSON` then `writeField`), a conversion per edit; edits are rare, so it doesn't matter.
- An input no longer follows a value that changes while it has focus (an undo from the menu while typing); the draft wins until blur or Escape.
- A value the editor can't classify now shows in a monospace JSON style in the scene Inspector too (`.field-json`).

## Deprecates

`FieldEditorView`, the inputs and `humanize` in `Inspector.tsx`; `LiveField`, `LiveNumber`, `LiveText`, `LiveNodeRef`, `safeJSON` and `humanize` in `RuntimeInspector.tsx`; `writeLive` in `runtimeInspect.ts` (the live adapter writes); both `inGroup` helpers. All removed.

## Open questions

- None.

## References

- `src/editor/fieldTarget.ts`, `src/editor/ui/fieldRows.tsx`, `src/editor/ui/PrefabActions.tsx`, `src/editor/inspectorEdits.ts`, `src/editor/document/CommandStack.ts`
- Tests: `src/editor/fieldTarget.test.ts`, `src/editor/inspectorFields.test.ts`, `src/editor/document/history.test.ts`, `tests/e2e/playdebug.spec.ts`
