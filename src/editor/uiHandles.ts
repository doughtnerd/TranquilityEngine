// Moving and resizing UI document elements in the scene view (ADR 0077 §4, wave B part 3).
//
// The selected element gets eight resize handles (corners and edges) on its box, drawn in an SVG
// overlay over the viewport like its outline (`uiOutline.ts`): theme-token colours, no renderer
// code. Dragging a handle sets `width`/`height` (and `left`/`top` when the west or north edge of an
// element placed by them moves); dragging the box itself moves an absolutely positioned element
// (`left`/`top`, or `right`/`bottom` when those place it) or, in flex flow, reorders it among its
// siblings, with an insertion marker across the parent along its main axis. The maths, and the
// decisions about percentages, aspect ratio and snapping, are `uiHandleMath.ts`.
//
// A handle or move drag is one undo step: `beginUIEdit`, `setUIElementAttributes` on each pointer
// move (the file is rewritten as the drag goes and the document rebuilds under it), `endUIEdit`;
// Escape puts the files back (`cancelUIEdit`). A reorder is one `moveUIElement` on release. A press
// on the box that doesn't travel `MOVE_THRESHOLD` pixels is a click, which `viewportSelection.ts`
// handles as before (select, click again to cycle). Handles show only where the element can be
// edited (not in read-only projects, play mode, list rows or a button's label, nor the root); the
// outline still shows there.
import type { Engine, UIDocumentElement } from "../engine";
import type { World } from "../engine/core/World";
import { uiElementBox, viewportCanvas } from "../engine/editor";
import type { UIComponentType } from "../engine/ui/components";
import { openScene } from "./state";
import { beginUIEdit, cancelUIEdit, endUIEdit, moveUIElement, setUIElementAttributes, whyNotEditableUI } from "./uiDocumentEdits";
import {
  boxMap,
  handleCursor,
  handlePoints,
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
import { elementLabel, resolveUIElement, selectedUIRef, type UIElementRef } from "./uiDocuments";
import { viewportElements } from "./ui/ScenePanel";

/** Pointer travel (CSS pixels) before a press on the box becomes a move (as a click's slop in `viewportSelection.ts`). */
export const MOVE_THRESHOLD = 4;
const HANDLE_SIZE = 8;

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
export function flowSiblings(el: UIDocumentElement, parent: UIDocumentElement, parentMap: BoxMap, boxOf: BoxOf): { siblings: FlowSibling[]; self: number } {
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

/** True when a press at canvas point `p` is on the selected element's box and its handles are shown (a drag there moves it). */
export function pressOnSelectedUI(world: World, p: Point): boolean {
  const scene = openScene.peek(), ref = selectedUIRef();
  const el = scene && ref ? resolveUIElement(scene.sync, ref) : null;
  if (!el || !el.node.activeInHierarchy || whyNoHandles(el)) return false;
  const box = uiElementBox(world, el.component), map = box && boxMap(box);
  const at = map?.toLocal(p);
  return !!box && !!at && at[0] >= 0 && at[1] >= 0 && at[0] <= box.size[0] && at[1] <= box.size[1];
}

const SVG = "http://www.w3.org/2000/svg";

/** Draw the selected element's handles over the viewport and turn drags on them (and on its box) into edits, until the returned function is called. */
export function installUIHandles(engine: Engine): () => void {
  const world = engine.world;
  const canvas = viewportCanvas(world);
  if (!canvas) return () => {};
  const host = viewportElements().viewport;
  const boxOf: BoxOf = (c) => uiElementBox(world, c);
  const svg = document.createElementNS(SVG, "svg");
  svg.classList.add("ui-element-handles");
  svg.setAttribute("aria-hidden", "true");
  const marker = document.createElementNS(SVG, "line");
  marker.classList.add("ui-insert-marker");
  svg.appendChild(marker);
  const handles = new Map<HandleId, SVGRectElement>();
  host.appendChild(svg);

  let drag: { drag: HandleDrag; pointerId: number; target: Element } | null = null;
  /** A press on the box, until it travels far enough to move or is released as a click. */
  let pending: { ref: UIElementRef; x: number; y: number; pointerId: number } | null = null;

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const options = (e: PointerEvent): DragOptions => ({ keepAspect: e.shiftKey, snap: !e.altKey });

  const stop = (apply: boolean) => {
    const d = drag;
    drag = null;
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", onDragUp, true);
    window.removeEventListener("pointercancel", onDragCancel, true);
    window.removeEventListener("keydown", onKey, true);
    if (!d) return;
    try {
      (d.target as Element & { releasePointerCapture?(id: number): void }).releasePointerCapture?.(d.pointerId);
    } catch {
      // already released
    }
    if (apply) d.drag.finish();
    else d.drag.cancel();
  };
  const startDrag = (d: HandleDrag, e: PointerEvent, target: Element) => {
    drag = { drag: d, pointerId: e.pointerId, target };
    try {
      (target as Element & { setPointerCapture?(id: number): void }).setPointerCapture?.(e.pointerId);
    } catch {
      // the pointer may be gone
    }
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerup", onDragUp, true);
    window.addEventListener("pointercancel", onDragCancel, true);
    window.addEventListener("keydown", onKey, true);
  };
  const onDragMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopPropagation();
    drag.drag.update(local(e), options(e));
  };
  const onDragUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.drag.update(local(e), options(e));
    stop(true);
  };
  const onDragCancel = () => stop(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    e.stopPropagation();
    stop(false);
  };

  const onHandleDown = (id: HandleId) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const ref = selectedUIRef();
    const d = ref ? beginResize(ref, id, local(e), boxOf) : null;
    if (d) startDrag(d, e, e.currentTarget as Element);
  };
  for (const id of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as HandleId[]) {
    const r = document.createElementNS(SVG, "rect");
    r.classList.add("ui-handle");
    r.dataset.handle = id;
    r.setAttribute("width", String(HANDLE_SIZE));
    r.setAttribute("height", String(HANDLE_SIZE));
    r.style.cursor = handleCursor(id);
    r.addEventListener("pointerdown", onHandleDown(id));
    svg.appendChild(r);
    handles.set(id, r);
  }

  // The box: a press there may become a move once it travels; otherwise it's a click (viewportSelection).
  const onCanvasDown = (e: PointerEvent) => {
    pending = null;
    if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || drag) return;
    const p = local(e), ref = selectedUIRef();
    if (ref && pressOnSelectedUI(world, p)) pending = { ref, x: p[0], y: p[1], pointerId: e.pointerId };
  };
  const onCanvasMove = (e: PointerEvent) => {
    if (!pending || drag || e.pointerId !== pending.pointerId) return;
    const p = local(e);
    if (Math.hypot(p[0] - pending.x, p[1] - pending.y) < MOVE_THRESHOLD) return;
    const { ref, x, y } = pending;
    pending = null;
    const d = beginMove(ref, [x, y], boxOf);
    if (!d) return;
    startDrag(d, e, canvas);
    d.update(p, options(e));
  };
  const onCanvasUp = () => (pending = null);
  canvas.addEventListener("pointerdown", onCanvasDown);
  canvas.addEventListener("pointermove", onCanvasMove);
  canvas.addEventListener("pointerup", onCanvasUp);

  let raf = 0;
  let last = "";
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const scene = openScene.peek(), ref = selectedUIRef();
    const el = scene && ref ? resolveUIElement(scene.sync, ref) : null;
    const box = el && el.node.activeInHierarchy && !whyNoHandles(el) ? uiElementBox(world, el.component) : null;
    const map = box && boxMap(box);
    const c = canvas.getBoundingClientRect(), h = host.getBoundingClientRect();
    const dx = c.left - h.left, dy = c.top - h.top;
    const points = map && box ? handlePoints(map, box.size) : [];
    const line = drag?.drag.marker() ?? null;
    const state = JSON.stringify([points.map((p) => p.at.map((v) => Math.round(v * 2))), line, dx, dy, !!drag && drag.drag.kind]);
    if (state === last) return;
    last = state;
    // While moving or reordering, the handles step aside; while resizing they follow the box.
    const showHandles = points.length > 0 && (!drag || drag.drag.kind === "resize");
    svg.style.display = showHandles || line ? "" : "none";
    for (const { id, at } of points) {
      const r = handles.get(id)!;
      r.setAttribute("x", (at[0] + dx - HANDLE_SIZE / 2).toFixed(1));
      r.setAttribute("y", (at[1] + dy - HANDLE_SIZE / 2).toFixed(1));
    }
    for (const r of handles.values()) r.style.display = showHandles ? "" : "none";
    marker.style.display = line ? "" : "none";
    if (line) {
      marker.setAttribute("x1", (line[0][0] + dx).toFixed(1));
      marker.setAttribute("y1", (line[0][1] + dy).toFixed(1));
      marker.setAttribute("x2", (line[1][0] + dx).toFixed(1));
      marker.setAttribute("y2", (line[1][1] + dy).toFixed(1));
    }
  };
  svg.style.display = "none";
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    stop(false);
    canvas.removeEventListener("pointerdown", onCanvasDown);
    canvas.removeEventListener("pointermove", onCanvasMove);
    canvas.removeEventListener("pointerup", onCanvasUp);
    svg.remove();
  };
}
