// Copying, cutting, pasting and duplicating scene nodes (ADR 0022, 0026). The clipboard holds the
// copied subtrees as authored (prefab instances with their overrides). Pasting gives every node a
// new id, points references between the pasted nodes at the copies, and keeps references to other
// nodes only when pasting back into the scene they came from. Each operation is one undo step.
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import { deleteNodes, isInsidePrefab } from "./hierarchyEdit";
import { uniqueName } from "./nodeCreate";
import { wouldNest } from "./prefabs";
import { hierarchyEntries, topmostKeys } from "./selectionModel";
import type { OpenScene } from "./state";

/** Copied nodes. */
export interface NodeClipboard {
  /** Path of the scene they were copied from. */
  readonly source: string;
  /** Each copied subtree: its root, then its descendants in file order, as authored. */
  readonly subtrees: readonly (readonly NodeEntry[])[];
}

/** The format tag of clipboard JSON put on the system clipboard. */
export const CLIPBOARD_FORMAT = "myco.nodes@1";

/** Why the nodes at `keys` can't be copied, or null if they can. */
export function whyNotCopyable(doc: SceneDocument, keys: readonly string[]): string | null {
  if (keys.length === 0) return "select something first";
  if (keys.some(isInsidePrefab)) return "nodes inside a prefab are copied in the prefab";
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

/** Replace every `{"$node": id}` in `value` (deeply) using `map`; ids it returns null for become null. */
function remapReferences(value: unknown, map: (id: string) => string | null): unknown {
  if (Array.isArray(value)) return value.map((v) => remapReferences(v, map));
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.$node === "string" && Object.keys(o).length === 1) {
      const to = map(o.$node);
      return to === null ? null : { $node: to };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = remapReferences(v, map);
    return out;
  }
  return value;
}

/** An id like `id` (without a `-2` style suffix) that neither `doc` nor `taken` uses. */
function freshId(doc: SceneDocument, id: string, taken: Set<string>): string {
  const base = id.replace(/-\d+$/, "") || "node";
  const has = (x: string) => doc.has(x) || taken.has(x);
  let out = has(base) ? null : base;
  for (let n = 2; out === null; n++) if (!has(`${base}-${n}`)) out = `${base}-${n}`;
  taken.add(out);
  return out;
}

/**
 * The clipboard's subtrees ready to add to `doc` under `parent`: new ids throughout, parents and
 * references inside the copies re-pointed, other references kept only within the source scene
 * (else None), and each root renamed if a sibling there already has its name.
 */
export function entriesForPaste(doc: SceneDocument, clip: NodeClipboard, parent: string | null): NodeEntry[][] {
  const taken = new Set<string>();
  const ids = new Map<string, string>();
  for (const subtree of clip.subtrees) for (const e of subtree) ids.set(e.id, freshId(doc, e.id, taken));
  const sameScene = clip.source === doc.path;
  const map = (id: string) => ids.get(id) ?? (sameScene && doc.has(id) ? id : null);
  const names: string[] = [];
  return clip.subtrees.map((subtree) =>
    subtree.map((e, i) => {
      const entry = structuredClone(e) as NodeEntry & Record<string, unknown>;
      entry.id = ids.get(e.id)!;
      if (i === 0) {
        delete entry.parent;
        if (entry.name !== undefined) {
          entry.name = uniqueName(doc, parent, entry.name, names);
          names.push(entry.name);
        }
      } else if (entry.parent != null) {
        entry.parent = ids.get(entry.parent) ?? entry.parent;
      }
      for (const c of entry.components ?? []) if (c.data) c.data = remapReferences(c.data, map) as typeof c.data;
      for (const o of entry.overrides ?? []) if (o.value !== undefined) o.value = remapReferences(o.value, map);
      return entry;
    }),
  );
}

/** Why the clipboard can't be pasted into `doc` under `parent`, or null if it can. */
export function whyNotPastable(doc: SceneDocument, clip: NodeClipboard | null, parent: string | null): string | null {
  if (!clip || clip.subtrees.length === 0) return "nothing copied";
  if (parent !== null && isInsidePrefab(parent)) return "nodes inside a prefab get children in the prefab";
  if (parent !== null && !doc.has(parent)) return "that node is gone";
  for (const subtree of clip.subtrees) for (const e of subtree) if (e.prefab && wouldNest(e.prefab, doc.path)) return `${e.prefab} would end up inside itself`;
  return null;
}

/** Where a paste goes: under `parent` (null: the top level) at `index` (undefined: last). */
export interface PasteTarget {
  parent: string | null;
  index?: number;
}

/**
 * Where pasting with `active` selected goes: right after it among its siblings (for a node inside
 * a prefab instance, after the instance), or into it with `asChild`; the end of the scene with
 * nothing selected.
 */
export function pasteTarget(doc: SceneDocument, active: string | null, asChild = false): PasteTarget {
  if (!active) return { parent: null };
  if (asChild) return { parent: active };
  const id = active.split("/")[0];
  if (!doc.has(id)) return { parent: null };
  const parent = doc.parentOf(id);
  return { parent, index: doc.children(parent).indexOf(id) + 1 };
}

const describe = (doc: SceneDocument, roots: readonly string[], verb: string) =>
  roots.length === 1 ? `${verb} ${doc.node(roots[0]).name ?? roots[0]}` : `${verb} ${roots.length} nodes`;

/** Paste the clipboard at `target` as one undo step. Returns the new subtrees' root ids, in order. */
export function pasteNodes(scene: OpenScene, clip: NodeClipboard, target: PasteTarget, verb = "Paste"): string[] {
  const { doc, stack } = scene;
  const reason = whyNotPastable(doc, clip, target.parent);
  if (reason) throw new Error(reason);
  const subtrees = entriesForPaste(doc, clip, target.parent);
  const roots = subtrees.map((s) => s[0].id);
  stack.beginGroup(subtrees.length === 1 ? `${verb} ${subtrees[0][0].name ?? roots[0]}` : `${verb} ${subtrees.length} nodes`);
  try {
    subtrees.forEach((s, i) => stack.execute(new AddNode(s, { parent: target.parent, index: target.index === undefined ? undefined : target.index + i })));
  } finally {
    stack.endGroup();
  }
  return roots;
}

/** Duplicate the nodes at `keys` (each right after itself) as one undo step. Returns the copies' ids. */
export function duplicateNodes(scene: OpenScene, keys: readonly string[]): string[] {
  const { doc, stack } = scene;
  const reason = whyNotCopyable(doc, keys);
  if (reason) throw new Error(reason);
  const roots = subtreeRoots(doc, keys);
  const made: string[] = [];
  stack.beginGroup(describe(doc, roots, "Duplicate"));
  try {
    for (const id of roots) {
      const parent = doc.parentOf(id);
      made.push(...pasteNodes(scene, copyNodes(doc, [id]), { parent, index: doc.children(parent).indexOf(id) + 1 }, "Duplicate"));
    }
  } finally {
    stack.endGroup();
  }
  return made;
}

/** Copy the nodes at `keys`, then delete them (clearing references to them) as one undo step. */
export function cutNodes(scene: OpenScene, keys: readonly string[]): NodeClipboard {
  const { doc, stack } = scene;
  const clip = copyNodes(doc, keys);
  const roots = subtreeRoots(doc, keys);
  stack.beginGroup(describe(doc, roots, "Cut"));
  try {
    deleteNodes(scene, roots);
  } finally {
    stack.endGroup();
  }
  return clip;
}

/** Clipboard JSON for the system clipboard. */
export const clipboardText = (clip: NodeClipboard) => JSON.stringify({ format: CLIPBOARD_FORMAT, ...clip }, null, 2);

/** The clipboard from system clipboard text, or null if it isn't copied nodes. */
export function parseClipboardText(text: string): NodeClipboard | null {
  try {
    const v = JSON.parse(text) as { format?: unknown; source?: unknown; subtrees?: unknown };
    if (v.format !== CLIPBOARD_FORMAT || typeof v.source !== "string" || !Array.isArray(v.subtrees)) return null;
    if (!v.subtrees.every((s) => Array.isArray(s) && s.length > 0 && s.every((e) => e && typeof e === "object" && typeof (e as NodeEntry).id === "string"))) return null;
    return { source: v.source, subtrees: v.subtrees as NodeEntry[][] };
  } catch {
    return null;
  }
}
