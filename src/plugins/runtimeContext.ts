// Runtime halves of plugins (ADR 0135): `{ manifest, activate(context) }`. The context records every
// registration, so deactivating a plugin undoes them all, as the editor half's does (ADR 0134).
// Hosts (the player, the dedicated server, the editor) make plugins active through a plugin set
// (`pluginSet.ts`, ADR 0144), which drives this module through `runtimeActivator`, before
// `Engine.create`; `src/engine/` never imports `src/plugins/`.
import { _unregisterComponent, getComponentClass, getComponentId, getComponentOptions, registerComponent, type ComponentClass } from "../engine/core/registry";
import { _undefineBuiltinSystem, _undefineSystem, defineBuiltinSystem, defineSystem, type BuiltinSystem, type SystemDef } from "../engine/core/systems";
import { _registerWorldService, type WorldServiceDef } from "../engine/core/worldServices";
import { _registerRenderFeature, type RenderFeatureRegistration, type RenderFeatureSpec } from "../engine/render/renderFeatures";
import type { PluginManifest } from "./manifest";
import { orderPlugins } from "./order";
import type { HalfActivator } from "./pluginSet";

/** A render feature a first-party plugin contributes (ADR 0135). */
export interface RenderFeatureContribution {
  readonly spec: RenderFeatureSpec;
  /** Features of the same phase that sync first; added to `spec.after`. */
  readonly after?: readonly string[];
  /** Loads the factory that builds the feature from the renderer's shared host services (a dynamic import). */
  load: RenderFeatureRegistration["load"];
  /** Loads what warms the feature's content before the feature has loaded (ADR 0154); optional. */
  loadWarm?: RenderFeatureRegistration["loadWarm"];
}

/**
 * A contribution point another plugin owns (ADR 0133, 0137), such as the Physics plugin's backends: the
 * owner exports it from its public module, and plugins that depend on the owner contribute through
 * their context, so deactivating them removes what they added.
 */
export interface ContributionPoint<T> {
  /** Unique, e.g. `myco.physics.backend`. */
  readonly id: string;
  /** Adds `value`; returns the undo. */
  register(value: T): () => void;
}

export interface RuntimePluginContext {
  /**
   * Claim Components for the plugin. They keep their decorators (`@component`); deactivating the plugin
   * unregisters them, so scene entries for them load as missing Components (ADR 0133).
   */
  registerComponents(classes: readonly ComponentClass[]): void;
  /** Systems for the system catalog (ADR 0032); removed again when the plugin is deactivated. */
  registerSystems(defs: readonly SystemDef[]): void;
  /**
   * @internal First-party only (ADR 0133): engine systems (`run(world, dt)`, every World unless `worlds`
   * says otherwise), listed with the engine's in the catalog, such as the physics steps. Removed again on
   * deactivation.
   */
  registerEngineSystems(defs: readonly BuiltinSystem[]): void;
  /** A lazily loaded per-World subsystem (ADR 0135). */
  registerWorldService<L, I>(service: WorldServiceDef<L, I>): void;
  /** @internal First-party only (ADR 0133): a render feature, for renderers created from now on. */
  registerRenderFeature(feature: RenderFeatureContribution): void;
  /** Add `value` to a contribution point another plugin owns (a physics backend); removed again on deactivation. */
  contribute<T>(point: ContributionPoint<T>, value: T): void;
}

/** A plugin's runtime half. */
export interface RuntimePlugin {
  readonly manifest: PluginManifest;
  activate(context: RuntimePluginContext): void;
}

export interface ActivateOptions {
  /** Names of the enabled plugins (default: all). A disabled plugin's Components are unregistered, and nothing else of it registers. */
  readonly enabled?: Iterable<string>;
  /** For the dedicated server: plugins whose manifest says `server: false` are left out (as disabled). */
  readonly server?: boolean;
  /** Dependencies outside `plugins` that are already active (ADR 0139: third-party halves activated after the first-party ones). */
  readonly provided?: ReadonlySet<string>;
}

const active = new Map<string, Array<() => void>>();
/** Plugins left out by an activation, with what undoing their Components' unregistration takes. */
const disabled = new Map<string, Array<() => void>>();
/** Each claimed class's id, kept while it's unregistered so it can be registered again. */
const claimedIds = new WeakMap<ComponentClass, string>();

/** Component type id → the plugin that claims it, kept while the plugin is disabled too (for "missing (plugin X is disabled)"). */
const componentPlugins = new Map<string, string>();

/** Manifests of the runtime halves that have run (active or disabled), by name. */
const manifests = new Map<string, PluginManifest>();
export const runtimePluginManifest = (name: string): PluginManifest | undefined => manifests.get(name);

/** The name of the plugin whose runtime half claims the Component `id` (once that half has run), if any. */
export const pluginOfComponent = (id: string): string | undefined => componentPlugins.get(id);

function idOf(cls: ComponentClass, plugin: string): string {
  const id = getComponentId(cls) ?? claimedIds.get(cls);
  if (id === undefined) throw new Error(`registerComponents: ${cls.name || "a class"} isn't a registered Component (decorate it with @component).`);
  claimedIds.set(cls, id);
  componentPlugins.set(id, plugin);
  return id;
}

/** Register `cls` under `id` if it isn't; returns the undo. */
function claim(cls: ComponentClass, id: string): () => void {
  if (getComponentClass(id) !== cls) registerComponent(id, cls, getComponentOptions(cls));
  return () => {
    if (getComponentClass(id) === cls) _unregisterComponent(id);
  };
}

/** Unregister `cls` (a disabled plugin's Component); returns the undo. */
function unclaim(cls: ComponentClass, id: string): () => void {
  if (getComponentClass(id) === cls) _unregisterComponent(id);
  return () => {
    if (getComponentClass(id) === undefined) registerComponent(id, cls, getComponentOptions(cls));
  };
}

/**
 * Run a disabled plugin's runtime half against a context that only unregisters its Components (their
 * decorators registered them), so scenes load them as missing (ADR 0133). Once per plugin until it is
 * activated; nothing happens for an active plugin.
 */
export function disableRuntimePlugin(plugin: RuntimePlugin): void {
  const name = plugin.manifest.name;
  manifests.set(name, plugin.manifest);
  if (active.has(name) || disabled.has(name)) return;
  const undo: Array<() => void> = [];
  disabled.set(name, undo);
  plugin.activate({
    registerComponents: (classes) => void classes.forEach((cls) => undo.push(unclaim(cls, idOf(cls, name)))),
    registerSystems: () => {},
    registerEngineSystems: () => {},
    registerWorldService: () => {},
    registerRenderFeature: () => {},
    contribute: () => {},
  });
}

/**
 * Activate one runtime half (its dependencies must be active). Nothing happens when it already is. A
 * half that throws is rolled back and the error rethrown.
 */
export function activateRuntimePlugin(plugin: RuntimePlugin): void {
  const name = plugin.manifest.name;
  if (active.has(name)) return;
  manifests.set(name, plugin.manifest);
  for (const u of (disabled.get(name) ?? []).reverse()) u();
  disabled.delete(name);
  const undo: Array<() => void> = [];
  active.set(name, undo);
  const context: RuntimePluginContext = {
    registerComponents: (classes) => {
      for (const cls of classes) undo.push(claim(cls, idOf(cls, name)));
    },
    registerSystems: (defs) => {
      for (const def of defs) {
        defineSystem(def);
        undo.push(() => _undefineSystem(def.name));
      }
    },
    registerEngineSystems: (defs) => {
      for (const def of defs) {
        defineBuiltinSystem(def);
        undo.push(() => _undefineBuiltinSystem(def));
      }
    },
    registerWorldService: (service) => void undo.push(_registerWorldService(service)),
    registerRenderFeature: (f) => {
      const after = [...(f.spec.after ?? []), ...(f.after ?? [])];
      undo.push(_registerRenderFeature({ spec: after.length ? { ...f.spec, after } : f.spec, load: f.load, ...(f.loadWarm ? { loadWarm: f.loadWarm } : {}) }));
    },
    contribute: (point, value) => void undo.push(point.register(value)),
  };
  try {
    plugin.activate(context);
  } catch (err) {
    deactivateRuntimePlugin(name);
    throw err;
  }
}

/**
 * Activate runtime halves in dependency order (ADR 0134's `orderPlugins`). Already-active plugins are
 * skipped. A plugin that throws is rolled back and the error rethrown. Low level: hosts go through a
 * plugin set (`pluginSet.ts`, ADR 0144), which drives `runtimeActivator`.
 */
export function activateRuntimePlugins(plugins: readonly RuntimePlugin[], options: ActivateOptions = {}): void {
  const enabled = options.enabled ? new Set(options.enabled) : null;
  for (const plugin of orderPlugins(plugins, options.provided)) {
    const on = (!enabled || enabled.has(plugin.manifest.name)) && !(options.server && plugin.manifest.server === false);
    if (on) activateRuntimePlugin(plugin);
    else if (!active.has(plugin.manifest.name)) disableRuntimePlugin(plugin);
  }
}

/**
 * Undo everything a runtime half registered: its Components are unregistered (scenes load them as
 * missing), its systems leave the catalog, its World services are disposed where they run, and its
 * render features are left out of renderers created from now on.
 */
export function deactivateRuntimePlugin(name: string): void {
  const undo = active.get(name);
  if (!undo) return;
  active.delete(name);
  for (const u of undo.reverse()) u();
}

/** True once any runtime half has been activated or disabled: a host has chosen the plugin set. */
export const runtimePluginsChosen = (): boolean => active.size > 0 || disabled.size > 0;

export const isRuntimePluginActive = (name: string): boolean => active.has(name);

/** The plugin set's runtime adapter (ADR 0144): activates, disables (the stub above) and deactivates runtime halves. */
export const runtimeActivator: HalfActivator<RuntimePlugin> = {
  activate: activateRuntimePlugin,
  deactivate: deactivateRuntimePlugin,
  disable: disableRuntimePlugin,
  isActive: isRuntimePluginActive,
};
