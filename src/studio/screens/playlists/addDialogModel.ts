// The Add dialog's list (the prototype's Add dialog, PL:1365–1402): the project's samples and playlists, searched and
// filtered (All / Samples / Playlists / Sequences, with counts), several picked at once. A playlist that would make the
// open one contain itself is listed but can't be picked, with why ("Not allowed: it would contain itself", "X already
// contains Y"). A Clip takes one sample ("Choose sample…" / "Replace sample…"). What it adds: a sample as an entry
// (wrapped in an embedded Clip), a playlist as a link ("Link existing", the default) or as an embedded copy ("Copy").
// Pure.
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { wouldContain } from "../../../engine/audio/playlist/references";
import type { Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import { defaultEntryUse } from "../../../engine/audio/playlist/format";
import { playlistBadge, sampleBadge, type BadgeCode } from "../../components/typeBadgeModel";
import { isSamplePath } from "./libraryModel";
import { playlistTitle, sampleTitle } from "./playlistPaths";

export type AddFilter = "all" | "samples" | "playlists" | "sequences";

export interface AddItem {
  readonly path: string;
  readonly kind: "sample" | "playlist" | "sequence";
  readonly name: string;
  readonly folder: string;
  readonly badge: BadgeCode;
  /** Why it can't be added here, or null. */
  readonly disabled: string | null;
}

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Every sample and playlist of the project as items for adding to the playlist file `target` (of type `targetType`). */
export function addItems(files: readonly string[], target: string, targetType: PlaylistBody["type"], load: (path: string) => PlaylistBody | null): AddItem[] {
  const out: AddItem[] = [];
  for (const path of files) {
    if (isSamplePath(path)) {
      out.push({ path, kind: "sample", name: sampleTitle(path), folder: folderOf(path), badge: sampleBadge().code, disabled: null });
    } else if (isPlaylistPath(path)) {
      const b = load(path);
      const kind = b?.type === "sequence" ? "sequence" : "playlist";
      let disabled: string | null = null;
      if (targetType === "clip") disabled = "A Clip plays a sample";
      else if (path === target) disabled = "Not allowed: it would contain itself";
      else if (!b) disabled = "Can't be read";
      else if (wouldContain(target, path, load)) disabled = `${playlistTitle(path)} already contains ${playlistTitle(target)}`;
      out.push({ path, kind, name: playlistTitle(path), folder: folderOf(path), badge: b ? playlistBadge(b.type, b.blend?.axes.length === 2 ? 2 : 1).code : "QUE", disabled });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const matches = (item: AddItem, filter: AddFilter): boolean =>
  filter === "all" || (filter === "samples" && item.kind === "sample") || (filter === "playlists" && item.kind === "playlist") || (filter === "sequences" && item.kind === "sequence");

/** The items a query and filter show (words matched against name and folder). */
export function filterItems(items: readonly AddItem[], query: string, filter: AddFilter): AddItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => matches(i, filter) && words.every((w) => i.path.toLowerCase().includes(w)));
}

/** How many items each filter shows for the query. */
export function filterCounts(items: readonly AddItem[], query: string): Record<AddFilter, number> {
  const shown = filterItems(items, query, "all");
  return {
    all: shown.length,
    samples: shown.filter((i) => i.kind === "sample").length,
    playlists: shown.filter((i) => i.kind === "playlist").length,
    sequences: shown.filter((i) => i.kind === "sequence").length,
  };
}

/** The picked set after clicking `path` (`toggle`: Ctrl/⌘ or a checkbox; a Clip picks one). Disabled items are never picked. */
export function togglePick(picked: readonly string[], item: AddItem, toggle: boolean, single: boolean): string[] {
  if (item.disabled) return [...picked];
  if (single || !toggle) return picked.length === 1 && picked[0] === item.path && toggle ? [] : [item.path];
  return picked.includes(item.path) ? picked.filter((p) => p !== item.path) : [...picked, item.path];
}

/** The entries picking `paths` adds: samples as samples (the edit wraps them), playlists linked or copied (`load` gives the copy's body). */
export function entriesFor(paths: readonly string[], items: readonly AddItem[], mode: "link" | "copy", load: (path: string) => PlaylistBody | null): Entry[] {
  const out: Entry[] = [];
  for (const path of paths) {
    const item = items.find((i) => i.path === path);
    if (!item || item.disabled) continue;
    if (item.kind === "sample") out.push({ kind: "sample", sample: path, trim: null, loop: "inherit", ...defaultEntryUse() });
    else if (mode === "link") out.push({ kind: "linked", playlist: path, ...defaultEntryUse() });
    else {
      const b = load(path);
      if (!b) continue;
      const { format: _f, ...body } = b as PlaylistBody & { format?: string };
      out.push({ kind: "embedded", embedded: structuredClone(body), ...defaultEntryUse() });
    }
  }
  return out;
}

/** The undo label for adding `n` entries. */
export const addLabel = (n: number): string => (n === 1 ? "Add entry" : `Add ${n} entries`);
