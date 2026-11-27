// The Input dialog's file steps (ADR 0433): making, naming and deleting an action set or context as edits of its
// history (`InputDialogHistory`), so each is one undoable step. A set file is listed in project.json's
// `input.actionSets` (the boot defines the sets in that order): making one lists it at the end, naming a new one
// renames its entry in place, and deleting one takes its entry out, all in the same step, so Undo restores both. The
// rest of project.json keeps its layout (`withMember`).
import { ACTION_SET_EXTENSION } from "../engine/input/actionAssets";
import type { FileEdit } from "./inputDialogHistory";
import { withMember } from "./jsonMember";
import { PROJECT_FILE } from "./projectPaths";

/** The files as the dialog's edits leave them: each one's text (undefined: no such file), and the list of them. */
export interface DialogFiles {
  text(path: string): string | undefined;
  readonly files: readonly string[];
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** `<stem><ext>` in `folder`, or the first of `<stem> 2<ext>`, `<stem> 3<ext>`… that no file has. */
export function freeFilePath(files: readonly string[], folder: string, stem: string, ext: string): string {
  for (let n = 1; ; n++) {
    const path = join(folder, `${stem}${n > 1 ? ` ${n}` : ""}${ext}`);
    if (!files.includes(path)) return path;
  }
}

const isSetFile = (path: string) => path.endsWith(ACTION_SET_EXTENSION);

/** project.json's text with its `input.actionSets` passed through `change`; null when there's no project.json or nothing changed. */
function editList(files: DialogFiles, change: (list: string[]) => string[]): FileEdit | null {
  const before = files.text(PROJECT_FILE);
  if (before === undefined) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(before) as Record<string, unknown>;
  } catch {
    return null; // a broken project.json is left for Project Settings to report
  }
  const input = json.input && typeof json.input === "object" && !Array.isArray(json.input) ? (json.input as Record<string, unknown>) : {};
  const list = Array.isArray(input.actionSets) ? input.actionSets.filter((p): p is string => typeof p === "string") : [];
  const next = change(list);
  if (next.length === list.length && next.every((p, i) => p === list[i])) return null;
  return { path: PROJECT_FILE, before, after: withMember(before, "input", { ...input, actionSets: next }) };
}

/** Make `path` holding `text`; a set file is also listed at the end of `input.actionSets`. */
export function makeFileEdits(files: DialogFiles, path: string, text: string): FileEdit[] {
  const list = isSetFile(path) ? editList(files, (l) => (l.includes(path) ? l : [...l, path])) : null;
  return [{ path, before: null, after: text }, ...(list ? [list] : [])];
}

/** Delete `path`; a set file's `input.actionSets` entry goes too. Empty when there's no such file. */
export function deleteFileEdits(files: DialogFiles, path: string): FileEdit[] {
  const before = files.text(path);
  if (before === undefined) return [];
  const list = isSetFile(path) ? editList(files, (l) => l.filter((p) => p !== path)) : null;
  return [{ path, before, after: null }, ...(list ? [list] : [])];
}

/**
 * Move `from` to `to` holding `text` (a new entry named: its file takes the name); a set's `input.actionSets` entry
 * is renamed where it stands. When `to` is `from`, or another file has it, the file stays where it is with `text`.
 */
export function moveFileEdits(files: DialogFiles, from: string, to: string, text: string): FileEdit[] {
  const before = files.text(from);
  if (before === undefined) return [];
  if (to === from || files.files.includes(to)) return [{ path: from, before, after: text }];
  const list = isSetFile(from) ? editList(files, (l) => l.map((p) => (p === from ? to : p))) : null;
  return [{ path: from, before, after: null }, { path: to, before: null, after: text }, ...(list ? [list] : [])];
}
