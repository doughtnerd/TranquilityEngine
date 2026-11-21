# 0290. One particle property value field, on the SDK's drag rule

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0060, 0219, 0243, 0257, 0282

## Context

A particle effect's graph properties (ADR 0060) are edited in two places: the Particle Graph's Blackboard
(`particleGraph/Blackboard.tsx`, `PropertyValue`) and, as per-instance overrides, the Inspector's ParticleSystem
section (`ParticleInspector.tsx`, `PropertyInput`). Each wrote its own "property value field by type", and they
disagreed: a curve that didn't read as one showed `[[0,1],[1,1]]` in the Inspector but `[[0,0],[1,1]]` (`asKeys`) on the
Blackboard; vectors were two `NumField`s or a `VecField` in the Inspector but `VectorValue` on the Blackboard; a number
property set to random on the Blackboard showed as 0 in the Inspector. Materials already share one such field between
their Blackboard and Inspector (`materials/editor/ShaderPropertyValue.tsx`).

The Inspector also hand-rolled its undo grouping: `colorDrag` opened `editor.scene.beginEdit` on a colour drag report,
and `groupGesture` opened one on pointer down in a curve or gradient editor and closed it from `window` `pointerup` /
`pointercancel` listeners. It was the only `beginEdit` caller outside the SDK, where ADR 0282's fields report
`(value, drag)` and Inspector controls reach undo through `useFieldDrag` and `writeField` (ADR 0243, 0257).

## Decision

We will have one particle property value field, `ParticlePropertyValue` (`particles/editor/ui/ParticlePropertyValue.tsx`).

- **One field by type.** Number (constant or random, `NumberValue`), vector 2/3 (`VectorValue`), colour (`ColorSwatch`),
  curve and gradient (preview opening the editor in a popover, `CurveValue`, `GradientValue`), texture (the SDK's
  `AssetPicker`), all from `particleGraph/valueFields.tsx`. A value that doesn't read as its type shows the type's
  default, `defaultPropertyValue(type)` (`graphEdit.ts`): the value a new property gets. The caller names the field
  (`label`): the Blackboard `"<name> value"`, the Inspector `"<name>"`.
- **It reports `(value, drag)` on ADR 0282's rule.** The colour passes on `ColorField`'s drag; a curve or gradient edit
  made while the pointer is down in the field reports `drag`, and the release (or cancel) reports the last value again
  with `drag` false; typed numbers, vectors and textures report `drag` false.
- **The Blackboard** commits each report as a graph edit (the graph editor already coalesces a gesture; an asset
  document skips an edit that leaves its text unchanged).
- **The Inspector** writes each report with `editor.scene.writeField` through `useFieldDrag`'s new `follow(drag, write)`:
  a report with `drag` opens the field drag if none is open, one without closes it after writing. `colorDrag`,
  `groupGesture` and the `beginEdit` call are gone.
- **SDK addition (minimal).** `FieldDragHandlers.follow(drag, write)` in `src/editor/ui/fieldDrag.ts`, for a field that
  reports its own drag (a colour picker's drag has no pointer gesture on the element).
- The value-field CSS moves from `particleGraph.css` to `particleGraph/valueFields.css`, imported by the fields, so the
  Inspector has it without loading the graph panel. `VecField` (unused now) is deleted.
- A story beside the field (ADR 0219) shows each type and the report rule; the Inspector story checks a colour pick is
  one undo step.

## Alternatives considered

- **Use `ShaderPropertyValue` for particles too** — the types differ (particle curves, gradients and random numbers), and
  the shader field doesn't load the particle editors.
- **Keep the Inspector's gesture code, share only the rendering** — leaves the only out-of-SDK `beginEdit` and its window
  listeners, and two undo rules for one control.
- **`useFieldDrag` pointer handlers on the row only** — covers curve and gradient drags, but not a colour pick, which
  happens in the browser's picker with no pointer gesture on the element.

## Consequences

**Positive**
- One field, one set of defaults and controls; the Inspector shows random numbers and the compact curve/gradient
  previews the Blackboard shows.
- The Inspector reaches undo through the SDK only; a field drag also gets the edit gate and prefab overrides.

**Negative / costs**
- The Inspector's curve and gradient editors open in a popover instead of inline.
- `FieldDragHandlers` grows a non-pointer member (`follow`); spreading the handlers on an element is still fine (Preact
  sets no attribute for a function).

## Deprecates

`PropertyValue` in `Blackboard.tsx`, `PropertyInput`, `colorDrag` and `groupGesture` in `ParticleInspector.tsx`, and
`VecField` in `particles/valueInputs.tsx`: removed.

## Open questions

None.

## References

`src/plugins/particles/editor/ui/ParticlePropertyValue.tsx`, `ParticlePropertyValue.stories.tsx`,
`ParticleInspector.tsx`, `ParticleInspector.stories.tsx`, `particleGraph/Blackboard.tsx`, `particleGraph/valueFields.tsx`;
`src/editor/ui/fieldDrag.ts`; `src/plugins/materials/editor/ShaderPropertyValue.tsx`.
