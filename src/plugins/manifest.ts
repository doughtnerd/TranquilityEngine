// A plugin's manifest (ADR 0133). Shared by runtime and editor halves, so it lives outside both.
export interface PluginManifest {
  /** Unique, e.g. "myco.sky". */
  readonly name: string;
  readonly version: string;
  /** Shown in the Project settings' Plugins category and in messages. Falls back to `name`. */
  readonly title?: string;
  /** One sentence for the Plugins category. */
  readonly description?: string;
  /** Plugin names this one needs, with version ranges (first-party plugins: the engine's version). */
  readonly dependencies?: Readonly<Record<string, string>>;
  /**
   * Plugins this one works with when they are on, with version ranges (ADR 0374). Same shape as `dependencies`, but a
   * missing, disabled, failed or out-of-range one never blocks the plugin: it activates without it, and reads
   * `ctx.plugins.isActive(name)` to register its integration code. When one comes or goes the plugin activates again.
   */
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  /** False for a runtime half the dedicated server skips (drawing only). Default true. */
  readonly server?: boolean;
}

/** A plugin's display name: its title, or its name when it has none. */
export const pluginTitle = (manifest: Pick<PluginManifest, "name" | "title">): string => manifest.title ?? manifest.name;
