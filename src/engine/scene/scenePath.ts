/**
 * Scene and prefab files by their path (ADR 0467): the one rule for which files are scenes or prefabs and the name a
 * scene node made from one gets. Endings match as the asset kind registry matches them (ADR 0143, 0454): in any case,
 * after a non-empty name, so `Boss.Scene.JSON` is a scene and named `Boss` wherever it is loaded (`SceneManager.load`,
 * a sub-scene instance, the editor's document). The editor's `projectPath.ts` builds on it.
 *
 * Pure: imports only `core/projectPath.ts`.
 */
import { fileName } from "../core/projectPath";

const SCENE = ".scene.json";
const PREFAB = ".prefab.json";

const endsWith = (path: string, suffix: string): boolean => {
  const name = fileName(path).toLowerCase();
  return name.length > suffix.length && name.endsWith(suffix);
};

/**
 * True for scene files (`*.scene.json`, any case). Instanced inside another scene, a scene becomes a scene node
 * holding its top-level nodes; any other file is a prefab, a single node instanced as itself.
 */
export const isScenePath = (path: string): boolean => endsWith(path, SCENE);

/** True for prefab files (`*.prefab.json`, any case). */
export const isPrefabPath = (path: string): boolean => endsWith(path, PREFAB);

/**
 * The name of the scene node a scene or prefab file makes, and the name it shows by: its file name without
 * `.scene.json` or `.prefab.json` (any case), so `scenes/Boss.Scene.JSON` → `Boss`. Another JSON file loses `.json`;
 * anything else keeps its file name.
 */
export function sceneNodeName(path: string): string {
  const name = fileName(path);
  const lower = name.toLowerCase();
  const suffix = isScenePath(path) ? SCENE : isPrefabPath(path) ? PREFAB : lower.length > 5 && lower.endsWith(".json") ? ".json" : "";
  return name.slice(0, name.length - suffix.length);
}
