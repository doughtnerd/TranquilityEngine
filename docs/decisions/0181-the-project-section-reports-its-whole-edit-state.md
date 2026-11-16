# 0181. The project section reports its whole edit state

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0151, 0173, 0174

## Context

ADR 0151 made both `project.json` panels (Project Settings and Worlds) views over one project section module, `projectSection.ts`. The session it hands out had the draft, `saving`, `error`, `unsaved` and the raw history flags, but not the section's problems, a status, or undo flags that respect a read-only project. So each caller rebuilt them: the Project Settings panel called `settingsProblems` again though the section spec already does; the Worlds panel recomputed `modelProblems`; each panel had its own save marker and its own `!editable || !undoLabel` toolbar; the SDK's `editor.project.settings` repeated the read-only check in `canUndo`/`canRedo`.

The two markers drifted. The Project Settings one checked `saving || unsaved` before `error`, so after a failed write (the draft still differs from the file, nothing queued) it said "Saving…" for good; the Worlds one checked the error first.

The Worlds section was also created inside its view module, while ADR 0173 moved the settings section to `projectSettingsInstance.ts`; and the Worlds selection was a module-level `WeakMap` keyed by session, shared by every copy of the panel, against ADR 0174's per-instance view state.

## Decision

We will have the section report its whole edit state, and every view read it from there:

- `ProjectSectionSession<D, P>` gains `problems: readonly P[]` (the spec's `problems`, typed by a second type parameter: `SettingsProblem` for Project Settings, `string` for Worlds) and `status: ProjectSectionStatus`, one of, first that applies: `read-only`; `problems { count, unsaved }`; `saving` (a write in progress); `failed { error }` (the last write failed, until one succeeds); `saving` (a write queued); `saved`.
- `canUndo` / `canRedo` on the session are false while the project is read-only. The section's `UndoHistory` and `editor.project.settings.canUndo/canRedo` read them instead of repeating the check.
- One view, `ui/ProjectSectionToolbar.tsx`, draws a section's toolbar: the panel's own buttons, Undo, Redo and the marker (`.section-status`) worded from the status. Panels pass what differs: the noun in tooltips, the `saved` wording (Worlds says "Default bootstrap" while the bootstrap is implicit), and a note on why problems matter.
- The shell's Worlds section lives in `worldsInstance.ts`, beside `projectSettingsInstance.ts`. Every Worlds panel copy views it.
- Each Worlds panel copy keeps its selection in its own view state (`usePanelState`, ADR 0174), tied to the session it was made in, so a new session (an outside edit, another project) selects the first World again.
- `ProjectSection.reset()`, which had no callers, is removed.

The SDK's public surface doesn't change.

## Alternatives considered

- **Keep the markers in the panels and fix the order there** — fixes the bug but leaves two copies to drift again, and the problems still computed twice.
- **A status only, no problems list** — the panels need the problems per field anyway, so they would go on calling the model's checks themselves.
- **Expose `status` and `problems` on `editor.project.settings` too** — no plugin needs them yet; adding them later is cheap.

## Consequences

**Positive**
- One place decides what a section's edits look like; the failed-write state reads "● Not saved" in both panels.
- The section's status, problems and read-only undo flags are tested through its interface (`projectSection.test.ts`).
- Two Worlds panels keep their own selection.

**Negative / costs**
- `problems` and `status` work the problems out on each read (the panel reads both once per render); the checks are cheap, and nothing caches on draft identity because they also depend on the project's files and the script catalog.

## Deprecates

The panels' own `SaveMarker`s and Undo/Redo buttons, the `.project-settings-status` and `.worlds-status` classes (now `.section-status`), the Worlds panel's module `WeakMap` selection, `ProjectSection.reset()`, and `instanceState`'s unused test-only `hasInstanceState`. All removed.

## Open questions

None.

## References

- `src/editor/projectSection.ts`, `src/editor/ui/ProjectSectionToolbar.tsx`, `src/editor/worldsInstance.ts`
