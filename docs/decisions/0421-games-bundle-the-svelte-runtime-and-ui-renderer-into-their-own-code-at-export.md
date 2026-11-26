# 0421. Games bundle the Svelte runtime and UI renderer into their own code at export, tree-shaken

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0041, 0419

## Context

0419 predicted a Svelte-only game would load about 30 KB gzip of UI code: the Svelte runtime plus our renderer, instead of the 40.9 KB markup and CSS parsers.

Wave A part 2 measured 58.9 KB:

| Part | gzip |
|---|---:|
| Svelte runtime | 45.8 KB |
| Renderer | 4.4 KB |
| Cascade and selector reader | 8.7 KB |
| Rule data | 0.7 KB |

The cause is the prebuilt player (`dist/player/`, 0041). It carries fixed-name entries for Svelte's whole internal client (`svelte/internal/client.js`, `svelte/myco-ui-renderer.js`) so every game's compiled components can import them. Nothing in them can be tree-shaken per game. Tree-shaken for one small HUD, the runtime is 18.5 KB, about 32 KB in all.

The prebuilt player can't know which Svelte features a game uses; only the game's own build does.

## Decision

**At export, a game's compiled Svelte code is bundled together with the parts of the Svelte runtime and the engine's UI renderer it uses, into the game's own code bundle, and tree-shaken there. The player carries no Svelte.**

- **One bundle and one Svelte instance per game.** The export step's code bundler (the one that bundles a game's scripts today) also takes the compiled components and `.svelte.ts` modules. Their imports of `svelte/internal/client`, other `svelte/*` modules and the renderer resolve to the packages, bundled once per game. That gives one Svelte instance per game, which Svelte requires.
- **`UIView` mounts through the game's bundle.** The bundle exports, for each component, a small mount function made with the bundled Svelte (`mount`/`unmount` plus the renderer). `UIView` in the player calls it with the host and props, and never imports Svelte itself. The player's fixed-name Svelte entries (`uiRuntimeEntries()`) are removed.
- **The editor is unchanged.** Play keeps the shared, un-shaken runtime from 0419 wave A part 2, so hot reload stays fast and every component shares one instance.
- **The cascade and selector reader stay engine code**, loaded on demand by `UIView` and UI documents. They're shared with UI documents until 0419 wave D, then only by `UIView`.
- **Measured and gated.** The export of a small Svelte HUD test project reports its UI code size, with a tripwire at the measured size plus 20% in the export tests. The figure is recorded in implementation-status.

## Alternatives considered

- **Keep the prebuilt runtime** (wave A part 2 as built). Simplest, but every Svelte game pays about 46 KB for the whole runtime, whatever it uses.
- **Several prebuilt runtime tiers** (small, full). They guess at feature sets, and still ship code a given game doesn't use.

## Consequences

**Positive**
- Svelte games load only the runtime they use: about 32 KB gzip of UI code for a small HUD, near 0419's estimate.
- The player gets smaller, and games without Svelte UI carry none of it.

**Negative / costs**
- The editor (shared runtime) and the export (bundled runtime) differ. The export tests mount exported components in the player layout to keep them honest.
- Every game build bundles and tree-shakes Svelte, which adds a little export time.

## Deprecates

- The player's fixed-name Svelte entries (`uiRuntimeEntries()` in `vite.shared.ts`) and the player importing Svelte: removed.

## Open questions

- Whether the dedicated server should link UI code at all; today it doesn't.

## References

- 0419 (wave A part 2's sizes, in implementation-status), 0041 (game builds), `vite.shared.ts`, `src/projectCode/compileUI.ts`, `src/export/`
