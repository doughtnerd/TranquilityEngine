# 0427. UI preferences (reduced motion, colour scheme) are a player setting read as user-preference media features

- **Status:** Accepted (built in wave Z3 of the UI program, `docs/plans/2026-11-ui-svelte-program.md`, which the owner approved running to completion)
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0317, 0357, 0418, 0419

## Context

0419's compatibility target includes Svelte's `prefersReducedMotion` (`svelte/motion`) and `MediaQuery`, and 0418 wave 5's canvas `@media` knows only the canvas's size and orientation. On the web, `prefers-reduced-motion` and `prefers-color-scheme` come from the operating system. A game wants them too, but also wants its own options menu to change them (a game played on a TV, an accessibility menu), and a choice made there should come back next time, as graphics quality (0050) and subtitle settings (0357 §5) do. Nothing in the engine held such a preference.

Svelte's `svelte/motion` makes `prefersReducedMotion` with `new MediaQuery(...)` from `svelte/reactivity` when it's imported, which calls the global `window.matchMedia`: the page's media in a browser, and an error in Node.

## Decision

We will add **`UIPreferences`** (public, from `myco`, in `src/engine/ui/preferences.ts`): the player's UI preferences, process-wide like `Graphics` and `Subtitles`.

- `reducedMotion: boolean` and `colorScheme: "light" | "dark"`: the player's choice once set, else the system's (`window.matchMedia("(prefers-reduced-motion: reduce)")`, `"(prefers-color-scheme: dark)"`, followed live), else no reduced motion and light outside a browser. Setting `null` follows the system again; `reset()` follows it for both; `onChange(fn)` hears every change of the values, the player's or the system's. Other values are refused with a warning.
- **Persisted** in player storage (0024, 0317), namespace `settings`, key `myco.ui` (only the values the player set); a set saves at once, `reset` deletes them. The UI plugin's World service loads them before a runtime World's first scene and forgets them when that World ends (the next game in the process starts from its own storage), as the Subtitles plugin does.
- **Canvas `@media`** gains the user-preference features `prefers-reduced-motion` (`no-preference`, `reduce`) and `prefers-color-scheme` (`light`, `dark`), with their boolean forms (Media Queries level 5), read from `UIPreferences` with or without a canvas size. UI documents and hosted trees restyle when the values change.
- **Svelte:** `MediaQuery` (already the canvas's, 0418 wave 5) answers them, and Svelte's `svelte/motion` gets the same `svelte/reactivity` module for its own import, so `prefersReducedMotion` follows `UIPreferences` (Vitest's and the editor's `svelteUI()`, and a game's UI bundle, resolve that one import so).

## Alternatives considered

- **Only the system's value** — what the web does, but a game's options menu couldn't change it, and a console or TV build has no such OS setting to read.
- **A section of `project.json`** — a project default doesn't fit a per-player preference; the system's value is the right first-run default.
- **A per-World setting** — preferences belong to the player, not a World (the reasons of 0032 for `Graphics`).
- **Replacing `svelte/motion` with an engine module** — it would need Svelte's internal files by path; resolving its one `svelte/reactivity` import is smaller and keeps Svelte's module as it is.

## Consequences

**Positive**
- Games honour reduced motion and dark mode as web UI does, and an options menu changes both with one line.
- `@media (prefers-reduced-motion: reduce)` works in UI documents and Svelte components alike.

**Negative / costs**
- The engine reads `window.matchMedia` for these two queries once something asks (browser and desktop webview).
- One more key in player storage.

## Deprecates

Nothing.

## Open questions

- `prefers-contrast`, `forced-colors` and `prefers-reduced-transparency` aren't features yet.
- Whether the editor's Settings should let a developer preview the preferences without changing the OS (Play reads the system's today).

## References

- Media Queries level 5, user preference media features.
- `src/engine/ui/preferences.ts`, `src/engine/ui/document/mediaQuery.ts`, `src/plugins/ui/runtime/uiViewPreferences.test.ts`.
