# 0280. One prefab-override fold under loading, the resolved view and Apply

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0016, 0022, 0028, 0029, 0033, 0042, 0086, 0122, 0135, 0279

## Context

What a scene or prefab file plus its instances' overrides come to was written out more than three times, and the copies had drifted:

- `engine/scene/SceneLoader.ts` (`Instantiation`) made the GameObjects: targeting through nested instances, the prefab-root alias for `worlds` overrides, `removeNode` / `addNodes` scoping, the component index, `order`, `enabled`, `worlds`, tags and fields.
- `engine/scene/resolvedScene.ts`, the pure "what does this scene contain" view behind warm-up, physics and navigation detection, thumbnails and the Hierarchy filter, copied those rules "the way Instantiation applies them". It ignored tag overrides and reordered Transform and data components, which the World never does (it orders behaviours only).
- `editor/prefabs.ts` re-implemented the rules as document commands for Apply (and dropped inner nodes' tag overrides, which stayed on the instance), and walked overrides a fourth time for the inner nodes the Hierarchy shows.
- `editor/hierarchyFilter.ts` hand-walked files and overrides for the `t:Type` filter: a component an override removed still matched, and nodes an override added never did.
- `editor/componentEdits.ts` worked out where a component came from with an unwritten rule ("added components come after the prefab's"), wrong once an `order` override moves one, and walked prefab files again for the order an instance has without its `order` override.

Separately, `{"$node"}` references were found in different places by different modules: `SceneDocument.references` missed references in an instance's added components (so deleting their target left them dangling), while paste and asset cleanup rewrote references nested anywhere, including inside plain JSON values the loader treats as data.

## Decision

We will fold prefab overrides in one engine module, `src/engine/scene/overrideFold.ts`, and make the loader, the resolved view and Apply its adapters.

- **Interface.** `foldNodes(adapter, nodes, parent, path)` walks a node list, expands prefab and scene instances, applies every override and tells the adapter each step through `FoldAdapter<N, C>`: `node`, `sceneNode`, `component` (returns the adapter's handle, or none when it left the entry out), `name`, `tags`, `active`, `removeNode`, `removeComponent`, `order`, `enabled`, `worlds`, `field`, `placed`, `problem` / `invalid`, and for Apply `expand` / `folded` / `deferred` (keep an instance entry folded and receive the overrides aimed into it).
- **Rules the fold owns.** A step of a target into a nested instance is that instance's override, applied after its own; an empty target, or one ending at a nested instance, is its root; a prefab root created at `[instance, rootId]` is addressed as `[instance]` (root alias), including for `worlds` overrides read before components exist; removed nodes leave their instance's id map and added nodes join it, with new ids only; `index` counts a node's entries of the type as they stand when the override applies, including entries an adapter left out (another World's component, a missing script), so an index means the same in every World; `removeComponent` takes the first of its type, `addComponent` appends; `order` arranges behaviours only, Transform and data components keep their slots; within one override, `addNodes`, name, tags, active, `removeComponent`, `addComponent`, `order`, `enabled`/`worlds`, field.
- **Adapters.** The resolved view builds plain entries, and now carries each node's editor `path` (a prefab's root is the instance), its `tags`, an `added` flag for added nodes, and on each component the override that added it (`added: { instance, override }`). `Instantiation` builds GameObjects and resolves `{"$node"}` references once every node exists. Apply (`ApplyToPrefab` in `editor/prefabs.ts`) turns each step into a command on the prefab document; the prefab's nested instances stay folded and overrides aimed into them become theirs.
- **Editor readers move onto the resolved view.** `SceneDocument.resolve(instance?, overrides?)` resolves the open document (through `resolveScene`'s `read` option). The Hierarchy's inner nodes, its type filter, component origins (`originOf`, which removal, enabling and Worlds use), an instance's natural order and a component's inherited Worlds all read it.
- **Node references.** `src/engine/scene/nodeReferences.ts` says where a reference sits: a field value or a list item, never deeper; in a node entry, component data, field overrides and added components resolve among the file's nodes, added nodes' components among those added nodes. The loader, `SceneDocument.references` (which now lists added components' references, by their index among the node's components, with the field's value), paste and asset cleanup all use it.
- **Fixes.** Apply writes inner nodes' tag overrides; the Hierarchy filter skips removed components and sees added nodes; the resolved view orders behaviours only; deleting a node clears references in added components. Apply now removes a nested instance a `removeNode` override names (it wrote an invalid target-less override on it).

## Alternatives considered

- **Instantiate from the resolved view** (resolve to effective entries, then make GameObjects from them) — one fewer adapter, but references in override values resolve in the instance's file while the prefab's own resolve in the prefab, so every value would have to carry its scope, and Apply still needs steps rather than results.
- **Keep the copies and share a test table** — catches drift after the fact; a new override kind would still be written four times.

## Consequences

**Positive**
- A new override kind is written once; warm-up, detection, thumbnails, the Hierarchy and Apply agree with the game by construction.
- One table of override cases (`src/engine/tests/overrideCases.ts`) runs against the resolved view, instantiation and Apply.
- A malformed file now fails with a message: a prefab that contains itself, which recursed forever when loaded.

**Negative / costs**
- Runtime behaviour shifts at the edges: an override `index` counts components left out of this World (before, it counted only created ones, so it could aim at the wrong one); a `removeComponent` matches the exact type id (before, a subclass instance could match); an override on a component whose script is missing is skipped without a second problem.
- References nested inside plain JSON values are no longer rewritten by paste or nulled by asset cleanup; the loader never resolved them.
- The editor resolves an instance each time it lists inner nodes or a component's origin (about what the hand walks cost; not cached).

## Deprecates

`Instantiation`'s own override code (`override`, `addNodes`, `applyOverride`, `noteWorldsOverrides`, `worldsOverride`, the skipped-component bookkeeping) and `resolvedScene.ts`' copy, both moved into the fold. In the editor: `innerNodes`, `applyOverride` and the `isDataComponent`-based order code in `prefabs.ts`; `componentTypesOf` / `instanceTypes` in `hierarchyFilter.ts`; `addedBy`, `prefabNodeEntry` and the file walk of `prefabOrder` in `componentEdits.ts`; the `liveCount` / `missingCount` parameters of `originOf`, `whyNotRemovable`, `whyNotToggleable`, `whyNotRemovableMissing`, `removeMissingComponent` and `componentWorlds`; `remapReferences` in `nodeInsertion.ts`; `refId` / `listRefs` in `SceneDocument.ts`; `cleanValue`'s own reference rule.

## Open questions

- A `worlds` override on a component an `addComponent` override added is shown by the resolved view but not applied at load (the loader decides Worlds when it creates a component, from file entries). Nothing writes one today.

## References

- `src/engine/scene/overrideFold.ts`, `resolvedScene.ts`, `SceneLoader.ts`, `nodeReferences.ts`; `src/editor/prefabs.ts`, `hierarchyFilter.ts`, `componentEdits.ts`, `inspectorEdits.ts`, `document/SceneDocument.ts`, `nodeInsertion.ts`, `assetRefValues.ts`, `hierarchyEdit.ts`
- Tests: `src/engine/tests/overrideFold.test.ts`, `resolvedScene.test.ts`, `nodeReferences.test.ts`; `src/editor/prefabApplyFold.test.ts`, `hierarchyFilter.test.ts`, `componentEdits.test.ts`, `document/document.test.ts`
