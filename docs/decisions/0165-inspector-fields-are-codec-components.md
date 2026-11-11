# 0165. Inspector fields with invariants are components built from a codec; rotations first

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0026, 0042, 0152, 0163, 0164

## Context

The Inspector (`src/editor/ui/Inspector.tsx`, ~1300 lines) picks an editor per field type in one `switch`
(`FieldEditorView`) and converts values to scene-file JSON in another (`toSceneJSON`, `src/editor/fieldValues.ts`).
Rules that belong to one kind of value are spread across both and across `fieldEdits.ts`. For rotations (ADR 0163)
that is: the stored form (a quaternion `[x, y, z, w]`, w ≥ 0, 7 decimals), the shown form (Euler angles, ZXY, in
some unit), the per-axis edit (rebuild the quaternion from the edited triple), and the "Euler hint" (show the
angles last typed for a rotation). The owner wants a rotation field as a reusable Preact component that can be told
how it reads (stored → shown) and writes (shown → stored), radians by default, and wants the same shape for other
fields with invariants later.

One constraint shapes it: a quaternion's x, y, z, w are not angles. They are sines and cosines of half the turn
(each in -1..1, and the four together must have length 1), so neither degrees nor radians apply to them, and editing
one alone breaks the length-1 rule. Units apply to the Euler view.

## Decision

**A codec per kind of value.** `src/editor/fields/codec.ts`:

```ts
interface FieldCodec<Stored, Shown> {
  read(stored: Stored): Shown;                  // deserialize: data → what the field shows
  write(shown: Shown, previous: Stored): Stored; // serialize: what the user typed → data
  toJSON(stored: Stored): unknown;              // the scene-file form (replaces toSceneJSON's case)
  same(a: Stored, b: Stored): boolean;          // for "mixed" across a multi-selection
}
```

Invariants live in `write` and `toJSON` (normalize, clamp, round), so every editor of that value keeps them.

**`RotationField`** (`src/editor/fields/RotationField.tsx`), a Preact component:
`<RotationField values={quaternions} view="radians" | "degrees" | "quaternion" onCommit={(q) => …} label="rotation" />`.

- Stored form is fixed: a quaternion (ADR 0163). `view` chooses the codec:
  - `"radians"` (default) and `"degrees"`: three boxes, Euler ZXY (ADR 0164), read with the angles last typed
    for that rotation when there are any (the hint moves here from `fieldValues.ts`), written by rebuilding the
    quaternion from the edited triple.
  - `"quaternion"`: four boxes x, y, z, w, unitless; a commit normalizes (the other three change to keep length 1),
    so it's a debug view, as Unity's Debug Inspector.
- Read and write use the same unit: a field that shows radians but takes typed degrees would surprise. Typing an
  expression with a unit (`90deg`, `1.57rad`) is an open question.
- Multi-selection: an axis that differs shows a dash, as `VectorInput` does today.

**Choosing the view.** A field may set it with `@field(Quaternion, { view: "degrees" })` (a new `FieldOptions.view`,
editor-only like `description`); Transform's rotation uses the editor preference **Settings > Inspector > Rotation
angles** (radians by default). A small toggle on the row flips one row for the session.

**The pattern for later fields.** Others move to codecs one at a time, when touched: angles that are degrees in
data (FOV, spot angle; a codec with a unit), unit vectors (normalize on write), colors (sRGB vs linear view), ranges
(clamp), layer masks. `FieldEditorView` dispatches to a codec component when the field's type has one and falls
back to today's editors otherwise. Plugins get `registerFieldCodec(type, codec, component)` in the editor SDK once
two built-in codecs prove the interface (not in this record).

## Alternatives considered

- **x, y, z, w boxes in radians or degrees.** Not meaningful: the components aren't angles. Offered only as the
  unitless debug view.
- **Separate read and write units.** Possible with the interface, but a row showing one unit while taking another
  would confuse; one `view` per row.
- **Keep the switch, add a rotation case.** Smallest change, but the next invariant field repeats the scatter the
  owner wants to end.
- **Store Euler radians.** Rejected by ADR 0163 (quaternions are the data).

## Consequences

**Positive**
- A rotation's rules sit in one module; the Inspector, list items and plugin panels can reuse the component.
- Radians or degrees is a view choice, not a data change.

**Negative / costs**
- Two ways to edit fields until the others move over.
- The quaternion view lets a user type a non-unit quaternion; it's normalized on commit, which can look like the
  other boxes "jumped".

## Deprecates

The `"quaternion"` cases in `FieldEditorView`, `toSceneJSON` and `fieldEdits.withAxis`, once `RotationField` is in.

## Open questions

- Unit suffixes in number boxes (`90deg`)?
- Whether the Settings default should follow the project (team-wide) rather than the user.

## References

- `src/editor/ui/Inspector.tsx` (`FieldEditorView`, `VectorInput`), `src/editor/fieldValues.ts`, `src/editor/fieldEdits.ts`.
- Unity Inspector Normal/Debug modes (Euler degrees vs raw quaternion).
