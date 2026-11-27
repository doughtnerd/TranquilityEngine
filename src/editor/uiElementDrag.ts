// Dragging UI elements in the hierarchy (ADR 0077 §4, ADR 0423 wave C): an element a UIView rendered drags within its
// `.svelte` file: near a row's top or bottom edge places it before or after a static element; the middle of a
// container's row puts it inside, last. Not across files, nor into scene nodes; view-only elements don't drag, nor
// take drops; releasing elsewhere, or Escape, does nothing. One undo step, through `moveUIViewElement`. The gesture is
// the editor's one row drag (`pointerDrag.ts`, ADR 0278).
import { signal } from "@preact/signals";
import { openScene } from "./state";
import { startPointerDrag } from "./pointerDrag";
import { parseUIViewRefKey, resolveUIViewElement, sourceOfFile, uiViewRefKey, viewElementLabel, whyViewOnly, type UIViewRef } from "./uiViews";
import { moveUIViewElement, whyNotMovableView, type UIViewAt } from "./uiViewEdits";
import { elementAtLocation, lineColumnAt as lineColumn } from "./uiEdit/svelteText";

export interface UIElementDrop {
  /** The row it lands at, and how. */
  readonly row: string;
  /** The row's element, as the hierarchy labels it. */
  readonly label: string;
  readonly mode: "before" | "after" | "into";
  /** A view's element or its top level. */
  readonly parent: UIViewRef | UIViewAt;
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

/** UI tags that hold dragged elements dropped on their middle. */
const VIEW_CONTAINERS: ReadonlySet<string> = new Set(["Panel", "Form", "Label", "Select"]);

/** Where dropping a view's element on the row `key` at `fraction` of its height lands, or a reason it can't. */
function viewDropAt(dragged: UIViewRef, key: string, fraction: number): { target: UIElementDrop | null; problem: string | null } {
  const scene = openScene.peek();
  const ref = parseUIViewRefKey(key);
  const el = scene && ref ? resolveUIViewElement(scene.sync, ref) : null;
  if (!scene || !ref || !el) return { target: null, problem: "drop it on an element of the same view" };
  const why = whyViewOnly(scene.sync, ref);
  if (why) return { target: null, problem: why };
  const src = sourceOfFile(ref.file);
  const written = src ? elementAtLocation(src, ref.line, ref.column) : null;
  if (!written) return { target: null, problem: "it's gone" };
  const label = viewElementLabel(el);
  const into = VIEW_CONTAINERS.has(el.uiTag) && fraction > 0.25 && fraction < 0.75;
  let target: UIElementDrop;
  if (into) target = { row: key, label, mode: "into", parent: ref, index: written.children.length };
  else {
    if (written.block) return { target: null, problem: `it's inside ${written.block}` };
    const parentRef: UIViewRef | UIViewAt = written.parent ? { ...ref, ...lineColumn(src!.text, written.parent.start), nth: 0 } : { host: ref.host, index: ref.index };
    target = fraction < 0.5 ? { row: key, label, mode: "before", parent: parentRef, index: written.index } : { row: key, label, mode: "after", parent: parentRef, index: written.index + 1 };
  }
  if (key === uiViewRefKey(dragged) && target.mode !== "into") return { target: null, problem: "that's where it is" };
  const problem = whyNotMovableView(scene, dragged, target.parent as UIViewRef | UIViewAt);
  return problem ? { target: null, problem } : { target, problem: null };
}

/** Press on a view element's row: past the threshold this drags it; releasing over a valid spot moves it in its file. */
export function startUIViewElementDrag(e: PointerEvent, ref: UIViewRef, key: string, label: string): void {
  startPointerDrag(e, {
    move: (m, doc) => {
      const row = (doc.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest<HTMLElement>(".row.ui-element[data-ui-key]");
      let drop: { target: UIElementDrop | null; problem: string | null } = { target: null, problem: "drop it on an element of the same view" };
      if (row) {
        const r = row.getBoundingClientRect();
        drop = viewDropAt(ref, row.dataset.uiKey!, r.height > 0 ? (m.clientY - r.top) / r.height : 0.5);
      }
      uiElementDrag.value = { key, label, x: m.clientX, y: m.clientY, ...drop };
    },
    end: (apply) => {
      const state = uiElementDrag.value;
      uiElementDrag.value = null;
      if (apply && state?.target) moveUIViewElement(ref, state.target.parent as UIViewRef | UIViewAt, state.target.index);
    },
  });
}

/** What releasing would do, for the label following the pointer. */
export function uiDropDescription(drag: UIElementDrag): string {
  if (!drag.target) return `${drag.label}: ${drag.problem ?? "can't drop here"}`;
  const verb = { before: "above", after: "below", into: "into" }[drag.target.mode];
  return `Move ${drag.label} ${verb} ${drag.target.label}`;
}
