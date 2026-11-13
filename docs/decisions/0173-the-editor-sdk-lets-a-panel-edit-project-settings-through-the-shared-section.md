# 0173. The editor SDK lets a panel edit project settings through the shared Project Settings section

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0147 (the SDK's `editor` object), 0151 (project sections: one draft, one undo history), 0171 and 0172 (the Mixer panel's edits commit as one undo step, R22)

## Context

The audio Mixer panel (ADR 0171, task Mp2b) edits the project's `audio` section: a fader drag previews live and, on release, commits **one** edit with **one** undo step, the same history the Project Settings panel uses, so an undo in either place undoes it and the save hooks run (R22: `onSectionChanged` fires after the history push).

Today a plugin can't do that from its own panel. The shell's Project Settings section is a module-private constant in `src/editor/ui/ProjectSettingsPanel.tsx` (`createProjectSettingsSection({ graphicsSaved, pluginsChanged })`). A plugin's settings **section** gets a per-render `set(label, next)` prop (`ProjectSettingsSectionProps`, `src/editor/sdk/contributions.ts`), but only while it renders inside the Project Settings panel. `editor.project` (`src/editor/sdk/project.ts`) offers `current`, `version`, `onSectionChanged` and file helpers, with no way to commit a settings edit or step its undo. Plugins may reach `src/editor` only through `editor/sdk` (`src/plugins/plugins.test.ts`), so the Mixer can't import the shell's section.

## Decision

We will add a narrow settings surface to the SDK's `editor.project`, backed by **the same section instance** the Project Settings panel uses:

```ts
editor.project.settings: {
  /** The current settings draft (a deep copy). */
  draft(): SettingsDraft;
  /** Commit `next` as one undo step named `label` in the Project Settings history (the panel's own); resolves when saved or failed. */
  edit(label: string, next: SettingsDraft): Promise<void>;
  /** Step the Project Settings history (what the panel's Undo/Redo do). */
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Bumped on every draft change (an edit, an undo, an outside change). */
  readonly version: number;
}
```

- **One instance:** move `createProjectSettingsSection(...)` out of `ProjectSettingsPanel.tsx` into a shell module (`src/editor/projectSettingsInstance.ts`); the panel and `sdk/project.ts` both use it, so there is one draft, one history and the save hooks run once.
- **Narrow, not the section:** the SDK exposes these six members, not `ProjectSection<SettingsDraft>`, so the shell keeps its internals (sessions, problem lists, keys) private and can change them.
- **Types:** `SettingsDraft` is already what plugin settings sections see; export it from `sdk/index.ts` if it isn't.
- **First user:** the Mixer's `mixerHost.section` in `src/plugins/audio/editor/mix/index.ts`.

## Alternatives considered

- **Expose `ProjectSection<SettingsDraft>` itself** — the smallest code change, but it makes the shell's section internals (sessions, `open(project)`, problems, keys) part of the public plugin API.
- **A separate history for the Mixer** — simple, but an undo in Project Settings wouldn't undo a fader drag and vice versa, and two writers on one `project.json` key could race; R22 asks for one history.
- **Render the Mixer inside the Project Settings panel** — gets `set(label, next)` for free, but the Mixer is a play-mode panel docked beside the game, not a settings page.

## Consequences

**Positive**
- The Mixer commits and undoes through the shared history; any later plugin panel that edits project settings can too.
- The shell's section stays private behind six members.

**Negative / costs**
- A public SDK addition the shell must keep stable (versioned with the SDK, 0147).
- A small shell refactor (the instance module) touching `ProjectSettingsPanel.tsx`.

## Deprecates

Nothing.

## Open questions

- Whether `edit` should take a draft transform `(d) => next` instead of a whole draft, to avoid lost updates if two panels edit at once. The Mixer reads `draft()` and commits at once, so the whole-draft form is enough today.

## References

- `src/editor/ui/ProjectSettingsPanel.tsx:60`, `src/editor/projectSettingsSection.ts`, `src/editor/projectSection.ts`, `src/editor/sdk/project.ts`, `src/editor/sdk/contributions.ts:158`
- `src/plugins/audio/editor/mix/MixerPanel.tsx`, `mixerPanelModel.ts` (`MixerSection`)
- The M5 build log, wave 8 (G8a's report)
