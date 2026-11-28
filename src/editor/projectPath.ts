// Reading project paths (ADR 0454): a project path is POSIX and relative to the project folder (`images/bird.png`,
// `scenes/level-1.scene.json`), and this module is the one place the editor takes one apart: its file name, its
// folder, and whether it's a file the scene view opens (a scene or a prefab) and the name it shows by. It builds on
// the runtime's rules (`core/projectPath.ts`, ADR 0466; `scene/scenePath.ts`, ADR 0467), which import nothing else,
// so any module (the Projects window's included, ADR 0059) can use it. Suffixes match the way the asset kind registry
// matches them (`assetKind`): case-insensitively, after a non-empty name, so `Level.Scene.JSON` is a scene everywhere.
import { folderOf } from "../engine/core/projectPath";
import { isPrefabPath, isScenePath, sceneNodeName } from "../engine/scene/scenePath";

export { fileName, folderOf } from "../engine/core/projectPath";

/** The parent of a folder: `a/b` → `a`, `a` → `""`. Null for the root (`""`), which has none. */
export const parentFolder = (folder: string): string | null => (folder === "" ? null : folderOf(folder));

/** True for a file the scene view opens: a scene (`*.scene.json`) or a prefab (`*.prefab.json`), in any case. */
export const isSceneFile = (path: string): boolean => isScenePath(path) || isPrefabPath(path);

/**
 * The name a scene or prefab shows by: its file name without `.scene.json` or `.prefab.json` (any case), so
 * `prefabs/Pipe-Pair.prefab.json` → `Pipe-Pair`. Another JSON file loses `.json`; anything else keeps its name.
 * The same name the runtime gives the scene node it makes from the file.
 */
export const sceneDisplayName = sceneNodeName;
