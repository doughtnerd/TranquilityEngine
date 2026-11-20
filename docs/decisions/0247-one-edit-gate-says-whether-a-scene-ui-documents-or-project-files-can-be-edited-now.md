# 0247. One edit gate says whether a scene, its UI documents or the project's files can be edited now

- **Status:** Accepted, amended by 0257 (Inspector field, component and node edits, gizmos and viewport tools go through the gate; the document is read-only during play)
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0145, 0147, 0231, 0237, 0246 (amends 0147: `editor.scene.edit` and `beginEdit` refuse while playing, and `editor.scene.whyNotEdit` is new)

## Context

"Can I edit this now, and what does the status bar say if not?" was answered at each call site:

- Two private `editableScene` functions: `hierarchyActions.ts` (play only, "Stop playing to …") and `uiDocumentEdits.ts` (`whyNotEditableUI`: no scene, read-only, play), whose read-only text was a hand copy of `readOnly.ts`' message.
- About 25 `playState … !== "edit"` checks in 16 files, with five wordings of the play refusal ("stop playing to edit the scene", "stop playing first", "stop playing to move files", "stop playing to edit UI documents", "Stop playing to add assets"), including the Hierarchy menu, node drags, the menu bar model, asset delete and drag, and plugins (Tilemaps' paint tool and palette).
- `editor.scene.edit` / `beginEdit` (ADR 0147, 0231) didn't check play at all, so a plugin had to read `playState` itself.
- `uiDocumentEdits.ts` kept a handle drag's undo step in a module global (`let gesture`), closed through `endUIEdit` / `cancelUIEdit`.

Not every `playState` read is an edit gate: previews that run only while editing (the particle preview, nav previews), whether the game view or Play button shows, which panel content appears in play, the Play session itself (ADR 0237), and viewport tools leaving their mode when play starts (ADR 0231) decide what to show or do, not whether an edit may happen.

## Decision

We will answer it in one module, `src/editor/editGate.ts`.

- **Targets.** `{ kind: "scene", scene? }` (a scene document; the open one by default), `{ kind: "ui-documents" }` (the open scene's UI document markup, which is project files written through the scene's undo stack, ADR 0077), `{ kind: "project-files", project?, removes? }` (assets; `removes` for deleting or moving, which the running game may be reading).
- **`whyNotEdit(target, toDo?)`** → one worded reason or null, reading the signals (so components re-render): no scene ("open a scene first"), no project ("open a project first"), a read-only project (`readOnlyMessage(project, toDo)`, `readOnly.ts`' one message), play (`stop playing to <toDo>`; scenes and UI documents always, project files only when `removes`). `toDo` defaults per target ("edit the scene", "edit its UI documents", "change its files").
- **`editableNow(target, toDo)`** reports the reason to the status bar as `Can't <toDo>: <reason>.` and returns the scene (or project) when editable, else null.
- **`editStep(target, label, toDo, fn)` / `beginEditStep(target, label, toDo)`** open the undo step on the target's stack after the gate passes (ADR 0231's `undoStep` / `beginUndoStep`); the caller holds the returned `UndoStep`.
- **SDK.** `editor.scene.edit` and `beginEdit` go through the gate, so they refuse (false / null, with the status) while playing and plugins inherit the rule. New `editor.scene.whyNotEdit(target?)` for plugins that need the reason before editing (the Tilemaps paint tool and palette panel).
- **Callers.** `hierarchyActions.ts`, `uiDocumentEdits.ts` (its `editableScene` and `whyNotEditableUI` become gate calls; `beginUIEdit` returns the `UndoStep`, and `endUIEdit` / `cancelUIEdit` and the module global go), the node insertion (ADR 0246) for its play refusal, `ui/HierarchyMenu.tsx`, `ui/Hierarchy.tsx` and `ui/UIElementInspector.tsx` (UI document rename and fields), `nodeDrag.ts`, `deleteSelection.ts`, the menu bar model (`MenuState.sceneEditBlocked` replaces `playing`), `assetDelete.ts` and `assetDrag.ts` (`removes`), `assetActions.ts` and `assetOps.ts` (read-only), and Tilemaps' `paintTool.ts` and `TilePalettePanel.tsx` through the SDK.
- **Left as they are** (not edit gates): `particlePreview.ts`, `ParticlePreviewOverlay.tsx`, `navPreviews.ts` (previews only while editing), `transportServiceHost.ts` (maps play state for the music transport), `playSession.ts`, `viewportTools.ts` and `sdk/viewport.ts` (tools leave and can't enter a mode in play, ADR 0231), `cameraPreview.ts`, `assetDrag.ts`' viewport target (where a drop lands; the add itself goes through the node insertion), `App.tsx`, `ScenePanel.tsx`, `MenuBar.tsx`'s Play item and the panels that show play-only content.

## Alternatives considered

- **One `isEditing()` boolean helper** — removes the comparison but keeps five wordings and the read-only copies; the reason, not the boolean, is what drifted.
- **Put the gate in the command stack** (refuse `execute` while playing) — the stack is also used by asset documents and tests outside play; and a refusal there comes too late for menus and tooltips, which need the reason before the user acts.

## Consequences

**Positive**
- One wording per refusal; menus, tooltips, the status bar and the operations agree.
- Plugins stop reading `playState` to gate edits; `editor.scene.edit` can't change a scene during play.
- The UI document gesture is a value its drag owns, not module state.

**Negative / costs**
- Visible text changes: "stop playing first" (asset delete) becomes "stop playing to delete files"; UI document refusals read "Stop playing to edit UI documents." instead of "Can't edit the UI document: …"; a Hierarchy shortcut with no scene says "Open a scene first."; the short "this project is read-only" in asset menus becomes the one read-only message.
- `editor.scene.edit` / `beginEdit` now refuse in play (no first-party plugin edited then).

## Deprecates

Removed: `hierarchyActions.ts`' and `uiDocumentEdits.ts`' `editableScene`, `whyNotEditableUI`, `endUIEdit`, `cancelUIEdit`, the module-global `gesture`; `menuBar.ts`' `STOP_PLAYING` and `MenuState.playing`; `assetActions.ts`' `READ_ONLY`.

## Open questions

- ~~Inspector field edits, component edits and node edits don't check play today (the Inspector shows the live World then, ADR 0243); they could move onto the gate if an edit path reaches them during play.~~ They do now (ADR 0257), with gizmos and viewport tools: one component field write asks the gate, and the edit modules refuse in play.

## References

- `src/editor/editGate.ts`, `src/editor/editGate.test.ts`, `src/editor/readOnly.ts`
