// The editor's panel catalog (ADR 0182): the panel registry as a `PanelCatalog` value for the layout
// model, the built-in panels and plugins' alike. Reading it reads the registry's version, so a component
// or effect that calls it follows registrations; the catalog is rebuilt only when that version changes.
import { panels } from "../sdk/contributions";
import { panelOwner } from "../sdk/panelOwners";
import { panelCatalog, type PanelCatalog } from "./catalog";

let cached: { version: number; catalog: PanelCatalog } | null = null;

/** Every panel type registered now (built-in ones first, as they register at start-up), with its plugin. */
export function registeredPanels(): PanelCatalog {
  const version = panels.version.value;
  if (cached?.version !== version) cached = { version, catalog: panelCatalog(panels.list(), panelOwner) };
  return cached.catalog;
}
