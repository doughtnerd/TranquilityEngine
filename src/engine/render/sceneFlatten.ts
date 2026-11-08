/**
 * @internal Scene and prefab files as one flat list of nodes, for the thumbnail renderer (ADR 0117):
 * the resolved scene view (`scene/resolvedScene.ts`) minus inactive nodes and their children. No Babylon here, so it is unit-tested.
 *
 * Ids are made unique by prefixing them with the instance's id path (`bg-a/root/child`), which is
 * also how an override's `target` path addresses a node inside an instance.
 */
import { resolveScene } from "../scene/resolvedScene";

export interface FlatNode {
  id: string;
  parent?: string;
  components: { type: string; data?: unknown }[];
}

/**
 * The nodes of the scene or prefab at `path`, instances expanded (the resolved scene view). `read` gives a project
 * file's parsed JSON (undefined when it is missing). A missing prefab leaves its instance out.
 */
export function flattenSceneNodes(path: string, read: (path: string) => unknown): FlatNode[] {
  const scene = resolveScene(path, { read });
  return scene.nodes
    .filter((n) => n.activeInHierarchy)
    .map((n) => ({
      id: n.id,
      ...(n.parent ? { parent: n.parent } : {}),
      components: n.components.map((c) => ({ type: c.type, ...(c.data !== undefined ? { data: c.data } : {}) })),
    }));
}
