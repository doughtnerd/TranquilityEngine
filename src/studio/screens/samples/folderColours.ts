// Folder colours (ADR 0362 item 4): a project folder's colour in the Studio's project settings (`audio.json`'s
// `studio.folderColours`), the Samples tree's folder rows drawn with it, set and cleared from the folder menu, and kept
// on the folder (and the folders under it) when it is renamed or moved. Pure: edits return `{ next } | { refused }`.
import { isMarkColour, markColourCss } from "../../../engine/audio/markColour";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { EditResult } from "../../../editor/sdk/editResult";

/** The folder swatches (theme tokens), after Default. */
export const FOLDER_COLOURS: readonly { readonly name: string; readonly colour: string }[] = [
  { name: "Amber", colour: "warning" }, { name: "Cyan", colour: "accent" }, { name: "Green", colour: "accent2" },
  { name: "Red", colour: "danger" }, { name: "Violet", colour: "series-6" }, { name: "Blue", colour: "series-4" },
];

/** A folder's colour as CSS, or null when it has none (the row's default look). */
export function folderColourCss(p: AudioProject | null, folder: string): string | null {
  const c = p?.studio?.folderColours?.[folder];
  return c ? markColourCss(c) : null;
}

/** The stored colour of a folder (null: none). */
export const folderColour = (p: AudioProject | null, folder: string): string | null => p?.studio?.folderColours?.[folder] ?? null;

const withColours = (p: AudioProject, colours: Record<string, string>): AudioProject => {
  const { studio: _old, ...rest } = p;
  const studio = { ...p.studio };
  if (Object.keys(colours).length) studio.folderColours = colours;
  else delete studio.folderColours;
  return Object.keys(studio).length ? { ...rest, studio } : (rest as AudioProject);
};

/** Folder `folder`'s colour (a theme token name or `#rrggbb`; null: none). */
export function setFolderColour(p: AudioProject, folder: string, colour: string | null): EditResult<AudioProject> {
  if (folder === "") return { refused: "the top level has no colour" };
  if (colour !== null && !isMarkColour(colour)) return { refused: "a folder colour is a theme colour or #rrggbb" };
  const colours = { ...p.studio?.folderColours };
  if (colour === null) {
    if (!(folder in colours)) return { refused: `${folder} has no colour` };
    delete colours[folder];
  } else colours[folder] = colour.toLowerCase();
  return { next: withColours(p, colours) };
}

/**
 * The colours after folder `from` became `to` (a rename or a move): `from` and every folder under it keep their colour
 * at the new path. `p` itself when none of them had one.
 */
export function moveFolderColours(p: AudioProject, from: string, to: string): AudioProject {
  const colours = p.studio?.folderColours;
  if (!colours || from === to) return p;
  let moved = false;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(colours)) {
    if (k === from || k.startsWith(`${from}/`)) {
      next[to + k.slice(from.length)] = v;
      moved = true;
    } else next[k] = v;
  }
  return moved ? withColours(p, next) : p;
}
