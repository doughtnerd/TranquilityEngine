# 0273. Each Inspector field kind is one entry of a field-kinds table that owns its scene form, sameness, blank value, unset rule and axis edits

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** 0165 in part (its "others move to codecs one at a time" pattern and the `FieldEditorView` fallback)
- **Related:** 0013, 0042, 0124, 0163, 0165, 0243, 0257

## Context

ADR 0165 introduced field codecs "rotations first"; no other kind followed. One kind's rules were spread over four
switches and two helpers:

- `fieldValues.ts`: `editorFor` (field → editor name), `defaultItem` (an empty list's Add), `toSceneJSON` (a switch,
  with an `itemEditor` option for lists and a `nodeId` option for references).
- `fieldEdits.ts`: `axesBase` (an unset vector's default) and `valueKey` (sameness for "mixed"; rotations rebuilt from
  `rotationCodec("radians").read` instead of the codec's `same`).
- `ui/fieldRows.tsx`: the `FieldEditorView` widget switch, with the unset vector's default written again.
- `runtimeInspect.ts`: the unset-vector skip, and two `toSceneJSON` calls without `itemEditor`.

Every caller assembled the same two steps, `editorFor` then `toSceneJSON(…, { itemEditor: editor === "list" ? … })`.
"Keep values" (ADR 0124) forgot the option twice: kept lists of nodes, colours or assets stored live `GameObject` and
`Color` objects in the scene document, and the comparison on Stop always reported a change.

## Decision

We will have one field-kinds table, `src/editor/fields/kinds.ts`, and callers ask it instead of switching on names.

- **The kinds:** `number`, `integer`, `boolean`, `string`, `asset`, `color`, `vector2`, `vector3`, `quaternion`,
  `node`, `object`, `choice`, `list`, `unknown` (`FieldKindName`). `FIELD_KINDS` holds every kind but `list`.
- **`fieldKind(field: FieldValue): FieldKind`** picks the kind from the declared type (choices first, then the type, a
  data component's scalar type, then the live value's shape). A list field's kind is built with its item kind
  (`kind.item`), so the item kind can't be left out.
- **A kind owns** (`FieldKind`):
  - `toJSON(value, nodeIds)`: the scene-file form (ADR 0013). `nodeIds: NodeIds` resolves node references and is a
    required argument (document ids, a live World's entity keys, or `noNodeRefs` for values that can't hold one, as
    a Transform pose). A list converts each item through its item kind.
  - `same(a, b, nodeIds)`: whether two values show as the same, for a multi-selection's "mixed". Scene-form equality,
    except rotations, which use the rotation codec's `same` (q and -q, float noise).
  - `blank(choices)`: what an empty list's Add starts from.
  - `isUnset(value)` and `explicit()`: the unset rule. Only vectors may be unset ("Auto", a sprite's size from its
    texture); `explicit` is what Set writes (2D: 1, 1; 3D: the origin), written once.
  - `axes` (vectors and rotations): `read(value, view)` and `write(value, axis, n, view)`, a rotation's through its
    codec (ADR 0165) in the row's view.
  - `savable`: false for `unknown`, which stored values and Keep values leave out.
- **Widgets register per kind** in `ui/fieldRows.tsx` (`WIDGETS: Record<FieldKindName, …>`), so a kind without a
  widget doesn't compile and `fields/kinds.ts` stays free of Preact.
- **Callers:** the document field target (`fieldEdits.ts`: `setFieldEach`, `setFieldAxis`, `fieldState`, which now
  takes the `FieldValue`), the live field target (`fieldTarget.ts`), the component field write's stored value
  (`componentField.ts`), Keep values (`runtimeInspect.ts`), the transform gizmo (`gizmo.ts`) and Hierarchy moves
  (`hierarchyEdit.ts`).
- **Keep values** converts every field through its kind: lists of nodes, colours and assets keep `{ $node }`, hex and
  `asset:` paths, and an unchanged value writes nothing on Stop. A value referring to a node outside the document
  (in a list too) is left out rather than cleared.
- **The codec stays** for rotations (`FieldCodec`, `rotationCodec`); the quaternion kind is built on it. ADR 0165's
  plan to move each kind to a codec "when touched", behind a `FieldEditorView` fallback, is replaced by this table:
  a kind that later needs a shown form different from its stored one (an angle in degrees, a normalized vector) adds
  a codec inside its entry.

## Alternatives considered

- **A `FieldCodec` per kind, as 0165 planned.** `read`/`write` are identity for most kinds; the rules that actually
  differ (scene form with node ids, list items, unset, blank) don't fit the codec's four methods.
- **Keep `toSceneJSON` and make `itemEditor` required.** Fixes the bug but leaves sameness, defaults, unset and
  widgets in separate switches.
- **Widgets in the table.** Would pull Preact into an engine-facing module that `runtimeInspect.ts` and
  `componentField.ts` import.

## Consequences

**Positive**
- A new kind touches one table entry and one widget; the type checker finds a missing widget.
- Keep values writes scene-file JSON for lists and reports no change when there is none.
- Every kind's rules are tested through one interface (`fields/kinds.test.ts`).

**Negative / costs**
- Callers with no node references pass `noNodeRefs` explicitly.
- Keep values now leaves out a list that names a node outside the document, where it used to store live objects.

## Deprecates

`editorFor`, `itemEditorFor`, `defaultItem`, `toSceneJSON`, the `FieldEditor` type and the `quaternionJSON` re-export
(`fieldValues.ts`); `axesBase`, `withAxis` and `valueKey` (`fieldEdits.ts`); the `FieldEditorView` switch and
`axesOf` (`ui/fieldRows.tsx`). All removed.

## Open questions

- `registerFieldCodec` / a plugin-registered kind (0165's open item) is still not offered.

## References

- `src/editor/fields/kinds.ts`, `fields/kinds.test.ts`, `ui/fieldRows.tsx`, `fieldEdits.ts`, `fieldTarget.ts`,
  `componentField.ts`, `runtimeInspect.ts` (`runtimeInspect.test.ts`: Keep values on lists).
