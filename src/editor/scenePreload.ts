// The scene's warm-up preload list in the editor (ADR 0080): `settings.preload` in the scene file,
// edited in the Inspector's Scene settings, and filled from the development report's warnings,
// which name the file that would have warmed a missed shader variant.
import { SetScenePreload, type SceneDocument } from "./document";
import type { CommandStack } from "./document";

/** Files the preload list takes: prefabs and material assets (what `warmSet` walks). */
export const PRELOAD_FILE = /\.(prefab|material)\.json$/;

/** The file a variant-report warning says to add to the scene's preload list, or null. */
export function preloadSuggestion(text: string): string | null {
  const m = /Add (\S+\.(?:prefab|material)\.json) to the scene's settings\.preload list/.exec(text);
  return m ? m[1].replace(/^asset:/, "") : null;
}

/** The project's files that can go on the preload list, sorted. */
export function preloadCandidates(files: readonly string[]): string[] {
  return files.filter((f) => PRELOAD_FILE.test(f)).sort();
}

/** Add `path` to the scene's preload list as one undoable step. False when it's already there or isn't a prefab or material. */
export function addToPreload(scene: { doc: SceneDocument; stack: CommandStack }, path: string): boolean {
  const p = path.trim().replace(/^asset:/, "");
  if (!PRELOAD_FILE.test(p) || scene.doc.preload.includes(p)) return false;
  scene.stack.execute(new SetScenePreload([...scene.doc.preload, p], "Add to Preload List"));
  return true;
}

/** Take `path` off the scene's preload list as one undoable step. */
export function removeFromPreload(scene: { doc: SceneDocument; stack: CommandStack }, path: string): void {
  if (!scene.doc.preload.includes(path)) return;
  scene.stack.execute(new SetScenePreload(scene.doc.preload.filter((p) => p !== path), "Remove from Preload List"));
}
