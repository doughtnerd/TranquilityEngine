// Moving and resizing UI elements in the scene view (ADR 0077 §4, wave B part 3; ADR 0419 wave C: the elements a
// UIView renders from a Svelte component).
//
// The selected element gets eight resize handles (corners and edges) on its box, drawn in an SVG
// overlay over the viewport like its outline (`uiOutline.ts`): theme-token colours, no renderer
// code. Dragging a handle sets `width`/`height` (and `left`/`top` when the west or north edge of an
// element placed by them moves); dragging the box itself moves an absolutely positioned element
// (`left`/`top`, or `right`/`bottom` when those place it) or, in flex flow, reorders it among its
// siblings, with an insertion marker across the parent along its main axis. The maths, and the
// decisions about percentages, aspect ratio and snapping, are `uiHandleMath.ts`; the drags' edits are `uiHandleDrags.ts`.
//
// A handle or move drag is one undo step: `beginUIEdit`, `setUIElementAttributes` on each pointer
// move (the file is rewritten as the drag goes and the view re-renders under it), `endUIEdit`;
// Escape puts the files back (`cancelUIEdit`). A reorder is one `moveUIElement` on release. A press
// on the box that doesn't travel `MOVE_THRESHOLD` pixels is a click, which `viewportSelection.ts`
// handles as before (select, click again to cycle). Handles show only where the element can be
// edited (not in read-only projects, play mode, list rows or a button's label, nor the root); the
// outline still shows there.
import type { Engine } from "../engine";
import type { World } from "../engine/core/World";
import { viewport, viewportCanvas } from "../engine/editor";
import { openScene } from "./state";
import { boxMap, handleCursor, handlePoints, type DragOptions, type HandleId, type Point } from "./uiHandleMath";
import { beginMove, beginResize, handleElement, whyNoHandles, type BoxOf, type HandleDrag } from "./uiHandleDrags";
import { selectedUIViewRef, type UIViewRef } from "./uiViews";

/** The selected UI element's ref (one a UIView rendered, ADR 0419 wave C). */
const selectedRef = (): UIViewRef | null => selectedUIViewRef();
import { viewportElements } from "./ui/ScenePanel";

/** Pointer travel (CSS pixels) before a press on the box becomes a move (as a click's slop in `viewportSelection.ts`). */
const MOVE_THRESHOLD = 4;
const HANDLE_SIZE = 8;

/** True when a press at canvas point `p` is on the selected element's box and its handles are shown (a drag there moves it). */
export function pressOnSelectedUI(world: World, p: Point): boolean {
  const ref = selectedRef();
  const el = openScene.peek() && ref ? handleElement(ref) : null;
  if (!ref || !el || !el.active || whyNoHandles(ref)) return false;
  const box = viewport(world).uiElementBox(el.component), map = box && boxMap(box);
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
  const boxOf: BoxOf = (c) => viewport(world).uiElementBox(c);
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
  let pending: { ref: UIViewRef; x: number; y: number; pointerId: number } | null = null;

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
    const ref = selectedRef();
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
    const p = local(e), ref = selectedRef();
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
    const ref = selectedRef();
    const el = openScene.peek() && ref ? handleElement(ref) : null;
    const box = ref && el && el.active && !whyNoHandles(ref) ? viewport(world).uiElementBox(el.component) : null;
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
