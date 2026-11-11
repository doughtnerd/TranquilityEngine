// The Event editor's toolbar actions over the selection (ADR 0158 §7): where "Add" puts a new node, and changing a
// list container's type. Pure, over eventTree.ts.
import type { EventNode, NodeType } from "../../../../engine/audio/eventFormat";
import {
  addChild,
  canAddChild,
  getNode,
  isListNode,
  newNode,
  parentPath,
  setNode,
  type ListNodeType,
  type NodePath,
  type TreeEdit,
} from "./EventTree";

/**
 * Where "Add" puts a new node with `selected` selected (`null`: the event row, which means the root): into a selected
 * list container, at its end; beside any other selected node in a list, right after it; nowhere for a node that sits
 * in a sustain slot or a root that isn't a list. Returns the parent and index, or null.
 */
export function addTarget(root: EventNode, selected: NodePath | null): { parent: NodePath; index: number } | null {
  const path = selected ?? [];
  const node = getNode(root, path);
  if (!node) return null;
  if (isListNode(node)) return { parent: path, index: node.children.length };
  const parent = parentPath(path);
  const step = path[path.length - 1];
  if (!parent || typeof step !== "number") return null;
  const p = getNode(root, parent);
  return p && isListNode(p) ? { parent, index: step + 1 } : null;
}

/** Add a fresh node of `type` (a clip with `clip`) where `addTarget` says, or a reason it can't. */
export function addNode(root: EventNode, selected: NodePath | null, type: NodeType, clip?: string): TreeEdit | string {
  const at = addTarget(root, selected);
  if (!at) return "select a container, or a node in one, to add beside it";
  const node = newNode(type, clip);
  if (!canAddChild(root, at.parent, node)) return "the event can't hold more nodes there";
  return addChild(root, at.parent, node, at.index);
}

/** The keys a node keeps whatever its type: the common fields and the ones its parent reads. */
const KEPT = ["volume", "pitch", "volumeRandom", "pitchRandom", "delay", "automation", "weight", "fade", "value", "range"] as const;

/**
 * The list container at `path` as another list type: a fresh node of `type` with the old node's children and kept
 * fields (`KEPT`); type-specific fields take the new type's defaults. Unchanged when the node isn't a list container
 * or already has the type.
 */
export function changeListType(root: EventNode, path: NodePath, type: ListNodeType): EventNode {
  const node = getNode(root, path);
  if (!node || !isListNode(node) || node.type === type) return root;
  const next = { ...newNode(type), children: node.children } as Record<string, unknown>;
  for (const key of KEPT) if (node[key] !== undefined) next[key] = node[key];
  return setNode(root, path, next as unknown as EventNode);
}
