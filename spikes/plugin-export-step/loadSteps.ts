// SPIKE: find and load the enabled plugins' export steps from what any exporting host already holds (the same Maps
// `planWebBuild` takes: no file access here). Reuses the repo's own pieces:
//   planPluginCode  (src/plugins/thirdParty.ts)   which plugins are enabled, in dependency order
//   link + MemoryTarget (src/projectCode/*)         TypeScript -> JS -> import(), the path the server and editor use
// What is NOT reused because it doesn't exist yet: plugin.json's `export` key (parsePluginManifest drops unknown keys),
// so the entry is read from the raw plugin.json here.
import { resolveScript, compileScript } from "../../src/projectCode/compile";
import { link } from "../../src/projectCode/linker";
import { MemoryTarget } from "../../src/projectCode/memoryTarget";
import { planPluginCode, type PluginCodePlan } from "../../src/plugins/thirdParty";
import { FIRST_PARTY_KEYS, FIRST_PARTY } from "../../src/plugins/catalogue";
import { exportStepOf, type ExportStep } from "./exportStep";
import { FIRST_PARTY_EXPORT_STEPS } from "./firstParty";

export interface StepSource {
  readonly json: ReadonlyMap<string, string>;
  /** `scripts/**` and `plugins/**` TypeScript by project path (what planWebBuild calls `source.scripts`). */
  readonly scripts: ReadonlyMap<string, string>;
  readonly files: readonly string[];
  readonly disabled?: readonly string[];
  /** The project's node_modules, for npm plugins (not exercised by this spike). */
  readonly packages?: Parameters<typeof planPluginCode>[0]["packages"];
}

export interface LoadedSteps {
  readonly steps: { plugin: string; step: ExportStep }[];
  readonly plan: PluginCodePlan;
  /** Problems that should stop the export, as planWebBuild's `stopOn` does. */
  readonly problems: string[];
  /** Project files the *game* build would compile that are export-only (they must be excluded from `game.json` scripts). */
  readonly exportOnlyFilesInGameCode: string[];
}

const folderOf = (where: string) => where.slice(0, -"/plugin.json".length);

/** The files `entry` imports, transitively, among `code` (the files an export entry needs, no more). */
async function closure(entry: string, code: ReadonlyMap<string, string>): Promise<Set<string>> {
  const paths = new Set(code.keys());
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const compiled = await compileScript(path, code.get(path)!, { sourceMap: false });
    if (!("code" in compiled)) continue; // reported by link
    for (const imp of compiled.imports) {
      const next = resolveScript(path, imp.specifier, paths);
      if (next) queue.push(next);
    }
  }
  return seen;
}

/**
 * Load the export steps of the enabled plugins: first-party ones from a static registry, third-party ones from their
 * `export` entry, compiled and imported by the memory target (the server's way to run a plugin half).
 * `engine` is what `import ... from "myco"` gives an export entry (a host decides; the CLI would pass the engine).
 */
export async function loadExportSteps(source: StepSource, engine: object): Promise<LoadedSteps> {
  const plan = await planPluginCode({ json: source.json, code: source.scripts, disabled: source.disabled, assets: source.files, packages: source.packages }, { editor: false });
  const problems = plan.problems.map((p) => `${p.where}: ${p.message}`);
  const steps: LoadedSteps["steps"] = [];

  // First-party: catalogue order, enabled ones only.
  for (const key of FIRST_PARTY_KEYS) {
    const name = FIRST_PARTY[key].name;
    const step = FIRST_PARTY_EXPORT_STEPS[name];
    if (step && plan.enabled.has(name)) steps.push({ plugin: name, step });
  }

  // Third-party: in dependency order (plan.loaded), those whose plugin.json names an `export` entry.
  const entries: { plugin: string; entry: string }[] = [];
  let exportCode = new Map<string, string>();
  for (const p of plan.loaded) {
    if (p.source.kind !== "project") continue; // npm plugins: entries would be `${pkg}/${export}` through extraEntries (unexercised)
    const raw = JSON.parse(source.json.get(p.where)!) as { export?: unknown };
    if (typeof raw.export !== "string") continue;
    const entry = `${folderOf(p.where)}/${raw.export.replace(/^\.\//, "")}`;
    if (!source.scripts.has(entry)) {
      problems.push(`${p.where}: its export entry ${entry} doesn't exist`);
      continue;
    }
    entries.push({ plugin: p.manifest.name, entry });
    for (const path of await closure(entry, source.scripts)) exportCode.set(path, source.scripts.get(path)!);
  }
  if (entries.length > 0) {
    const target = new MemoryTarget(engine);
    const linked = await link({ code: exportCode, json: source.json }, target);
    problems.push(...linked.problems.map((p) => `${p.path}: ${p.message}`));
    for (const { plugin, entry } of entries) {
      try {
        const step = exportStepOf(await target.scriptModule(entry));
        if (!step) throw new Error("exports no step (a default export, or `exportStep`, with a run(ctx) function)");
        steps.push({ plugin, step });
      } catch (err) {
        problems.push(`${plugin} (${entry}): ${(err as Error).message}`);
      }
    }
  }
  const exportEntries = new Set(entries.map((e) => e.entry));
  return { steps, plan, problems, exportOnlyFilesInGameCode: [...plan.code.keys()].filter((p) => exportEntries.has(p)) };
}
