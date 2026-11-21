# 0275. One project-plugin plan for every host, over one first-party catalogue

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0135, 0139, 0144, 0010

## Context

ADR 0139 says the editor, the exporter and the dedicated server agree on which project code loads because they share `thirdParty.ts`. They shared its steps, not its plan:

- Game builds (`export/webBuild.ts`) and the server (`server/project.ts`) called `planPluginCode` (discover, check, resolve enabled, select code, npm entries). The editor's `loadProjectCode` (`thirdPartyEditor.ts`) wrote the same pipeline out again inline, with its own catch around discovery.
- The editor checked third-party plugins against `pluginManifests()`, built from its `RUNTIME_PLUGINS` and `EDITOR_PLUGINS` lists; builds and the server checked against `FIRST_PARTY_MANIFESTS`. They agreed only while the lists did.
- The first-party plugins were listed three times: `manifests.ts` (14), `runtime.ts` (14) and `editor.ts` (11), kept in step by a test that counted the plugin folders.
- "Load a half's entry module by where the plugin came from" was written in the editor and in the server; the player built a fake discovery result (`{ source: { kind: "project", folder: "" } }`) to call `toRuntimePlugin`.

## Decision

We will have one plan and one catalogue.

- **One plan.** `planPluginCode(input, options)` in `plugins/thirdParty.ts` is the only way a host learns what of a project loads: the editor (`{ editor: true }`), game builds and the server (`{ editor: false }`, `server`). It checks against the first-party catalogue itself (no `builtIn` input), turns a discovery that throws into a plan problem, and returns everything a host needs: `found` (every valid manifest), `plugins` (the usable ones, dependency order), `loaded` (the enabled ones this host loads code for), `runtime` (those with a runtime half), `enabled`, `code`, `npmEntries`, `problems`. Discovery, checks and selection become private to `thirdParty.ts`; their tests go through the plan. The editor adds only its loading (the script loader) and its plugin-set apply (ADR 0144).
- **One first-party catalogue.** `plugins/catalogue.ts` holds `FIRST_PARTY`, one entry per first-party plugin keyed by its folder (`"physics-rapier"`), whose value is its manifest. Its order is the runtime halves' registration order (0135, 0140). `FIRST_PARTY_MANIFESTS` is its values. It imports manifests only, so the exporter and the server plan without loading plugin code.
- **Halves keyed by the catalogue.** `runtime.ts` maps every catalogue key to its runtime half (a mapped type over the keys: a missing half fails to compile) and derives `RUNTIME_PLUGINS` in catalogue order. `editor.ts` maps catalogue keys to editor halves (optional per key) and derives `EDITOR_PLUGINS` in its own order (panel and settings-category order). Editor halves stay out of runtime code: only the editor imports `editor.ts` (0133, 0010). A test checks every plugin folder has a catalogue entry and every half carries its entry's manifest.
- **Halves from a manifest and an entry.** `toRuntimePlugin(manifest, entry, module)` and the editor's `toEditorPlugin(manifest, entry, module)` take what a build's manifest also holds, not a discovery result, so the player passes its `BuiltPlugin` fields. The script loader's `loadedPluginModule(plugin, half)` loads a found plugin's half by where it came from, for the editor and the server.

## Alternatives considered

- **Catalogue entries holding both halves, the editor half as a lazy import.** One literal entry per plugin, but Vite emits a chunk for every dynamic import, so the player build would carry editor chunks, and editor boot would turn async. Rejected.
- **The runtime halves as the catalogue** (manifests read off them). Fewer tables, but the exporter in Node would load every plugin's runtime code to plan a build. Rejected.
- **Keep `builtIn` as a plan input.** Every host would pass the same list; a parameter that must always be the same value is the seam the editor drifted through. Rejected.

## Consequences

**Positive**
- The editor, builds and the server cannot disagree on which plugins load: they run the same plan against the same list. Existing plan tests now cover the editor path, plus a test that the editor and a build agree.
- Adding a first-party plugin is one catalogue entry; the compiler then asks for its runtime half.

**Negative / costs**
- The editor half order is still written in `editor.ts`, as a table keyed by catalogue entries, since panel order differs from runtime order.

## Deprecates

`plugins/manifests.ts` (moved into `catalogue.ts`), `pluginManifests()` (`editorPlugins.ts`), the inline plan in `thirdPartyEditor.ts`, the exports `discoverPlugins`, `checkPlugins`, `selectPluginCode`, `npmPluginEntries`, `runtimeHalves` (now private), `planPluginCode`'s `builtIn` input, the server's own module loading, the player's fake `FoundPlugin`, and the folder-count test. Removed.

## Open questions

None.

## References

- `src/plugins/catalogue.ts`, `thirdParty.ts`, `thirdPartyEditor.ts`, `runtime.ts`, `editor.ts`; `src/server/project.ts`; `src/export/webBuild.ts`; `src/player/main.ts`.
