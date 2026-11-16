// What each dock panel renders, by panel type (ADR 0025, 0083, 0182). Every panel type is a panel
// contribution in the registry, the built-in ones (`panels.builtin.tsx`) and plugins' (ADR 0133) alike,
// and every one is lazy: its `view` loads the first time it shows, with the shared `<PanelLoading />`
// placeholder until then, through one `lazyComponent` per contribution object, created on first use here.
// At start-up, `preloadPanels` loads the panels the saved layout shows straight away and the rest (but
// on-demand ones) when the editor is idle, so switching to a tab rarely waits.
//
// Every panel type renders its content inside `<Panel>` (ui/panel/Panel.tsx, ADR 0174), which gives the frame and
// the instance's own view state.
import type { ComponentChildren } from "preact";
import { isOnDemand } from "../layout/catalog";
import { typeOf, type Layout, type PanelId } from "../layout/model";
import { registeredPanels } from "../layout/registeredPanels";
import { layout } from "../layout/store";
import { panels as panelRegistry, type PanelContribution } from "../sdk/contributions";
import { lazyComponent, whenIdle, type LazyComponent } from "./lazy";
import { UnavailablePanel } from "./UnavailablePanel";

// One lazy wrapper per contribution object (a re-registered panel is a new object, so a new wrapper).
const views = new WeakMap<PanelContribution, LazyComponent>();
function lazyFor(type: PanelId): LazyComponent | undefined {
  const c = panelRegistry.get(type);
  if (!c) return undefined;
  let lazy = views.get(c);
  if (!lazy) views.set(c, (lazy = lazyComponent(c.view, "framed")));
  return lazy;
}

/** What `DockLayout` renders for a panel type: its view, or `UnavailablePanel` for a type nothing registers (its plugin is off or gone, ADR 0174). */
export function panelView(type: PanelId): ComponentChildren {
  void panelRegistry.version.value; // a panel registered later renders too
  return lazyFor(type)?.() ?? <UnavailablePanel info={layout.value.panelInfo[type]} />;
}

/** The panel types a layout shows: each expanded dock's front tabs. */
export function visiblePanels(layout: Layout): PanelId[] {
  return layout.docks.filter((d) => !d.collapsed).flatMap((d) => d.groups.map((g) => typeOf(layout, g.active)));
}

/** Load the panels `layout` shows now, and every other panel but on-demand ones once the editor is idle. */
export function preloadPanels(layout: Layout): Promise<void> {
  const now = Promise.all(visiblePanels(layout).map((p) => lazyFor(p)?.preload())).then(() => {});
  void now.then(() =>
    whenIdle(() => {
      // On-demand panels (the Sky panel) load only when opened, not when idle.
      const catalog = registeredPanels();
      for (const type of catalog.keys()) if (!isOnDemand(catalog, type)) void lazyFor(type)?.preload();
    }),
  );
  return now;
}
