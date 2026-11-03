# 0026. The editor edits a scene document through commands

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0013, 0016, 0022, 0024

## Context

0022 says edits save back to scene/prefab files, with nested prefab overrides, and that undo/redo is a command stack. It doesn't say what the editor treats as the truth while editing: the live Editor World, or the scene file's data.

The World holds expanded, instantiated state: a prefab's nodes are copied in and no longer know which values came from the prefab and which are overrides. Serializing the World back to a file would lose that distinction. It would also save engine-generated values (defaults, derived state) that were never authored.

The editor also needs things from the engine that game code must not see: every node, every component and its declared fields, the scene a node came from, and raycasts for selection. Putting those in the public API would leak editor needs into games (0010, 0022).

## Decision

- **The scene document is the source of truth.** The editor loads a scene file (`tranquility.scene@1`, 0013) into a `SceneDocument`: the parsed JSON plus indexes by node id. Saving writes the document, not the World.
- **Every edit is a command** on the document (add/remove/reparent/rename node, add/remove component, set field, set prefab override…). A command can apply and undo itself. Commands live on an undo/redo stack, and related edits can be grouped into one undo step (e.g. a gizmo drag).
- **The Editor World is a view of the document.** After a command, the editor syncs the affected nodes in the Editor World from the document: rebuild the node for structural changes, write the field for value changes. Nodes keep a mapping from World entity to document node id, so viewport selection resolves to document nodes.
- **Editor-only engine access** goes through an internal module, `src/engine/editor/` (not exported from `src/engine/index.ts`). It covers enumerating nodes and components, reading field declarations, mapping entities to scene node ids, instantiating a document into a World, and selection raycasts. Game builds never import it.
- **File I/O** goes through the platform adapter (0003, 0024): a project folder opened with Tauri's file system and dialog plugins. In a plain browser the editor works on documents in memory (opened from the dev server's assets, never saved).

## Alternatives considered

- **The live World as the source of truth, serialized on save.** Fastest to start, but loses prefab overrides and authored-versus-default values, and undo needs snapshots of World state.
- **Snapshot undo (store a copy of the document per edit).** Simple, but memory grows with scene size and edit count, and grouping drags is awkward. Commands can still fall back to snapshots internally where that's easier.
- **Editor API in the public engine API.** Simpler imports, but exposes internals to every game.

## Consequences

**Positive**
- Saved files contain only what was authored; prefab overrides stay intact.
- Undo/redo, dirty tracking and save are all straightforward over a document.
- The editor's view and the file can't drift apart, since the World is rebuilt from the document.

**Negative / costs**
- Two representations to keep in sync (document and Editor World).
- Every editing feature needs a command.

## Deprecates

- Nothing.

## Open questions

- Multi-scene editing (several documents open at once).
- ~~How play mode hands the document to a Runtime World~~ Resolved: a deep copy of the document is served under the scene's path by a temporary asset source, and the Runtime World loads it like any scene file.

## References

- [0013](0013-data-driven-scene-format.md), [0016](0016-world-root-and-scenes-as-nodes.md), [0022](0022-editor-is-a-v1-goal.md)
