# 0124. The live Hierarchy and Inspector edit a running World's structure, play-only and without undo

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0032, 0034

## Context

While playing, the Hierarchy's **Show** picker switches the Hierarchy and Inspector to a live World of the play Engine
(`runtimeInspect.ts`, `ui/RuntimeHierarchy.tsx`, `ui/RuntimeInspector.tsx`). Field values, active and enabled can be
edited there, against the running World only, and **Keep values** writes a component's values into the document on
Stop as one undo step. The 0032 status row lists the rest as gaps: the live Hierarchy can't create, delete or
reparent nodes, and the live Inspector can't add or remove components or change node references (it shows the node's
name read-only). Unity's play mode allows all of these and throws them away on Stop.

Everything needed already exists as public engine API: `GameObject.create(name, { parent })` (uses the parent's World,
ADR 0034), `GameObject.destroy`, `setParent` (refuses cycles, throws across Worlds), `addBehavior`/`removeBehavior`,
`addData`/`removeData`, and `name`. Destruction and component removal are queued until step 10 of the frame
(`World._flushDestroyed`), so while the session is paused a deleted node or removed component would linger.

## Decision

We will let the live views edit a running World's structure through the public API, as game code would, with these
rules (code in `src/editor/liveEdits.ts`):

- **Hierarchy.** A **+** button and a right-click menu on live rows: **Create Empty** (beside the row, or at the top
  level: under the World's active scene, else its root), **Create Empty Child**, **Rename** (F2), **Delete** (Del),
  and **Move to Top Level**. Dragging a row onto another reparents it (keeping its world transform, `setParent`'s
  default) and onto the World header moves it to the top level. The World root can't be touched, a loaded scene's
  node can't be moved, and a move that would make a cycle is refused with a message.
- **Inspector.** **Add Component** (the same menu as in edit mode, with the same "already has one" rules, and
  colliders fitted to the sprite or mesh as `newComponentEntry` does) and **Remove Component** on each header except
  the Transform. Added behaviors run at once (`awake`, `onEnable`), as `addBehavior` does in a game.
- **Node references.** A node field is a dropdown of the same World's live nodes (indented by depth, plus None).
  Other Worlds' nodes are never offered (ADR 0032 isolation). Values are written through `writeField`, so assignment
  goes the way the scene loader does it.
- **Applied at once.** After a delete or a component removal the editor runs the World's deferred destroys right
  away (`applyDestroys`, editor-only, ADR 0026), between frames, so the change shows while paused; a paused session
  redraws.
- **Play-only, no undo.** Like live field edits, structural live edits change the running game only, aren't on the
  undo stack, and are gone on Stop. **Keep values** stays field-only: it doesn't record created or deleted nodes,
  moves, or added or removed components. Nodes made in the live Hierarchy can't keep values (they already say why:
  made at runtime).

## Alternatives considered

- **Undo for live edits** — a second, session-only stack. Destroying a node runs `onDestroy` and drops its script
  state, so undoing a delete can't put the same node back; only re-creating from a snapshot could, which isn't the
  node game code holds. Unity has no play-mode undo either.
- **Keep structural changes on Stop** — record created nodes, moves and added/removed components as document
  commands. Possible for scene nodes (they map back through `docPathFor`), but new nodes have no ids, prefab
  instances would need structural overrides (being reworked in 0122), and live state (spawned children) is hard to
  tell apart from intent. Left as an open question.
- **Engine-internal calls** (`World._createNode`, `_setParent`) — would skip the isolation checks and the
  `_componentAllowedIn` rule (ADR 0033); the public API is what scripts see, so it behaves like the game.

## Consequences

**Positive**
- The live views close ADR 0032's editing gaps with no new engine API beyond one editor-only helper.
- Live edits behave exactly like script calls (same hooks, same isolation errors).

**Negative / costs**
- Nothing structural survives Stop; users have to redo it in the scene.
- Deleting a ghost on a client World, or a node a script holds, can make that script fail or replication re-create it;
  the editor doesn't stop that (the game would do the same).

## Deprecates

Nothing.

## Open questions

- Should **Keep** extend to structural changes on scene nodes (added/removed components, moves, deletions) on Stop?
- Should live edits get undo after all (fields at least, which can be put back)?
- Outlines for headless Worlds and showing several Worlds outside the editor stay out of scope (0032 row).

## References

- `src/editor/liveEdits.ts`, `src/editor/ui/RuntimeHierarchy.tsx`, `src/editor/ui/RuntimeInspector.tsx`,
  `src/editor/ui/AddComponentMenu.tsx`, `src/engine/editor/index.ts` (`applyDestroys`).
- Tests: `src/editor/liveEdits.test.ts`, `tests/e2e/playdebug.spec.ts`.
