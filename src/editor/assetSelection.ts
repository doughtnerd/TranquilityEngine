// The Assets panel's state: the folder each copy shows (with Back/Forward history, ADR 0174), the selection of
// files and folders, and how clicks, box selection and arrow keys change it. Entries are project
// paths, folders ending in "/" (assetDelete.ts). The logic is pure; ui/Assets.tsx renders it.
import { computed, signal } from "@preact/signals";

/**
 * One Assets panel's browsing (ADR 0174): the folder it shows, its Back/Forward history and its
 * search. Each copy of the panel has its own; the selection below is the editor's, shared by all.
 */
export class AssetBrowserView {
  /** The folder showing (project-relative, "" = the root). */
  readonly folder = signal("");
  /** Search text; when set, the panel lists matching files from every folder. */
  readonly query = signal("");
  /** Bumped when the history stacks change, so the Back/Forward buttons re-render. */
  readonly historyVersion = signal(0);
  private readonly back: string[] = [];
  private readonly forward: string[] = [];

  constructor() {
    views.add(new WeakRef(this));
  }

  canGoBack = (): boolean => this.back.length > 0;
  canGoForward = (): boolean => this.forward.length > 0;

  /** Show `path`, remembering the folder left for Back. Clears the search and selection. */
  openFolder = (path: string): void => {
    this.query.value = "";
    if (path === this.folder.value) return;
    this.back.push(this.folder.value);
    this.forward.length = 0;
    this.show(path);
  };

  goBack = (): void => {
    const to = this.back.pop();
    if (to === undefined) return;
    this.forward.push(this.folder.value);
    this.show(to);
  };

  goForward = (): void => {
    const to = this.forward.pop();
    if (to === undefined) return;
    this.back.push(this.folder.value);
    this.show(to);
  };

  /** Forget history and search (another project opened). */
  reset(): void {
    this.back.length = this.forward.length = 0;
    this.folder.value = "";
    this.query.value = "";
    this.historyVersion.value++;
  }

  private show(path: string): void {
    // The selection is kept when the folder showing is where it was made (going back to it).
    if (selectedAssets.value.some((e) => !isIn(e, path))) select([]);
    this.folder.value = path;
    this.historyVersion.value++;
  }
}

const views = new Set<WeakRef<AssetBrowserView>>();

/** The browsing used when no Assets panel is drawn (tests), and the first one shown. */
export const defaultAssetBrowser = new AssetBrowserView();
/** The Assets panel last used (clicked or focused): where an import shows its files and an OS drop lands by default. */
export const lastAssetBrowser = signal<AssetBrowserView>(defaultAssetBrowser);

/** The last-used Assets panel's folder. */
export const folderPath = computed(() => lastAssetBrowser.value.folder.value);
/** The last-used Assets panel's search text. */
export const assetQuery = computed(() => lastAssetBrowser.value.query.value);
/** Selected entries, in selection order. */
export const selectedAssets = signal<readonly string[]>([]);
/** Where Shift ranges start: the entry last clicked or moved to without Shift. */
export const assetAnchor = signal<string | null>(null);
/** The entry the arrow keys move from. */
export const assetCursor = signal<string | null>(null);
/** The entry being renamed in place, if any. */
export const renamingAsset = signal<string | null>(null);

export const canGoBack = (): boolean => lastAssetBrowser.peek().canGoBack();
export const canGoForward = (): boolean => lastAssetBrowser.peek().canGoForward();
/** Show `path` in the last-used Assets panel. */
export const openFolder = (path: string): void => lastAssetBrowser.peek().openFolder(path);
export const goBack = (): void => lastAssetBrowser.peek().goBack();
export const goForward = (): void => lastAssetBrowser.peek().goForward();

/** The parent of a folder: `a/b` → `a`, `a` → `""`. Null for the root. */
export const parentFolder = (path: string) => (path === "" ? null : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const isIn = (entry: string, folder: string) => {
  const p = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === folder;
};

/** Forget every Assets panel's history, and the selection (another project opened). */
export function resetAssetBrowser(): void {
  for (const ref of [...views]) {
    const view = ref.deref();
    if (view) view.reset();
    else views.delete(ref);
  }
  renamingAsset.value = null;
  select([]);
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
