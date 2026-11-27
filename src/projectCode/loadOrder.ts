// The order a project's scripts link in (ADR 0030, 0329): each after the scripts it imports, with the
// imports that can't be satisfied reported. A pure step of the linker, in its own module.
import { isPackageSpecifier } from "../editor/packages";
import { isEditorHalfPath } from "../plugins/thirdParty";
import { EDITOR_MODULE, ENGINE_MODULE, isEngineModule, resolveScript, type CompiledScript, type ScriptProblem } from "./compile";
import { isUIRuntimeSpecifier } from "./uiModules";


/**
 * Scripts in load order: each after the scripts it imports. Scripts in an import cycle, or that
 * import a missing script, invalid JSON or a package that isn't available, are problems (and so is
 * anything that imports them); the rest still load. `json` maps the project's JSON files to
 * whether they parse; importing one isn't a dependency between scripts. `packages` maps the
 * package specifiers scripts import to why each can't load (undefined: it can), ADR 0125; without
 * it, packages aren't supported.
 */
export function loadOrder(
  scripts: ReadonlyMap<string, CompiledScript>,
  json: ReadonlyMap<string, boolean> = new Map(),
  packages?: ReadonlyMap<string, string | undefined>,
): { order: string[]; problems: ScriptProblem[]; deps: Map<string, string[]> } {
  const paths = new Set([...scripts.keys(), ...json.keys()]);
  const deps = new Map<string, string[]>();
  const problems = new Map<string, string>();
  for (const [path, s] of scripts) {
    const list: string[] = [];
    for (const imp of s.imports) {
      if (isEngineModule(imp.specifier) || isUIRuntimeSpecifier(imp.specifier)) continue;

      if (imp.specifier === EDITOR_MODULE) {
        if (!isEditorHalfPath(path)) problems.set(path, `can't import "${EDITOR_MODULE}": only a plugin's editor half (its editor/ folder) can, and it never ships in a game`);
        continue;
      }
      if (packages && isPackageSpecifier(imp.specifier)) {
        const why = packages.has(imp.specifier) ? packages.get(imp.specifier) : "it wasn't bundled";
        if (why !== undefined) problems.set(path, `can't import "${imp.specifier}": ${why}`);
        continue;
      }
      const target = resolveScript(path, imp.specifier, paths);
      if (target && isEditorHalfPath(target) && !isEditorHalfPath(path)) problems.set(path, `can't import ${target}: it is in a plugin's editor half, which only the editor loads`);
      else if (target && json.has(target)) {
        if (!json.get(target)) problems.set(path, `can't import ${target}: it isn't valid JSON`);
      } else if (target) list.push(target);
      else if (imp.specifier.startsWith(".")) problems.set(path, `can't find "${imp.specifier}"`);
      else problems.set(path, `can't import "${imp.specifier}": scripts can import "${ENGINE_MODULE}", other scripts, the project's JSON files and npm packages installed in the project folder`);
    }
    deps.set(path, [...new Set(list)]);
  }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (path: string, stack: string[]): boolean => {
    if (state.get(path) === "done") return !problems.has(path);
    if (state.get(path) === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(path)), path];
      for (const p of cycle) problems.set(p, `import cycle: ${cycle.join(" → ")}`);
      return false;
    }
    state.set(path, "visiting");
    let ok = !problems.has(path);
    for (const d of deps.get(path)!) {
      if (!visit(d, [...stack, path])) {
        ok = false;
        if (!problems.has(path)) problems.set(path, `imports ${d}, which didn't load`);
      }
    }
    state.set(path, "done");
    if (ok && !problems.has(path)) order.push(path);
    return ok && !problems.has(path);
  };
  for (const path of [...scripts.keys()].sort()) visit(path, []);
  return { order, problems: [...problems].map(([path, message]) => ({ path, message })), deps };
}
