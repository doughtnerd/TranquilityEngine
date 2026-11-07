# 0116. Editor themes import/export and per-project themes, display scaling, layer rename, persisted folder access, undo pruning

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0025, 0027, 0037, 0038, 0059

## Context

Several follow-ups to earlier editor records had piled up: themes could only be picked and tweaked per user (0025); the Project panel (0038) had no display scaling, renaming a layer left colliders and sprites pointing at the old name, and desktop folder access lapsed on restart; the undo tree (0027) only ever shrank by state count. The logo is art on black, so light themes showed a black banner, and fonts came only from what the machine had installed.

## Decision

**Themes (0025).**
- A theme is a JSON file, `{ "format": "myco.theme@1", name, kind, base: {bg, panel, text, accent, accent2}, danger, warning, success }` (`themeFile.ts`). Reading is lenient: unknown keys are ignored, a missing or invalid colour falls back to the built-in theme of the same kind (and is reported), a missing kind comes from the panel's luminance, a newer `@N` is read as far as it makes sense with a note. Only text that isn't a JSON object, or has no colours at all, is rejected.
- Settings > Appearance exports the theme in use (overrides applied) and imports a file. Imports are kept in the user's preferences (`customThemes`), listed after the built-in presets, and can be removed. An import named like a built-in gets " (imported)".
- **Per-project theme:** `.myco/theme.json` in the project folder, same format. While the project is open it replaces the user's theme (their own choice and overrides are untouched and return on close); a Settings checkbox lets a user keep their own theme anyway. It is a file of its own, not a `project.json` key, so the Project and Worlds panels' write queue is not involved and `.myco/` (already the editor's folder, ADR 0027) holds it. Teams who gitignore `.myco/` should un-ignore `theme.json`; read-only projects (samples) can't have one.
- **Logo:** `myco-logo-light.webp` is the same art recoloured for light backgrounds (made once from the master with a script: alpha from brightness, near-neutral pixels to dark ink, saturated glow darkened). The start screen and About dialog use it, on the panel colour instead of black, when the theme's panel luminance is above 0.4. The launcher's window bar keeps the black banner.
- **Fonts:** `@fontsource/inter` and `@fontsource/jetbrains-mono` (SIL OFL 1.1; latin subset, 400/600 and 400) are self-hosted by Vite and offered as "Inter (bundled)" and "JetBrains Mono (bundled)". The defaults stay the system fonts.

**Project settings (0038).**
- `display.scaleMode`: `"fit"` (default, aspect kept, letterboxed), `"stretch"` (fill the window) or `"pixel-perfect"` (whole multiples of the reference size; fit when the window is smaller). Applied by the game render surface through `fitCanvas`; the editor's Scene view always fills its panel. The Project panel's Display section has the dropdown; `project.json` omits the key for `fit`.
- **Layer rename:** renaming a physics layer rewrites the `layer` field of every collider component (type contains "Collider"), and renaming a sorting layer rewrites every `sortingLayer`, in all scenes and prefabs including prefab-instance overrides (`layerRename.ts`). If anything uses the layer the panel asks first, listing the files. Other files are written at once, the open scene changes as one undo step (the same pattern as moving an asset). Undoing or redoing the panel's rename edit performs the reverse rewrite, found by comparing the two drafts (one changed name in an otherwise equal list); adds, removes, reorders and duplicate names are never treated as renames. Scripts' own `layer` fields are not touched.
- **Persisted folder access (desktop):** `tauri-plugin-persisted-scope` is a dependency, registered after the fs plugin, so folders the user picks stay in the fs scope after a restart. It needs no capability entry (it exposes no commands).
- **Browser recents:** the File System Access API never reveals a folder's real path, so none can be shown. A recent entry for a browser folder shows its name, or a note the user typed (✎ on the entry, stored with the recent entry, never used for opening). Desktop entries keep real paths as before.

**History (0027).** Settings > General has "Prune history older than N days" (`historyPruneDays`, 0 = never, the default). `pruneHistoryByAge` is applied to the history file when it is loaded and each time it is saved (the in-memory tree is untouched). A state survives if it is newer than the cutoff, on the path from the root to the current state, on the path to the saved state, or an ancestor of a surviving state; so only whole old branches go and the way back to the head is never cut.

## Alternatives considered

- **Theme in `project.json`.** Travels with the project file, but needs a new section in the Project panel's model and shares its write queue; a separate `.myco/theme.json` is simpler and independent.
- **Recolouring the logo in CSS (filters or blend modes).** Fragile on the glow and cream lettering; a prepared light asset reads correctly.
- **Pruning the live stack.** Would make undo depth change under the user; pruning only the file means the open session is unchanged.
- **Rewriting layers by the component registry** (any String field with `choices: physics.layers`). More exact, but needs the registry in a pure helper; the name rule covers the engine's components.

## Consequences

**Positive:** shareable themes; a project can carry its look; light themes get a fitting logo; the desktop editor reopens recent projects without asking again; layer renames no longer break colliders; history size can be bounded.

**Negative / costs:** another asset (about 140 KB webp) and two font packages in the bundle; a custom component with "Collider" in its type name and a `layer` field would be rewritten too; undoing a layer rename rewrites files that were already saved; a browser can't show real folder paths.

## Deprecates

Nothing.

## Open questions

- The persisted-scope plugin could not be compiled where this was written (no GTK/WebKit system libraries); build with `npm run tauri:dev` once to confirm.
- Whether `historyPruneDays` should default above 0.
