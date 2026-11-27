// The TypeScript module the Code panel's checker gets for a project JSON file, so `import x from "./a.json"` resolves
// with types. Monaco's worker reads files with unknown extensions, .json included, as TypeScript, so the JSON becomes a
// module whose default export has the types TypeScript infers from it.
import { ACTION_SET_EXTENSION } from "../../engine/input/actionAssets";

/**
 * The module source for the JSON file at `path` holding `text`. An action set file (`*.actions.json`, ADR 0433) is
 * different: a script importing it gets the defined set at run time (the code linker defines it), so its default export
 * is an `ActionSetDef` from "myco", whatever the JSON says. Invalid JSON is untyped (the loader reports it when a script
 * imports it).
 */
export function jsonModuleSource(path: string, text: string): string {
  if (path.endsWith(ACTION_SET_EXTENSION)) return 'import type { ActionSetDef } from "myco";\ndeclare const set: ActionSetDef;\nexport default set;\n';
  try {
    JSON.parse(text);
    return `const json = ${text.trim()};\nexport default json;\n`;
  } catch {
    return "declare const json: any;\nexport default json;\n";
  }
}
