// Open Prefab from an instance (ADR 0122): the prefab opens in its own scene tab, with the node
// that was selected in the instance selected in it, and a bar leads back to the scene.
import { signal } from "@preact/signals";
import type { NodePath } from "./document";
import { prefabTarget } from "./prefabs";
import { switchScene } from "./session";
import { openScene, openScenes, select, status } from "./state";

/** Prefab tabs opened from an instance: prefab path → the path of the tab it was opened from. */
export const prefabOrigins = signal<ReadonlyMap<string, string>>(new Map());

/** The tab the open prefab was opened from, if it was opened with Open Prefab and that tab is still open. */
export function prefabOrigin(): string | null {
  const scene = openScene.value;
  if (!scene) return null;
  const from = prefabOrigins.value.get(scene.path);
  return from && openScenes.value.some((s) => s.path === from) ? from : null;
}

/** Open the prefab of the instance at `path` (or of the instance a node at `path` is inside) in its tab. */
export async function openPrefabFrom(path: NodePath): Promise<void> {
  const scene = openScene.peek();
  const target = scene ? prefabTarget(scene.doc, path) : null;
  if (!scene || !target) return;
  if (target.prefab === scene.path) return;
  await switchScene(target.prefab);
  const opened = openScene.peek();
  if (opened?.path !== target.prefab) return; // it didn't open (the status bar says why)
  const next = new Map(prefabOrigins.peek());
  next.set(target.prefab, scene.path);
  prefabOrigins.value = next;
  if (target.select && opened.doc.has(target.select.split("/")[0])) select([target.select]);
  status.value = { kind: "info", text: `Editing ${target.prefab}. Save writes the prefab; Back returns to ${scene.path.split("/").pop()}.` };
}

/** Go back to the tab the open prefab was opened from (one level up). */
export async function backFromPrefab(): Promise<void> {
  const scene = openScene.peek();
  const from = scene ? prefabOrigins.peek().get(scene.path) : undefined;
  if (!scene || !from) return;
  const next = new Map(prefabOrigins.peek());
  next.delete(scene.path);
  prefabOrigins.value = next;
  await switchScene(from);
}
