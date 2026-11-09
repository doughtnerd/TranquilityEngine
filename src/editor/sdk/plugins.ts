// Plugins (ADR 0133): a manifest plus halves that register contributions. The editor half's
// `activate` registers through the context, which remembers every registration so deactivating the
// plugin removes them all.
import type { PluginManifest } from "../../plugins/manifest";
import { orderPlugins } from "../../plugins/order";
import { assetActions, assetFormats, assetKinds, componentHeaderActions, hierarchyCreateEntries, idlePrefetches, playStatsCounters, sceneOpenMigrations, type AssetActionContribution, type HierarchyCreateContribution, type IdlePrefetchContribution, type PlayStatsCounterContribution, type SceneOpenMigrationContribution, componentNotes, panelExtensions, panels, projectSettingsSections, sceneToolbarItems, viewportTools, type AssetFormatContribution, type ComponentHeaderActionContribution, type SceneToolbarItemContribution, type ComponentNoteContribution, type AssetKindContribution, type PanelContribution, type PanelExtensionContribution, type ProjectSettingsSectionContribution, type ViewportToolContribution } from "./contributions";
import { registerInspectorSection, type InspectorSectionOptions, type InspectorSectionProps } from "../ui/inspectorSections";
import type { LoadComponent } from "./contributions";


export interface EditorPluginContext {
  registerAssetKind(kind: AssetKindContribution): void;
  registerAssetFormat<T>(format: AssetFormatContribution<T>): void;
  registerPanel(panel: PanelContribution): void;
  /** A category of the Project settings panel (listed after the built-in ones unless `after` places it). */
  registerProjectSettingsSection(section: ProjectSettingsSectionContribution): void;
  /** Extra UI rendered under a built-in panel's own content (`panel`: its id). */
  registerPanelExtension(extension: PanelExtensionContribution): void;
  /** A note after a Component's name in the Add Component menu. */
  registerComponentNote(note: ComponentNoteContribution): void;
  /** Extra UI under a Component type's fields in the Inspector (ADR 0131), loaded on first use. */
  registerInspectorSection(type: string, view: LoadComponent<InspectorSectionProps>, options?: InspectorSectionOptions): void;
  /** A scene-view tool (ADR 0138), installed on every scene view while the plugin is active. */
  registerViewportTool(tool: ViewportToolContribution): void;
  /** A Scene toolbar button that opens a popover (ADR 0142). */
  registerSceneToolbarItem(item: SceneToolbarItemContribution): void;
  /** A control in Inspector component cards' headers for some Component types (ADR 0142). */
  registerComponentHeaderAction(action: ComponentHeaderActionContribution): void;
  /** An entry of the Hierarchy's Create menu (ADR 0144). */
  registerHierarchyCreateEntry(entry: HierarchyCreateContribution): void;
  /** An Assets panel context-menu entry for selected files or slices (ADR 0144). */
  registerAssetAction(action: AssetActionContribution): void;
  /** A count on the Play Stats panel's Nodes row (ADR 0144). */
  registerPlayStatsCounter(counter: PlayStatsCounterContribution): void;
  /** Work done on a scene when the editor opens it (ADR 0144). */
  registerSceneOpenMigration(migration: SceneOpenMigrationContribution): void;
  /** Code fetched once the editor is idle (ADR 0144). */
  registerIdlePrefetch(prefetch: IdlePrefetchContribution): void;
}

/** A plugin's editor half. */
export interface EditorPlugin {
  readonly manifest: PluginManifest;
  activate(context: EditorPluginContext): void;
}

const active = new Map<string, Array<() => void>>();

/**
 * Activate editor halves in dependency order; already-active plugins are skipped. `provided` names
 * dependencies outside `plugins` that are already active (ADR 0139: a third-party half needing a
 * first-party plugin).
 */
export function activatePlugins(plugins: readonly EditorPlugin[], options: { provided?: ReadonlySet<string> } = {}): void {
  for (const plugin of orderPlugins(plugins, options.provided)) {
    const name = plugin.manifest.name;
    if (active.has(name)) continue;
    const undo: Array<() => void> = [];
    active.set(name, undo);
    const context: EditorPluginContext = {
      registerAssetKind: (k) => void undo.push(assetKinds.register(k)),
      registerAssetFormat: (f) => void undo.push(assetFormats.register(f)),
      registerPanel: (p) => void undo.push(panels.register(p)),
      registerProjectSettingsSection: (section) => void undo.push(projectSettingsSections.register(section)),
      registerPanelExtension: (extension) => void undo.push(panelExtensions.register(extension)),
      registerComponentNote: (n) => void undo.push(componentNotes.register(n)),
      registerInspectorSection: (type, view, options) => void undo.push(registerInspectorSection(type, view, options)),
      registerViewportTool: (t) => void undo.push(viewportTools.register(t)),
      registerSceneToolbarItem: (item) => void undo.push(sceneToolbarItems.register(item)),
      registerComponentHeaderAction: (action) => void undo.push(componentHeaderActions.register(action)),
      registerHierarchyCreateEntry: (entry) => void undo.push(hierarchyCreateEntries.register(entry)),
      registerAssetAction: (action) => void undo.push(assetActions.register(action)),
      registerPlayStatsCounter: (counter) => void undo.push(playStatsCounters.register(counter)),
      registerSceneOpenMigration: (migration) => void undo.push(sceneOpenMigrations.register(migration)),
      registerIdlePrefetch: (prefetch) => void undo.push(idlePrefetches.register(prefetch)),
    };
    try {
      plugin.activate(context);
    } catch (err) {
      deactivatePlugin(name);
      throw err;
    }
  }
}

/** Remove everything a plugin registered. */
export function deactivatePlugin(name: string): void {
  const undo = active.get(name);
  if (!undo) return;
  active.delete(name);
  for (const u of undo.reverse()) u();
}

export const isPluginActive = (name: string): boolean => active.has(name);

export type { PluginManifest };
export { orderPlugins };
