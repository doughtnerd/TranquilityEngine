# 0025. Editor UI: DOM panels built with Preact

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0015, 0020, 0022

## Context

0022 left the editor UI technology open (open question O1). The editor needs dense panels: a node tree, an inspector with typed text and number inputs, an asset browser, and toolbars. These sit around the engine viewport. Game UI is in-canvas uikit (0020), but that choice was for games, which need UI that renders inside the 3D scene and works on any surface. Editor chrome needs text input, focus, scrolling, selection and accessibility, and the browser DOM already provides all of these.

The inspector and hierarchy reflect state that changes all the time (selection, field values, undo/redo). Writing that by hand with DOM calls gets messy fast.

## Decision

- Editor chrome is **DOM**, laid out around the engine canvas. The viewport stays the engine's renderer (0022).
- We use **Preact** (with `@preact/signals` for shared editor state) as the UI framework. Components are `.tsx` files under `src/editor/`.
- JSX is compiled by the same `tsc` transpile plugin as the rest of the code (`vite.shared.ts`), using `jsx: "react-jsx"` and `jsxImportSource: "preact"`.
- The layout starts **fixed**: hierarchy on the left, viewport in the centre, inspector on the right, assets along the bottom, toolbar on top. Docking comes later if it's needed.
- Preact is an editor-only dependency. It never appears in the engine (`src/engine/`) or in game bundles.

## Alternatives considered

- **In-canvas uikit, like game UI (0020).** Keeps one UI system, but text editing, scrolling lists and focus handling would all have to be rebuilt.
- **Plain DOM, no framework.** Nothing to install, but manual DOM updates for live-changing state are error-prone and verbose.
- **React.** Same model as Preact but about 10× larger. Preact keeps the editor bundle lean.
- **Solid / Svelte.** Fine choices. Solid needs its own JSX transform (not tsc's), and Svelte needs a compiler plugin. Preact works with the existing tsc pipeline.
- **A docking library (e.g. dockview, golden-layout) from day one.** Adds weight before we know which panels exist.

## Consequences

**Positive**
- Familiar React-style components with tiny runtime cost.
- Native text input, scrolling and keyboard focus for free.

**Negative / costs**
- Two UI systems in the project: DOM for the editor, uikit for games.
- `.tsx` must be supported by the transpile plugin and tsconfig.

## Deprecates

- Open question O1.

## Open questions

- ~~A docking layout and saved panel arrangements.~~ Resolved 2026-11-01: an in-house docking layout (`src/editor/layout/`), no library. Panels dock on the left, right and bottom around a fixed viewport, split evenly or as tabs, can be resized, and are saved per user with a Reset Layout action.
- Theming beyond the default dark palette.

## References

- https://preactjs.com/
- https://preactjs.com/guide/v10/signals/
