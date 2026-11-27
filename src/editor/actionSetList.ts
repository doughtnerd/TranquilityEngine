// What Project Settings › Input shows for the action sets (ADR 0433): one row per file in `input.actionSets`, in load
// order, with the id and action count the file defines (or what is wrong with it), the sets scripts define beside them,
// and the set files that could still be added.
import { ACTION_SET_EXTENSION, actionSetProblems } from "../engine/input/actionAssets";

/** One listed action set file. */
export interface ActionSetRow {
  readonly path: string;
  /** The set's id, when the file names one. */
  readonly id: string | null;
  /** How many actions it lists, when it lists them. */
  readonly actions: number | null;
  /** What is wrong with the file (it's missing, isn't JSON, or breaks the format), else null. */
  readonly problem: string | null;
}

/**
 * The row for the file at `path`. `exists` says whether the project has it; `read` gives its value as the project's
 * assets hold it (parsed JSON; may throw for a file that isn't JSON).
 */
export function actionSetRow(path: string, exists: boolean, read: () => unknown): ActionSetRow {
  if (!exists) return { path, id: null, actions: null, problem: "The file is missing." };
  let value: unknown;
  try {
    value = read();
  } catch (err) {
    return { path, id: null, actions: null, problem: `The file isn't valid JSON: ${(err as Error).message}` };
  }
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const id = record && typeof record.id === "string" ? record.id : null;
  const actions = record && Array.isArray(record.actions) ? record.actions.length : null;
  const first = actionSetProblems(value)[0];
  return { path, id, actions, problem: first ? (first.field ? `${first.field}: ${first.message}` : first.message) : null };
}

/** The sets scripts define: `all` (every defined set) without the ids a listed file defines, which the file's row stands for. */
export function codeActionSets<T extends { readonly id: string }>(all: readonly T[], rows: readonly ActionSetRow[]): T[] {
  const fromFiles = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
  return all.filter((s) => !fromFiles.has(s.id));
}

/** The action set files in `files` that aren't in `listed`, in the order given. */
export function unlistedActionSets(files: readonly string[], listed: readonly string[]): string[] {
  return files.filter((f) => f.endsWith(ACTION_SET_EXTENSION) && !listed.includes(f));
}
