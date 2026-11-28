// The Code panel's buffers (ADR 0030, 0308): the one owner of the files open in the Code panel and their unsaved
// text. Which files are open as tabs, which one shows, the text of each buffer with unsaved edits, and what the panel
// can hold. The discard guard asks it what is unsaved (dialogs.ts); moves and deletes tell it, as they tell asset
// documents (assetOps.ts, assetDelete.ts); and a project-wide edit asks it, as a file's owner, to rewrite unsaved text
// (`codeBufferOwner`, ADR 0302). Monaco (code/monaco.ts) is an adapter: its models hold `bufferTexts`, and the Code
// panel reports typing with `editBuffer`. No Monaco here, so it is tested without it.
import { isSceneFile } from "../projectPath";
import { signal, type ReadonlySignal } from "@preact/signals";
import { showPanel } from "../layout/store";
import { isTextAsset, isWithin, type EditorProject } from "../projects";
import { currentProject } from "../state";

// ---------------------------------------------------------------------------------------------
// What the Code panel holds

/** A text file (not a script) the Code panel edits: scenes and prefabs open in the scene view instead. */
const isCodeTextFile = (path: string) => isTextAsset(path) && !isSceneFile(path);

/**
 * Every file the Code panel can show, by project path, with its text on disk: the scripts, and
 * the project's text files (JSON, `.js`/`.mjs`/`.cjs`, `.mts`/`.cts`, `.md`, `.txt`), which are
 * edited only: tools such as `tools/*.mjs` never load as scripts. Scenes and prefabs open in the
 * scene view instead.
 */
export function codeFiles(project: EditorProject): Map<string, string> {
  const files = new Map(project.scripts);
  for (const path of project.files) {
    if (!isCodeTextFile(path)) continue;
    const text = project.textOf(path);
    if (text !== undefined) files.set(path, text);
  }
  return files;
}

/** The text on disk of one file the Code panel can show (undefined for any other file). */
export function codeFileText(project: EditorProject, path: string): string | undefined {
  return project.scripts.get(path) ?? (isCodeTextFile(path) ? project.textOf(path) : undefined);
}

/** Every file the Code panel can show with its buffer's text: the unsaved text, else the file's. What the models hold. */
export function bufferTexts(project: EditorProject): Map<string, string> {
  const files = codeFiles(project);
  if (project === currentProject.peek()) for (const [path, text] of unsaved) files.set(path, text);
  return files;
}

/** The URI of a file's model in the Code panel: the one place the scheme is written. */
export const codeFileUri = (path: string): string => `file:///project/${path}`;

/** The project path a Code panel model's URI names, or null for any other URI (the engine's declarations, packages). */
export function codeFilePath(uri: { readonly scheme: string; readonly path: string } | null | undefined): string | null {
  if (!uri || uri.scheme !== "file" || !uri.path.startsWith("/project/")) return null;
  return uri.path.slice("/project/".length);
}

// ---------------------------------------------------------------------------------------------
// Tabs

const tabs = signal<readonly string[]>([]);
const active = signal<string | null>(null);
/** Unsaved text, by path: only buffers whose text differs from the file on disk. */
const unsaved = new Map<string, string>();
const dirty = signal<ReadonlySet<string>>(new Set());
const rewrites = signal(0);

/** Files open as tabs in the Code panel, by project path, in tab order. */
export const openScripts: ReadonlySignal<readonly string[]> = tabs;
/** The tab showing, or null. */
export const activeScript: ReadonlySignal<string | null> = active;
/** Files whose buffer holds unsaved text (it differs from the file on disk). */
export const dirtyScripts: ReadonlySignal<ReadonlySet<string>> = dirty;
/** Bumped when this module changes a buffer's text itself (a rewrite, a revert, a move), not when the user types: the models follow. */
export const bufferRewrites: ReadonlySignal<number> = rewrites;

/** A place to show once its file is open in the Code panel (a type error's line, ADR 0125). The view clears it. */
export const revealAt = signal<{ path: string; line: number; column: number } | null>(null);

/** Open a file in the Code panel (as a new tab, or its existing one) and bring the panel forward; with `at`, put the cursor there. */
export function openScript(path: string, at?: { line: number; column: number }): void {
  if (!tabs.value.includes(path)) tabs.value = [...tabs.value, path];
  active.value = path;
  if (at) revealAt.value = { path, ...at };
  showPanel("code");
}

/** Show an open tab. */
export function showScript(path: string): void {
  if (tabs.value.includes(path)) active.value = path;
}

/** Close a file's tab, dropping its unsaved text (the caller asks first). The tab beside it shows next. */
export function closeScript(path: string): void {
  const at = tabs.value.indexOf(path);
  if (at < 0) return;
  const rest = tabs.value.filter((p) => p !== path);
  tabs.value = rest;
  if (active.value === path) active.value = rest[Math.min(at, rest.length - 1)] ?? null;
  if (unsaved.delete(path)) {
    updateDirty();
    rewrites.value++; // the model goes back to the file's text
  }
}

/** Close every tab, dropping all unsaved text (another project opened, or the project closed). */
export function closeAllScripts(): void {
  tabs.value = [];
  active.value = null;
  if (unsaved.size > 0) rewrites.value++;
  unsaved.clear();
  updateDirty();
}

// ---------------------------------------------------------------------------------------------
// Unsaved text

const diskText = (path: string): string | undefined => {
  const project = currentProject.peek();
  return project ? codeFileText(project, path) : undefined;
};

function updateDirty(): void {
  const now = dirty.peek();
  if (now.size === unsaved.size && [...unsaved.keys()].every((p) => now.has(p))) return;
  dirty.value = new Set(unsaved.keys());
}

/** Hold `text` as the buffer's (the view reports typing): unsaved while it differs from the file on disk. */
export function editBuffer(path: string, text: string): void {
  if (text === diskText(path)) unsaved.delete(path);
  else unsaved.set(path, text);
  updateDirty();
}

/** The buffer's text: its unsaved text, else the file's on disk. */
export function bufferText(path: string): string | undefined {
  return unsaved.get(path) ?? diskText(path);
}

/** Files at or inside these paths (files or folders) whose buffers hold unsaved text. */
export function unsavedWithin(paths: readonly string[]): string[] {
  return [...unsaved.keys()].filter((file) => paths.some((p) => isWithin(file, p.replace(/\/+$/, ""))));
}

/**
 * Write the buffer's text with `write` (the session's save), then compare again: the buffer is saved unless the user
 * typed while it was written.
 */
export async function saveBuffer(path: string, write: (path: string, text: string) => Promise<void>): Promise<void> {
  const text = bufferText(path);
  if (text === undefined) return;
  await write(path, text);
  editBuffer(path, unsaved.get(path) ?? text);
}

// ---------------------------------------------------------------------------------------------
// Moves and deletes

/** Called by moveAssets: tabs, the tab showing and unsaved text at `from`, or inside folder `from`, move to `to`. */
export function codeBuffersMoved(moves: readonly (readonly [string, string])[]): void {
  const rename = (path: string): string => {
    for (const [from, to] of moves) if (isWithin(path, from)) return to + path.slice(from.length);
    return path;
  };
  if (tabs.value.some((p) => rename(p) !== p)) tabs.value = tabs.value.map(rename);
  if (active.value) active.value = rename(active.value);
  const reveal = revealAt.peek();
  if (reveal) revealAt.value = { ...reveal, path: rename(reveal.path) };
  const moved = [...unsaved].filter(([p]) => rename(p) !== p);
  if (moved.length === 0) return;
  for (const [p] of moved) unsaved.delete(p);
  for (const [p, text] of moved) unsaved.set(rename(p), text);
  updateDirty();
  rewrites.value++;
}

/** Called by deleteAssets: tabs of files at or inside these paths close, their unsaved text dropped. */
export function codeBuffersDeleted(paths: readonly string[]): void {
  for (const path of tabs.value.filter((p) => paths.some((d) => isWithin(p, d.replace(/\/+$/, ""))))) closeScript(path);
}

// ---------------------------------------------------------------------------------------------
// The buffer as a file's owner (ADR 0302)

/** A buffer with unsaved text, as the owner a project-wide edit asks to follow its change. */
export interface CodeBufferOwner {
  /** The unsaved text. */
  readonly text: string;
  /**
   * Apply `change` (the edited JSON, or null for no change) to the unsaved text, which stays unsaved. False when it
   * doesn't change, or the text isn't valid JSON and can't be rewritten.
   */
  follow(change: (json: unknown) => unknown): boolean;
}

/** The owner of `path`'s unsaved text, or null when its buffer has none (the file's own owner writes it alone). */
export function codeBufferOwner(project: EditorProject, path: string): CodeBufferOwner | null {
  const text = project === currentProject.peek() ? unsaved.get(path) : undefined;
  if (text === undefined) return null;
  return {
    text,
    follow(change) {
      let json: unknown;
      try {
        json = JSON.parse(unsaved.get(path) ?? text);
      } catch {
        return false;
      }
      const next = change(json);
      if (next === null) return false;
      editBuffer(path, `${JSON.stringify(next, null, 2)}\n`);
      rewrites.value++;
      return true;
    },
  };
}

/**
 * Why references to `paths` can't be rewritten in the Code panel's buffers, or null: a JSON buffer whose unsaved text
 * names one of them isn't valid JSON (moves refuse then, ADR 0308).
 */
export function whyBuffersCantFollow(paths: readonly string[]): string | null {
  for (const [file, text] of unsaved) {
    if (!file.endsWith(".json") || !paths.some((p) => text.includes(p))) continue;
    try {
      JSON.parse(text);
    } catch {
      return `${file} has unsaved changes in the Code panel that aren't valid JSON, so its references can't be updated; fix, save or close it first`;
    }
  }
  return null;
}
