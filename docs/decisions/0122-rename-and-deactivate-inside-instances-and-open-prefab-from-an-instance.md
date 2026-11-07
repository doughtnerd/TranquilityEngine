# 0122. Nodes inside a prefab instance can be renamed and deactivated, and an instance opens its prefab in a tab

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0022, 0026, 0028, 0029, 0086, 0087

## Context

ADR 0013 already lets an override carry `name` and `active` (`{ "target": ["top"], "name": "Lid" }`), and the loader applies them (`SceneLoader.ts`, `applyOverride`). The editor never writes them:

- The Inspector shows a node inside an instance with a read-only name ("Nodes inside a prefab are renamed in the prefab") and a disabled Active box, single or multi-selected.
- Apply (`applyOverrides` in `src/editor/prefabs.ts`) skips `name` and `active` overrides, so hand-written ones stay on the instance for ever.
- The Hierarchy builds an instance's rows from the prefab files alone (`innerNodes`), so it shows neither overridden names, inactive inner nodes, nor the nodes an instance adds or removes (ADR 0086).
- Changing the prefab itself means finding its file in the Assets panel and opening it; nothing links an instance to it, and you lose your place.

## Decision

**Renaming and deactivating inner nodes.** Renaming a node inside an instance, or switching its Active box, writes an override on the instance: `{ "target": [...], "name": "..." }` or `{ "target": [...], "active": false }`, one entry per target and key, replaced on the next edit (`RenameNode` and `SetActive` take an optional `target`, like `SetField`). As with ADR 0028, the editor writes the override only while the value differs from what the instance would show without it (the prefab file plus nested instances' own overrides); setting it back removes the entry. The instance root keeps its name and active flag on its own node entry, as today. The multi-selection Active box works on inner nodes too.

**What the Editor World and Hierarchy show.** The command reports a `name`/`active` change with the full path, and `WorldSync` writes the name or active flag onto that World node (rebuilding the instance when the override went away, since only a fresh instance knows the prefab's value). `innerNodes` takes the instance's overrides into account: overridden names, `active` (inactive inner rows are dimmed like plain ones), `addNodes` (added nodes appear under their target) and `removeNode` (removed nodes disappear). Nested instances' own overrides in the prefab files count the same way, outer overrides winning. The Inspector marks an overridden name or Active box like an overridden field, and Revert on it removes that one override.

**Apply.** Apply writes `name` and `active` overrides whose target is not empty into the prefab: on a plain prefab node it sets the node's `name`, or `active: false` (removing the key for `true`); inside a nested instance it stays an override there, like ADR 0029's `order`. Overrides with an empty target (the instance root) stay on the instance, because each instance is usually named and placed on its own, as in Unity.

**Open Prefab from an instance.** An instance, and any node inside one, has an **Open Prefab** button in the Inspector, an item in the Hierarchy's right-click menu, and a double-click on the Hierarchy's prefab badge. It opens the prefab file in its own scene tab (the existing tabs, ADR 0026), isolated from the scene, and selects the node that was selected: `[instance]` maps to the prefab's root, `[instance, a, ...]` to `[a, ...]` in the prefab file (for a node inside a nested instance, the path inside that instance). A bar at the top of the Scene panel says "Editing prefab `prefabs/pipe.prefab.json` from `level-1`" with **Back to level-1**, which switches back to the scene's tab. Saving writes the prefab file as any tab does. Switching back rebuilds the scene's nodes from the files, so its instances show the change. Nested instances inside the opened prefab open their own prefab the same way, and Back goes up one level at a time.

The format doesn't change: these override keys already exist in `myco.scene@1`.

## Alternatives considered

- **Editing the prefab in context** (Unity's Prefab Mode in Context): stay in the scene tab, grey out and lock the rest of the scene, and edit the instance's contents as the prefab. It needs a second document stacked inside one tab, with its own undo history and save, and a World holding both. The user chose the tab for now; in-context editing can come later on top of it.
- **Renaming in the prefab only** (today's rule). Simple, but makes a common edit (one instance's "Door" is "Back door") impossible without a new prefab.
- **Applying the instance root's name and active too.** Every instance would then rename the prefab when applied, which is rarely wanted; Unity also leaves the root's name out.
- **One override entry per target holding every property** (`name`, `active` and `tags` together). Fewer entries, but each edit would have to merge and split entries, and the loader already treats each entry on its own.

## Consequences

**Positive**
- The last two kinds of instance edits the format had but the editor lacked now work, and Apply handles every override kind.
- The Hierarchy shows instances as they are, including the nodes they add or remove (it didn't before).
- Getting from an instance to its prefab and back is one click each way.

**Negative / costs**
- `innerNodes` now reads every nested prefab's overrides on each Hierarchy render; it already read the files, so the extra cost is small.
- Overrides aimed at nodes the prefab later removes are reported as problems in the editor, as other overrides already are.
- Edits in a prefab tab can leave other open tabs' instances stale until they're shown again (they rebuild when activated).

## Deprecates

The read-only inner-node name and disabled Active box in the Inspector.

## Open questions

- In-context editing (above), if the tab turns out to be too far from the scene.

## References

- `src/editor/prefabs.ts`, `src/editor/document/commands.ts`, `src/editor/document/WorldSync.ts`, `src/editor/ui/Inspector.tsx`, `src/editor/ui/Hierarchy.tsx`, `src/editor/session.ts`
- Unity Manual, "Editing a Prefab in Prefab Mode"; Godot "Editable Children"
