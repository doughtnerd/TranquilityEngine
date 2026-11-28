// Where a drop on the Hierarchy lands (ADR 0258): the one geometry shared by asset drags and node drags. Over a row,
// the top quarter means before it, the bottom quarter after it and the middle into it; empty space and the scene's
// own header mean the scene's top level. A drop answers both questions callers ask: where inserted nodes go (a node
// insertion place, ADR 0246) and where moved scene nodes go (a document parent and index), or why they can't.
//
// Rows inside a prefab instance: the middle of a row inserts into that inner node, as an `addNodes` override
// (ADR 0086), as paste does; an override has no order, so the edges insert into the row's parent (its inner parent,
// or the instance itself for a top-level inner row) and the drop marks that parent. Moving scene nodes inside an
// instance is refused: an override's nodes can't be referenced from outside it, so the move would break references
// to them; copy and paste is the way. Nodes inside an instance are moved in the prefab.
import type { SceneDocument } from "./document";
import type { InsertPlace } from "./nodeInsertion";
import { innerAt, isInnerKey as isInner } from "./nodeKey";

/** How a drop relates to the row it marks: into it, before or after it, or the scene's top level. */
export type HierarchyDropMode = "into" | "before" | "after" | "root";

/** Where a drop on the Hierarchy puts dropped assets or moved nodes. */
export interface HierarchyDrop {
  readonly mode: HierarchyDropMode;
  /** The row the drop marks (a path key; null: the scene header). */
  readonly row: string | null;
  /** Where inserting here puts new nodes (the node insertion's place). */
  readonly insert: InsertPlace;
  /** Where moving scene nodes here puts them (under `parent`, null: the top level, at `index`), or why they can't go here. */
  readonly move: { readonly parent: string | null; readonly index?: number } | { readonly reason: string };
}

/** Why scene nodes can't be dropped inside a prefab instance. */
export const NO_MOVE_INSIDE = "scene nodes can't move inside a prefab instance; copy and paste them there";

/**
 * The drop for a pointer over the row `rowKey` at `fraction` of its height (0 = top), or null when the row's node is
 * gone. A null row (empty space, the scene header) is the scene's top level.
 */
export function hierarchyDrop(doc: SceneDocument, rowKey: string | null, fraction: number): HierarchyDrop | null {
  if (rowKey === null) return { mode: "root", row: null, insert: { kind: "into", key: null }, move: { parent: null } };
  const edge = fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : null;
  if (isInner(rowKey)) {
    const inner = innerAt(doc, rowKey);
    if (!inner) return null;
    const row = edge ? inner.parent : rowKey; // an override has no order: beside an inner row is into its parent
    return { mode: "into", row, insert: { kind: "into", key: row }, move: isInner(row) ? { reason: NO_MOVE_INSIDE } : { parent: row } };
  }
  if (!doc.has(rowKey)) return null;
  if (!edge) return { mode: "into", row: rowKey, insert: { kind: "into", key: rowKey }, move: { parent: rowKey } };
  const parent = doc.parentOf(rowKey);
  const index = doc.children(parent).indexOf(rowKey) + (edge === "after" ? 1 : 0);
  return { mode: edge, row: rowKey, insert: { kind: "into", key: parent, index }, move: { parent, index } };
}

/** The drop under a client point in the Hierarchy panel (rows carry `data-key`), or null outside it or over a gone row. `doc`: the window's the drag is in (ADR 0174). */
export function hierarchyDropAt(sceneDoc: SceneDocument, clientX: number, clientY: number, doc: Document = document): HierarchyDrop | null {
  const el = doc.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!el?.closest(".panel.hierarchy")) return null;
  const row = el.closest(".tree .row") as HTMLElement | null;
  if (!row) return hierarchyDrop(sceneDoc, null, 0);
  const r = row.getBoundingClientRect();
  return hierarchyDrop(sceneDoc, row.dataset.key ?? null, r.height > 0 ? (clientY - r.top) / r.height : 0.5);
}

/** The name a drop's row shows: a scene node's name, an inner node's, or "the scene". */
export function dropRowName(doc: SceneDocument | null, row: string | null): string {
  if (row === null || !doc) return "the scene";
  if (isInner(row)) return innerAt(doc, row)?.node.name ?? row.split("/").pop()!;
  return doc.has(row) ? (doc.node(row).name ?? row) : "the scene";
}
