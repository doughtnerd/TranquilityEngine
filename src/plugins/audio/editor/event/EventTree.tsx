// The Event editor's container tree (ADR 0158 §7): the event row, then the nodes depth first with each sustain's
// empty slots as placeholder rows. A toolbar adds, wraps, retypes, duplicates, reorders and deletes; rows drag to
// a new place; clips dragged from the asset browser drop into containers and slots or onto a clip row. Every edit is
// handed to the panel as a new root and the path to select, which it makes one undo step.
import { useEffect, useState } from "preact/hooks";
import { NODE_TYPES, type EventNode, type NodeType } from "../../../../engine/audio/eventFormat";
import { assetDragging, draggedClips, releasedClips } from "./assetDrop";
import {
  LIST_NODE_TYPES,
  SUSTAIN_SLOTS,
  canDuplicate,
  canRemove,
  childSteps,
  duplicateNode,
  getNode,
  isListNode,
  moveNode,
  nodeLabel,
  nodePaths,
  parentPath,
  parsePathKey,
  pathKey,
  removeNode,
  reorderChild,
  samePath,
  wrapNode,
  type ListNodeType,
  type NodePath,
  type SustainSlot,
  type TreeEdit,
} from "./eventTree";
import { addNode, changeListType } from "./treeActions";
import { applyClipDrop, canDropNode, describeDrop, dropAt, type DropRow, type TreeDrop } from "./treeDrop";

export interface EventTreeProps {
  root: EventNode;
  /** The selected node, or null for the event row. */
  selected: NodePath | null;
  onSelect(path: NodePath | null): void;
  /** An edit: the new root, the path to select (null: the event row) and the undo step's name. */
  onEdit(root: EventNode, select: NodePath | null, label: string): void;
  /** A problem to report (an action that can't be done). */
  onProblem(text: string): void;
  readOnly: boolean;
}

type Row =
  | { kind: "node"; path: NodePath; node: EventNode; depth: number; slot?: SustainSlot }
  | { kind: "slot"; sustain: NodePath; slot: SustainSlot; depth: number };

/** The rows in display order: every node depth first, with each sustain's empty start and end as slot rows. */
function rowsOf(root: EventNode): Row[] {
  const out: Row[] = [];
  const walk = (node: EventNode, path: NodePath, depth: number, slot?: SustainSlot) => {
    out.push({ kind: "node", path, node, depth, slot });
    if (node.type === "sustain") {
      for (const s of SUSTAIN_SLOTS) {
        const child = node[s];
        if (child) walk(child, [...path, s], depth + 1, s);
        else out.push({ kind: "slot", sustain: path, slot: s, depth: depth + 1 });
      }
    } else for (const step of childSteps(node)) walk(getNode(node, [step])!, [...path, step], depth + 1);
  };
  walk(root, [], 0);
  return out;
}

/** Pointer travel (CSS px) before pressing a row becomes a drag, as in the asset browser. */
const DRAG_THRESHOLD = 5;

/** The row under a client point and the fraction of its height there, from the DOM (`data-event-row`). */
function rowAt(x: number, y: number): { row: DropRow; fraction: number } | null {
  const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-event-row]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const fraction = r.height > 0 ? (y - r.top) / r.height : 0.5;
  const slot = el.dataset.slot as SustainSlot | undefined;
  const path = parsePathKey(el.dataset.eventPath ?? "");
  if (!path) return null;
  return { row: el.dataset.eventRow === "slot" ? { sustain: path, slot: slot! } : { path }, fraction };
}

/** The indicator a row shows for `drop`: a line before or after it, or a highlight for into / replace. */
function indicator(row: Row, drop: TreeDrop | null, root: EventNode): string {
  if (!drop) return "";
  if ("replace" in drop) return row.kind === "node" && samePath(row.path, drop.replace) ? " drop-replace" : "";
  if ("slot" in drop) return row.kind === "slot" && row.slot === drop.slot && samePath(row.sustain, drop.parent) ? " drop-into" : "";
  if (row.kind !== "node") return "";
  const parent = getNode(root, drop.parent);
  const count = parent && isListNode(parent) ? parent.children.length : 0;
  if (samePath(row.path, drop.parent)) return count === 0 || drop.index === count ? " drop-into" : "";
  const p = parentPath(row.path);
  const step = row.path[row.path.length - 1];
  if (!p || !samePath(p, drop.parent) || typeof step !== "number") return "";
  return step === drop.index ? " drop-before" : "";
}

const TYPE_LABEL: Record<NodeType, string> = { clip: "Clip", random: "Random", sequence: "Sequence", switch: "Switch", blend: "Blend", layer: "Layer", sustain: "Sustain" };

export function EventTree(props: EventTreeProps) {
  const { root, selected, readOnly } = props;
  const rows = rowsOf(root);
  const sel = selected ? getNode(root, selected) : undefined;
  /** A row being dragged: its path and the drop under the pointer (after the threshold). */
  const [nodeDrag, setNodeDrag] = useState<{ from: NodePath; drop: TreeDrop | null; x: number; y: number } | null>(null);
  /** Clips from the asset browser hovering the tree: the drop under the pointer. */
  const [clipHover, setClipHover] = useState<TreeDrop | null>(null);
  const dragging = assetDragging();
  const clips = dragging ? draggedClips() : [];
  useEffect(() => {
    if (!dragging) setClipHover(null);
  }, [dragging]);

  const edit = (e: TreeEdit | string, label: string) => (typeof e === "string" ? props.onProblem(e) : props.onEdit(e.root, e.path, label));
  const add = (type: NodeType) => edit(addNode(root, selected, type), `Add ${type}`);
  const remove = () => {
    if (!selected || !canRemove(root, selected)) return;
    props.onEdit(removeNode(root, selected), parentPath(selected), "Delete node");
  };
  const step = selected?.[selected.length - 1];
  const parent = selected ? parentPath(selected) : null;
  const parentNode = parent ? getNode(root, parent) : undefined;
  const siblings = parentNode && isListNode(parentNode) ? parentNode.children.length : 0;
  const move = (by: number) => {
    if (!parent || typeof step !== "number") return;
    edit(reorderChild(root, parent, step, step + by), "Reorder node");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    const keys = rows.filter((r) => r.kind === "node").map((r) => (r as { path: NodePath }).path);
    const at = selected ? keys.findIndex((k) => samePath(k, selected)) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.altKey && !readOnly) return move(e.key === "ArrowDown" ? 1 : -1);
      const next = at + (e.key === "ArrowDown" ? 1 : -1);
      if (next < 0) props.onSelect(null);
      else if (next < keys.length) props.onSelect(keys[next]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) {
      e.preventDefault();
      remove();
    } else if (e.key === "d" && (e.ctrlKey || e.metaKey) && !readOnly && selected && canDuplicate(root, selected)) {
      e.preventDefault();
      edit(duplicateNode(root, selected), "Duplicate node");
    }
  };

  /** Press on a row: select it; past the threshold, drag it to a new place. */
  const onRowPointerDown = (e: PointerEvent, path: NodePath) => {
    if (e.button !== 0) return;
    props.onSelect(path);
    if (readOnly || !canRemove(root, path)) return;
    const startX = e.clientX, startY = e.clientY;
    let active = false;
    let drop: TreeDrop | null = null;
    const update = (m: PointerEvent) => {
      if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
      active = true;
      const at = rowAt(m.clientX, m.clientY);
      const d = at ? dropAt(root, at.row, at.fraction, "node") : null;
      drop = canDropNode(root, path, d) ? d : null;
      setNodeDrag({ from: path, drop, x: m.clientX, y: m.clientY });
    };
    const finish = (apply: boolean) => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      setNodeDrag(null);
      if (apply && active && drop && canDropNode(root, path, drop)) edit(moveNode(root, path, drop), "Move node");
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  /** Clips from the asset browser: follow the pointer over the tree, add them on release. */
  const clipDropAt = (x: number, y: number): TreeDrop | null => {
    const at = rowAt(x, y);
    if (at) return dropAt(root, at.row, at.fraction, "clips");
    return isListNode(root) ? { parent: [], index: root.children.length } : null; // empty space: the root's end
  };
  const onTreePointerMove = (e: PointerEvent) => {
    if (!dragging || readOnly) return;
    setClipHover(clips.length > 0 ? clipDropAt(e.clientX, e.clientY) : null);
  };
  const onTreePointerUp = (e: PointerEvent) => {
    const released = releasedClips();
    setClipHover(null);
    if (released.length === 0 || readOnly) return;
    const drop = clipDropAt(e.clientX, e.clientY);
    if (!drop) return props.onProblem("Drop clips on a container, an empty slot or a clip");
    edit(applyClipDrop(root, drop, released), released.length === 1 ? "Add clip" : "Add clips");
  };

  const drop = nodeDrag?.drop ?? clipHover;
  const listSelected = sel && isListNode(sel) ? sel : null;
  return (
    <section class="ev-tree-pane" aria-label="Containers">
      <div class="ev-section-head">
        <span>Containers</span>
      </div>
      <div class="ev-toolbar" role="toolbar" aria-label="Tree actions">
        <select aria-label="Add node" data-testid="event-add-node" value="" disabled={readOnly} onChange={(e) => {
          const t = (e.currentTarget as HTMLSelectElement).value as NodeType;
          (e.currentTarget as HTMLSelectElement).value = "";
          if (t) add(t);
        }}>
          <option value="">+ Add…</option>
          {NODE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select aria-label="Wrap in" value="" disabled={readOnly || !sel} onChange={(e) => {
          const t = (e.currentTarget as HTMLSelectElement).value as ListNodeType | "sustain";
          (e.currentTarget as HTMLSelectElement).value = "";
          if (t && selected) {
            try {
              edit(wrapNode(root, selected, t), `Wrap in ${t}`);
            } catch {
              props.onProblem("The event can't nest any deeper there");
            }
          }
        }}>
          <option value="">Wrap in…</option>
          {[...LIST_NODE_TYPES, "sustain" as const].map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        {listSelected && (
          <select aria-label="Change type" value={listSelected.type} disabled={readOnly} onChange={(e) => {
            const t = (e.currentTarget as HTMLSelectElement).value as ListNodeType;
            props.onEdit(changeListType(root, selected!, t), selected, `Change to ${t}`);
          }}>
            {LIST_NODE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        )}
        <button class="icon" aria-label="Move up" title="Move up (Alt+↑)" disabled={readOnly || typeof step !== "number" || step === 0 || siblings === 0} onClick={() => move(-1)}>↑</button>
        <button class="icon" aria-label="Move down" title="Move down (Alt+↓)" disabled={readOnly || typeof step !== "number" || step >= siblings - 1} onClick={() => move(1)}>↓</button>
        <button class="icon" aria-label="Duplicate" title="Duplicate (Ctrl+D)" disabled={readOnly || !selected || !canDuplicate(root, selected)} onClick={() => selected && edit(duplicateNode(root, selected), "Duplicate node")}>⧉</button>
        <button class="icon ev-danger" aria-label="Delete" title="Delete (Del)" disabled={readOnly || !selected || !canRemove(root, selected)} onClick={remove}>×</button>
      </div>
      <div
        class={`ev-tree${dragging && clips.length > 0 ? " ev-drop-ready" : ""}`}
        role="tree"
        aria-label="Event tree"
        data-testid="event-tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={onTreePointerMove}
        onPointerUp={onTreePointerUp}
        onPointerLeave={() => setClipHover(null)}
      >
        <div
          class={`ev-row ev-row-event${selected === null ? " selected" : ""}`}
          role="treeitem"
          aria-selected={selected === null}
          data-testid="event-tree-event"
          onPointerDown={(e) => e.button === 0 && props.onSelect(null)}
        >
          <span class="ev-badge">event</span>
          <span class="ev-row-label">Event</span>
        </div>
        {rows.map((row) => {
          const ind = indicator(row, drop, root);
          if (row.kind === "slot") {
            return (
              <div
                key={`${pathKey(row.sustain)}#${row.slot}`}
                class={`ev-row ev-row-slot${ind}`}
                role="treeitem"
                aria-selected={false}
                data-event-row="slot"
                data-event-path={pathKey(row.sustain)}
                data-slot={row.slot}
                style={{ paddingLeft: `${8 + row.depth * 14}px` }}
              >
                <span class="ev-slot-name">{row.slot}</span>
                <span class="ev-row-hint">empty: drop a clip or a node here</span>
              </div>
            );
          }
          const key = pathKey(row.path);
          const isSel = selected !== null && samePath(row.path, selected);
          const count = isListNode(row.node) ? row.node.children.length : null;
          const dragged = nodeDrag && samePath(nodeDrag.from, row.path);
          return (
            <div
              key={key}
              class={`ev-row${isSel ? " selected" : ""}${dragged ? " dragged" : ""}${ind}`}
              role="treeitem"
              aria-selected={isSel}
              aria-level={row.depth + 1}
              data-testid="event-tree-row"
              data-event-row="node"
              data-event-path={key}
              data-node-type={row.node.type}
              title={row.node.type === "clip" ? row.node.clip || "No clip chosen" : undefined}
              style={{ paddingLeft: `${8 + row.depth * 14}px` }}
              onPointerDown={(e) => onRowPointerDown(e, row.path)}
            >
              {row.slot && <span class="ev-slot-name">{row.slot}</span>}
              <span class={`ev-badge ev-badge-${row.node.type}`}>{row.node.type}</span>
              <span class={`ev-row-label${row.node.type === "clip" && !row.node.clip ? " missing" : ""}`}>{nodeLabel(row.node)}</span>
              {count !== null && <span class="ev-row-hint">{count === 0 ? "empty" : count}</span>}
            </div>
          );
        })}
        {nodePaths(root).length === 1 && isListNode(root) && root.children.length === 0 && (
          <p class="ev-empty">Drag clips here from the Assets panel, or use + Add.</p>
        )}
      </div>
      {(nodeDrag?.from || clipHover || (dragging && clips.length > 0)) && (
        <div class="ev-drop-hint" role="status" data-testid="event-drop-hint">
          {nodeDrag ? describeDrop(root, nodeDrag.drop, 1, "node") : describeDrop(root, clipHover, clips.length, "clips")}
        </div>
      )}
    </section>
  );
}
