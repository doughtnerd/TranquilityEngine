# 0083. Editor panels and dialogs load on first show, through one small lazy-component helper

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0025, 0059, 0082

## Context

The editor's `App.tsx` imported every dock panel and dialog statically, so their code was part of start-up whether or not they showed. Only the Shader Graph and Particle Graph panels were lazy, through a `lazyPanel` helper private to `App.tsx` (ADR 0059). Most panels sit behind tabs at launch (Assets/Code, History/Worlds/Network/Project, the graph editors), and the Export, Settings and Sprite Editor dialogs show only when asked for. Other work will keep adding panels, so the mechanism should be one documented pattern rather than a per-panel decision.

## Decision

We will load every dock panel except the Scene view, and the Export, Settings and Sprite Editor dialogs, the first time they show:

- **`src/editor/ui/lazy.tsx`.** `lazyComponent(() => import("./X").then((m) => m.X))` returns a component that renders the shared placeholder `<PanelLoading />` ("Loading…", or why it didn't load with a Try again button) until its module has loaded, then the component. It loads once; `preload()` starts the load early and never throws; `loaded` says whether it has. `lazyDialog(isOpen, load)` is the same for dialogs: nothing renders and nothing loads until `isOpen()` is first true, it shows no placeholder, and it stays mounted afterwards (the dialogs hide themselves when closed, as before). `whenIdle(task)` wraps `requestIdleCallback`.
- **`src/editor/ui/panels.tsx` is the panel registry.** `PANEL_VIEWS` maps each `PanelId` to what `DockLayout` renders: the Scene view directly (the session needs its viewport to start the engine), every other panel through `lazyComponent`. Panel ids, titles and the default layout stay in `layout/model.ts`; layout persistence (`layout/store.ts`) is unchanged, since it stores ids, not components.
- **Preloading.** At start-up `preloadPanels(layout)` loads the panels the saved layout shows (each expanded dock's front tab, `visiblePanels`) at once, and every other panel when the editor is idle, so switching tabs rarely shows the placeholder.
- **Dialog state apart from dialogs.** `exportOpen` and `settingsOpen` move to `ui/dialogState.ts` (re-exported from the dialogs' modules for existing importers), so the menu bar opens a dialog without loading it; the Sprite Editor already opened through `spriteEditorImage` in `assetImport.ts`.
- **The rule for new panels:** add the id in `layout/model.ts` and a `lazyComponent` entry in `panels.tsx`; nothing else imports the panel's module statically (it still works if something does, only without the saving).

## Alternatives considered

- **`preact/compat`'s `lazy` and `Suspense`** — pulls in the compat layer (the editor uses plain Preact) and suspends whole subtrees; a 60-line helper with a signal does what is needed.
- **Lazy only the panels hidden in the default layout** — a user's saved layout decides what shows, so a static split would load the wrong things for many layouts; loading the visible ones first covers every layout.
- **Lazy the Inspector and Hierarchy too, but without preloading** — they show at launch in the default layout, so they would flash the placeholder every start.

## Consequences

**Positive**
- Panel code no longer blocks the editor's first render; with ADR 0082's start-screen shell, the browser editor's start card shows after ~80 dev requests instead of ~310.
- One pattern and one placeholder for every panel and dialog, which later panels follow.

**Negative / costs**
- A panel that isn't preloaded yet shows "Loading…" for a moment when its tab is first chosen (mostly before the idle preload finishes).
- A panel module that something else imports statically stays in the start-up bundle (`WorldsPanel` shares field components with `ProjectSettingsPanel`; `NavDebugPanel` is used by the scene tools).
- Most of the editor's start-up code is the session and engine, not the panels, so this saves less than ADR 0082's ordering.

## Deprecates

`lazyPanel` in `ui/App.tsx` (ADR 0059), replaced by `lazyComponent`; the `PANELS` map in `App.tsx`, replaced by `PANEL_VIEWS` in `ui/panels.tsx`.

## Open questions

- Whether the rarely used, heavy panels (the graph editors) should skip the idle preload on low-memory machines.

## References

- `src/editor/ui/lazy.tsx`, `src/editor/ui/panels.tsx`, `src/editor/ui/dialogState.ts`, `src/editor/ui/App.tsx`, `src/editor/main.tsx`.
- Tests: `src/editor/lazyPanels.test.ts`.
