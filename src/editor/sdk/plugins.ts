// Plugins (ADR 0133): a manifest plus halves that register contributions. The editor half's
// `activate` registers through the context, made from the table of contribution points (ADR 0284), which
// records the plugin with each entry and remembers every registration so deactivating the plugin removes them all.
import type { PluginManifest } from "../../plugins/manifest";
import { orderPlugins } from "../../plugins/order";
import type { PluginsView } from "../../plugins/pluginSet";
import { assetActions, assetKinds, componentHeaderActions, componentNotes, componentWireframes, fieldAdornments, fieldChoices, fieldWriteInterceptors, hierarchyCreateEntries, idlePrefetches, nameReferences, nodeAssetDrops, assetNodesAugments, importSettingsSections, spriteEditorTools, panelExtensions, panels, playStatsCounters, playStatsTables, playToolbarItems, projectSettingsSections, sceneOpenMigrations, sceneToolbarItems, skeletonBones, viewportTools } from "./contributions";
import { registerInspectorSection, type InspectorSectionOptions, type InspectorSectionProps } from "../ui/inspectorSections";
import { componentEditToggle } from "../componentEditToggle";
import type { LoadComponent } from "./contributions";
import { checkSettingsSectionKeys } from "../projectSettingsModel";
import type { ContributionOwner, Registry } from "./registry";

/**
 * One contribution point (ADR 0284): what a plugin's `register…` call does, for `owner`. Returns the functions that
 * undo it, which deactivating the plugin runs.
 */
interface ContributionPoint<F extends (...args: never[]) => void> {
  add(owner: ContributionOwner, ...args: Parameters<F>): Array<() => void>;
}

/** A point that isn't one registry's (Inspector sections are kept per Component type). */
const point = <F extends (...args: never[]) => void>(add: ContributionPoint<F>["add"]): ContributionPoint<F> => ({ add });

/**
 * A point that adds one entry to `registry`, recording its plugin there. `check` vets the entry first (and may throw);
 * `also` registers what comes with it, removed with it.
 */
function registryPoint<T extends { readonly id: string }>(registry: Registry<T>, hooks: { check?(entry: T): T; also?(entry: T, owner: ContributionOwner): (() => void) | null } = {}): ContributionPoint<(entry: T) => void> {
  return {
    add(owner, entry) {
      const e = hooks.check ? hooks.check(entry) : entry;
      const undo = [registry.register(e, owner)];
      try {
        const extra = hooks.also?.(e, owner);
        if (extra) undo.push(extra);
      } catch (err) {
        undo[0]();
        throw err;
      }
      return undo;
    },
  };
}

/**
 * Every editor contribution point, declared once (ADR 0284): the plugin context's `register…` methods are made from
 * this table, with these comments. A new point is its contribution type and registry (`contributions.ts`) and a row here.
 */
const CONTRIBUTION_POINTS = {
  /** An asset kind (ADR 0134, 0143, 0233), with its format, default folder and panel when it declares them. */
  registerAssetKind: registryPoint(assetKinds),
  registerPanel: registryPoint(panels),
  /**
   * A category of the Project settings panel (listed after the built-in ones unless `after` places it), owning
   * the `project.json` keys it declares (ADR 0151). Throws for a key the shell or another section owns.
   */
  registerProjectSettingsSection: registryPoint(projectSettingsSections, { check: checkSettingsSectionKeys }),
  /** Extra UI rendered under a built-in panel's own content (`panel`: its id). */
  registerPanelExtension: registryPoint(panelExtensions),
  /** A note after a Component's name in the Add Component menu. */
  registerComponentNote: registryPoint(componentNotes),
  /** Extra UI under a Component type's fields in the Inspector (ADR 0131), loaded on first use. */
  registerInspectorSection: point<(type: string, view: LoadComponent<InspectorSectionProps>, options?: InspectorSectionOptions) => void>((_owner, type, view, options) => [registerInspectorSection(type, view, options)]),
  /** A scene-view tool (ADR 0138), installed on every scene view while the plugin is active; with `editsComponents`, also its Edit toggle (ADR 0266). */
  registerViewportTool: registryPoint(viewportTools, { also: (t, owner) => (t.editsComponents ? componentHeaderActions.register(componentEditToggle(t), owner) : null) }),
  /** A Scene toolbar button that opens a popover (ADR 0142). */
  registerSceneToolbarItem: registryPoint(sceneToolbarItems),
  /** Controls on the Play toolbar after Pause and Step (the Subtitles plugin's overlay toggle; ADR 0416 removed the Audio plugin's record toggles). */
  registerPlayToolbarItem: registryPoint(playToolbarItems),
  /** A control in Inspector component cards' headers for some Component types (ADR 0142). */
  registerComponentHeaderAction: registryPoint(componentHeaderActions),
  /** An entry of the Hierarchy's Create menu (ADR 0146). */
  registerHierarchyCreateEntry: registryPoint(hierarchyCreateEntries),
  /** An Assets panel context-menu entry for selected files or slices (ADR 0146). */
  registerAssetAction: registryPoint(assetActions),
  /** A count on the Play Stats panel's Nodes row (ADR 0146). */
  registerPlayStatsCounter: registryPoint(playStatsCounters),
  /** A titled table under a World's rows in the Play Stats panel (T34). */
  registerPlayStatsTable: registryPoint(playStatsTables),
  /** Work done on a scene when the editor opens it (ADR 0146). */
  registerSceneOpenMigration: registryPoint(sceneOpenMigrations),
  /** Code fetched once the editor is idle (ADR 0146). */
  registerIdlePrefetch: registryPoint(idlePrefetches),
  /** Choices for a Component field that depend on its other values or on files (ADR 0152). */
  registerFieldChoices: registryPoint(fieldChoices),
  /** Fields or files of this plugin's that name entries of another section's named list (ADR 0262), renamed with them. */
  registerNameReferences: registryPoint(nameReferences),
  /** A Component's wireframe for other plugins' scene-view tools to draw (ADR 0295). */
  registerComponentWireframe: registryPoint(componentWireframes),
  /** Read-only bone rows under scene nodes in the Hierarchy, with the Inspector's bone view (ADR 0373, 0242). */
  registerSkeletonBones: registryPoint(skeletonBones),
  /** What dropping files on a node's Hierarchy row does instead of adding them under it (ADR 0373: a clip on an Animator). */
  registerNodeAssetDrop: registryPoint(nodeAssetDrops),
  /** A change to what adding files of an asset kind to a scene makes (ADR 0373: the Animation plugin's skinned models). */
  registerAssetNodesAugment: registryPoint(assetNodesAugments),
  /** A card in an asset kind's Import Settings, editing the same draft as the kind's own rows (ADR 0373: the Animation plugin's bone map and clip import settings on a model). */
  registerImportSettingsSection: registryPoint(importSettingsSections),
  /** A tab of the Sprite Editor beside Slices, its view over the image's slices and flipbooks (ADR 0373: the Animation plugin's Flipbooks and Bones). */
  registerSpriteEditorTool: registryPoint(spriteEditorTools),
  /** A control after a field's name in the scene Inspector (ADR 0373: the Animation window's key buttons). */
  registerFieldAdornment: registryPoint(fieldAdornments),
  /** Takes component field writes to scene documents instead of the document (ADR 0373: the Animation window's record mode). */
  registerFieldWriteInterceptor: registryPoint(fieldWriteInterceptors),
};

type ContextOf<P> = { [K in keyof P]: P[K] extends ContributionPoint<infer F> ? F : never };

/** What a plugin's editor half registers through: one `register…` method per contribution point (ADR 0284). */
export interface EditorPluginContext extends ContextOf<typeof CONTRIBUTION_POINTS> {
  /** The other plugins, as this one sees them (ADR 0374): `plugins.isActive(name)` is read at activation, for optional dependencies. */
  readonly plugins: PluginsView;
}

/** A plugin's editor half. */
export interface EditorPlugin {
  readonly manifest: PluginManifest;
  activate(context: EditorPluginContext): void;
}

const active = new Map<string, Array<() => void>>();

/** Activate one editor half (its dependencies must be active); nothing happens when it already is. A half that throws is rolled back and the error rethrown. */
export function activatePlugin(plugin: EditorPlugin, plugins: PluginsView = { isActive: (name) => active.has(name) }): void {
  const name = plugin.manifest.name;
  if (active.has(name)) return;
  const undo: Array<() => void> = [];
  active.set(name, undo);
  const owner: ContributionOwner = { plugin: name, pluginTitle: plugin.manifest.title ?? name };
  const context = { plugins } as unknown as Record<string, (...args: never[]) => void>;
  for (const [method, point] of Object.entries(CONTRIBUTION_POINTS) as [string, ContributionPoint<(...args: never[]) => void>][]) {
    context[method] = (...args) => void undo.push(...point.add(owner, ...args));
  }
  try {
    plugin.activate(context as unknown as EditorPluginContext);
  } catch (err) {
    deactivatePlugin(name);
    throw err;
  }
}

/**
 * Activate editor halves in dependency order; already-active plugins are skipped. `provided` names
 * dependencies outside `plugins` that are already active. Low level: the editor makes plugins active
 * through its plugin set (`plugins/editorPlugins.ts`, ADR 0144), which drives `editorActivator`.
 */
export function activatePlugins(plugins: readonly EditorPlugin[], options: { provided?: ReadonlySet<string> } = {}): void {
  for (const plugin of orderPlugins(plugins, options.provided)) activatePlugin(plugin);
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

