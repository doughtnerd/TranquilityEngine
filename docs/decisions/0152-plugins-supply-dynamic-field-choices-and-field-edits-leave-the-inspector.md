# 0152. Plugins supply a field's dynamic choices through a field-choices contribution point, and field edits move out of the Inspector

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0026, 0042, 0118, 0131, 0133, 0140, 0146, 0147

## Context

- **The Inspector named a plugin's Component.** ADR 0118 shows `MeshRenderer.variant` as a dropdown of the referenced model's material variants. `src/editor/ui/Inspector.tsx` did that itself: it checked `info.type === "engine.MeshRenderer" && field.name === "variant"`, imported `loadModel` and listed `ModelData.variants`. The Meshes plugin (`src/plugins/meshes/`, ADR 0140) owns MeshRenderer and models, and ADR 0146 says the shell reaches plugins only through contribution points. A field's static `choices` option (ADR 0042) can't express this: the choices depend on another field (`mesh`) and on a file that loads asynchronously.
- **Field edits lived in a view.** `FieldRow` (about 100 lines of `Inspector.tsx`, 1345 lines in all) held the rules for writing a field: the previous value is the instance's override on a prefab instance and the node's own field otherwise, an axis edit keeps each node's other axes, quaternions are edited as rounded Euler degrees, several nodes are one undo step, mixed values are told apart by a comparable key, revert removes matching overrides in one group. None of it could be tested without rendering. Components and tags already have edit modules (`componentEdits.ts`, `inspectorEdits.ts`).

## Decision

**A field-choices contribution point.** `myco/editor` gains `FieldChoicesContribution` and `EditorPluginContext.registerFieldChoices` (registry `fieldChoices`, removed with the plugin like every contribution):

```ts
interface FieldChoicesContribution {
  id: string;
  type: string;            // "engine.MeshRenderer"
  field: string;           // "variant"
  none?: FieldChoice;      // the choice that clears the field, listed first ({ label: "Default", value: "" })
  key(info: ComponentInfo): string;   // what the choices depend on (the mesh reference); asked again when it changes
  choices(info: ComponentInfo): readonly FieldChoice[] | Promise<readonly FieldChoice[]>;  // a rejection counts as none
}
```

- The Inspector shows a contributed field as a dropdown of `none` then the choices. With no choices (still loading, or none to offer) it hides the row while the field is unset on every selected node, and otherwise lists `none` alone so a stale value can be cleared. This is exactly 0118's behaviour.
- `src/editor/fieldChoices.ts` answers which contribution applies (`fieldChoicesFor`), loads its choices (`loadFieldChoices`) and computes the list or "hidden" (`listedChoices`). `Inspector.tsx` only renders it.
- The Meshes plugin's editor half registers `mesh-renderer-variant`, which loads the model and returns its variant names (none for `builtin:` meshes or an empty reference). The shell no longer imports `loadModel` or names MeshRenderer.

**A field-edits module.** `src/editor/fieldEdits.ts`, beside `componentEdits.ts` and `inspectorEdits.ts`, owns field-value edits; Inspector rows only call it:

- `setField` / `setFieldEach` (a value per node) / `setFieldAxis` (one axis, others kept) write through `SetField`, as overrides on prefab instances and nodes inside them; several nodes are one undo step (`Set <field> on N nodes`).
- `revertField` removes the field's override from every instance that has one, as one step (`Revert <field>`); plain nodes are skipped.
- `fieldState` / `isMixed` / `isFieldOverridden` / `fieldValues` report what the Inspector shows; `eulerAnglesOf`, `axesBase`, `withAxis` and `valueKey` hold the quaternion and vector rules (angles rounded to 1e-4, `-0` dropped).

## Alternatives considered

- **Use an inspector section** (ADR 0131) for MeshRenderer. It renders under the fields, so the variant would move out of its row and the field would need hiding; every plugin with one dynamic dropdown would rebuild the field UI.
- **A function-valued `choices` option on the field** (`@field(String, { choices: (component) => … })`). It would put an editor concern (loading a model file) on the runtime Component declaration, and `FieldChoices` functions already mean "from project settings".
- **A general field-editor contribution** (a plugin renders the whole value cell). More than needed today; a dropdown covers the only case, and the shell keeps mixed-value, override and undo handling.

## Consequences

**Positive**
- The shell no longer names MeshRenderer or loads models for the Inspector; disabling Meshes removes the dropdown with the rest of the plugin.
- Field edits are tested headless (`editor/fieldEdits.test.ts`): axis edits on two prefab instances, one undo step, quaternion round trip, mixed values, revert.
- `Inspector.tsx` is about 50 lines shorter and its rows hold no document logic.

**Negative / costs**
- One more contribution point in the editor SDK (experimental until v1).
- Choices are keyed by the active node's component only: with several nodes on different models, the dropdown lists the active node's variants (as before).

## Deprecates

The MeshRenderer special case in `Inspector.tsx` (`useModelVariants`, `variantChoices`) and its private `commitEach`, `axesBase`, `roundAngles` and `valueKey`, now in `fieldEdits.ts`, `fieldChoices.ts` and the Meshes plugin.

## Open questions

- Whether list items (`[String]` fields) should take contributed choices too; nothing needs it yet.

## References

- `src/editor/fieldEdits.ts`, `src/editor/fieldChoices.ts`, `src/editor/sdk/contributions.ts`, `src/editor/sdk/plugins.ts`, `src/plugins/meshes/editor/index.ts`, `src/editor/ui/Inspector.tsx`
- Tests: `src/editor/fieldEdits.test.ts`
