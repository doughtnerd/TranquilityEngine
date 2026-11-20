# 0243. One field row edits a component field, in the edited document or in a live World, through a field target

- **Status:** Proposed; amended by 0257 (both adapters write through the component field write; the document adapter refuses in play through the edit gate; during play the Hierarchy and Inspector show the live World by default)
- **Date:** 2026-11-09 (rebuilt on current master 2026-11-19)
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0032, 0042, 0124, 0131, 0152, 0165, 0231 (amends 0022/0124's live Inspector: every field type is editable live)

## Context

> **Rebuilt on current master.** This record was written on an unmerged branch (as its ADR 0158) and rebuilt on the
> 2026-11-19 editor. Master had meanwhile done three of the branch's five parts another way: the prefab buttons are
> `nodeEdits.ts` `prefabActions` and the Inspector's `PrefabActionsBar`; setting Worlds for several components is
> `inspectorEdits.setComponentWorlds`; and one undo step around a body is `undoStep(stack, label, fn)` with
> `beginUndoStep` and `cancelGroup` for open steps (ADR 0231). Those parts are dropped here. Rotations became codec
> components (ADR 0165: `fields/RotationField.tsx`, `fields/NumberInput.tsx`), so the rows below are built on them.
> What remains is the single field switch, which this record now covers alone.

- **Two switches over the same field kinds.** `ui/Inspector.tsx` (1156 lines) rendered a field with `FieldEditorView`,
  a switch over ADR 0042's `FieldEditor` kinds, plus its own inputs (`TextInput`, `VectorInput`, `ColorInput`,
  `NodeRefInput`, `ObjectInput`, `ChoiceInput`, `ListInput`, `ScrubLabel`). `ui/RuntimeInspector.tsx` had a second
  switch (`LiveField`) with its own `LiveNumber`, `LiveText`, `LiveNodeRef` and a copy of `humanize`. The live one had
  drifted: `quaternion`, `choice`, `list` and `object` fields fell through to read-only JSON (a rotation or a body type
  couldn't be changed on a live node), labels didn't scrub, asset fields had no suggestions, plugin field choices
  (0152) weren't offered, and an unset vector showed Auto with no Set.
- **Widgets mixed with node logic.** About 450 lines of `Inspector.tsx` were generic widgets, between the node
  header's override logic, prefab buttons, component reordering and the Worlds menu.

## Decision

**A field target.** New `src/editor/fieldTarget.ts` (no UI) defines what a field row edits: one component field on
one or more nodes.

```ts
interface FieldTarget {
  readonly info: ComponentInfo;                                       // the active node's component
  state(field: FieldValue): FieldState;                               // each node's value, mixed, overridden
  set(field: FieldValue, value: unknown): string | null;              // editor form → stored; why not, or null
  setEach(field: FieldValue, values: readonly unknown[]): string | null; // each node its own value (a rotation's axis edit)
  setAxis(field: FieldValue, axis: number, n: number): string | null; // one axis, each node's others kept
  revert(field: FieldValue): void;                                    // prefab overrides only
  drag(field: FieldValue, label: string): FieldDrag;                  // a scrub drag: { open, end(), cancel() }
  readonly nodes: NodeRefs;                                           // choices(): { key, label, depth }[], keyOf(value), missing
}
```

Values arrive in the editors' form (numbers, strings, `Color`, axis arrays, `Quaternion`s, a node choice's key, plain
objects, list items) and each adapter converts them with `toSceneJSON`:

- **`documentFieldTarget(scene, paths, infos)`** writes through `fieldEdits` (`setField`, `setFieldEach`,
  `setFieldAxis`, `revertField`): overrides on prefab instances, one undo step across the selected nodes, mixed values
  from `fieldState`. A drag is a `beginUndoStep` (ADR 0231): one undo step, and Escape cancels it, putting the
  document back. Node choices are the document's nodes, keyed by id.
- **`liveFieldTarget(node, info, afterEdit)`** writes the running World through `writeField`, as the loader would. Node
  choices are the World's nodes keyed by entity; a single reference goes through `setLiveNodeRef` (same-World check,
  ADR 0032), list items resolve their keys in the same World. Values are never mixed or overridden; a drag is just its
  writes, and cancelling it writes the value it started from. A refused write (a destroyed node, a node of another
  World) is returned, and the row says why in the status bar.

Rotation axes follow ADR 0165 in both: `setAxis` edits the axis the field's view shows (Euler radians or degrees, or
x, y, z, w), and `RotationField`'s commit (each node's new quaternion) goes through `setEach`.

**One field-row module.** New `src/editor/ui/fieldRows.tsx` renders a component's fields for any target: `FieldRows`,
`FieldRow` (label that scrubs numbers, revert ↺, contributed choices from 0152), the value switch (rotations through
`RotationField`, numbers through `NumberInput`), and every input. Both inspectors render it; `TextInput` and
`AssetLists` are exported for the node header and the live view, which now gets asset suggestions. `ui/draftText.ts`'s
`useDraftText` keeps a box's draft while it is being typed in, so the live view's 250 ms refresh doesn't overwrite
typing; when the box is left it shows the latest value again.

**Live reach.** Live editing now covers every 0042 kind: numbers, booleans, strings, asset paths (with suggestions),
colors, vectors (Set on an unset one), quaternions (in the row's rotation view, with its toggle), node references,
plain objects, choices (static, project-setting and plugin-supplied) and lists. What stays read-only live, and why:
fields the editor can't classify (`unknown`) show JSON, as in the document (now in the `.field-json` style in both);
prefab override marks and revert don't apply to a live World. A reference can't point into another World (0032).

## Alternatives considered

- **Keep two switches, port the missing cases to the live one.** Fixes today's drift and leaves the next field kind to
  drift again.
- **Make the live view write through the document** (a temporary document of the live node). The live World has no
  file; node references and runtime-made nodes have no document ids.
- **A field-editor contribution per kind.** No plugin needs to supply widgets yet (0152 chose a choices point for the
  same reason; 0165 leaves `registerFieldCodec` for later).

## Consequences

**Positive**
- Live editing reaches rotations, choices, lists and objects; live labels scrub, asset fields suggest, plugin choices
  appear.
- One switch and one `humanize`; `Inspector.tsx` goes from 1156 to about 670 lines, `RuntimeInspector.tsx` from 384 to
  about 190.
- Headless tests for both adapters (`fieldTarget.test.ts`); `playdebug.spec.ts` changes a choice field live.

**Negative / costs**
- Live writes go through the scene-file form (`toSceneJSON` then `writeField`), a conversion per edit; edits are rare,
  so it doesn't matter.
- A box being typed in no longer follows a value that changes underneath (in the document, an undo from the menu while
  typing); the draft wins until the box is left or Escape. This applies to every `useDraftText` box, plugins' included.
- A value the editor can't classify now shows in a monospace JSON style in the scene Inspector too.

## Deprecates

`FieldEditorView`, the inputs, `ScrubLabel` and `humanize` in `Inspector.tsx` (moved); `LiveField`, `LiveNumber`,
`LiveText`, `LiveNodeRef`, `safeJSON` and `humanize` in `RuntimeInspector.tsx`, and `writeLive` in `runtimeInspect.ts`
(the live adapter writes). All removed.

## Open questions

- None.

## References

- `src/editor/fieldTarget.ts`, `src/editor/ui/fieldRows.tsx`, `src/editor/ui/draftText.ts`, `src/editor/ui/Inspector.tsx`,
  `src/editor/ui/RuntimeInspector.tsx`
- Tests: `src/editor/fieldTarget.test.ts`, `tests/e2e/playdebug.spec.ts`
