// Copying and cutting scene nodes (ADR 0022, 0026). The clipboard holds the copied subtrees as authored (prefab
// instances with their overrides); pasting and duplicating them is the node insertion's (ADR 0246,
// `nodeInsertion.ts`), which gives every node a new id and re-points references. Cut is one undo step.
// Copies also go on the system clipboard as tagged JSON (ADR 0226), read back by a paste.
import { readClipboard } from "./clipboard";
import type { NodeEntry, SceneDocument } from "./document";
import { deleteNodes } from "./hierarchyEdit";
import { isInnerKey } from "./nodeKey";
import { hierarchyEntries, topmostKeys } from "./selectionModel";
import type { OpenScene } from "./state";
import { undoStep } from "./undoStep";

/** Copied nodes. */
export interface NodeClipboard {
  /** Path of the scene they were copied from. */
  readonly source: string;
  /** Each copied subtree: its root, then its descendants in file order, as authored. */
  readonly subtrees: readonly (readonly NodeEntry[])[];
}

/** The format tag of clipboard JSON put on the system clipboard. */
export const CLIPBOARD_FORMAT = "myco.nodes@1";

/** Copied nodes as clipboard JSON (ADR 0226). */
export const nodeClipboardPayload = (clip: NodeClipboard) => ({ format: CLIPBOARD_FORMAT, source: clip.source, subtrees: clip.subtrees });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const optional = (v: unknown, test: (v: unknown) => boolean) => v === undefined || test(v);
const isArrayOf = (test: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(test);

/** A node entry as a scene file holds it: an id, and (when present) the right shapes for the rest. */
function isNodeEntry(v: unknown): v is NodeEntry {
  if (!isObject(v) || typeof v.id !== "string" || v.id === "") return false;
  return (
    optional(v.name, (x) => typeof x === "string") &&
    optional(v.prefab, (x) => typeof x === "string") &&
    optional(v.parent, (x) => x === null || typeof x === "string") &&
    optional(v.components, isArrayOf((c) => isObject(c) && typeof c.type === "string" && optional(c.data, isObject))) &&
    optional(v.overrides, isArrayOf(isObject))
  );
}

/** Well-formed copied subtrees: each a root then descendants whose parents come earlier in it, no id twice. */
function wellFormed(v: unknown): boolean {
  if (!isObject(v) || typeof v.source !== "string" || !Array.isArray(v.subtrees) || v.subtrees.length === 0) return false;
  const ids = new Set<string>();
  for (const subtree of v.subtrees as unknown[]) {
    if (!Array.isArray(subtree) || subtree.length === 0) return false;
    const inside = new Set<string>();
    for (const [i, e] of subtree.entries()) {
      if (!isNodeEntry(e) || ids.has(e.id)) return false;
      if (i > 0 && !inside.has(e.parent ?? "")) return false;
      ids.add(e.id);
      inside.add(e.id);
    }
  }
  return true;
}

/** The copied nodes in system clipboard text, or null if it holds none (or malformed ones). */
export function nodeClipboardFromText(text: string): NodeClipboard | null {
  const v = readClipboard<ReturnType<typeof nodeClipboardPayload>>(text, CLIPBOARD_FORMAT, wellFormed);
  return v && { source: v.source, subtrees: v.subtrees };
}

/** Why the nodes at `keys` can't be copied, or null if they can. */
export function whyNotCopyable(doc: SceneDocument, keys: readonly string[]): string | null {
  if (keys.length === 0) return "select something first";
  if (keys.some(isInnerKey)) return "nodes inside a prefab are copied in the prefab";
  if (keys.some((k) => !doc.has(k))) return "that node is gone";
  return null;
}

/** The topmost of `keys` (children go with their parents), in hierarchy order. */
export function subtreeRoots(doc: SceneDocument, keys: readonly string[]): string[] {
  const order = new Map(hierarchyEntries(doc).map((e, i) => [e.key, i]));
  return topmostKeys(doc, keys).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Copy the nodes at `keys` and their children. Throws if they can't be copied. */
export function copyNodes(doc: SceneDocument, keys: readonly string[]): NodeClipboard {
  const reason = whyNotCopyable(doc, keys);
  if (reason) throw new Error(reason);
  return {
    source: doc.path,
    subtrees: subtreeRoots(doc, keys).map((id) => doc.subtree(id).map((i) => structuredClone(doc.node(i)))),
  };
}

const describe = (doc: SceneDocument, roots: readonly string[], verb: string) =>
  roots.length === 1 ? `${verb} ${doc.node(roots[0]).name ?? roots[0]}` : `${verb} ${roots.length} nodes`;

/** Copy the nodes at `keys`, then delete them (clearing references to them) as one undo step. */
export function cutNodes(scene: OpenScene, keys: readonly string[]): NodeClipboard {
  const { doc, stack } = scene;
  const clip = copyNodes(doc, keys);
  const roots = subtreeRoots(doc, keys);
  undoStep(stack, describe(doc, roots, "Cut"), () => {
    deleteNodes(scene, roots);
  });
  return clip;
}
