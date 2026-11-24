# 0272. Runtime `project.json` sections are declared once, each with a default and a parse that gives the value and its problems

- **Status:** Accepted; amended by [0397](0397-system-ordering-loops-fail-at-definition-for-the-engine-and-are-broken-for-scripts.md) (a fixed timestep may be longer than the max frame time)
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0253, 0065, 0097, 0137, 0010, 0133, 0151

## Context

The engine reads ten top-level `project.json` keys. Each needed separate edits in `core/settings.ts` (the `ProjectSettings` type, `defaultSettings`, `resolveSettings`) and in `core/projectBoot.ts` (start-up warnings), and the warnings followed different rules:

- Graphics warned its parse problems; navigation warned only when the section was present; physics warned only bad backend ids (`physicsBackendProblems`); audio warned problems and warnings; display, time, render, name, autoload and plugins warned nothing, and `resolveSettings` passed their bad values through (a `display.width` of `-5` or a blank name reached the Engine).
- The checks for those sections lived only in the editor: the shell's `projectSettingsModel.ts` checked name, display, time, render and autoloads, and the Physics plugin's `physicsSettingsModel.ts` checked gravity, layers and the matrix, reusing only the core's backend check and `resolvePhysicsSettings`.

So the panel and the Engine disagreed about what was wrong, and a new section touched four places. ADR 0253 gave the editor one handle per key; this is its runtime twin.

## Decision

We will declare each runtime section once, in one table in `src/engine/core/settings.ts`: `RUNTIME_SETTINGS`, one `RuntimeSettingsSection` per key (`name`, `display`, `time`, `physics`, `render`, `graphics`, `navigation`, `audio`, `autoload`, `plugins`).

- **A section** has its `key`, its `default`, and `parse(written)`, which never throws and returns `{ value, problems, warnings }`. `value` is what the engine runs with: what's written over the default, with a value of the wrong type or range replaced by its default. Problems and warnings are `SettingsIssue`s (`{ field, message }`, the field dotted like the Project panel's: `"display.width"`, `"physics.layers.2"`, or the key for the lenient sections). An absent section parses to the default with nothing to say.
- **Through the table:** `defaultSettings` is `resolveSettings({})`; `resolveSettings` takes each section's `value`; `settingsIssues(project)` lists every section's problems and warnings in table order.
- **One warning rule at start-up:** `bootProject` warns every problem and warning `settingsIssues` reports, for every section, present or not.
- **The editor reuses the parses.** The shell's `settingsProblems` checks the core keys through their sections (adding only what needs the project's files: autoloads that aren't in the project), and `settingsWarnings` takes the render section's warning. The Physics plugin's handle (0253) reads with `RUNTIME_SETTINGS.physics.parse(...).value` and reports its `problems`; its own checker is gone. Navigation and audio already parsed with the engine's functions; audio keeps `audioSection`, the same parse memoised on the draft. The audio plugin reads physics layer names through the physics section too.
- **Where the declarations live.** In engine core, not in the plugins. Physics, navigation and audio have plugin editor halves, but the engine reads those sections itself (the `ProjectSettings` type, the mixer, the nav runtime, backend choice), and the engine core doesn't know plugins (0010, 0133). One table in core keeps the declaration beside the type.
- **Physics specifics.** Gravity of the wrong form is replaced; a list of layer names is kept even with a duplicate or blank (layers are named by index; both are reported); a bad backend id is dropped, so the only enabled backend is used (0137); a non-object collision matrix is dropped (every layer collides). `MAX_PHYSICS_LAYERS` (16) moves to core.
- **Not in the table:** `bootstrap`, which is checked against the system catalog when the bootstrap runs (`validateBootstrap`), and `build`, which only the exporter reads. Unknown plugin names in `plugins.disabled` stay warnings the hosts give with the known list (`pluginSettingsProblems(input, known)`).

## Alternatives considered

- **Plugins own their runtime declarations** through a contribution point: the engine would have to resolve sections it reads before plugins activate, or know plugin names; 0010 rules that out.
- **Warn only sections that are present:** absent sections never have problems, so the rule is the same and simpler stated as "every section".
- **Keep bad values and only warn:** the Engine would keep running with a width of `-5`; replacing with the default is what navigation and graphics already did.

## Consequences

**Positive**
- One rule for warnings, and the Engine warns what the Project panel shows, with the same words.
- A new runtime section is one declaration.
- Bad display, time, render, name and gravity values no longer reach the Engine.

**Negative / costs**
- The Engine now warns at start-up about display, time, render, name, autoload, plugins and the full physics checks, and about a project with no `Default` sorting layer.
- The physics messages are written for the panel ("Gravity must be two numbers…"); they read fine in the console but are less code-like than the backend message.

## Deprecates

`physicsBackendProblems`, `navigationSettingsProblems`, `resolvePhysicsSettings` (core), the Physics plugin's `physicsProblems` and `MAX_LAYERS`, and the shell's own display, time, render, name and autoload checks and their helpers. All removed.

## Open questions

- Should `bootstrap` join the table with a catalog-free form check, leaving the catalog check to the bootstrap? Not needed today.

## References

- Architecture review 2026-11-20, candidate 6.
- `src/engine/core/settings.ts`, `src/engine/core/projectBoot.ts`, `src/editor/projectSettingsModel.ts`, `src/plugins/physics/editor/physicsSettingsModel.ts`; tests `engine/tests/runtimeSettings.test.ts`, `editor/projectSettingsModel.test.ts`, `plugins/physics/editor/physicsSettingsModel.test.ts`.
