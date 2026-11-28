// Reading project paths (ADR 0454): a project path is POSIX and relative to the project folder (`images/bird.png`,
// `scenes/level-1.scene.json`), and this module is the one place that takes one apart: its file name, its folder,
// and whether it's a file the scene view opens (a scene or a prefab) and the name it shows by. Suffixes match the
// way the asset kind registry matches them (`assetKind`): case-insensitively, after a non-empty name, so
// `Level.Scene.JSON` is a scene everywhere the editor asks. No dependencies, so any module (the Projects window's
// included, ADR 0059) can use it.

/** The file name of a project path: `images/bird.png` → `bird.png`. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The folder of a project path: `images/bird.png` → `images`, `project.json` → `""` (the root). */
export const folderOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** The parent of a folder: `a/b` → `a`, `a` → `""`. Null for the root (`""`), which has none. */
export const parentFolder = (folder: string): string | null => (folder === "" ? null : folderOf(folder));

/** The scene view's file endings (the core `scene` and `prefab` asset kinds'), longest first. */
const SCENE_SUFFIXES = [".scene.json", ".prefab.json"] as const;

/** The scene or prefab ending `path` has after a non-empty name (any case), or null. */
function sceneSuffix(path: string): string | null {
  const name = fileName(path).toLowerCase();
  return SCENE_SUFFIXES.find((s) => name.length > s.length && name.endsWith(s)) ?? null;
}

/** True for a file the scene view opens: a scene (`*.scene.json`) or a prefab (`*.prefab.json`), in any case. */
export const isSceneFile = (path: string): boolean => sceneSuffix(path) !== null;

/**
 * The name a scene or prefab shows by: its file name without `.scene.json` or `.prefab.json` (any case), so
 * `prefabs/Pipe-Pair.prefab.json` → `Pipe-Pair`. Another JSON file loses `.json`; anything else keeps its name.
 */
export function sceneDisplayName(path: string): string {
  const name = fileName(path);
  const suffix = sceneSuffix(path) ?? (name.length > 5 && name.toLowerCase().endsWith(".json") ? ".json" : "");
  return name.slice(0, name.length - suffix.length);
}
