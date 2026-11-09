// Type-checking project scripts before Play (ADR 0125). Play asks Monaco's TypeScript service, the
// one behind the Code panel's squiggles (strict, the engine's declarations, every script, JSON
// file and npm package's declarations), for each script's errors. With errors, a dialog lists
// them: clicking one opens the script at that line, Play anyway starts the game, and a checkbox
// turns the check off (Settings > General has it too).
import { codeFiles, dirtyScripts, loadMonaco, loadedMonaco, openScript } from "./code/codeState";
import type { ScriptDiagnostic } from "./code/monaco";
import { packageTypes } from "./packages";
import { checkScriptsBeforePlay } from "./preferences";
import { packageSourceFor } from "./projectPackages";
import type { EditorProject } from "./projects";
import { loadedPackageSpecifiers } from "./scriptLoader";
import { status } from "./state";
import { confirmInEditor, type ConfirmOptions, type ConfirmResult } from "./ui/ConfirmDialog";

export type { ScriptDiagnostic };

/** At most this many errors are listed in the dialog. */
const MAX_LISTED = 50;

/** The package declarations the TypeScript service was last given, by specifiers and project. */
let packageTypesKey: string | null = null;

/**
 * Give Monaco's TypeScript service the declarations of the npm packages the loaded scripts import
 * (ADR 0125), when they changed. Monaco must be loaded.
 */
export async function refreshPackageTypes(project: EditorProject): Promise<void> {
  const m = await loadMonaco();
  const specifiers = loadedPackageSpecifiers();
  const source = packageSourceFor(project);
  const key = `${project.root ?? project.name}\n${specifiers.join("\n")}`;
  if (key === packageTypesKey) return;
  packageTypesKey = key;
  if (!source || specifiers.length === 0) return m.setPackageTypes(new Map(), []);
  const { files, untyped } = await packageTypes(specifiers, source.files);
  m.setPackageTypes(files, untyped);
}

/** The Code panel's TypeScript service learns the npm packages the scripts import (ADR 0125); loads Monaco only when there are some. */
export function syncPackageTypes(project: EditorProject): void {
  if (typeof document === "undefined" || (loadedPackageSpecifiers().length === 0 && !loadedMonaco)) return;
  refreshPackageTypes(project).catch((err: unknown) => console.warn("[editor] couldn't read the npm packages' types:", err));
}

/** Forget which package declarations the TypeScript service has, so the next check reads them again (an `npm install`, say). */
export function forgetPackageTypes(): void {
  packageTypesKey = null;
}

/** The type errors of `project`'s scripts, from Monaco's TypeScript service (loaded if it isn't yet). */
async function monacoCheck(project: EditorProject): Promise<ScriptDiagnostic[]> {
  const m = await loadMonaco();
  await refreshPackageTypes(project);
  return m.checkScripts(project, codeFiles(project), dirtyScripts.value);
}

/** How a check runs and asks: the defaults use Monaco and the in-editor dialog; tests pass their own. */
export interface CheckOptions {
  check?: (project: EditorProject) => Promise<ScriptDiagnostic[]>;
  ask?: (options: ConfirmOptions) => Promise<ConfirmResult>;
}

/** One error as the dialog lists it. */
export const describeDiagnostic = (d: ScriptDiagnostic) => `${d.path}:${d.line}: ${d.message}`;

/**
 * Before Play (ADR 0125): type-check `project`'s scripts and, with errors, ask whether to play
 * anyway. True to play. Skipped (true) when the check is turned off, the project has no scripts,
 * or there's no page to check in (headless, unless `options.check` is given). A check that fails
 * to run doesn't stop Play; the status bar says so.
 */
export async function checkBeforePlay(project: EditorProject, options: CheckOptions = {}): Promise<boolean> {
  if (!checkScriptsBeforePlay.value || project.scripts.size === 0) return true;
  if (!options.check && typeof document === "undefined") return true;
  status.value = { kind: "info", text: "Checking scripts…" };
  let errors: ScriptDiagnostic[];
  try {
    errors = await (options.check ?? monacoCheck)(project);
  } catch (err) {
    console.warn("[editor] couldn't type-check the scripts before Play:", err);
    status.value = { kind: "info", text: "Couldn't type-check the scripts; playing without the check." };
    return true;
  }
  if (errors.length === 0) {
    status.value = null;
    return true;
  }
  const listed = errors.slice(0, MAX_LISTED);
  const files = new Set(errors.map((e) => e.path)).size;
  const result = await (options.ask ?? confirmInEditor)({
    title: "Scripts have type errors",
    message: `${errors.length} error${errors.length === 1 ? "" : "s"} in ${files} script${files === 1 ? "" : "s"}. Click one to open it, or play anyway.`,
    items: [...listed.map(describeDiagnostic), ...(errors.length > listed.length ? [`…and ${errors.length - listed.length} more`] : [])],
    confirmLabel: "Play anyway",
    danger: false,
    optionLabel: "Don't check before Play",
    onItem: (i) => {
      const d = listed[i];
      if (d) openScript(d.path, { line: d.line, column: d.column });
    },
  });
  if (result.option) checkScriptsBeforePlay.value = false;
  status.value = result.ok ? null : { kind: "info", text: `Didn't play: ${errors.length} type error${errors.length === 1 ? "" : "s"} in the scripts.` };
  return result.ok;
}
