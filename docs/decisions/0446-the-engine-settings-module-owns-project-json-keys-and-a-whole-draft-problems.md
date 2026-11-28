# 0446. The engine's settings module says which `project.json` keys exist, who owns each, and what's wrong with a whole draft

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0272 (extended), 0151 (extended), 0041, 0344, 0433

## Context

ADR 0272 declared each runtime `project.json` section once (`RUNTIME_SETTINGS`), but the editor kept its own knowledge of the file beside it, and the copies had drifted:

- **A live bug.** `projectSettingsModel.ts` checked the core keys through a hand-kept `RUNTIME_CORE_KEYS` (7 keys) that left out `input`, so `parseInput` never ran in the editor. A bad `input.join`, a fractional `maxPlayers` or a duplicate action set saved without complaint, and `ProjectSettingsPanel.tsx` highlighted `input.actionSets.${i}` problems that nothing produced.
- **Three key lists in the editor:** `CORE_SETTINGS_KEYS` (9), `RUNTIME_CORE_KEYS` (7) and `RESERVED_KEYS`, besides `RUNTIME_SETTINGS`' own 14.
- **Restated shapes and rules:** `SettingsDraft` restated each section's fields by hand; `actionSetsOf` re-implemented `parseInput`'s filtering; the `build.identifier` and `build.version` regexes and messages were copied from `src/export/desktop.ts` into `settingsProblems`, and the icon rule a third time in `src/export/node.ts`.
- **Plugin keys were checked only if the section remembered to.** A settings section's `problems` is optional (0151), so a section that owned a runtime key (`lighting2D`, `navigation`) and omitted it left that key unchecked in the panel.

## Decision

We will make `src/engine/core/settings.ts` the one module that answers three questions about `project.json`, and shrink the editor model to draft edits plus writing text back.

- **Who owns each key.** `projectKeyOwner(key, sections?)` returns `"runtime"` (the Project panel's own categories edit it and the engine reads it: `name`, `display`, `time`, `render`, `input`, `autoload`, `graphics`, `plugins`), `"editor"` (the panel edits it, only the editor and exporter read it: `build`), `"section"` (a settings section edits it: the runtime keys `physics`, `lighting2D`, `navigation`, `languages`, `subtitles`, or any key a registered section declares) or `"reserved"` (`bootstrap`, the Worlds panel's; `audio`, `audio.json`'s per 0344). The table is typed to cover every `RuntimeSettingsKey`, so a new runtime section fails the typecheck until it is classified. `projectSettingsKeys(sections)` lists the panel's keys (its own in order, then the sections'); `sectionKeyConflict(section, sections)` gives the refusal for a section claiming a taken key.
- **What's wrong with a whole draft.** `projectSettingsIssues(draft, { sections, files, knownPlugins })` returns `{ problems, warnings }` as `SettingsIssue`s for every key the panel edits: each runtime key through `RUNTIME_SETTINGS[key].parse` (so `input` too, and a section's runtime key even when the section has no `problems`), `build` through the exporter's rules, autoloads and the icon against the project's files, the unknown-plugin warnings, and each section's own `problems`, a problem the runtime section already gave being given once.
- **Field-addressed.** Every problem carries the dotted field the panel highlights (`input.actionSets.2`, `build.version`).
- **Build rules in one place.** `src/engine/core/buildSettings.ts` holds `BuildSettings` and `buildSettingsProblems(written, files?)`. The exporter (`desktop.ts` for the identifier and version, `node.ts` for the icon's form) and the editor both use it. `settings.ts` imports it only from `projectSettingsIssues`, which the player never calls, so the player bundle drops it when tree-shaken.
- **The draft type is derived.** `ProjectSettingsDraft` maps the runtime keys to their `ProjectSettings` types (fields optional, unknown fields kept; the leniently parsed sections as plain records) plus `build` and an index signature for section keys. The editor's `SettingsDraft` and `SettingsProblem` are aliases.
- **The editor binds, it doesn't decide.** `projectSettingsModel.ts`'s `settingsKeys`, `checkSettingsSectionKeys`, `settingsProblems` and `settingsWarnings` are one-line bindings of the engine functions to the registered sections; `actionSetsOf` returns the written list entry for entry, so row `i` is the one `input.actionSets.i` is about and a bad entry stays listed to be removed.

## Alternatives considered

- **Add `"input"` to `RUNTIME_CORE_KEYS`.** Fixes the bug, keeps three lists that can drift again.
- **Keep key ownership in the editor** (`projectSettingsModel.ts`). The editor would still restate which keys the engine reads; the engine's table is where a new runtime key is declared, so its owner belongs beside it.
- **Make a section's `problems` required.** Still lets a section forget a field, and breaks third-party sections; checking runtime keys through the engine regardless covers them.
- **Put build validation in `src/export/`.** The editor would import from the exporter, whose modules pull in Node-facing code; a small engine-core module both import is lighter and tree-shakes out of the player.

## Consequences

**Positive**
- The input problems the panel was built to show now appear, and every key the panel edits is checked; tests iterate all of them.
- One place for the build rules, so the panel and the exporter can't disagree.
- A new runtime section is classified in one table and checked by the panel without editor changes.

**Negative / costs**
- The engine's settings module now knows the Project panel's split (core categories versus settings sections) by key name; it already declared the plugin-edited runtime sections (0272).
- A section that repeats the runtime section's problems relies on de-duplication by field and message.
- Exporter error messages for a bad identifier, version or icon now read `project.json's build.version "1.0": The version must look like 1.2.3.`.

## Deprecates

`CORE_SETTINGS_KEYS`, `RUNTIME_CORE_KEYS` and `RESERVED_KEYS` in `projectSettingsModel.ts` (removed); the hand-written `SettingsDraft` shape (now an alias); the copied build regexes in `projectSettingsModel.ts`, `desktop.ts` and `node.ts` (removed). `BuildSettings` moves to `engine/core/buildSettings.ts`; `desktop.ts` re-exports it.

## Open questions

- Whether a section's `problems` should be documented as "beyond the runtime section's" so the plugin sections that repeat the parse (physics, lights2d) can drop it.

## References

- `src/engine/core/settings.ts`, `src/engine/core/buildSettings.ts`, `src/editor/projectSettingsModel.ts`, `src/export/desktop.ts`, `src/export/node.ts`
- Tests: `src/engine/tests/projectSettingsKeys.test.ts`, `src/editor/projectSettingsModel.test.ts`

## As built (wave 2)

The physics and lights2d settings sections no longer declare `problems`: the Project panel gets their keys' problems from `projectSettingsIssues` through `RUNTIME_SETTINGS`, so the repeated parse is gone (their registrations pass no `problems`). Their tests assert through `projectSettingsIssues` and show a bad physics gravity and a bad lighting2D value reported exactly once. The animation section (its key is not a runtime key) keeps its own `problems`; navigation was not touched (frozen). The de-duplication by field and message in `projectSettingsIssues` stays, though nothing in-repo now relies on it: third-party sections may still repeat a runtime parse. `src/engine/core/settings.ts` is unchanged.
