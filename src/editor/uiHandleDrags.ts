// The edits behind the scene view's UI handles (ADR 0077 §4, wave B part 3; ADR 0423 wave C): which elements get
// handles, and the resize, move and reorder drags, each one undo step over the element's file (see
// uiHandles.ts, which draws the handles and turns pointer events into these drags). A drag reads
// boxes on the canvas through the `BoxOf` it's given.
//
// The elements are those a UIView renders from a Svelte component, reached through a `HandleSubject` (the element,
// its parent and flow siblings with their places in the file, and the edits that write attributes or reorder it); on
// a view's dynamic parts (expressions, `{#each}` rows, child components) handles are refused with the reason.
import type { UIComponentType } from "../engine/ui/components";
import type { UIHostElement } from "../engine/ui/host/UIHost";
import { uiBorderEdges } from "../engine/ui/layout";
import { hasTransform, type UITransformFields } from "../engine/ui/transform2d";
import { openScene } from "./state";
import type { UndoStep } from "./undoStep";
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
import { refOfViewElement, resolveUIViewElement, sourceOfFile, viewElementLabel, type UIViewRef } from "./uiViews";
import { beginUIViewEdit, moveUIViewElement, setUIViewElementAttributes, whyNotEditViewElement } from "./uiViewEdits";
import { elementAtLocation } from "./uiEdit/svelteText";

/** A UI component's box on the viewport canvas (CSS pixels) with its size in UI pixels, or null. */
export type BoxOf = (c: UIComponentType) => BoxOnCanvas | null;

/** A UI element as the handles see it: its component, whether it's shown, its parent and its place among the elements written beside it (-1: none). */
interface HandleElement {
  readonly component: UIComponentType;
  readonly active: boolean;
  readonly parent: HandleElement | null;
  readonly index: number;
  readonly children: readonly HandleElement[];
}

/** What a drag acts on: the element, and the edits that write it (its view's `.svelte` source). */
interface HandleSubject {
  readonly el: HandleElement;
  readonly label: string;
  /** Why it gets no handles, or null. */
  readonly whyNot: string | null;
  begin(label: string): UndoStep | null;
  setAttributes(attributes: Record<string, string>, label: string): boolean;
  /** Move it to be the `index`th element written in its parent (as `moveUIViewElement` counts). */
  reorder(index: number): boolean;
}

function viewElement(el: UIHostElement): HandleElement {
  return {
    component: el.component,
    get active() {
      return el.node.activeInHierarchy;
    },
    get parent() {
      return el.parent ? viewElement(el.parent) : null;
    },
    get index() {
      const s = el.source, src = s ? sourceOfFile(s.file) : null;
      const at = s && src ? elementAtLocation(src, s.line, s.column) : null;
      return at && !at.block && !at.repeated ? at.index : -1;
    },
    get children() {
      return el.children.filter((c) => !c.synthetic).map(viewElement);
    },
  };
}

/** The subject of a drag on the element `ref` names, or null when it's gone. */
function subjectOf(ref: UIViewRef): HandleSubject | null {
  const scene = openScene.peek();
  if (!scene) return null;
  const el = resolveUIViewElement(scene.sync, ref);
  if (!el) return null;
  const parentRef = el.parent?.source ? refOfViewElement(scene.sync, el.parent) : null;
  const why = whyNotEditViewElement(scene, ref) ?? (el.parent ? null : "the root fills its canvas");
  return {
    el: viewElement(el),
    label: viewElementLabel(el),
    whyNot: why,
    begin: (label) => beginUIViewEdit(label),
    setAttributes: (attributes, label) => setUIViewElementAttributes(ref, attributes, label),
    reorder: (index) => moveUIViewElement(ref, parentRef ?? { host: ref.host, index: ref.index }, index),
  };
}

/** Why the scene view shows no handles on the element `ref` names (outline only), or null when it does. */
export function whyNoHandles(ref: UIViewRef): string | null {
  const s = subjectOf(ref);
  return s ? s.whyNot : "it's gone";
}

/** The element a ref names, for the handles' overlay: its component and whether it's shown, or null. */
export function handleElement(ref: UIViewRef): { readonly component: UIComponentType; readonly active: boolean } | null {
  return subjectOf(ref)?.el ?? null;
}

/** The parent's padding box (inside its border) in its own frame, UI pixels: origin and size. */
function paddingBox(parent: HandleElement, box: BoxOnCanvas): { x: number; y: number; width: number; height: number } {
  const [top, right, bottom, left] = uiBorderEdges(parent.component); // each side's own width (ADR 0422)
  return { x: left, y: top, width: Math.max(0, box.size[0] - left - right), height: Math.max(0, box.size[1] - top - bottom) };
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

const fieldsOf = (el: HandleElement) => el.component as unknown as Record<string, unknown>;

/** Attributes as a stable string, to skip pointer moves that write the same thing again. */
const attrKey = (a: Record<string, string>) => JSON.stringify(Object.entries(a).sort());

/** A drag that writes attributes on each move, as one undo step (resize, and moving an absolute element). */
function attributeDrag(kind: "resize" | "move", subject: HandleSubject, label: string, map: BoxMap, pointer: Point, compute: (dx: number, dy: number, options: DragOptions) => Record<string, string>): HandleDrag | null {
  const start = map.toLocal(pointer);
  const step = start && subject.begin(label);
  if (!start || !step) return null;
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
      wrote = subject.setAttributes(attrs, label) || wrote;
    },
    marker: () => null,
    finish() {
      if (!open) return false;
      open = false;
      step.end();
      return wrote;
    },
    cancel() {
      if (!open) return;
      open = false;
      step.cancel();
    },
  };
}

/** Start dragging resize handle `id` of the element at `ref`, pressed at `pointer` (canvas CSS pixels). Null if it can't be resized. */
export function beginResize(ref: UIViewRef, id: HandleId, pointer: Point, boxOf: BoxOf): HandleDrag | null {
  const subject = subjectOf(ref);
  if (!subject || subject.whyNot) return null;
  const el = subject.el;
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
    // ADR 0422 wave 3: with a transform of its own, the box's frame isn't its parent's, where left/top are: size only.
    absolute: f.positionType === "absolute" && !hasTransform(el.component as unknown as UITransformFields),
    left: f.left,
    top: f.top,
    parentWidth: pad.width,
    parentHeight: pad.height,
  };
  return attributeDrag("resize", subject, `Resize ${subject.label}`, map, pointer, (dx, dy, o) => resizeAttributes(start, id, dx, dy, o));
}

/**
 * Start moving the element at `ref` from `pointer` (canvas CSS pixels, where the press began): an
 * absolutely positioned element moves; one in flex flow reorders among its siblings. Null if it
 * can't move.
 */
export function beginMove(ref: UIViewRef, pointer: Point, boxOf: BoxOf): HandleDrag | null {
  const subject = subjectOf(ref);
  const el = subject?.el;
  const parent = el?.parent;
  if (!subject || !el || !parent || subject.whyNot) return null;
  const box = boxOf(el.component), parentBox = boxOf(parent.component);
  const map = box && boxMap(box), parentMap = parentBox && boxMap(parentBox);
  if (!box || !map || !parentBox || !parentMap) return null;
  const pad = paddingBox(parent, parentBox);
  const f = fieldsOf(el);
  const label = subject.label;
  if (f.positionType === "absolute") {
    // ADR 0422 wave 3: offsets are in the parent's frame, from where layout put the box (its own translate aside).
    const topLeft = parentMap.toLocal((box.layoutPoints ?? box.points)[0]);
    if (!topLeft) return null;
    const start = { left: f.left, top: f.top, right: f.right, bottom: f.bottom, x: topLeft[0] - pad.x, y: topLeft[1] - pad.y, parentWidth: pad.width, parentHeight: pad.height };
    return attributeDrag("move", subject, `Move ${label}`, parentMap, pointer, (dx, dy, o) => moveAttributes(start, dx, dy, o));
  }
  return reorderDrag(subject, el, parent, parentMap, pad, boxOf, label);
}

/** The siblings in flow (shown, not absolute, written in the file) along the parent's main axis, with the dragged element's markup index. */
function flowSiblings(el: HandleElement, parent: HandleElement, parentMap: BoxMap, boxOf: BoxOf): { siblings: FlowSibling[]; self: number } {
  const column = isColumn(String(fieldsOf(parent).flexDirection ?? "row"));
  const siblings: FlowSibling[] = [];
  for (const s of parent.children) {
    if (s.component === el.component || s.index < 0 || !s.active) continue;
    const sf = fieldsOf(s);
    if (sf.positionType === "absolute" || sf.display === "none") continue;
    const index = s.index;
    const b = index >= 0 ? boxOf(s.component) : null;
    if (!b) continue;
    const local = b.points.map((p) => parentMap.toLocal(p));
    if (local.some((p) => !p)) continue;
    const along = local.map((p) => p![column ? 1 : 0]);
    siblings.push({ index, start: Math.min(...along), end: Math.max(...along) });
  }
  return { siblings, self: el.index };
}

function reorderDrag(subject: HandleSubject, el: HandleElement, parent: HandleElement, parentMap: BoxMap, pad: { x: number; y: number; width: number; height: number }, boxOf: BoxOf, label: string): HandleDrag | null {
  const direction = String(fieldsOf(parent).flexDirection ?? "row");
  const column = isColumn(direction);
  const { siblings, self } = flowSiblings(el, parent, parentMap, boxOf);
  if (self < 0) return null;
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
      return !!target && !target.same && subject.reorder(target.index);
    },
    cancel() {
      open = false;
    },
  };
}
