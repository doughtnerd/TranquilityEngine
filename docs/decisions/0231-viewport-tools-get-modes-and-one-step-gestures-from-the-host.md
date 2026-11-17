# 0231. Viewport tools get modes and one-step gestures from the host; long-running undo steps go through the SDK

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0138's active-tool API and 0142's `editingCollider`)
- **Related:** 0138 (viewport tools), 0142 (collider editing as a viewport tool), 0147 (the `editor` surface), 0133 (the internal tier), 0027 (undo), 0103 (tile painting), 0162 (the reverb zone gizmo)

## Context

ADR 0138's viewport-tool context gives a tool `active`, `activate`, `deactivate` and a synchronous `edit`. Three tools are modal: the collider gizmo (`editingCollider`), the reverb zone gizmo (`editingZone`) and tile painting (`brushTool`). Each kept a module-level mode signal and wrapped it in the same four effects: mode set → activate; `active` lost → clear the mode; the selection changes → end it; the scene changes → end it. The paint tool read the shell's `activeViewportTool` instead of `view.active`.

Drags were one undo step only by convention. `edit()` covers synchronous edits, so the collider and zone gizmos each wrote a `grouped()` helper around `scene.stack.beginGroup`/`endGroup`, and Inspector controls (particles, audio) and the particle migration opened groups by hand. A cancelled drag closed its group (keeping the edit); Escape mid-drag did nothing. `colliderGizmo.test.ts` drove the tool by writing `editingCollider` and reading `editor/state` and `editor/viewportTools`. The collider gizmo imported `editor/sceneTools` (an internal-tier entry) only to snap.

## Decision

We deepen the viewport-tool host so a tool keeps only its geometry.

1. **The host owns a tool's mode.** The active tool is held as `{ id, mode }`; the mode lives exactly as long as the tool stays active. `ViewportToolContext<M>` gains `mode: ReadonlySignal<M | null>`, `enter(mode?)` and `leave()`, replacing `activate`/`deactivate`. The host ends the mode when a transform tool or another tool takes the scene view, on Escape (no drag running), when play starts, when another scene opens, when the tool is removed and, if the contribution's `endsOnSelection(mode)` returns true, when the active node changes. Entering is ignored while playing.
2. **`editor.viewport`** (ADR 0147's surface) reads and sets the same state from outside an install: `activeTool`, `mode<M>(id)` (one signal per id), `enter(id, mode)`, `leave(id)`. The Edit Collider and Edit Zone buttons and the Tile Palette use it. `activeViewportTool` and `activateViewportTool` leave the SDK's exports.
3. **A gesture is a drag that is one undo step.** `view.gesture(label, drag)` opens a step on the open scene at once (called from `onPress`); every command executed meanwhile joins it; it closes after `end`. `ViewportDrag.cancel` now receives a `ViewportCancel` reason: `"escape"` reverts the step (the host routes Escape to a running drag first and consumes it); `"pointer"`, `"blur"` (the window lost focus, new), `"tool"` (the active tool changed mid-drag, new), `"play"` and `"removed"` keep it.
4. **`CommandStack.cancelGroup()`** closes the outermost group without recording it, putting the document and any text files back and emitting a `"cancel"` event with the changes; a nested group just closes.
5. **Long-running undo steps for everyone else.** `editor.scene.edit(label, fn, scene?)` (synchronous) and `editor.scene.beginEdit(label, scene?) → UndoStep { open, end(), cancel() }` over a shell module `undoStep.ts`. Plugin editor halves never call `beginGroup`/`endGroup`/`cancelGroup`; `plugins.test.ts` scans for it.
6. **`view.snap(value)`** snaps to the move step while snapping is on, so the collider gizmo drops its `editor/sceneTools` import and that internal-tier entry goes.

Moved onto it: the collider gizmo, the reverb zone gizmo, tile painting (`brushTool` is now `editor.viewport.mode("myco.tilemaps.paint")`, `endsOnSelection` = "the new node has no Tilemap"), tile palette commits, the particle Inspector's curve gesture, the particle migration and the audio Inspector's `dragGroup`.

## Alternatives considered

- **Keep plugin-owned mode signals and have the host bind them (`view.bindMode(signal)`).** Less churn, but the mode still lives in module state that tests write directly, and two sources of truth (signal and active tool) must be kept in step.
- **Revert on every cancel.** A blur or tool switch mid-drag is not the user saying "undo"; Unity and Blender put a drag back only on Escape/right-click. Keeping is the less surprising default.
- **Abort by committing and then undoing.** It would leave a redo branch in the history tree (ADR 0027) for an edit the user cancelled.

## Consequences

**Positive**
- The end-of-mode and cancel rules are written once; three tools lose about 25 lines of effects each.
- Escape now puts back a collider, zone or tile-paint drag in progress.
- Tests drive tools through `editor.viewport`, the scene view's pointer and key events and the contribution, not shell state.
- One internal-tier entry (`colliderGizmo.ts -> editor/sceneTools`) removed.

**Negative / costs**
- `activate`/`deactivate` and the SDK's `activeViewportTool`/`activateViewportTool` are renamed or removed (experimental SDK, first-party callers only).
- Picking a brush with no scene view open no longer persists the brush: without a host nothing is active.

## Deprecates

`ViewportToolContext.activate`/`deactivate` (removed; use `enter`/`leave`), the SDK exports `activeViewportTool`/`activateViewportTool` (removed; use `editor.viewport`), the writable module signals `editingCollider`, `editingZone` and `brushTool` (now read-only views of the host's mode), and the plugins' own `grouped()` helpers.

## Open questions

- The shell's own transform gizmo and Inspector number drags still open groups directly; moving them onto `UndoStep` (and Escape-to-revert for the transform gizmo) is left for later.

## References

- `src/editor/viewportTools.ts`, `src/editor/sdk/viewport.ts`, `src/editor/undoStep.ts`, `src/editor/document/CommandStack.ts`
- Architecture review 2026-11-17, candidate 4
