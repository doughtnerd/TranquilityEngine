// The editor's panel registry (ADR 0025, 0083): what each dock panel renders, by `PanelId` (titles
// and the default layout are in layout/model.ts). Every panel but the Scene view is lazy: its code
// loads the first time it shows, with the shared `<PanelLoading />` placeholder until then. At
// start-up, `preloadPanels` loads the panels the saved layout shows straight away and the rest when
// the editor is idle, so switching to a tab rarely waits. The Scene view is not lazy: the session
// needs its viewport to start the engine.
//
// Adding a panel: add its id to `PanelId`/`PANELS`/`PANEL_TITLES` (and the default layout) in
// layout/model.ts (or list it in `ON_DEMAND_PANELS` there to keep it out of the default layout and the idle
// preload), and an entry here: `lazyComponent(() => import("./MyPanel").then((m) => m.MyPanel))`.
import type { ComponentChildren } from "preact";
import { ON_DEMAND_PANELS, type Layout, type PanelId } from "../layout/model";
import { lazyComponent, whenIdle, type LazyComponent } from "./lazy";
import { ScenePanel } from "./ScenePanel";

const LAZY: Record<Exclude<PanelId, "scene">, LazyComponent> = {
  hierarchy: lazyComponent(() => import("./Hierarchy").then((m) => m.Hierarchy)),
  inspector: lazyComponent(() => import("./Inspector").then((m) => m.Inspector)),
  assets: lazyComponent(() => import("./Assets").then((m) => m.AssetsPanel)),
  history: lazyComponent(() => import("./HistoryPanel").then((m) => m.HistoryPanel)),
  code: lazyComponent(() => import("./CodePanel").then((m) => m.CodePanel)),
  worlds: lazyComponent(() =>
    Promise.all([import("./WorldsPanel"), import("./NavDebugPanel")]).then(([{ WorldsPanel }, { NavDebugPanel }]) => () => (
      <>
        <WorldsPanel />
        <NavDebugPanel />
      </>
    )),
  ),
  network: lazyComponent(() => import("./NetworkPanel").then((m) => m.NetworkPanel)),
  project: lazyComponent(() => import("./ProjectSettingsPanel").then((m) => m.ProjectSettingsPanel)),
  shadergraph: lazyComponent(() => import("./ShaderGraphPanel").then((m) => m.ShaderGraphPanel)),
  particlegraph: lazyComponent(() => import("./ParticleGraphPanel").then((m) => m.ParticleGraphPanel)),
  tilepalette: lazyComponent(() => import("./TilePalettePanel").then((m) => m.TilePalettePanel)),
  sky: lazyComponent(() => import("./SkyPanel").then((m) => m.SkyPanel)), // on demand (ON_DEMAND_PANELS): not in the default layout
};

/** What `DockLayout` renders for each panel. */
export const PANEL_VIEWS: Record<PanelId, () => ComponentChildren> = { scene: () => <ScenePanel />, ...LAZY };

/** The panels a layout shows: each expanded dock's front tabs. */
export function visiblePanels(layout: Layout): PanelId[] {
  return layout.docks.filter((d) => !d.collapsed).flatMap((d) => d.groups.map((g) => g.active));
}

/** Load the panels `layout` shows now, and every other panel once the editor is idle. */
export function preloadPanels(layout: Layout): Promise<void> {
  const shown = visiblePanels(layout).filter((p): p is Exclude<PanelId, "scene"> => p !== "scene");
  const now = Promise.all(shown.map((p) => LAZY[p].preload())).then(() => {});
  void now.then(() => whenIdle(() => {
    // On-demand panels (the Sky panel) load only when opened, not when idle.
    for (const [id, lazy] of Object.entries(LAZY)) if (!ON_DEMAND_PANELS.includes(id as PanelId)) void lazy.preload();
  }));
  return now;
}

/** True once a panel's code has loaded (the Scene view always has). */
export const panelLoaded = (panel: PanelId): boolean => panel === "scene" || LAZY[panel].loaded;
