// Which plugin registered each panel type (ADR 0174), so a layout can say which plugin to turn back on
// when one of its panels is unavailable. Kept after the plugin is deactivated: the editor may still
// show its panels as unavailable, and the plugin's name and title are what the placeholder needs.
export interface PanelOwner {
  /** The plugin's name, e.g. "myco.sky". */
  readonly plugin: string;
  /** The plugin's title, e.g. "Sky". */
  readonly pluginTitle: string;
}

const owners = new Map<string, PanelOwner>();

export function setPanelOwner(panelType: string, owner: PanelOwner): void {
  owners.set(panelType, owner);
}

/** The plugin that registered `panelType` (now or earlier in this session); undefined for built-in panels. */
export function panelOwner(panelType: string): PanelOwner | undefined {
  return owners.get(panelType);
}

/** The panel types a plugin registered this session. */
export function panelsOfPlugin(plugin: string): string[] {
  return [...owners].filter(([, o]) => o.plugin === plugin).map(([type]) => type);
}
