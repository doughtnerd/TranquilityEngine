// The edits behind the scene view's UI handles (ADR 0077 §4, wave B part 3): which elements get
// handles, and the resize, move and reorder drags, each one undo step over the element's file (see
// uiHandles.ts, which draws the handles and turns pointer events into these drags). A drag reads
// boxes on the canvas through the `BoxOf` it's given.
import type { UIDocumentElement } from "../engine/ui/UIDocument";
import type { UIComponentType } from "../engine/ui/components";
import { openScene } from "./state";
import { beginUIEdit, cancelUIEdit, endUIEdit, moveUIElement, setUIElementAttributes, whyNotEditableUI } from "./uiDocumentEdits";
import {
  boxMap,
  isColumn,
  isReverse,
  moveAttributes,
  reorderTarget,
  resizeAttributes,
  type BoxMap,
  type BoxOnCanvas,
  type DragOptions,
  type FlowSibling,
  type HandleId,
  type Point,
  type ReorderTarget,
} from "./uiHandleMath";
import { elementLabel, resolveUIElement, type UIElementRef } from "./uiDocuments";

/** A UI component's box on the viewport canvas (CSS pixels) with its size in UI pixels, or null. */
export type BoxOf = (c: UIComponentType) => BoxOnCanvas | null;

/** Why the scene view shows no handles on `el` (outline only), or null when it does. */
export function whyNoHandles(el: UIDocumentElement): string | null {
  const reason = whyNotEditableUI();
  if (reason) return reason;
  if (el._path === null) return "it's made by a script (a list row)";
  if (el._synthetic) return "a button's label is its text content";
  if (!el.parent || el.tag === "Canvas") return "the root fills its canvas";
  return null;
}

/** The parent's padding box (inside its border) in its own frame, UI pixels: origin and size. */
function paddingBox(parent: UIDocumentElement, box: BoxOnCanvas): { x: number; y: number; width: number; height: number } {
  const b = (parent.component as { borderWidth?: number }).borderWidth;
  const border = typeof b === "number" && Number.isFinite(b) ? Math.max(0, b) : 0;
  return { x: border, y: border, width: Math.max(0, box.size[0] - 2 * border), height: Math.max(0, box.size[1] - 2 * border) };
}

/** A drag in progress. `update` takes the pointer on the canvas; `finish` applies it (true if a file changed); `cancel` undoes it. */
export interface HandleDrag {
  readonly kind: "resize" | "move" | "reorder";
  readonly label: string;
  update(pointer: Point, options?: DragOptions): void;
  /** The reorder's insertion marker on the canvas (two points), or null. */
  marker(): readonly [Point, Point] | null;
  finish(): boolean;
  cancel(): void;
}

const fieldsOf = (el: UIDocumentElement) => el.component as unknown as Record<string, unknown>;

/** Attributes as a stable string, to skip pointer moves that write the same thing again. */
const attrKey = (a: Record<string, string>) => JSON.stringify(Object.entries(a).sort());

/** A drag that writes attributes on each move, as one undo step (resize, and moving an absolute element). */
function attributeDrag(kind: "resize" | "move", ref: UIElementRef, label: string, map: BoxMap, pointer: Point, compute: (dx: number, dy: number, options: DragOptions) => Record<string, string>): HandleDrag | null {
  const start = map.toLocal(pointer);
  if (!start || !beginUIEdit(label)) return null;
  let last = "";
  let open = true;
  let wrote = false;
  return {
    kind,
    label,
    update(p, options = {}) {
      const at = open ? map.toLocal(p) : null;
      if (!at) return;
      const attrs = compute(at[0] - start[0], at[1] - start[1], options);
      const key = attrKey(attrs);
      if (key === last || Object.keys(attrs).length === 0) return;
      last = key;
      wrote = setUIElementAttributes(ref, attrs, label) || wrote;
    },
    marker: () => null,
    finish() {
      if (!open) return false;
      open = false;
      endUIEdit();
      return wrote;
    },
    cancel() {
      if (!open) return;
      open = false;
      cancelUIEdit();
    },
  };
}

/** Start dragging resize handle `id` of the element at `ref`, pressed at `pointer` (canvas CSS pixels). Null if it can't be resized. */
export function beginResize(ref: UIElementRef, id: HandleId, pointer: Point, boxOf: BoxOf): HandleDrag | null {
  const scene = openScene.peek();
  const el = scene ? resolveUIElement(scene.sync, ref) : null;
  if (!el || whyNoHandles(el)) return null;
  const box = boxOf(el.component), map = box && boxMap(box);
  if (!box || !map) return null;
  const parentBox = el.parent ? boxOf(el.parent.component) : null;
  const pad = el.parent && parentBox ? paddingBox(el.parent, parentBox) : { width: 0, height: 0 };
  const f = fieldsOf(el);
  const start = {
    width: box.size[0],
    height: box.size[1],
    widthValue: f.width,
    heightValue: f.height,
    absolute: f.positionType === "absolute",
    left: f.left,
    top: f.top,
    parentWidth: pad.width,
    parentHeight: pad.height,
  };
  return attributeDrag("resize", ref, `Resize ${elementLabel(el)}`, map, pointer, (dx, dy, o) => resizeAttributes(start, id, dx, dy, o));
}

/**
 * Start moving the element at `ref` from `pointer` (canvas CSS pixels, where the press began): an
 * absolutely positioned element moves; one in flex flow reorders among its siblings. Null if it
 * can't move.
 */
export function beginMove(ref: UIElementRef, pointer: Point, boxOf: BoxOf): HandleDrag | null {
  const scene = openScene.peek();
  const el = scene ? resolveUIElement(scene.sync, ref) : null;
  const parent = el?.parent;
  if (!el || !parent || whyNoHandles(el)) return null;
  const box = boxOf(el.component), parentBox = boxOf(parent.component);
  const map = box && boxMap(box), parentMap = parentBox && boxMap(parentBox);
  if (!box || !map || !parentBox || !parentMap) return null;
  const pad = paddingBox(parent, parentBox);
  const f = fieldsOf(el);
  const label = elementLabel(el);
  if (f.positionType === "absolute") {
    const topLeft = parentMap.toLocal(box.points[0]);
    if (!topLeft) return null;
    const start = { left: f.left, top: f.top, right: f.right, bottom: f.bottom, x: topLeft[0] - pad.x, y: topLeft[1] - pad.y, parentWidth: pad.width, parentHeight: pad.height };
    return attributeDrag("move", ref, `Move ${label}`, map, pointer, (dx, dy, o) => moveAttributes(start, dx, dy, o));
  }
  return reorderDrag(ref, el, parent, parentMap, pad, boxOf, label);
}

/** The siblings in flow (shown, not absolute, written in the file) along the parent's main axis, with the dragged element's markup index. */
function flowSiblings(el: UIDocumentElement, parent: UIDocumentElement, parentMap: BoxMap, boxOf: BoxOf): { siblings: FlowSibling[]; self: number } {
  const column = isColumn(String(fieldsOf(parent).flexDirection ?? "row"));
  const children = parent._markup.children;
  const siblings: FlowSibling[] = [];
  for (const s of parent.children) {
    if (s === el || s._path === null || s._synthetic || !s.node.activeInHierarchy) continue;
    const sf = fieldsOf(s);
    if (sf.positionType === "absolute" || sf.display === "none") continue;
    const index = children.indexOf(s._markup);
    const b = index >= 0 ? boxOf(s.component) : null;
    if (!b) continue;
    const local = b.points.map((p) => parentMap.toLocal(p));
    if (local.some((p) => !p)) continue;
    const along = local.map((p) => p![column ? 1 : 0]);
    siblings.push({ index, start: Math.min(...along), end: Math.max(...along) });
  }
  return { siblings, self: children.indexOf(el._markup) };
}

function reorderDrag(ref: UIElementRef, el: UIDocumentElement, parent: UIDocumentElement, parentMap: BoxMap, pad: { x: number; y: number; width: number; height: number }, boxOf: BoxOf, label: string): HandleDrag | null {
  const direction = String(fieldsOf(parent).flexDirection ?? "row");
  const column = isColumn(direction);
  const { siblings, self } = flowSiblings(el, parent, parentMap, boxOf);
  if (self < 0) return null;
  const parentRef: UIElementRef = { host: ref.host, index: ref.index, path: parent._path ?? "" };
  // The marker spans the parent's content box (inside its padding).
  const p = (parent.component as { padding?: number }).padding;
  const inset = typeof p === "number" && Number.isFinite(p) ? Math.max(0, p) : 0;
  const content = { x: pad.x + inset, y: pad.y + inset, width: Math.max(0, pad.width - 2 * inset), height: Math.max(0, pad.height - 2 * inset) };
  let target: ReorderTarget | null = null;
  let open = true;
  return {
    kind: "reorder",
    label: `Move ${label}`,
    update(p) {
      const at = open ? parentMap.toLocal(p) : null;
      if (at) target = reorderTarget(siblings, at[column ? 1 : 0], self, isReverse(direction));
    },
    marker() {
      if (!open || !target || target.same) return null;
      const m = target.marker;
      const a: Point = column ? [content.x, m] : [m, content.y];
      const b: Point = column ? [content.x + content.width, m] : [m, content.y + content.height];
      return [parentMap.toCanvas(a), parentMap.toCanvas(b)];
    },
    finish() {
      if (!open) return false;
      open = false;
      return !!target && !target.same && moveUIElement(ref, parentRef, target.index);
    },
    cancel() {
      open = false;
    },
  };
}
