// Document patches for the edit history (ADR 0027): the difference between two scene files at
// node-entry level, plain JSON so it can be written to a history file.
import type { Change } from "./commands";
import type { NodeEntry, SceneFile } from "./SceneDocument";

/**
 * What changes one document into another. `nodes` holds the full new value of each node entry
 * that changed (`null`: removed). `order` is the complete id order of the result, present when the
 * set of nodes or their order changed. `top` is the result's top-level keys in order (the node
 * list as `["nodes"]`), present when anything outside the node list changed.
 */
export interface DocPatch {
  nodes?: Record<string, NodeEntry | null>;
  order?: string[];
  top?: [string, unknown?][];
}

const json = (v: unknown) => JSON.stringify(v);

function topOf(file: SceneFile): [string, unknown?][] {
  return Object.entries(file).map(([k, v]) => (k === "nodes" ? [k] : [k, structuredClone(v)]));
}

/** The patches between two documents, both ways; null when they're the same. */
export function diffFiles(a: SceneFile, b: SceneFile): { redo: DocPatch; undo: DocPatch } | null {
  const redo: DocPatch = {}, undo: DocPatch = {};
  const byA = new Map(a.nodes.map((n) => [n.id, n]));
  const byB = new Map(b.nodes.map((n) => [n.id, n]));
  for (const id of new Set([...byA.keys(), ...byB.keys()])) {
    const na = byA.get(id), nb = byB.get(id);
    if (json(na) === json(nb)) continue;
    (redo.nodes ??= {})[id] = nb ? structuredClone(nb) : null;
    (undo.nodes ??= {})[id] = na ? structuredClone(na) : null;
  }
  const idsA = a.nodes.map((n) => n.id), idsB = b.nodes.map((n) => n.id);
  if (json(idsA) !== json(idsB)) {
    redo.order = idsB;
    undo.order = idsA;
  }
  if (json(topOf(a)) !== json(topOf(b))) {
    redo.top = topOf(b);
    undo.top = topOf(a);
  }
  return redo.nodes || redo.order || redo.top ? { redo, undo } : null;
}

/** `file` with `patch` applied (a new object; `file` is untouched). */
export function applyPatch(file: SceneFile, patch: DocPatch): SceneFile {
  const byId = new Map(file.nodes.map((n) => [n.id, n]));
  for (const [id, value] of Object.entries(patch.nodes ?? {})) {
    if (value === null) byId.delete(id);
    else byId.set(id, structuredClone(value));
  }
  const ids = patch.order ?? file.nodes.map((n) => n.id).filter((id) => byId.has(id));
  const nodes = ids.map((id) => {
    const n = byId.get(id);
    if (!n) throw new Error(`History patch refers to a missing node "${id}".`);
    return structuredClone(n);
  });
  const top = patch.top ?? topOf(file);
  const out: Record<string, unknown> = {};
  for (const [k, v] of top) out[k] = k === "nodes" ? nodes : structuredClone(v);
  return out as unknown as SceneFile;
}

/**
 * What the Editor World must do to go from `before` to `after` (see `WorldSync`): remove nodes
 * that are gone, rebuild nodes that are new or changed (parents before children, skipping nodes
 * whose ancestor is rebuilt anyway), and move nodes that only changed place among siblings.
 */
export function changesBetween(before: SceneFile, after: SceneFile): Change[] {
  const d = diffFiles(before, after);
  if (!d) return [];
  const parentIn = (file: SceneFile) => new Map(file.nodes.map((n) => [n.id, n.parent ?? null]));
  const pBefore = parentIn(before), pAfter = parentIn(after);
  const ancestors = (id: string, parents: Map<string, string | null>) => {
    const out: string[] = [];
    for (let p = parents.get(id) ?? null; p !== null; p = parents.get(p) ?? null) out.push(p);
    return out;
  };
  const touched = Object.entries(d.redo.nodes ?? {});
  const removed = new Set(touched.filter(([, v]) => v === null).map(([id]) => id));
  const rebuilt = new Set(touched.filter(([, v]) => v !== null).map(([id]) => id));
  const out: Change[] = [];
  for (const id of removed) if (!ancestors(id, pBefore).some((a) => removed.has(a))) out.push({ kind: "remove", node: id });
  const depth = (id: string) => ancestors(id, pAfter).length;
  for (const id of [...rebuilt].sort((x, y) => depth(x) - depth(y))) {
    if (!ancestors(id, pAfter).some((a) => rebuilt.has(a))) out.push({ kind: "rebuild", node: id });
  }
  if (d.redo.order) {
    const siblingsIndex = (file: SceneFile) => {
      const index = new Map<string, number>(), count = new Map<string | null, number>();
      for (const n of file.nodes) {
        const p = n.parent ?? null;
        index.set(n.id, count.get(p) ?? 0);
        count.set(p, (count.get(p) ?? 0) + 1);
      }
      return index;
    };
    const ib = siblingsIndex(before), ia = siblingsIndex(after);
    for (const n of after.nodes) {
      if (rebuilt.has(n.id) || !ib.has(n.id) || ancestors(n.id, pAfter).some((a) => rebuilt.has(a))) continue;
      if (ib.get(n.id) !== ia.get(n.id)) out.push({ kind: "move", node: n.id });
    }
  }
  return out;
}

/** A short hash of a document's content (cyrb53 over its JSON), to match history to files. */
export function hashFile(file: SceneFile): string {
  const str = json(file);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
