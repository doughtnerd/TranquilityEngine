# 0253. A settings section handle owns one `project.json` key of the settings draft

- **Status:** Accepted, amended by 0262 (the shell's `layersOf` is gone: physics layers are a named list the Physics section declares); amended by 0272 (the physics handle reads and checks through the runtime physics section; `resolvePhysicsSettings` is gone)
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0147, 0151, 0175, 0181

## Context

Settings sections (0151) own top-level `project.json` keys, and their models edit the Project panel's draft as pure functions. Each model rebuilt the same small pieces around its key:

- **Navigation** (`navSettingsModel.ts`) had `navigationOf` (lenient parse), a private `withNavigation`, a private `setPath`, `setNavValue`, `resetNavigation`, and `newNavId`, a copy of the UUID fallback in `layout/model.ts`. The plugin's `problems` re-ran the parser in `index.ts`.
- **Physics** (`physicsSettingsModel.ts`) had a `layersOf` identical to the shell's in `projectSettingsModel.ts`. It wrote `physics` by hand in three places and through the shell's `setValue` in two more.
- **Audio** wrote `audioOf` twice (`audioSettingsModel.ts`, `mix/mixerModel.ts`), with a third variant `audioOfProject` in `audioInspectorModel.ts`.
- The project section (`projectSection.ts`) and `projectSettingsModel.ts` imported the generic undo history (`EditHistory`) and JSON member writer (`withMember`) from `worldsConfig.ts`, the Worlds panel's model.

So each key's parse, defaults and write-back were spread over several modules, and the leverage of a shared interface was lost.

## Decision

We will give each key one **settings section handle**, made by `settingsSection(spec)` in `src/editor/settingsSection.ts`. The handle is exported from `myco/editor` beside `setValue` and `SettingsDraft`.

- **The spec** has the `key` and its lenient `parse(written) → { settings, problems? }`. Two options: `edits` (`"parsed"`, the default, sets the value in the parsed section and writes the whole section back; `"written"` changes only that value in what's written, removes it for undefined, and drops objects and the section left empty, so unset values keep following the defaults) and `write` (a custom write-back: audio prunes built-in occlusion rows). An optional `problems(draft)` replaces the default, which lists each parse problem under the key.
- **The handle** has `key`, `read(values)` (a draft or a project's settings: the defaults when absent), `write(draft, settings)`, `set(draft, dottedPath, value)`, `reset(draft)` (removes the key) and `problems(draft)`. Its members are plain functions, so a contribution can pass `problems: handle.problems` and `keys: [handle.key]`.
- **The models build on it:** `navigationSettings` (parsed edits; agent-type values are `set` at `agentTypes.<i>.<path>`), `physicsSettings` (written edits, its field-level problems; `setBackend` uses it too), and `audioSettings` (in its own small module `audio/editor/audioDraft.ts`, so the mixer and the inspectors read it without loading the settings model). `navigationOf`, `setNavValue`, `resetNavigation`, the plugin's `layersOf`, `physicsSettingsProblems`, `audioOf` (both) and `audioOfProject` are gone.
- **One physics defaulting rule:** the engine's `resolvePhysicsSettings` (in `core/settings.ts`, used by `resolveSettings`). The physics handle reads through it, and so does the shell's `layersOf`, which its layer rename (0116) needs and which can't import the plugin.
- **Generic pieces leave the Worlds model:** `EditHistory` moves to `src/editor/editHistory.ts` and `withMember` to `src/editor/jsonMember.ts`, so `worldsConfig.ts` keeps only Worlds code. **One UUID helper:** `randomUuid()` in `src/engine/core/uuid.ts` serves panel instance ids and navigation ids.

`ProjectSettingsSectionContribution` is unchanged: a section still declares `keys` and `problems`. The handle is the building block a section's model and contribution use for them.

## Alternatives considered

- **Put the handle on the contribution** (`section: SettingsSection` in place of `keys`/`problems`): one key per section would no longer fit the audio section (it edits a core key and owns none) or sections that own several keys. Changing the contribution shape buys nothing the plain functions don't already give.
- **Keep the handle inside the shell, not in `myco/editor`**: the plugin halves may import only the SDK (0147), and the handle's callers are plugins.
- **One edit mode only:** parsed-only would write every physics default into `project.json` on the first edit. Written-only would lose navigation's "edit the parsed section, rejected values show as problems" behaviour.
- **Also ship the shared stylesheets (`assetInspector.css`, `bake.css`, `graph/graph.css`) through `myco/editor`** (0147's open question): an SDK import loads 10 KB of panel CSS at boot, which 0147 rejected against 0083's lazy loading. A lazy loader would apply styles after a panel's first render. Not done here; the internal-tier entries stay.

## Consequences

**Positive**
- Each key's parse, defaults, write-back, reset and problems are in one place. A new settings section gets them by naming its parser.
- `worldsConfig.ts` is Worlds code only. The undo history and the member writer have their own tests.
- Small fixes: unchecking and re-checking a physics pair with no section no longer leaves `"physics": {}` in the draft. Navigation and panel ids share one UUID fallback (crypto bytes before `Math.random`).

**Negative / costs**
- One more export in the experimental `myco/editor` surface.
- The audio plugin has a handle whose `problems` it doesn't use (the shell checks the core `audio` key itself).

## Deprecates

`navigationOf`, `setNavValue`, `resetNavigation` and `newNavId` (navigation editor); the physics plugin's `layersOf` and `physicsSettingsProblems`; `audioOf` (settings model and mixer model) and `audioOfProject`; `EditHistory` and `withMember` in `worldsConfig.ts`; `layout/model.ts`'s exported `newInstanceId` (now private, over `randomUuid`). All removed. Callers and tests moved to the handles and the new modules.

## Open questions

- Should the shell's own lenient keys (`graphics`, `audio`'s problems) use handles too? They work today; moving them is a later tidy-up.

## References

- Architecture review 2026-11-20, candidate 8b.
