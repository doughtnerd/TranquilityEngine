// A Studio screen's panels (ADR 0341 "The shell"): each screen is a dock of panels with one fixed panel (it can't be
// closed and fills the middle). A screen's folder (`src/studio/screens/<screen>/`) lists its panels; the shell makes
// the screen's panel catalog, layout store (`myco.studio.layout.<screen>`) and dock host from the list.
import type { ComponentChildren } from "preact";
import type { PanelDock } from "../../editor/sdk/contributions";
import { panelCatalog, type PanelCatalog } from "../../editor/layout/catalog";
import type { DockHost } from "../../editor/layout/dockHost";
import { createLayoutStore, type LayoutStore } from "../../editor/layout/layoutStore";
import type { ScreenId } from "./screens";

export interface StudioPanel {
  /** Unique across the Studio, `<screen>-<name>` ("mixer-board"); also the panel element's class. */
  readonly id: string;
  readonly title: string;
  /** Where it starts. The fixed panel fills the middle ("fill"). */
  readonly dock: PanelDock;
  /** The screen's one fixed panel: it can't be closed. */
  readonly fixed?: boolean;
  /** Kept out of the default layout until added (the header menu's Add <panel>). */
  readonly onDemand?: boolean;
  /** Its content, drawn inside the dock group (wrap it in the editor's `Panel`). */
  view(): ComponentChildren;
}

/** One screen's dock: its panels, catalog, layout store and dock host. */
export interface ScreenDockModel {
  readonly screen: ScreenId;
  readonly panels: ReadonlyMap<string, StudioPanel>;
  readonly catalog: PanelCatalog;
  readonly store: LayoutStore;
  readonly host: DockHost;
}

/** ADR 0361: below this width a screen's left dock folds while both sides are open. */
export const FOLD_BELOW = 900;

/** The layout store key of a screen. */
export const layoutKey = (screen: ScreenId): string => `myco.studio.layout.${screen}`;

/** A screen's catalog: its panels in order, the fixed one single and not closable, none detachable (v1). */
export function screenCatalog(panels: readonly StudioPanel[]): PanelCatalog {
  return panelCatalog(panels.map((p) => ({ id: p.id, title: p.title, dock: p.dock, onDemand: p.onDemand, single: p.fixed || undefined, closable: p.fixed ? false : undefined, detachable: false })));
}

/** Make a screen's dock model (reading its saved layout). */
export function screenDock(screen: ScreenId, panels: readonly StudioPanel[]): ScreenDockModel {
  const fixed = panels.filter((p) => p.fixed);
  if (fixed.length !== 1) throw new Error(`The ${screen} screen needs exactly one fixed panel (has ${fixed.length}).`);
  const catalog = screenCatalog(panels);
  const store = createLayoutStore({ key: layoutKey(screen), catalog: () => catalog });
  return { screen, panels: new Map(panels.map((p) => [p.id, p])), catalog, store, host: { store, reset: store.reset, foldBelow: FOLD_BELOW } };
}
