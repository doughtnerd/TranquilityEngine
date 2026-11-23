// Label scrubbing (owner's prototype, spec §1.3/§3.4; the rules are `scrubModel.ts`'s). Two ways in:
//
// - `useLabelScrub(handlers)`: props for a component's own label (`NumberField`, `SliderField`, `ParameterRow`), which
//   reports values as `onValue(v, drag)`: drag true while it moves, then the last value with false on release (one undo
//   step per gesture), or the start value with false after Escape.
// - `installLabelScrub(root)`: every number field's label under `root` scrubs with no work in the screen, as the
//   prototype's script does. A label scrubs when it is a short text close to exactly one number field (`<label for>`
//   naming it, or within three parents of it), and never from inside buttons, links, timeline clips or lanes, other
//   inputs, or anything marked `data-noscrub`. While it drags it fires `input` on the field at every step and one
//   `change` on release (Escape: back to the start text, then `change`), so a screen's `onChange` commits once and its
//   `onInput` follows live. Hovering such a label shows the ew-resize cursor and the tooltip.
import { useRef } from "preact/hooks";
import { SCRUB_DEAD_ZONE_PX, SCRUB_TOOLTIP, startTextScrub, textScrubValue, type ScrubMods, type TextScrub } from "./scrubModel";

export { SCRUB_TOOLTIP } from "./scrubModel";

const SKIP = 'input,select,textarea,button,a,[contenteditable="true"],svg,[data-clip],[data-lane],[role="button"],[role="option"],[role="tab"],[role="slider"],[draggable="true"],[data-noscrub]';
const FIELDS = 'input[type="number"],input[type="text"],input:not([type])';

function scrubbable(el: Element | null): el is HTMLInputElement {
  if (!el || el.tagName !== "INPUT") return false;
  const input = el as HTMLInputElement;
  if (input.disabled || input.readOnly || input.closest("[data-noscrub]")) return false;
  return startTextScrub(input) !== null;
}

const fieldsIn = (el: Element): HTMLInputElement[] => [...el.querySelectorAll(FIELDS)].filter(scrubbable);

/** The number field a press on `target` scrubs, or null. */
export function scrubTarget(target: EventTarget | null): HTMLInputElement | null {
  const t = target as Element | null;
  if (!t || t.nodeType !== 1 || t.closest(SKIP)) return null;
  const text = (t.textContent ?? "").trim();
  if (!text || text.length > 48) return null;
  const label = t.closest("label");
  if (label?.htmlFor) {
    const f = t.ownerDocument.getElementById(label.htmlFor);
    if (scrubbable(f)) return f;
    if (f instanceof HTMLInputElement && f.type === "range" && f.parentElement) {
      const near = fieldsIn(f.parentElement);
      if (near.length === 1) return near[0]!;
    }
  }
  let a: Element | null = t;
  for (let i = 0; i < 3 && a?.parentElement; i++) {
    a = a.parentElement;
    if (a.matches(SKIP)) return null;
    const near = fieldsIn(a);
    if (near.length > 1) return null;
    if (near.length === 1) return a.childElementCount > 6 ? null : near[0]!;
  }
  return null;
}

const setValue = (input: HTMLInputElement, text: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, text);
  else input.value = text;
};

/** The document-wide drag look: the resize cursor everywhere and no text selection. */
function dragLook(doc: Document, on: boolean) {
  doc.documentElement.style.cursor = on ? "ew-resize" : "";
  doc.documentElement.style.userSelect = on ? "none" : "";
}

/** Every number field's label under `root` scrubs (see the header). Returns the uninstaller. */
export function installLabelScrub(root: Document | HTMLElement): () => void {
  const doc = root instanceof Document ? root : root.ownerDocument;
  let hovered: HTMLElement | null = null;
  let addedTitle = false;
  let drag: { input: HTMLInputElement; label: Element; scrub: TextScrub; x: number; id: number; on: boolean; startText: string; last: string } | null = null;
  let swallow = false;
  const inside = (t: EventTarget | null) => t instanceof Node && root.contains(t);

  const clearHover = () => {
    if (!hovered) return;
    hovered.style.cursor = "";
    if (addedTitle) hovered.removeAttribute("title");
    hovered = null;
    addedTitle = false;
  };
  const onOver = (e: PointerEvent) => {
    if (drag || e.target === hovered) return;
    clearHover();
    if (!inside(e.target) || !scrubTarget(e.target)) return;
    hovered = e.target as HTMLElement;
    hovered.style.cursor = "ew-resize";
    if (!hovered.title) {
      hovered.title = SCRUB_TOOLTIP;
      addedTitle = true;
    }
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !inside(e.target)) return;
    const input = scrubTarget(e.target);
    const scrub = input && startTextScrub(input);
    if (!input || !scrub) return;
    drag = { input, label: e.target as Element, scrub, x: e.clientX, id: e.pointerId, on: false, startText: input.value, last: input.value };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    let dx = e.clientX - drag.x;
    if (!drag.on) {
      if (Math.abs(dx) < SCRUB_DEAD_ZONE_PX) return;
      drag.on = true;
      drag.x = e.clientX;
      dx = 0;
      try {
        (drag.label as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // The label left the document.
      }
      dragLook(doc, true);
    }
    e.preventDefault();
    const text = textScrubValue(drag.scrub, dx, { shift: e.shiftKey, alt: e.altKey });
    if (text === drag.last) return;
    drag.last = text;
    setValue(drag.input, text);
    drag.input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const end = (cancel: boolean) => {
    const d = drag;
    drag = null;
    if (!d?.on) return;
    if (cancel) {
      setValue(d.input, d.startText);
      d.input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (d.input.value !== d.startText || cancel) d.input.dispatchEvent(new Event("change", { bubbles: true }));
    swallow = true;
    setTimeout(() => (swallow = false), 0);
    dragLook(doc, false);
  };
  const onUp = (e: PointerEvent) => drag && e.pointerId === drag.id && end(false);
  const onCancel = () => end(true);
  const onKey = (e: KeyboardEvent) => {
    if (drag?.on && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      end(true);
    }
  };
  const onClick = (e: MouseEvent) => {
    if (!swallow) return;
    e.preventDefault();
    e.stopPropagation();
    swallow = false;
  };
  const opts = { capture: true } as const;
  doc.addEventListener("pointerover", onOver, opts);
  doc.addEventListener("pointerdown", onDown, opts);
  doc.addEventListener("pointermove", onMove, opts);
  doc.addEventListener("pointerup", onUp, opts);
  doc.addEventListener("pointercancel", onCancel, opts);
  doc.addEventListener("keydown", onKey, opts);
  doc.addEventListener("click", onClick, opts);
  return () => {
    clearHover();
    doc.removeEventListener("pointerover", onOver, opts);
    doc.removeEventListener("pointerdown", onDown, opts);
    doc.removeEventListener("pointermove", onMove, opts);
    doc.removeEventListener("pointerup", onUp, opts);
    doc.removeEventListener("pointercancel", onCancel, opts);
    doc.removeEventListener("keydown", onKey, opts);
    doc.removeEventListener("click", onClick, opts);
  };
}

export interface LabelScrubHandlers {
  /** The value a scrub starts from, or null when the field can't change (disabled, read-only). */
  begin(): number | null;
  /** The value `dx` pixels from the start with `mods` (`scrubNumber`, or a range-relative rule). */
  valueAt(start: number, dx: number, mods: ScrubMods): number;
  onValue(value: number, drag: boolean): void;
}

/** Props for a label that scrubs its field (spread them on the `<label>`); it carries `data-noscrub`, so `installLabelScrub` leaves it to these. */
export function useLabelScrub(handlers: LabelScrubHandlers) {
  const h = useRef(handlers);
  h.current = handlers;
  const drag = useRef<{ x: number; start: number; last: number; on: boolean; id: number; stop: () => void } | null>(null);
  const swallow = useRef(false);
  const finish = (el: Element, keep: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    d.stop();
    if (!d.on) return;
    dragLook(el.ownerDocument, false);
    swallow.current = true;
    setTimeout(() => (swallow.current = false), 0);
    h.current.onValue(keep ? d.last : d.start, false);
  };
  return {
    "data-noscrub": "",
    onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      const start = h.current.begin();
      if (start === null) return;
      const el = e.currentTarget as HTMLElement;
      const view = el.ownerDocument.defaultView ?? window;
      const onKey = (k: KeyboardEvent) => {
        if (k.key !== "Escape" || !drag.current?.on) return;
        k.preventDefault();
        k.stopImmediatePropagation();
        finish(el, false);
      };
      view.addEventListener("keydown", onKey, true);
      drag.current = { x: e.clientX, start, last: start, on: false, id: e.pointerId, stop: () => view.removeEventListener("keydown", onKey, true) };
    },
    onPointerMove(e: PointerEvent) {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      let dx = e.clientX - d.x;
      if (!d.on) {
        if (Math.abs(dx) < SCRUB_DEAD_ZONE_PX) return;
        d.on = true;
        d.x = e.clientX;
        dx = 0;
        const el = e.currentTarget as HTMLElement;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // A synthetic pointer.
        }
        dragLook(el.ownerDocument, true);
      }
      e.preventDefault();
      const v = h.current.valueAt(d.start, dx, { shift: e.shiftKey, alt: e.altKey });
      if (v === d.last) return;
      d.last = v;
      h.current.onValue(v, true);
    },
    onPointerUp(e: PointerEvent) {
      finish(e.currentTarget as Element, true);
    },
    onPointerCancel(e: PointerEvent) {
      finish(e.currentTarget as Element, false);
    },
    onClickCapture(e: MouseEvent) {
      if (!swallow.current) return;
      e.preventDefault();
      e.stopPropagation();
      swallow.current = false;
    },
  };
}
