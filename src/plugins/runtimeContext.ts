// Runtime halves of plugins (ADR 0135): `{ manifest, activate(context) }`. The context records every
// registration, so deactivating a plugin undoes them all, as the editor half's does (ADR 0134).
// The player, the dedicated server and the editor (its own World and Play) activate the first-party
// halves (`RUNTIME_PLUGINS`) before `Engine.create`; `src/engine/` never imports `src/plugins/`.
import { _unregisterComponent, getComponentClass, getComponentId, getComponentOptions, registerComponent, type ComponentClass } from "../engine/core/registry";
import { _undefineSystem, defineSystem, type SystemDef } from "../engine/core/systems";
import { _registerWorldService, type WorldServiceDef } from "../engine/core/worldServices";
import { _registerRenderFeature, type RenderFeatureRegistration, type RenderFeatureSpec } from "../engine/render/renderFeatures";
import type { PluginManifest } from "./manifest";
import { orderPlugins } from "./order";

/** A render feature a first-party plugin contributes (ADR 0135). */
export interface RenderFeatureContribution {
  readonly spec: RenderFeatureSpec;
  /** Features of the same phase that sync first; added to `spec.after`. */
  readonly after?: readonly string[];
  /** Loads the factory that builds the feature from the renderer's shared host services (a dynamic import). */
  load: RenderFeatureRegistration["load"];
}

export interface RuntimePluginContext {
  /**
   * Claim Components for the plugin. They keep their decorators (`@component`); deactivating the plugin
   * unregisters them, so scene entries for them load as missing Components (ADR 0133).
   */
  registerComponents(classes: readonly ComponentClass[]): void;
  /** Systems for the system catalog (ADR 0032); removed again when the plugin is deactivated. */
  registerSystems(defs: readonly SystemDef[]): void;
  /** A lazily loaded per-World subsystem (ADR 0135). */
  registerWorldService<L, I>(service: WorldServiceDef<L, I>): void;
  /** @internal First-party only (ADR 0133): a render feature, for renderers created from now on. */
  registerRenderFeature(feature: RenderFeatureContribution): void;
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
}

const active = new Map<string, Array<() => void>>();
/** Plugins left out by an activation, with what undoing their Components' unregistration takes. */
const disabled = new Map<string, Array<() => void>>();
/** Each claimed class's id, kept while it's unregistered so it can be registered again. */
const claimedIds = new WeakMap<ComponentClass, string>();

function idOf(cls: ComponentClass): string {
  const id = getComponentId(cls) ?? claimedIds.get(cls);
  if (id === undefined) throw new Error(`registerComponents: ${cls.name || "a class"} isn't a registered Component (decorate it with @component).`);
  claimedIds.set(cls, id);
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
 * Activate runtime halves in dependency order (ADR 0134's `orderPlugins`). Already-active plugins are
 * skipped. A plugin that throws is rolled back and the error rethrown.
 */
export function activateRuntimePlugins(plugins: readonly RuntimePlugin[], options: ActivateOptions = {}): void {
  const enabled = options.enabled ? new Set(options.enabled) : null;
  for (const plugin of orderPlugins(plugins)) {
    const name = plugin.manifest.name;
    if (active.has(name)) continue;
    const on = (!enabled || enabled.has(name)) && !(options.server && plugin.manifest.server === false);
    if (!on) {
      if (disabled.has(name)) continue;
      // Run it against a context that only unregisters its Components (their decorators registered them).
      const undo: Array<() => void> = [];
      disabled.set(name, undo);
      plugin.activate({
        registerComponents: (classes) => void classes.forEach((cls) => undo.push(unclaim(cls, idOf(cls)))),
        registerSystems: () => {},
        registerWorldService: () => {},
        registerRenderFeature: () => {},
      });
      continue;
    }
    for (const u of (disabled.get(name) ?? []).reverse()) u();
    disabled.delete(name);
    const undo: Array<() => void> = [];
    active.set(name, undo);
    const context: RuntimePluginContext = {
      registerComponents: (classes) => {
        for (const cls of classes) undo.push(claim(cls, idOf(cls)));
      },
      registerSystems: (defs) => {
        for (const def of defs) {
          defineSystem(def);
          undo.push(() => _undefineSystem(def.name));
        }
      },
      registerWorldService: (service) => void undo.push(_registerWorldService(service)),
      registerRenderFeature: (f) => {
        const after = [...(f.spec.after ?? []), ...(f.after ?? [])];
        undo.push(_registerRenderFeature({ spec: after.length ? { ...f.spec, after } : f.spec, load: f.load }));
      },
    };
    try {
      plugin.activate(context);
    } catch (err) {
      deactivateRuntimePlugin(name);
      throw err;
    }
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

export const isRuntimePluginActive = (name: string): boolean => active.has(name);
