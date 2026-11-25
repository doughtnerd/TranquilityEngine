// Where the Studio keeps takes when no project is open (ADR 0408): one folder, by default `<app data>/recordings` (ADR 0409), which the
// user can change with a folder dialog; and the take files added to the Recorded takes list by dropping them on the
// launcher. Both are per user preferences (localStorage, shared by the launcher's and the Studio's windows). Light: the
// launcher imports it, so it loads no engine code.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { isTauri, type FileSystem } from "../engine/platform/FileSystem";
import { persisted } from "../editor/preferences";
import { TAKE_SUFFIX } from "../engine/audio/take/types";

/** The folder the user chose for takes, or null for the default. */
export const takesFolderChoice = persisted<string | null>("myco.studio.takesFolder", null);

/** Take files added to Recorded takes from outside the takes folder and projects (absolute paths, newest first). */
export const addedTakes = persisted<string[]>("myco.studio.addedTakes", []);

const appTakes = signal<string | null>(null);
let appTakesAsked = false;

/** The default takes folder: `<app data>/recordings` in the desktop app; null in a browser (there's no folder to use). */
export async function defaultTakesFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  if (appTakes.peek() !== null) return appTakes.peek();
  const { appDataDir } = await import("@tauri-apps/api/path");
  const base = (await appDataDir()).replace(/[\\/]+$/, "");
  appTakes.value = `${base}${base.includes("\\") ? "\\" : "/"}recordings`;
  return appTakes.peek();
}

/**
 * The takes folder in use: the user's choice, else the default (null until the default is known, and in a browser).
 * Reading it asks for the default once.
 */
export const takesFolder: ReadonlySignal<string | null> = computed(() => {
  if (!appTakesAsked) {
    appTakesAsked = true;
    void defaultTakesFolder().catch((err) => console.warn("[studio] couldn't find the app data folder for takes:", err));
  }
  return takesFolderChoice.value ?? appTakes.value;
});

/** True when the takes folder is the default one. */
export const takesFolderIsDefault: ReadonlySignal<boolean> = computed(() => takesFolderChoice.value === null);

/** Change…: the folder dialog, starting at the current folder; the choice is kept (cancel keeps the current one). */
export async function chooseTakesFolder(fs: FileSystem): Promise<string | null> {
  const picked = await fs.pickFolder("Folder for recorded takes", takesFolder.peek() ?? undefined);
  if (picked) takesFolderChoice.value = picked;
  return picked;
}

/** Back to the default folder. */
export function resetTakesFolder(): void {
  takesFolderChoice.value = null;
}

/** True when `path` names a take file (not its notes). */
export const isTakeFilePath = (path: string): boolean => path.toLowerCase().endsWith(TAKE_SUFFIX);

/** Add take files to Recorded takes (non-take files are ignored); returns the ones added. */
export function addTakes(paths: readonly string[]): string[] {
  const takes = paths.filter(isTakeFilePath);
  if (takes.length === 0) return [];
  const known = new Set(takes.map((p) => p.toLowerCase()));
  addedTakes.value = [...takes, ...addedTakes.peek().filter((p) => !known.has(p.toLowerCase()))];
  return takes;
}

/** Drop an added take from the list (the file stays where it is). */
export function forgetTake(path: string): void {
  addedTakes.value = addedTakes.peek().filter((p) => p.toLowerCase() !== path.toLowerCase());
}

/** A path's folder and file name, by either separator: `C:\a\b.sporesample` → `["C:\a", "b.sporesample"]`. */
export function splitPath(path: string): [folder: string, file: string] {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
}
