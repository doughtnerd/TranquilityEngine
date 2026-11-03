// Restructuring the open scene from the hierarchy (ADR 0026): move nodes (reorder, reparent,
// unparent) and delete them. Each operation is one undo step. Nodes inside prefab instances come
// from their prefab file, so they can't be moved or deleted here (the instance itself can).
import { localPoseUnder } from "../engine/editor";
import { RemoveNode, ReparentNode, SetField, type NodeReference, type SceneDocument } from "./document";
import { toSceneJSON } from "./fieldValues";
import type { OpenScene } from "./state";

const EPSILON = 1e-4;

/** True for a path key that points inside a prefab instance (`pipe/top`). */
export const isInsidePrefab = (key: string) => key.includes("/");

/** Why `id` can't move under `parent`, or null if it can. */
export function whyNotMovable(doc: SceneDocument, id: string, parent: string | null): string | null {
  if (isInsidePrefab(id)) return "nodes inside a prefab are moved in the prefab";
  if (!doc.has(id)) return "that node is gone";
  if (parent !== null && isInsidePrefab(parent)) return "nodes inside a prefab can't take children here";
  if (parent !== null && !doc.has(parent)) return "that parent is gone";
  if (parent !== null && doc.subtree(id).includes(parent)) return "a node can't go inside itself";
  return null;
}

/**
 * Move node `id` under `parent` (null: the top of the scene) at `index` among the parent's
 * children as they are now (undefined: last). Moving to a new parent keeps the node where it is in
 * the world, rewriting its local Transform values; reordering among the same siblings changes
 * nothing else. Returns false (and does nothing) when the node would stay where it is.
 */
export function moveNode(scene: OpenScene, id: string, parent: string | null, index?: number): boolean {
  const { doc, stack, sync } = scene;
  const reason = whyNotMovable(doc, id, parent);
  if (reason) throw new Error(reason);
  const oldParent = doc.parentOf(id);
  const siblings = doc.children(parent);
  let at = index;
  if (oldParent === parent) {
    const current = siblings.indexOf(id);
    if (at === undefined) at = siblings.length; // last
    if (current < at) at -= 1; // the node vacates its slot first
    if (at === current) return false;
  }

  // Work out the world-preserving pose before anything moves.
  const node = sync.nodeFor(id);
  const pose = oldParent !== parent && node ? localPoseUnder(node, parent === null ? null : sync.nodeFor(parent)) : null;
  const name = doc.node(id).name ?? id;
  stack.beginGroup(oldParent === parent ? `Reorder ${name}` : `Move ${name}`);
  try {
    stack.execute(new ReparentNode(id, parent, at));
    if (pose && node?.transform) {
      const t = node.transform;
      const current = { position: t.position.toArray(), rotation: t.eulerAngles.toArray(), scale: t.scale.toArray() };
      for (const field of ["position", "rotation", "scale"] as const) {
        if (pose[field].every((v, i) => Math.abs(v - current[field][i]) < EPSILON)) continue;
        const previous = doc.isPrefabInstance(id) ? doc.overrideValue(id, [], "engine.Transform", field) : doc.fieldValue(id, "engine.Transform", field);
        stack.execute(new SetField(id, "engine.Transform", field, toSceneJSON("vector3", pose[field], { field, previous })));
      }
    }
  } finally {
    stack.endGroup();
  }
  return true;
}

/** References from nodes outside `id`'s subtree to nodes inside it: the ones deleting it breaks. */
export function referencesInto(doc: SceneDocument, id: string | readonly string[]): NodeReference[] {
  const inside = new Set((typeof id === "string" ? [id] : id).flatMap((i) => doc.subtree(i)));
  return doc.references().filter((r) => inside.has(r.to) && !inside.has(r.path[0]));
}

/** Why `key` can't be deleted, or null if it can. */
export function whyNotDeletable(doc: SceneDocument, key: string): string | null {
  if (isInsidePrefab(key)) return "nodes inside a prefab are removed in the prefab";
  if (!doc.has(key)) return "that node is gone";
  return null;
}

/**
 * Delete node `id` and its children, first setting every reference to them from elsewhere in the
 * scene to None, as one undo step (undo restores the node and the references). Returns the
 * references it cleared.
 */
export function deleteNode(scene: OpenScene, id: string): NodeReference[] {
  return deleteNodes(scene, [id]);
}

/** `deleteNode` for several nodes at once, as one undo step. None of them may be inside another. */
export function deleteNodes(scene: OpenScene, ids: readonly string[]): NodeReference[] {
  const { doc, stack } = scene;
  for (const id of ids) {
    const reason = whyNotDeletable(doc, id);
    if (reason) throw new Error(reason);
  }
  const refs = referencesInto(doc, ids);
  stack.beginGroup(ids.length === 1 ? `Delete ${doc.node(ids[0]).name ?? ids[0]}` : `Delete ${ids.length} nodes`);
  try {
    for (const r of refs) {
      let value: unknown = null;
      if (r.element !== undefined) {
        // An item of a list field (ADR 0042): set just that item to None.
        const [id, ...target] = r.path;
        const list = doc.isPrefabInstance(id) ? doc.overrideValue(id, target, r.type, r.field, r.index) : doc.fieldValue(id, r.type, r.field, r.index);
        value = Array.isArray(list) ? list.map((item, i) => (i === r.element ? null : item)) : null;
      }
      stack.execute(new SetField(r.path[0], r.type, r.field, value, { index: r.index, target: r.path.slice(1) }));
    }
    for (const id of ids) stack.execute(new RemoveNode(id));
  } finally {
    stack.endGroup();
  }
  return refs;
}

/** "GameManager.bird" style labels for references, for the confirmation and status bar. */
export function describeReference(doc: SceneDocument, r: NodeReference): string {
  const owner = doc.has(r.path[0]) ? doc.node(r.path[0]).name ?? r.path[0] : r.path[0];
  const inner = r.path.length > 1 ? `/${r.path.slice(1).join("/")}` : "";
  const target = doc.has(r.to) ? doc.node(r.to).name ?? r.to : r.to;
  return `${owner}${inner} · ${r.type.replace(/^(engine|game)\./, "")}.${r.field} → ${target}`;
}
