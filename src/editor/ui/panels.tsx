// The editor's panel registry (ADR 0025, 0083): what each dock panel renders, by `PanelId` (titles
// and the default layout are in layout/model.ts). Every panel but the Scene view is lazy: its code
// loads the first time it shows, with the shared `<PanelLoading />` placeholder until then. At
// start-up, `preloadPanels` loads the panels the saved layout shows straight away and the rest when
// the editor is idle, so switching to a tab rarely waits. The Scene view is not lazy: the session
// needs its viewport to start the engine.
//
// A plugin's panel (the `panels` registry, ADR 0133) renders its `view` through one `lazyComponent`
// per contribution object, created on first use here.
//
// Adding a built-in panel: add its id to `PanelId`/`PANELS`/`PANEL_TITLES` (and the default layout) in
// layout/model.ts (or list it in `ON_DEMAND_PANELS` there to keep it out of the default layout and the idle
// preload), and an entry here: `lazyComponent(() => import("./MyPanel").then((m) => m.MyPanel))`.
import type { ComponentChildren } from "preact";
import { isOnDemand, PANELS, type BuiltinPanelId, type Layout, type PanelId } from "../layout/model";
import { panels as panelRegistry, type PanelContribution } from "../sdk/contributions";
import { lazyComponent, whenIdle, type LazyComponent } from "./lazy";
import { ScenePanel } from "./ScenePanel";

const LAZY: Record<Exclude<BuiltinPanelId, "scene">, LazyComponent> = {
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
};

const builtin = (id: PanelId): LazyComponent | undefined => (Object.hasOwn(LAZY, id) ? LAZY[id as keyof typeof LAZY] : undefined);

// One lazy wrapper per contribution object (a re-registered panel is a new object, so a new wrapper).
const registered = new WeakMap<PanelContribution, LazyComponent>();
function lazyFor(id: PanelId): LazyComponent | undefined {
  const built = builtin(id);
  if (built) return built;
  const c = panelRegistry.get(id);
  if (!c) return undefined;
  let lazy = registered.get(c);
  if (!lazy) registered.set(c, (lazy = lazyComponent(c.view)));
  return lazy;
}

const sceneView = () => <ScenePanel />;
const render = (id: PanelId): ComponentChildren => (id === "scene" ? sceneView() : (lazyFor(id)?.() ?? null));

/**
 * What `DockLayout` renders for each panel: the built-in ones and every registered one, looked up
 * by id (a live view of the registry, so a panel registered later renders too).
 */
export const PANEL_VIEWS = new Proxy({} as Record<PanelId, () => ComponentChildren>, {
  get: (_t, id) => (typeof id === "string" ? () => render(id) : undefined),
  has: (_t, id) => typeof id === "string" && (id === "scene" || builtin(id) !== undefined || panelRegistry.get(id) !== undefined),
  ownKeys: () => [...PANELS, ...panelRegistry.list().map((p) => p.id).filter((id) => !(PANELS as readonly string[]).includes(id))],
  getOwnPropertyDescriptor: (_t, id) => (typeof id === "string" ? { enumerable: true, configurable: true, value: () => render(id) } : undefined),
});

/** The panels a layout shows: each expanded dock's front tabs. */
export function visiblePanels(layout: Layout): PanelId[] {
  return layout.docks.filter((d) => !d.collapsed).flatMap((d) => d.groups.map((g) => g.active));
}

/** Load the panels `layout` shows now, and every other panel once the editor is idle. */
export function preloadPanels(layout: Layout): Promise<void> {
  const shown = visiblePanels(layout).filter((p) => p !== "scene");
  const now = Promise.all(shown.map((p) => lazyFor(p)?.preload())).then(() => {});
  void now.then(() => whenIdle(() => {
    // On-demand panels (the Sky panel) load only when opened, not when idle.
    for (const id of Object.keys(PANEL_VIEWS)) if (id !== "scene" && !isOnDemand(id)) void lazyFor(id)?.preload();
  }));
  return now;
}

/** True once a panel's code has loaded (the Scene view always has). */
export const panelLoaded = (panel: PanelId): boolean => panel === "scene" || (lazyFor(panel)?.loaded ?? false);
