# 0042. List fields, field choices, and per-instance Worlds and tags overrides

- **Status:** Proposed
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0019, 0022, 0026, 0028, 0033

## Context

`@field(type, options)` (ADR 0013, 0033) declared one value of a fixed set of types: numbers, booleans, strings, asset paths, plain objects, and engine classes (`Vector2`, `Vector3`, `Color`, `GameObject`). Scripts had no way to declare a list (waypoints, spawn weights, targets), and fields with a fixed set of values (`RigidBody2D.bodyType`, `SpriteRenderer.sortingLayer`, `Text.align`) were plain strings that the Inspector showed as text boxes, inviting typos. A `Quaternion` field had no scene-file form.

ADR 0033 §3 lets a scene file's component entry carry `worlds`, but prefab instances had no way to change it, and the Inspector couldn't set it. Node `tags` were in the scene format for plain nodes and instance roots, but a node inside an instance couldn't take different tags, and the Inspector didn't show them.

## Decision

**List fields.** A field type in brackets declares a list of that type: `@field([Number])`, `@field([Vector2])`, `@field([GameObject])`, `@field([AssetRef])`. The value is a plain array; a scene file stores a JSON array whose items take the item type's usual form (`[[1, 2], [3, 4]]`, `[{ "$node": "a" }, null]`). Lists don't nest (`@field([[Number]])` throws), and a list field is always replaced whole: loading builds a new array, and a prefab override's `value` replaces the prefab's list rather than merging with it. `ListFieldType` and `FieldType` are exported from `"myco"`.

**Choices.** `FieldOptions.choices` lists the values a field (or each item of a list field) may take, and the editor shows a dropdown:

- a list of values: `@field(String, { choices: ["dynamic", "kinematic", "static"] })`;
- an object of labels to values, so a TypeScript enum works as is: `@field(Number, { choices: Mood })` (a numeric enum's reverse entries are skipped), or `{ Small: 1, Big: 10 }`;
- a function of the project settings, for lists that live there: `@field(String, { choices: (s) => s.render.sortingLayers })`.

Choices guide the editor only; nothing validates them at load or at runtime, so a renamed layer still loads (the Inspector shows it as "not a choice"). `FieldChoices` and `FieldChoice` are exported. Built-ins use them: `RigidBody2D.bodyType` and `collisionDetection`, `Collider2D.layer` (project physics layers), `SpriteRenderer.sortingLayer` (project sorting layers), `Camera.projection`, `Text.anchor` and `align`, `Replicated.mode`.

**Quaternion fields.** `@field(Quaternion)` stores Euler degrees `[x, y, z]` (ADR 0019), as Transform rotation does; a 4-number array is read as a raw quaternion.

**Overrides.** Two override kinds join the scene format (no format version change; older engines ignore them):

- `{ component, index?, worlds: [...] }` (no `field`): the Worlds that instance's component is created in, replacing the prefab entry's `worlds` (or the class's option). `["*"]` is every World. Because it decides whether a component is created at all, the loader reads these before instantiating the prefab's nodes; outer instances' overrides win over nested ones'. Apply writes it into the prefab's entry.
- `{ target, tags: [...] }`: a node's tags inside an instance, replacing the prefab's. An instance root keeps using the node entry's own `tags`. Like name and active, Apply leaves tags on the instance.

## Alternatives considered

- **`@field(List(Number))` or `@field(Array, { of: Number })`.** A helper reads no better than brackets and adds an export; brackets match how TypeScript writes the value's type (`number[]`).
- **`options` as the key for choices** (`@field(String, { options: [...] })`). It reads as `options.options` in `FieldOptions`; `choices` says what it is.
- **An `Enum({...})` field type.** It would replace the value's type (`Number`, `String`) with a marker, losing what replication and the codec read from the type; choices are a hint on top of the type.
- **Named setting sources (`choices: "sortingLayers"`).** A function needs no registry of names and works for any project setting, including ones added later.
- **A node-level physics layer.** Layers belong to colliders in the engine today (`Collider2D.layer`); a node layer would be a new runtime concept. The collider field became a dropdown instead.

## Consequences

**Positive**
- Scripts can declare lists and enum-like fields, edited in the Inspector without typing values by hand.
- Per-instance Worlds and tags make one prefab usable in client-only, server-only and shared roles.

**Negative / costs**
- A list override replaces the whole list, so a later change to the prefab's list doesn't reach an instance that overrode it.
- `worlds` overrides on components of a node whose prefab also has `removeComponent` overrides count component indexes in the prefab file's order, not after removals.
- Choices from settings depend on the editor reading `project.json`; outside the editor they resolve to nothing.

## Deprecates

Nothing.

## Open questions

- Vector4, ranges (`min`/`max` sliders) and nested lists aren't supported.
- Replication doesn't send list fields (only Number and Boolean fields replicate, ADR 0033).

## References

- `src/engine/core/registry.ts` (`ListFieldType`, `FieldChoices`, `resolveChoices`), `src/engine/scene/SceneLoader.ts` (`assignField`, `worlds` and `tags` overrides).
- Editor: `src/editor/fieldValues.ts`, `src/editor/inspectorEdits.ts`, `src/editor/ui/Inspector.tsx`.
- Tests: `src/engine/tests/fieldTypes.test.ts`, `src/editor/inspectorFields.test.ts`, `tests/e2e/inspector-fields.spec.ts`.
