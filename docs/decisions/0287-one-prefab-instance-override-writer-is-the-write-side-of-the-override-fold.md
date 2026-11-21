# 0287. One prefab-instance override writer is the write side of the override fold

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0022, 0026, 0028, 0029, 0033, 0042, 0086, 0122, 0257, 0280

## Context

ADR 0280 put reading overrides in one fold (`scene/overrideFold.ts`). Writing them was still done by hand for each Inspector edit, about ten times in five editor files, each with its own matcher and its own "is it overridden?" reader:

- Worlds (`inspectorEdits.ts`: `isWorldsOverride`, `componentWorlds`, `setComponentWorlds`), tags (`tagsOverridden`, `setNodeTags`'s filter), enabled, add, remove and order (`componentEdits.ts`: `overridesWithout`, an inline enabled matcher, `prefabOrder`), name and active (`prefabs.ts`: `innerBaseValue`, `isInnerPropertyOverridden`, `nodePropertyCommand`, `revertInnerProperty`; `document/prefabCommands.ts`: `isInnerPropertyOverride`, `SetInnerNodeProperty`), fields (`prefabs.ts`: `isOverridden`; `SceneDocument.ts`: `isFieldOverride`), removing an inner node (`prefabs.ts`: `removeInnerNode`) and inserting into an instance (`nodeInsertion.ts`).
- Each copy split the path, chose entry or override, cloned the list, found the override, spliced and issued `SetOverrides`.
- The matchers disagreed with the fold. Name, active and tags overrides were recognised only when they held nothing else (`{ target, name }`), while the fold applies a name from any override, so a hand-written `{ target, name, active }` showed no revert button and a rename added a second override. The fold reads `index` only when it is a number; the editor used `o.index ?? 0`. `WorldSync` skipped name overrides that also named a component.
- Two bugs came from the copies. Disabling a component the instance had added rebuilt its entry from `type` and `data` and lost its `worlds`. Removing a prefab component appended the `removeComponent` override after the overrides it renumbered, but the fold counts `index` as the entries stand when each override applies, so a later component's renumbered override landed on the removed one and its value was lost.

## Decision

We will write prefab-instance overrides in one editor module, `src/editor/overrideWriter.ts`, and share override matching with the fold.

- **Shared matching (engine).** `overrideFold.ts` exports `OverrideProperty` (a node's `name`, `active`, `tags`, `order`; a component's `enabled`, `worlds` or `field` by type and index), `setsProperty(o, p)`, `overrideComponent(o)` and `sameTarget`. The fold applies overrides by `setsProperty`, and the writer, `SetField`, `SceneDocument.overrideValue` and `WorldSync` find overrides by it. `sameTarget` moves here from `SceneDocument.ts` (which re-exports it).
- **The writer's interface.** `writeProperty(doc, path, p, value, label?)` returns the command that sets property `p` of the node or component at `path`, or with `value` undefined reverts it; null when nothing would change or `p` can't be written there. `isOverridden(doc, path, p)`, `inheritedValue(doc, path, p)` (what applies without this instance's override: the resolved view with it taken out), `writtenValue(doc, path, p)` and `originOf(doc, path, component)` answer the reads. Structural writes: `writeAddComponent`, `writeRemoveComponent`, `writeAddNodes`, `writeRemoveNode`.
- **Rules the writer owns.** Where a value goes: a document node's entry (a plain node, and an instance root's own name, active flag and tags), an added component's `addComponent` entry (its switch and Worlds), or an override of the instance; a field on a plain node or a new field override is `SetField` (ADR 0257). Setting merges into the last override that sets `p` at that target (the one the fold applies last) and takes `p` out of earlier ones; reverting takes `p` out; an override left setting nothing is dropped. Inside an instance a value equal to the inherited one is written as a revert (fields keep their override, as before). On an instance's root its own `tags` count as overridden, its name and active flag never do. Removing a prefab component puts the `removeComponent` override before the first override it renumbers.
- **One command.** Every override write is `SetOverrides(instance, label, next, changes?)`; `changes` lets a name or active override report just that node (as `SetInnerNodeProperty` did) instead of rebuilding the instance.
- **The per-kind edit modules** (`nodeEdits.ts`, `componentEdits.ts`, `inspectorEdits.ts`, `fieldEdits.ts`, `nodeInsertion.ts`, `deleteSelection.ts`) keep the edit gate, labels and multi-select and call the writer once per node.
- **Behaviour changes.** Combined overrides are read and edited property by property; tags equal to the prefab's leave no override; reverting a field that has no override records nothing (it used to rebuild the instance). The two bugs above are fixed.

## Alternatives considered

- **Put the writer in the engine beside the fold** — the fold has no notion of the editor's document, commands or undo; only matching is shared, which is what both sides need.
- **One command per property kind** (keep `SetInnerNodeProperty`, add `SetWorldsOverride`, …) — the per-kind matchers would move into commands instead of going away.
- **Route field-value writes through the writer** — `SetField` already is the component field write (ADR 0257) with in-place undo for drags; the writer returns it for a new field value and uses the shared matcher.

## Consequences

**Positive**
- A new override kind is a case of `OverrideProperty`: the fold applies it and the writer writes it by the same rule.
- Each Inspector edit is about one line per node; following Worlds means reading one file.
- One test table (`overrideWriter.test.ts`): path shapes (plain, instance root, inner, nested instance root, nested inner) × edit kinds, each written then folded.

**Negative / costs**
- Reading "is it overridden?" or "what does it inherit?" resolves the instance each time (as the readers it replaces did).
- Hand-written overrides that combine properties are rewritten when one of their properties is edited.

## Deprecates

`isWorldsOverride`, `tagsOverridden` (`inspectorEdits.ts`; the Inspector asks `isOverridden(doc, path, TAGS)`); `overridesWithout`, `prefabOrder`, `resolvedNode` and `originOf` in `componentEdits.ts` (`originOf` moved to the writer); `innerBaseValue`, `isInnerPropertyOverridden`, `nodePropertyCommand`, `revertInnerProperty`, `isOverridden`, `removeInnerNode` in `prefabs.ts`; `isInnerPropertyOverride`, `SetInnerNodeProperty` in `document/prefabCommands.ts`; `isFieldOverride` in `SceneDocument.ts`. Removed.

## Open questions

- Apply's `deferred` step still appends overrides onto a nested instance entry of the prefab verbatim; it is an adapter of the fold, not an Inspector edit.

## References

- `src/editor/overrideWriter.ts`, `src/engine/scene/overrideFold.ts`, `src/editor/document/prefabCommands.ts`
- Tests: `src/editor/overrideWriter.test.ts`; `prefabInstanceEdits.test.ts`, `prefabs.test.ts`, `inspectorFields.test.ts`, `componentEdits.test.ts`, `prefabApplyFold.test.ts`, `src/engine/tests/overrideFold.test.ts`
