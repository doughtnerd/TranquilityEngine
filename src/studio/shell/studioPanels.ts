// A Studio screen's panels (ADR 0341 "The shell"): each screen is a dock of panels with one fixed panel (it can't be
// closed and fills the middle). A screen's folder (`src/studio/screens/<screen>/`) lists its panels; the shell makes
// the screen's panel catalog, layout store (`myco.studio.layout.<screen>`) and dock host from the list.
import type { ComponentChildren } from "preact";
import type { PanelDock } from "../../editor/sdk/contributions";
import { panelCatalog, type PanelCatalog } from "../../editor/layout/catalog";
import type { DockHost } from "../../editor/layout/dockHost";
import { createLayoutStore, type LayoutStore } from "../../editor/layout/layoutStore";
import { defaultLayout, parseLayout, type Layout } from "../../editor/layout/model";
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

/** One side dock of a screen's default layout: its groups stacked along it (each a list of panel ids, as tabs). */
export interface DockSideArrangement {
  /** Thickness in CSS px: width of a side dock, height of the bottom one. */
  readonly size?: number;
  /** Groups, top to bottom (the bottom dock: left to right); each group's panels are tabs, the first showing. */
  readonly groups: readonly (readonly string[])[];
  /** Each group's share of the dock (default: even). */
  readonly fractions?: readonly number[];
}

/**
 * A screen's default layout (UI pass G70: the prototype stacks side panels, Samples over Outline, Inspector over Game
 * parameters…). The left and right docks run the full height and the bottom dock sits between them, under the middle.
 * Panels it leaves out start in their catalog dock, beside their neighbours; ids it names that the screen doesn't have
 * (or keeps on demand) are skipped.
 */
export interface DockArrangement {
  readonly left?: DockSideArrangement;
  readonly right?: DockSideArrangement;
  readonly bottom?: DockSideArrangement;
}

const SIDE_SIZE = { left: 240, right: 300, bottom: 190 } as const;

/** The default layout an arrangement gives for `catalog` (the plain default when it gives nothing usable). */
export function arrangedLayout(catalog: PanelCatalog, arrangement: DockArrangement): Layout {
  const usable = (id: string) => catalog.has(id) && !catalog.get(id)!.onDemand && catalog.get(id)!.dock !== "fill";
  const docks: { id: string; side: "left" | "right" | "bottom"; size: number; groups: { id: string; panels: string[]; active: string }[]; fractions: number[] }[] = [];
  for (const side of ["left", "right", "bottom"] as const) {
    const a = arrangement[side];
    if (!a) continue;
    const kept = a.groups.map((g, i) => ({ panels: g.filter(usable), share: a.fractions?.[i] ?? 1 })).filter((g) => g.panels.length > 0);
    if (kept.length === 0) continue;
    const total = kept.reduce((sum, g) => sum + g.share, 0);
    docks.push({ id: side, side, size: a.size ?? SIDE_SIZE[side], groups: kept.map((g) => ({ id: g.panels[0], panels: [...g.panels], active: g.panels[0] })), fractions: kept.map((g) => g.share / total) });
  }
  const fill = [...catalog.keys()].filter((id) => catalog.get(id)!.dock === "fill");
  if (fill.length > 0) docks.push({ id: "main", side: "left", size: 0, groups: [{ id: fill[0], panels: fill, active: fill[0] }], fractions: [1] });
  // A version-1 layout lists panel types; reading it gives each an instance and adds the panels it left out.
  return parseLayout({ version: 1, docks }, catalog) ?? defaultLayout(catalog);
}

/** A screen's catalog: its panels in order, the fixed one single and not closable, none detachable (v1). */
export function screenCatalog(panels: readonly StudioPanel[]): PanelCatalog {
  return panelCatalog(panels.map((p) => ({ id: p.id, title: p.title, dock: p.dock, onDemand: p.onDemand, single: p.fixed || undefined, closable: p.fixed ? false : undefined, detachable: false })));
}

/**
 * Make a screen's dock model (reading its saved layout). `arrangement` sets its default layout (stacked groups); a
 * layout the user saved before keeps working as it was, and Reset layout gives the default.
 */
export function screenDock(screen: ScreenId, panels: readonly StudioPanel[], arrangement?: DockArrangement): ScreenDockModel {
  const fixed = panels.filter((p) => p.fixed);
  if (fixed.length !== 1) throw new Error(`The ${screen} screen needs exactly one fixed panel (has ${fixed.length}).`);
  const catalog = screenCatalog(panels);
  const store = createLayoutStore({ key: layoutKey(screen), catalog: () => catalog, defaults: arrangement ? (c) => arrangedLayout(c, arrangement) : undefined });
  return { screen, panels: new Map(panels.map((p) => [p.id, p])), catalog, store, host: { store, reset: store.reset, foldBelow: FOLD_BELOW } };
}
