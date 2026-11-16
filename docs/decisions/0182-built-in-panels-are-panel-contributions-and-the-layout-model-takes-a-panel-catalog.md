# 0182. Built-in panels are panel contributions, and the layout model takes a panel catalog

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0083, 0133, 0134, 0143, 0174, 0180

## Context

A panel type's facts were split in two. Built-in panels lived in hard-coded tables: `PANELS`, `PANEL_TITLES`, `BESIDE`, `ON_DEMAND_PANELS` and `SINGLE_PANELS` in `layout/model.ts`, the default docks in `builtinDefaultDocks`, and the `LAZY` view table in `ui/panels.tsx`. Plugin panels (ADR 0134) lived in the panel registry. Six lookups in the model asked "table, else registry", and `panels.tsx` merged the two again behind a `Proxy`. The Scene view was a string checked about nine times (`canClosePanel`, `canDetach`, the default layout, three `parseLayout` repairs, the eager view, the preload, `panelLoaded`). Adding a built-in panel took four edits in two files.

The layout model is meant to be pure (its rules are unit-tested), but it read the global registry's `version` and `get`, so `model.test.ts` registered panels into the global registry and activated real plugins to test layout rules.

ADR 0143 set the precedent for this split elsewhere: the core asset kinds register through `AssetKindContribution` like plugins' kinds, and the fallback tables went.

## Decision

We will register the built-in panels at start-up as ordinary panel contributions, and give the layout model the panel catalog as a value.

- **Contributions.** `PanelContribution` (SDK, `sdk/contributions.ts`) gains three optional facts: `closable` (default true; a panel that can't be closed is always in the layout, and one missing from a saved layout goes back), `detachable` (default true; a saved layout with it in a detached window drops it there) and `dock` (`"left" | "right" | "bottom" | "fill"`: the default layout dock it starts in, after earlier panels naming the same dock). `single` also means a hand-edited layout holding two copies keeps the first. Plugins may use all of them.
- **Built-in panels.** `ui/panels.builtin.tsx` lists them (`BUILTIN_PANELS`) with `registerBuiltinPanels()`. `corePanels.ts`, the first import of `main.tsx`, calls it before the plugins (`editorBoot.ts`) and before anything loads the layout store. They are Core, not a plugin: no manifest, can't be turned off. The Scene view is `{ dock: "fill", single: true, closable: false, detachable: false }`, and its view is lazy like every other: its viewport and game view are elements the session owns (`viewportElements`), so the engine never needed the panel mounted. Adding a built-in panel is one entry. Panel type ids are unchanged.
- **Catalog.** `layout/catalog.ts` defines `PanelCatalog` (a `ReadonlyMap<PanelId, PanelFacts>` in registration order; `PanelFacts` is a contribution's facts without its view, plus its plugin `owner`), `panelCatalog(...)`, and the fact readers with their defaults in one place (`panelTitle`, `panelBeside`, `isOnDemand`, `isSinglePanel`, `canClosePanel`, `canDetach`, `panelDock`). A type the catalog doesn't hold (an unavailable plugin panel) is a plain closable, detachable panel titled from the layout's `panelInfo`.
- **Model.** Every model function that needs panel facts takes the catalog as a parameter: `defaultLayout(catalog)`, `parseLayout(value, catalog)`, `activatePanel`, `addPanel`, `closePanel`, `removePanelTypes`, `detachPanel`, `movePanelToWindow`, `closeWindow`, `withPanelInfo`, `instanceTitle`; `saved.ts` `layoutOf` and `matchesHead` pass it on. The model names no panel type and imports nothing from the registry. A panel without a `beside` neighbour goes to the first group holding a right-dock panel (the Inspector's), as before.
- **Adapter.** `layout/registeredPanels.ts` `registeredPanels()` is the registry as a catalog (rebuilt when its version changes, read reactively); the store, `savedStore`, `editorPlugins`, `DockLayout`, `detached`, the Add Panel dialog, the Plugins section and `MenuBar.tsx` pass it. `menuBar.ts` stays pure: `MenuState.panels` carries the catalog.
- **Views.** `ui/panels.tsx` keeps one lazy wrapper per contribution object; `panelView(type)` replaces the `PANEL_VIEWS` Proxy and `DockLayout` takes it as `view`.

## Alternatives considered

- **Keep a hard-coded default dock skeleton in the model** (built-ins by id, plugins by `beside`) — fewer SDK fields, but the model would still name panel types and adding a built-in panel would still touch two files.
- **A layout model object built from the catalog** (`layoutModel(catalog).addPanel(...)`) — the same seam with less argument passing, but callers would rebuild it on every registry change; a parameter is plainer and keeps the free functions.
- **Register the built-in panels inside `editorBoot.ts`'s body** — the layout store is loaded by plugin modules before that body runs, so the first read of the saved layout would see no built-in panels.

## Consequences

**Positive**
- A panel type's facts live in one place for built-in and plugin panels alike; no "scene" checks outside its contribution.
- Layout rules are tested with any catalog value, no global registry and no plugin activation.
- Plugins get the same facts the Scene view uses (a pinned, single or main-window-only panel).

**Negative / costs**
- Model call sites pass a catalog. The Scene view shows the shared loading placeholder for the first frame after the editor renders (its module is already loaded with the session, so it resolves at once).

## Deprecates

Removed: `PANELS`, `PANEL_TITLES`, `BuiltinPanelId`, `ON_DEMAND_PANELS`, `BESIDE`, `SINGLE_PANELS`, `builtinDefaultDocks`, `allPanels`, `isKnownPanel` and the registry-reading `panelTitle`/`panelBeside`/`isOnDemand`/`isSinglePanel`/`canClosePanel`/`canDetach` in `layout/model.ts`; `LAZY` and the `PANEL_VIEWS` Proxy in `ui/panels.tsx`. Amends 0083 (the Scene view is lazy too; the panel registry is the contribution registry), 0134 (panel contributions' new facts; the built-in panels are contributions) and 0174 (the Scene view's rules are its contribution's facts).

## Open questions

None.

## References

- `src/editor/layout/catalog.ts`, `src/editor/layout/registeredPanels.ts`, `src/editor/ui/panels.builtin.tsx`, `src/editor/corePanels.ts`
- Tests: `src/editor/layout/model.test.ts` ("the panel catalog's facts"), `src/editor/lazyPanels.test.ts` ("the built-in panels")
