# 0401. Create Prefab keeps references to scene nodes outside the prefab as overrides on the new instance

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0087)
- **Related:** 0013, 0022, 0087, 0280

## Context

Create Prefab (`createPrefab`, `createPrefabFromNodes` in `src/editor/prefabs.ts`) copies the chosen nodes into a new prefab file. A reference from one of them to a scene node outside them (an enemy's `target` naming the scene's Player) was copied as written. In the prefab file that id names nothing, since `{"$node"}` references resolve among the file's own nodes (0013, 0280). References the other way, from outside nodes to inner ones, were already refused (0087).

The owner's call: do what Unity does. A Unity prefab asset can't hold scene references, so the asset's field is None, and the scene object that becomes the prefab's instance keeps the reference as a prefab override.

## Decision

We will, when Create Prefab makes a prefab:

- Write `null` in the prefab file for every reference from the new prefab's nodes to a scene node outside them. That covers component data, nested instances' field overrides and their added components' data (where `nodeReferences.ts` says references sit). For a list field, only the outside items become `null`.
- Record each such field's original value as a field override on the new instance (`target` empty for the prefab root's own fields, else the node's path within the prefab; the `index` counts components of the type, as `SceneDocument.references()` does). The scene resolves exactly as before.
- Keep references between the prefab's own nodes in the file as they are. In `createPrefab` the instance keeps the root's id, so a reference to the root still names it from the scene.
- A list field that holds outside references beside references to other nodes inside the prefab (owner decision): the prefab file keeps the inside items (outside ones `null`); the instance's override keeps the outside items (and the root, whose id the instance keeps) and clears the inside ones to null, as a cleared reference, since the override is read in the scene where those inner nodes no longer exist. The Create Prefab message says how many list items were cleared.
- Make it one undo step, the same as before. Report the count in the status bar, e.g. "Created prefabs/game.prefab.json. 5 references to nodes outside the prefab became instance overrides; the prefab file leaves them empty."

`createPrefab` and `createPrefabFromNodes` return `{ path, instanceOverrides }` (`CreatedPrefab`) in place of the path.

## Alternatives considered

- **Refuse when a reference points out** — safe, but it makes the user cut references by hand before making a prefab, and Unity users expect the override.
- **Null the references and only warn** — the scene would change (the instance loses its references) without the user asking for it.
- **Refuse a mixed list** — the first version did; the owner chose clearing the inside items instead.
- **Per-item list overrides, to handle mixed lists** — the override format has no list-item override. Adding one is a file-format change for a rare case.

## Consequences

**Positive**
- Making a prefab never changes how the scene plays. The prefab file never holds a reference that names nothing.

**Negative / costs**
- The new instance starts with overrides, so it shows as modified. Apply would write those scene references into the prefab file again, and they would name nothing there. That's the same as Apply on any instance override that points into the scene.
- In a mixed list (inside and outside references in one field), the instance's override clears the inside items (null); the scene's list keeps its length, with those items empty until the override is edited.

## Deprecates

Nothing.

## Open questions

- Should Apply leave out overrides whose value references scene nodes, as Unity does?

## References

`src/editor/prefabs.ts` (`outsideReferences`), `src/editor/nodeEdits.ts` (`createPrefabFrom`), tests in `src/editor/prefabs.test.ts` and `src/editor/nodeEdits.test.ts`.
