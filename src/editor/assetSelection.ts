// The Assets panel's state: the folder showing (with Back/Forward history), the selection of
// files and folders, and how clicks, box selection and arrow keys change it. Entries are Assets panel
// entries (assetEntry.ts). The logic is pure; ui/Assets.tsx renders it, and assetActions.ts runs the
// panel's commands on it (ADR 0157).
import { signal } from "@preact/signals";
import { entryFolder } from "./assetEntry";

/** The folder showing (project-relative, "" = the root). */
export const folderPath = signal("");
/** Search text; when set, the panel lists matching files from every folder. */
export const assetQuery = signal("");
/** Selected entries, in selection order. */
export const selectedAssets = signal<readonly string[]>([]);
/** Where Shift ranges start: the entry last clicked or moved to without Shift. */
export const assetAnchor = signal<string | null>(null);
/** The entry the arrow keys move from. */
export const assetCursor = signal<string | null>(null);
/** The entry being renamed in place, if any. */
export const renamingAsset = signal<string | null>(null);

const back: string[] = [];
const forward: string[] = [];
/** Bumped when the history stacks change, so the Back/Forward buttons re-render. */
export const historyVersion = signal(0);

export const canGoBack = () => back.length > 0;
export const canGoForward = () => forward.length > 0;

/** Show `path`, remembering the folder left for Back. Clears the search and selection. */
export function openFolder(path: string): void {
  assetQuery.value = "";
  if (path === folderPath.value) return;
  back.push(folderPath.value);
  forward.length = 0;
  show(path);
}

export function goBack(): void {
  const to = back.pop();
  if (to === undefined) return;
  forward.push(folderPath.value);
  show(to);
}

export function goForward(): void {
  const to = forward.pop();
  if (to === undefined) return;
  back.push(folderPath.value);
  show(to);
}

/** The parent of a folder: `a/b` → `a`, `a` → `""`. Null for the root. */
export const parentFolder = (path: string) => (path === "" ? null : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function show(path: string): void {
  // The selection is kept when the folder showing is where it was made (going back to it).
  if (selectedAssets.value.some((e) => !isIn(e, path))) select([]);
  folderPath.value = path;
  historyVersion.value++;
}

const isIn = (entry: string, folder: string) => entryFolder(entry) === folder;

/** Forget history and selection (another project opened). */
export function resetAssetBrowser(): void {
  back.length = forward.length = 0;
  folderPath.value = "";
  assetQuery.value = "";
  renamingAsset.value = null;
  select([]);
  historyVersion.value++;
}

/** Set the selection; the cursor and anchor go to `focus` (the last entry by default). */
export function select(entries: readonly string[], focus: string | null = entries.at(-1) ?? null, anchor: string | null = focus): void {
  selectedAssets.value = entries;
  assetCursor.value = focus;
  assetAnchor.value = anchor;
}

export interface Modifiers {
  shift: boolean;
  /** Ctrl, or Cmd on macOS. */
  toggle: boolean;
}

/** The entries from `a` to `b` in `items`, inclusive (either order). */
function range(items: readonly string[], a: string, b: string): string[] {
  const i = items.indexOf(a), j = items.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return items.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * The selection after clicking `entry` among `items` (in display order): a plain click selects
 * it alone; Ctrl/Cmd toggles it; Shift selects the range from the anchor (with Ctrl/Cmd, adding
 * the range to the selection).
 */
export function clickSelection(items: readonly string[], selected: readonly string[], anchor: string | null, entry: string, mods: Modifiers): { selected: string[]; anchor: string } {
  if (mods.shift && anchor && items.includes(anchor)) {
    const span = range(items, anchor, entry);
    return { selected: mods.toggle ? [...new Set([...selected, ...span])] : span, anchor };
  }
  if (mods.toggle) return { selected: selected.includes(entry) ? selected.filter((e) => e !== entry) : [...selected, entry], anchor: entry };
  return { selected: [entry], anchor: entry };
}

/**
 * The selection while dragging a box over `hits`, from the selection `before` the drag: a plain
 * box replaces it, Shift adds to it, Ctrl/Cmd toggles each hit (the scene view's rules).
 */
export function boxSelection(before: readonly string[], hits: readonly string[], mods: Modifiers): string[] {
  if (mods.toggle) return [...before.filter((e) => !hits.includes(e)), ...hits.filter((e) => !before.includes(e))];
  if (mods.shift) return [...new Set([...before, ...hits])];
  return [...hits];
}

/**
 * Where an arrow key (or Home/End) moves the cursor among `items` laid out `columns` wide (1 in
 * the list view). Returns the new cursor, or null for keys that don't move it.
 */
export function moveCursor(items: readonly string[], cursor: string | null, key: string, columns: number): string | null {
  if (items.length === 0) return null;
  const at = cursor === null ? -1 : items.indexOf(cursor);
  const clamp = (i: number) => items[Math.max(0, Math.min(items.length - 1, i))];
  if (at < 0) return key.startsWith("Arrow") || key === "Home" ? items[0] : key === "End" ? items.at(-1)! : null;
  switch (key) {
    case "ArrowLeft": return clamp(at - 1);
    case "ArrowRight": return clamp(at + 1);
    case "ArrowUp": return at - columns >= 0 ? items[at - columns] : items[at];
    case "ArrowDown": return at + columns < items.length ? items[at + columns] : items[at];
    case "Home": return items[0];
    case "End": return items.at(-1)!;
    default: return null;
  }
}

/**
 * The selection after an arrow key (or Home/End) among `items` laid out `columns` wide: the cursor
 * moves (`moveCursor`) and selects that entry alone, or with Shift the range from the anchor to it.
 * Null for keys that don't move the cursor. `focus` is the new cursor.
 */
export function arrowSelection(
  items: readonly string[],
  cursor: string | null,
  anchor: string | null,
  key: string,
  columns: number,
  shift: boolean,
): { selected: string[]; focus: string; anchor: string } | null {
  const next = moveCursor(items, cursor, key, columns);
  if (next === null) return null;
  if (!shift || !anchor) return { selected: [next], focus: next, anchor: next };
  const range = clickSelection(items, [], anchor, next, { shift: true, toggle: false });
  return { selected: range.selected, focus: next, anchor: range.anchor };
}
