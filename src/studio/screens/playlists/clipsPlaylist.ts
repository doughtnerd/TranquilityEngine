// "Create playlist from clips" (the editor's lost authoring path, decision log D31): samples picked in the Library
// become a new playlist file. One sample makes a Clip, several a Queue (random, as a set of variations is usually
// meant: footsteps, impacts). It is named after what the samples share (`footstep_01`, `footstep_02` → "footstep"),
// else their folder, else "New playlist", and goes in the deepest folder they share. Pure.
import { emptyPlaylist } from "../../../engine/audio/playlist/format";
import type { PlaylistAsset } from "../../../engine/audio/playlist/types";
import { sampleEntry } from "./playlistEdits";
import { sampleTitle } from "./playlistPaths";

/** What a new playlist from `samples` is: its file name (no extension), folder and value. Null for no samples. */
export interface ClipsPlaylist {
  readonly name: string;
  readonly folder: string;
  readonly value: PlaylistAsset;
}

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The deepest folder every path is in ("" for the project root). */
function sharedFolder(paths: readonly string[]): string {
  let parts = folderOf(paths[0]!).split("/").filter(Boolean);
  for (const p of paths.slice(1)) {
    const other = folderOf(p).split("/").filter(Boolean);
    let k = 0;
    while (k < parts.length && k < other.length && parts[k] === other[k]) k++;
    parts = parts.slice(0, k);
  }
  return parts.join("/");
}

/** The start the titles share, less trailing numbers and separators (`kick_0` of `kick_01`, `kick_02` → "kick"). */
function sharedStem(titles: readonly string[]): string {
  let stem = titles[0]!;
  for (const t of titles.slice(1)) {
    let k = 0;
    while (k < stem.length && k < t.length && stem[k]!.toLowerCase() === t[k]!.toLowerCase()) k++;
    stem = stem.slice(0, k);
  }
  return stem.replace(/[\s._-]*\d*[\s._-]*$/u, "").replace(/[\s._-]+$/u, "");
}

/** The new playlist for `samples` (in the order given; duplicates once), or null when there are none. */
export function clipsPlaylist(samples: readonly string[]): ClipsPlaylist | null {
  const list = [...new Set(samples)];
  if (list.length === 0) return null;
  const folder = sharedFolder(list);
  // A Queue's samples are each in an embedded Clip (ADR 0329: entries are playlists; `sampleEntry`'s rule).
  const empty = emptyPlaylist(list.length === 1 ? "clip" : "queue");
  const value: PlaylistAsset = { ...empty, entries: list.map((sample) => sampleEntry(empty, sample)) };
  if (list.length === 1) return { name: sampleTitle(list[0]!), folder, value };
  const stem = sharedStem(list.map(sampleTitle));
  const folderName = folder.slice(folder.lastIndexOf("/") + 1);
  return { name: stem.length >= 2 ? stem : folderName || "New playlist", folder, value };
}
