// The action picker's folds (ADR 0433), per project and per user: which sets the user folded or unfolded, by id
// (true: folded). Kept in browser storage like the scene view's hidden nodes (`nodeVisibility.ts`), so they last
// across editor restarts and never reach the project's files; a set never touched follows `foldedByDefault`.
// Storage that can't be read or written (blocked, full, a private window) leaves the folds for this run only.

const memory = new Map<string, Map<string, boolean>>();

const storageKey = (project: string) => `myco.editor.inputPickerFolds:${project}`;

function read(project: string): Map<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(project));
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) return new Map(Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
  } catch {
    // unreadable: start from the defaults
  }
  return new Map();
}

/** The folds the user chose in `project` (a project folder's path, or a sample's name). */
export function pickerFolds(project: string): ReadonlyMap<string, boolean> {
  let folds = memory.get(project);
  if (!folds) memory.set(project, (folds = read(project)));
  return folds;
}

/** Remember that the user folded (true) or unfolded the set `id` in `project`. */
export function setPickerFold(project: string, id: string, folded: boolean): void {
  const folds = new Map(pickerFolds(project)).set(id, folded);
  memory.set(project, folds);
  try {
    globalThis.localStorage?.setItem(storageKey(project), JSON.stringify(Object.fromEntries(folds)));
  } catch {
    // storage blocked: the folds last until the editor closes
  }
}
