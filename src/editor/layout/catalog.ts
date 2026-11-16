// The panel catalog (ADR 0182): every panel type the editor can show, with the facts the layout model
// needs about each. It is a plain value: the layout model takes it as a parameter and never reads the
// panel registry, so its rules are tested with any catalog. The editor builds its catalog from the
// panel registry (`registeredPanels.ts`), where the built-in panels (`panels.builtin.ts`) and plugins'
// panels are registered the same way.
import type { PanelContribution, PanelDock } from "../sdk/contributions";
import type { PanelOwner } from "../sdk/panelOwners";

/** A panel type: a built-in panel's id ("scene", "hierarchy", …) or the id of a panel a plugin registered (ADR 0133). */
export type PanelId = string;

/** What the layout model knows about a panel type: a panel contribution's facts (its view aside), and its plugin. */
export type PanelFacts = Omit<PanelContribution, "id" | "view"> & {
  /** The plugin that registered it; none for a built-in panel. */
  readonly owner?: PanelOwner;
};

/** Every panel type the editor can show now, in registration order (the built-in panels first). */
export type PanelCatalog = ReadonlyMap<PanelId, PanelFacts>;

/** A catalog of `panels` (contributions, or anything with an id and the facts), in their order; `ownerOf` names each one's plugin. */
export function panelCatalog(panels: Iterable<PanelFacts & { readonly id: PanelId }>, ownerOf: (id: PanelId) => PanelOwner | undefined = () => undefined): PanelCatalog {
  const catalog = new Map<PanelId, PanelFacts>();
  for (const { id, title, beside, onDemand, single, closable, detachable, dock } of panels) {
    const owner = ownerOf(id);
    catalog.set(id, { title, beside, onDemand, single, closable, detachable, dock, ...(owner ? { owner } : {}) });
  }
  return catalog;
}

// The facts' defaults, in one place. A type the catalog doesn't hold (a plugin panel whose plugin is off)
// behaves as a plain panel: closable, detachable, any number of copies.

/** A panel type's title: the catalog's, else `info`'s (a layout's memory of an unavailable plugin panel), else the type itself. */
export const panelTitle = (catalog: PanelCatalog, type: PanelId, info?: { title: string }): string => catalog.get(type)?.title ?? info?.title ?? type;
/** The panel whose group `type` joins when it is added, if it names one. */
export const panelBeside = (catalog: PanelCatalog, type: PanelId): PanelId | undefined => catalog.get(type)?.beside;
/** Kept out of the default layout (and the idle preload) until something opens it. */
export const isOnDemand = (catalog: PanelCatalog, type: PanelId): boolean => catalog.get(type)?.onDemand === true;
/** Only one copy can be open (the Scene view). */
export const isSinglePanel = (catalog: PanelCatalog, type: PanelId): boolean => catalog.get(type)?.single === true;
/** The user can close it (every panel but the Scene view). A panel that can't be closed is always in the layout. */
export const canClosePanel = (catalog: PanelCatalog, type: PanelId): boolean => catalog.get(type)?.closable !== false;
/** It can go into a detached window (every panel but the Scene view, whose canvas belongs to the main window). */
export const canDetach = (catalog: PanelCatalog, type: PanelId): boolean => catalog.get(type)?.detachable !== false;
/** The dock of the default layout it starts in, if it names one. */
export const panelDock = (catalog: PanelCatalog, type: PanelId): PanelDock | undefined => catalog.get(type)?.dock;
