// Which project folders the Studio's trees and folder pickers show (UI pass T5): a new project has the game's own
// content folders (`scenes/` and `scripts/` from the project scaffold, `plugins/` for project plugins), and they aren't
// audio. The Samples and Playlists trees, Import's "Into folder", Fork's "Folder" and the other folder pickers leave
// them out, and the editor's hidden folders (`.myco/`), unless audio content was put in them (then the folder and
// its ancestors show, so nothing in the project is out of reach). Any other folder shows, empty or not: a folder the
// user just made is theirs.
//
// Pure.

/** The game's own content roots: folders the project scaffold and the editor make for scenes, scripts and plugins. */
export const GAME_CONTENT_ROOTS: readonly string[] = ["scenes", "scripts", "plugins"];

const hidden = (folder: string): boolean => folder.split("/").some((part) => part.startsWith("."));
const rootOf = (folder: string): string => folder.split("/", 1)[0]!;

/**
 * `folders` without the game's content folders and hidden ones, except those holding content `isContent` accepts
 * (a sample, a playlist: what the tree or picker is for) in them or below them. Order kept.
 */
export function contentFolders(folders: readonly string[], files: readonly string[], isContent: (path: string) => boolean): string[] {
  const holding = new Set<string>();
  for (const f of files) {
    if (!isContent(f)) continue;
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) holding.add(parts.slice(0, i).join("/"));
  }
  return folders.filter((f) => holding.has(f) || (!hidden(f) && !GAME_CONTENT_ROOTS.includes(rootOf(f))));
}
