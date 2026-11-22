// The Playlists screen's Library (the prototype's library, PL:1353–1355, 1767–1781): the project's samples, which are
// audio files and derived samples (`*.sample.json`, ADR 0328), grouped by folder and searched by path. Dragging one onto
// the open playlist adds it as an entry. Pure.
import { sampleTitle } from "./playlistPaths";

/** Audio files the engine plays (the audio asset kind's extensions). */
export const AUDIO_EXTENSIONS = [".wav", ".ogg", ".mp3", ".flac", ".m4a"] as const;

/** True for a sample: an audio file or a `*.sample.json`. */
export function isSamplePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".sample.json") || AUDIO_EXTENSIONS.some((x) => lower.endsWith(x));
}

export interface LibraryGroup {
  /** The folder ("" for the project root). */
  readonly folder: string;
  readonly samples: readonly { readonly path: string; readonly name: string; readonly derived: boolean }[];
}

/** The most rows a search shows (the prototype's 300). */
export const LIBRARY_SEARCH_LIMIT = 300;

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The samples of `files` (matching every word of `query` in their path), grouped by folder A–Z, at most `limit` while searching. */
export function libraryGroups(files: readonly string[], query = "", limit = LIBRARY_SEARCH_LIMIT): { groups: LibraryGroup[]; total: number; shown: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hidden = (p: string) => p.split("/").some((part) => part.startsWith("."));
  const all = files.filter((p) => isSamplePath(p) && !hidden(p) && words.every((w) => p.toLowerCase().includes(w))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const shownList = words.length ? all.slice(0, limit) : all;
  const byFolder = new Map<string, LibraryGroup["samples"][number][]>();
  for (const path of shownList) {
    const f = folderOf(path);
    const list = byFolder.get(f) ?? [];
    list.push({ path, name: sampleTitle(path), derived: path.toLowerCase().endsWith(".sample.json") });
    byFolder.set(f, list);
  }
  const groups = [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, samples]) => ({ folder, samples }));
  return { groups, total: all.length, shown: shownList.length };
}

/** The drag payload a Library row writes (`text/plain`), and reading it back on a drop. */
export const SAMPLE_DRAG_PREFIX = "sample:";
export const sampleDragText = (path: string): string => `${SAMPLE_DRAG_PREFIX}${path}`;
export const sampleFromDrag = (text: string | null | undefined): string | null => (text && text.startsWith(SAMPLE_DRAG_PREFIX) ? text.slice(SAMPLE_DRAG_PREFIX.length) : null);

/** The Library's selection after a click on `path` among `order` (the rows shown, top to bottom). */
export interface LibrarySelection {
  readonly selected: readonly string[];
  /** Where a Shift-click range starts (the last plain or Ctrl/⌘ click). */
  readonly anchor: string | null;
}

/** A click: plain selects only `path`; Ctrl/⌘ toggles it; Shift selects the shown rows from the anchor to it. */
export function libraryClick(s: LibrarySelection, order: readonly string[], path: string, mods: { readonly toggle?: boolean; readonly range?: boolean }): LibrarySelection {
  if (mods.range && s.anchor !== null && order.includes(s.anchor) && order.includes(path)) {
    const a = order.indexOf(s.anchor), b = order.indexOf(path);
    return { selected: order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor: s.anchor };
  }
  if (mods.toggle) {
    const on = s.selected.includes(path);
    return { selected: on ? s.selected.filter((p) => p !== path) : [...s.selected, path], anchor: path };
  }
  return { selected: [path], anchor: path };
}

/** What a row's menu acts on: the selection when the row is in it, else just that row. */
export const menuTargets = (s: LibrarySelection, path: string): readonly string[] => (s.selected.includes(path) ? s.selected : [path]);

/** The menu label of "Create playlist from clips" for `paths` (one sample's name, or how many). */
export function createPlaylistLabel(paths: readonly string[]): string {
  return paths.length === 1 ? `Create playlist from “${sampleTitle(paths[0]!)}”` : `Create playlist from ${paths.length} samples`;
}
