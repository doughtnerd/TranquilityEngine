// SPIKE: the contract of a plugin's export step (ADR 0452 "Build steps from plugins"). Pure TypeScript: no node:*,
// no DOM, no engine import, so the same module runs in the CLI (Node) and in the editor page (browser / Tauri webview).
// Third-party plugins would import these types from "myco" (type-only imports are erased, so they cost nothing at run time).

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One Export option a step declares: the Export dialog and the CLI both render/parse these. */
export interface ExportOptionDecl {
  readonly key: string;
  readonly label: string;
  readonly type: "boolean" | "string" | "number";
  readonly default: boolean | string | number;
  /** Only debug builds have this option (ADR 0452 "Debug build"). */
  readonly debugOnly?: boolean;
}

/** What a step may read: the project, never the host's file system. `read` is the host's FileSource (Node fs, or the editor's FileSystem). */
export interface ExportStepContext {
  readonly plugin: string;
  /** The step's options, defaults filled in, debug-only ones left out of a release build. */
  readonly options: Readonly<Record<string, boolean | string | number>>;
  readonly debug: boolean;
  readonly platform: "web" | "desktop";
  readonly project: {
    readonly settings: Readonly<Record<string, unknown>>;
    /** Every project file, project-relative. */
    readonly files: readonly string[];
    readonly json: ReadonlyMap<string, string>;
    read(path: string): Promise<string | Uint8Array>;
  };
  log(line: string): void;
}

export interface ExportStepResult {
  /** Stored in game.json under this plugin's name; the plugin's launch step reads it back. JSON only. */
  readonly manifest?: JsonValue;
  /** Files to write, relative to the plugin's own folder in the build (`plugins/<name>/`); the host prefixes and checks the path. */
  readonly files?: ReadonlyMap<string, string | Uint8Array>;
  readonly warnings?: readonly string[];
}

export interface ExportStep {
  readonly options?: readonly ExportOptionDecl[];
  run(ctx: ExportStepContext): Promise<ExportStepResult> | ExportStepResult;
}

/** A step's module export, as `activateOf` finds `activate`: the named `exportStep`, or a default export. */
export function exportStepOf(module: Record<string, unknown>): ExportStep | undefined {
  const own = module.exportStep ?? module.default;
  return typeof own === "object" && own !== null && typeof (own as ExportStep).run === "function" ? (own as ExportStep) : undefined;
}

/** What the host gets back: slices for game.json and files for the build, namespaced so plugins can't collide or escape. */
export interface ExportStepsResult {
  readonly slices: Readonly<Record<string, JsonValue>>;
  readonly files: ReadonlyMap<string, string | Uint8Array>;
  readonly warnings: readonly string[];
}

export interface RunStepsInput {
  /** Enabled plugins' steps in dependency/catalogue order. */
  readonly steps: ReadonlyArray<{ readonly plugin: string; readonly step: ExportStep }>;
  /** Option values by plugin name (the dialog's or the CLI's `--plugin-option name.key=value`). */
  readonly values?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly debug: boolean;
  readonly platform: "web" | "desktop";
  readonly project: ExportStepContext["project"];
  readonly log?: (line: string) => void;
}

const SAFE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\\:]+$/;

/** Run each step (in order, one at a time), validating what it returns. A step that throws stops the export with its plugin's name. */
export async function runExportSteps(input: RunStepsInput): Promise<ExportStepsResult> {
  const slices: Record<string, JsonValue> = {};
  const files = new Map<string, string | Uint8Array>();
  const warnings: string[] = [];
  for (const { plugin, step } of input.steps) {
    const given = input.values?.[plugin] ?? {};
    const options: Record<string, boolean | string | number> = {};
    for (const decl of step.options ?? []) {
      if (decl.debugOnly && !input.debug) continue;
      const v = given[decl.key] ?? decl.default;
      if (typeof v !== typeof decl.default) throw new Error(`${plugin}: option "${decl.key}" must be a ${decl.type}`);
      options[decl.key] = v as boolean | string | number;
    }
    let result: ExportStepResult;
    try {
      result = await step.run({ plugin, options, debug: input.debug, platform: input.platform, project: input.project, log: (l) => input.log?.(`[${plugin}] ${l}`) });
    } catch (err) {
      throw new Error(`The export step of ${plugin} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result.manifest !== undefined) slices[plugin] = JSON.parse(JSON.stringify(result.manifest)) as JsonValue; // proves it is JSON
    for (const [path, contents] of result.files ?? []) {
      if (!SAFE.test(path)) throw new Error(`${plugin}: export file path "${path}" must be relative and stay inside the plugin's folder`);
      const out = `plugins/${plugin}/${path}`;
      if (files.has(out)) throw new Error(`${plugin}: wrote ${out} twice`);
      files.set(out, contents);
    }
    warnings.push(...(result.warnings ?? []).map((w) => `${plugin}: ${w}`));
  }
  return { slices, files, warnings };
}
