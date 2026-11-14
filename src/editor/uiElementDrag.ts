// Dragging UI document elements in the hierarchy (ADR 0077 §4): near a row's top or bottom edge
// places the element before or after it; the middle of a Canvas or Panel row puts it inside, last.
// Only within the element's own markup file (not across files, nor into scene nodes); releasing
// elsewhere, or Escape, does nothing. One undo step, through `moveUIElement`.
import { signal } from "@preact/signals";
import { openScene } from "./state";
import { moveUIElement, whyNotMovable } from "./uiDocumentEdits";
import { elementLabel, parseUIRefKey, resolveUIElement, uiRefKey, type UIElementRef } from "./uiDocuments";
import { eventWindow } from "./windows/dom";

const DRAG_THRESHOLD = 5;

export interface UIElementDrop {
  /** The row it lands at, and how. */
  readonly row: string;
  /** The row's element, as the hierarchy labels it. */
  readonly label: string;
  readonly mode: "before" | "after" | "into";
  readonly parent: UIElementRef;
  readonly index: number;
}

export interface UIElementDrag {
  readonly key: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly target: UIElementDrop | null;
  readonly problem: string | null;
}

export const uiElementDrag = signal<UIElementDrag | null>(null);

const CONTAINERS: ReadonlySet<string> = new Set(["Canvas", "Panel"]);

/** Where dropping on the row `key` at `fraction` (0 top, 1 bottom) of its height lands, or a reason it can't. */
export function uiDropAt(dragged: UIElementRef, key: string, fraction: number): { target: UIElementDrop | null; problem: string | null } {
  const scene = openScene.peek();
  const ref = parseUIRefKey(key);
  const el = scene && ref ? resolveUIElement(scene.sync, ref) : null;
  if (!scene || !ref || !el) return { target: null, problem: "drop it on an element of the same document" };
  if (el._synthetic) return { target: null, problem: "a button's label is its text content" };
  const label = elementLabel(el);
  const into = CONTAINERS.has(el.tag) && fraction > 0.25 && fraction < 0.75;
  let target: UIElementDrop;
  if (into || !el.parent) {
    target = { row: key, label, mode: "into", parent: ref, index: el._markup.children.length };
  } else {
    const parentRef = { host: ref.host, index: ref.index, path: el.parent._path ?? "" };
    const at = el.parent._markup.children.indexOf(el._markup);
    target = fraction < 0.5 ? { row: key, label, mode: "before", parent: parentRef, index: at } : { row: key, label, mode: "after", parent: parentRef, index: at + 1 };
  }
  if (key === uiRefKey(dragged) && target.mode !== "into") return { target: null, problem: "that's where it is" };
  const problem = whyNotMovable(dragged, target.parent);
  return problem ? { target: null, problem } : { target, problem: null };
}

/** Press on an element row: past the threshold this drags it; releasing over a valid spot moves it. A plain click still selects. */
export function startUIElementDrag(e: PointerEvent, ref: UIElementRef, key: string, label: string): void {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let active = false;
  // The window the drag started in: a detached panel window's own (ADR 0174).
  const win = eventWindow(e);
  const update = (m: PointerEvent) => {
    if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
    active = true;
    const row = (win.document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest<HTMLElement>(".row.ui-element[data-ui-key]");
    let drop: { target: UIElementDrop | null; problem: string | null } = { target: null, problem: "drop it on an element of the same document" };
    if (row) {
      const r = row.getBoundingClientRect();
      drop = uiDropAt(ref, row.dataset.uiKey!, r.height > 0 ? (m.clientY - r.top) / r.height : 0.5);
    }
    uiElementDrag.value = { key, label, x: m.clientX, y: m.clientY, ...drop };
  };
  const finish = (apply: boolean) => {
    win.removeEventListener("pointermove", update);
    win.removeEventListener("pointerup", up);
    win.removeEventListener("pointercancel", cancel);
    win.removeEventListener("keydown", escape, true);
    const state = uiElementDrag.value;
    uiElementDrag.value = null;
    if (apply && active && state?.target) moveUIElement(ref, state.target.parent, state.target.index);
  };
  const up = (m: PointerEvent) => {
    if (active) update(m);
    finish(true);
  };
  const cancel = () => finish(false);
  const escape = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !active) return;
    k.preventDefault();
    k.stopPropagation();
    finish(false);
  };
  win.addEventListener("pointermove", update);
  win.addEventListener("pointerup", up);
  win.addEventListener("pointercancel", cancel);
  win.addEventListener("keydown", escape, true);
}

/** What releasing would do, for the label following the pointer. */
export function uiDropDescription(drag: UIElementDrag): string {
  if (!drag.target) return `${drag.label}: ${drag.problem ?? "can't drop here"}`;
  const verb = { before: "above", after: "below", into: "into" }[drag.target.mode];
  return `Move ${drag.label} ${verb} ${drag.target.label}`;
}

/** The element row being renamed in place (its ref key), or null. */
export const renamingUIElement = signal<string | null>(null);
