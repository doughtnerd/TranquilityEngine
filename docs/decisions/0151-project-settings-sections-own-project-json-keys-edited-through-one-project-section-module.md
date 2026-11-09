# 0151. Project settings sections own the project.json keys they declare, edited through one project section module

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0038, 0116, 0133, 0134, 0137, 0145, 0147

## Context

Two panels edit `project.json`: Project Settings (everything but `bootstrap`, ADR 0038) and Worlds (`bootstrap`, ADR 0032). Each carried the same document session inside its `.tsx`, untested (`ui/ProjectSettingsPanel.tsx` about 110 lines, `ui/WorldsPanel.tsx` about 110):

- a module-level `PanelState` (draft history, the file text last seen, the text a write in progress is writing, saving and error flags);
- `stateFor`, which told the panel's own write coming back from an outside edit (by comparing `writingText`) and kept the draft and undo when only another panel's key changed;
- `persist` (a valid-only write through `projectFile.ts`'s queue), `edit`, undo and redo;
- an `UndoHistory` (ADR 0145) of four getters reading a `version` signal.

Only the write queue and `EditHistory` (`worldsConfig.ts`) were shared. The after-save work was inline: reloading the graphics tiers, re-applying plugins turned on or off (ADR 0133), bumping `docVersion` for the project's name, and on undo or redo moving the scenes' layer references (ADR 0116).

The Project panel's keys were a closed list, `SETTINGS_SECTIONS` in `projectSettingsModel.ts`, including `physics` and `navigation`, which the Physics and Navigation plugins' settings sections edit. `readDraft`, `sectionsKey` and `withSettings` looped only over it, so a third-party section registered with `registerProjectSettingsSection` couldn't own a new top-level key, and the plugins guide listed "no per-plugin settings storage in `project.json`" as a limit. ADR 0133's table already described the contribution point as "a set of owned `project.json` keys with read, write and validate"; the built contribution had only `id`, `title`, `view` and `after`. Physics and navigation validation lived in the shell's `settingsProblems`, and the Physics section imported the shell's `projectSettingsModel` through the internal tier (ADR 0147).

## Decision

We will edit `project.json` through one non-UI module, `src/editor/projectSection.ts`, and let settings sections declare the keys they own.

- **The project section.** `createProjectSection(spec)` is "a set of top-level `project.json` keys being edited". The spec gives `name` (the history's), `what` (for save errors), `keys()` (asked each time), `read(values)` and `write(draft)` (draft from and to the owned keys' values), `problems(draft, project)` (anything listed keeps the draft unsaved), optional `adopt(draft, added)`, `saved(project, draft, before)` and `stepped(project, before, after)`. The section exposes `open(project)` (the session, reconciled with the file), `version` (a signal for views), `history` (an `UndoHistory` for `usePanelHistory`), `refresh` and `reset`. A session has `draft`, `saving`, `error`, `unsaved`, undo and redo labels, and `edit(label, next)`, `undo()`, `redo()`, each resolving once its queued write is done.
- **Reconciliation.** The session keeps the file text it last read or wrote, the text a write in progress is writing, and its keys' values (as JSON). `open` keeps the session when the text is either of those (its own write), or when only other keys changed (another panel's save, the Code panel); it starts again, dropping the draft and undo, when its own keys changed elsewhere.
- **Keys that come and go.** Keys removed from `keys()` (a plugin turned off) are no longer compared or written; the file keeps them untouched. Keys added (a plugin turned on) are adopted: `adopt` puts the file's value into every state of the history, so undoing past that point never deletes them; a section without `adopt` starts again.
- **Saves.** Only valid drafts are written, through `queueProjectFileWrite`, one top-level key at a time with `withMember` (only keys whose value changed), so the rest of the text keeps its layout. A failed write sets `error` and the status bar.
- **The two panels are views.** `projectSettingsSection.ts` (`createProjectSettingsSection(hooks)`) and `worldsSection.ts` (`createWorldsSection()`, a draft of the bootstrap view plus its raw value, never written unless it is a graph) are the two specs. The settings section's `saved` hook reloads graphics and re-applies plugins (both passed in by the panel, so tests run without a renderer), and bumps `docVersion`; its `stepped` hook moves layer references. The panels keep only their UI and, for Worlds, the selection (per session).
- **Settings sections own keys.** `ProjectSettingsSectionContribution` gains `keys: readonly string[]` (required; `[]` for a section that edits core keys only) and optional `problems(draft)` (field-tagged, starting with the section's `id`). `projectSettingsModel.ts`'s `SETTINGS_SECTIONS` becomes `CORE_SETTINGS_KEYS` (`name`, `display`, `time`, `render`, `autoload`, `graphics`, `audio`, `plugins`, `build`), and `settingsKeys()` adds the registered sections' keys; `readDraft`, `sectionsKey` and `withSettings` default to it, and `settingsProblems` adds the registered sections' problems. Registering a section that claims a core key, `bootstrap` or another section's key throws (`checkSettingsSectionKeys`). `SettingsDraft` gains an index signature for plugin keys.
- **Physics and Navigation declare theirs.** The Physics section owns `physics` and checks it (`plugins/physics/editor/physicsSettingsModel.ts`: the layer and collision-matrix edits, gravity and `physicsSettingsProblems`, moved out of the shell); the Navigation section owns `navigation` and checks it with `parseNavigationSettings`. The shell keeps `layersOf` for the project-wide layer rename, and `renameLayerEdit` takes the renamed draft from the section that owns the layers. The internal-tier entry `PhysicsSettingsSection.tsx -> editor/projectSettingsModel` is removed.
- **Not in the SDK.** `createProjectSection` stays shell-internal: a plugin owns `project.json` keys by declaring them on its settings section, not by making its own panel session.

## Alternatives considered

- **Leave the closed list and add plugin keys to it by hand.** Keeps every plugin key in the shell, which is what 0133 set out to end, and third parties still couldn't store settings.
- **A per-plugin namespace (`plugins.<name>.settings`)** instead of top-level keys. Avoids collisions, but moves `physics` and `navigation`, which the engine and every project read at the top level, and needs a migration; declared keys with a registration check keep the file as it is.
- **One session per settings section,** each with its own draft and undo. Matches the contribution more literally, but the panel shows one Undo for all categories, and turning a plugin off in the Plugins category changes which sections exist, which one draft handles as keys coming and going.
- **Keep the logic in the panels and only share helpers.** Smaller, but the reconciliation rules are the subtle part, and they stay untested inside `.tsx` files.

## Consequences

**Positive**
- The draft, reconciliation, valid-only saves, undo and the after-save work are written once and unit-tested over an in-memory project (`projectSection.test.ts`).
- Third-party settings sections can store their own top-level `project.json` keys, saved, validated and undone like the built-in ones.
- A disabled plugin's keys are left alone in the file rather than edited by a section that isn't there.
- The Physics section no longer reaches into the shell's settings model.

**Negative / costs**
- `keys` is required on the contribution, an SDK change (experimental before v1); sections registered without it fail to type-check.
- With a plugin off, its keys aren't checked in the editor (its section isn't there to say what's valid).
- Turning a plugin on rewrites every state of the history to adopt its keys; turning one off and editing its key in the Code panel, then turning it on, adopts the outside value without restarting.

## Deprecates

- The `PanelState`, `stateFor`, `persist`, `edit`, `jump`/`undo`/`redo` and hand-written `UndoHistory` objects in `ui/ProjectSettingsPanel.tsx` and `ui/WorldsPanel.tsx`: removed (0133 listed them).
- `SETTINGS_SECTIONS` and `SettingsSection` in `projectSettingsModel.ts`: replaced by `CORE_SETTINGS_KEYS` and `settingsKeys()`.
- `collides`, `setCollides`, `addLayer`, `renameLayer`, `removeLayer`, `setGravity`, `MAX_LAYERS` and the physics and navigation checks in `projectSettingsModel.ts`: moved to the plugins.

## Open questions

- Whether `createProjectSection` should be offered to plugins that edit `project.json` from a panel of their own.
- Merging `EditHistory` into the other histories behind `UndoHistory` (0145's open question).

## References

- `src/editor/projectSection.ts`, `src/editor/projectSettingsSection.ts`, `src/editor/worldsSection.ts`, `src/editor/projectSettingsModel.ts`, `src/editor/sdk/contributions.ts`, `src/editor/sdk/plugins.ts`
- `src/plugins/physics/editor/physicsSettingsModel.ts`, `src/plugins/physics/editor/index.ts`, `src/plugins/navigation/editor/index.ts`
- Tests: `src/editor/projectSection.test.ts`, `src/plugins/physics/editor/physicsSettingsModel.test.ts`, `src/plugins/navigation/editor/navSettingsModel.test.ts`, `src/plugins/plugins.test.ts`
