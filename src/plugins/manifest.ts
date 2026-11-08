// A plugin's manifest (ADR 0133). Shared by runtime and editor halves, so it lives outside both.
export interface PluginManifest {
  /** Unique, e.g. "myco.sky". */
  readonly name: string;
  readonly version: string;
  /** Plugin names this one needs, with version ranges (first-party plugins: the engine's version). */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** False for a runtime half the dedicated server skips (drawing only). Default true. */
  readonly server?: boolean;
}
