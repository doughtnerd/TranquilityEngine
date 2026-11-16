// Popovers: the editor's menus and small floating panels (context menus, the dock's tab menus, the
// Scene toolbar's popovers, the play bar's Gizmos menu, value popovers in graph nodes, the menu bar's
// drop-down). One module owns what they all need, in the window they are in: a popover may render
// in a detached panel window (ADR 0174), so it listens, measures and moves focus there, never in the
// main window by default.
//
// - Placement: at a point (a right-click) or beside an anchor element, measured once drawn and kept
//   inside its window's viewport (flipping to the other side of an anchor element when that fits
//   better). Without an anchor it isn't moved (its CSS places it).
// - Dismissal: a press outside it (and outside the elements counted as inside, such as its toggle
//   button), Escape, its window losing focus, or focus moving out of it to an element outside.
//   Each calls `onDismiss` once; the owner then stops showing it.
// - Focus: optionally its first enabled item when it opens; Escape gives focus back to what had it
//   when it opened.
import { useLayoutEffect, useRef } from "preact/hooks";
import { activeElementOf, isKeyboardEvent, ownerWindowOf } from "../windows/dom";

/** A point in the window's client coordinates. */
export interface PopoverPoint {
  readonly x: number;
  readonly y: number;
}

/** Why the user dismissed a popover. */
export type DismissReason = "outside" | "escape" | "blur" | "focus";

export interface PopoverOptions {
  /**
   * Where it opens. A point: its top-left corner there (its top-right with `align: "end"`). An
   * element: beside it on `side`, aligned with its `align` edge. Omitted: it isn't placed.
   */
  readonly anchor?: PopoverPoint | Element | null;
  /** Which side of an anchor element (default "below"). It flips when the other side has room and this one doesn't. */
  readonly side?: "below" | "above";
  /** Which edge lines up with the anchor (default "start": left edges; "end": right edges). */
  readonly align?: "start" | "end";
  /** Pixels between an anchor element and the popover (default 4; 0 for a point). */
  readonly gap?: number;
  /** Pixels kept between the popover and its window's edges (default 4). */
  readonly margin?: number;
  /** Elements a press in (or focus moving to) doesn't dismiss it: its toggle button, which toggles it itself. */
  readonly inside?: readonly (Element | { readonly current: Element | null } | null | undefined)[];
  /** Escape dismisses it (default true). False for owners that handle Escape themselves. */
  readonly escape?: boolean;
  /** Focus its first enabled item when it opens (menus; default false). */
  readonly focusFirst?: boolean;
  /** The user dismissed it. Called once; the owner stops showing it (and `close` is then a no-op). */
  readonly onDismiss: (reason: DismissReason) => void;
}

export interface Popover {
  /** The window it lives in: the anchor element's, else its own. */
  readonly window: Window;
  /** Measure and place it again (its content changed size). */
  place(): void;
  /** Stop listening (the owner hid it). Idempotent. */
  close(): void;
}

/** What `focusFirst` focuses: the first enabled control, in document order. */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const isPoint = (a: PopoverPoint | Element): a is PopoverPoint => typeof (a as Element).getBoundingClientRect !== "function";
const elementOf = (x: Element | { readonly current: Element | null } | null | undefined): Element | null => (x && "current" in x ? x.current : (x ?? null));

/**
 * Show `el` as a popover: place it, focus it if asked, and dismiss it as the user leaves it. `el`
 * is the popover's own element, already in its document and positioned by its CSS (`position:
 * fixed` when it's placed). Returns its handle; call `close` when the owner hides it.
 */
export function openPopover(el: HTMLElement, options: PopoverOptions): Popover {
  const anchorElement = options.anchor && !isPoint(options.anchor) ? options.anchor : null;
  const win = ownerWindowOf(anchorElement ?? el);
  const opener = activeElementOf(el);
  let open = true;

  const inside = (target: EventTarget | null): boolean => {
    const node = target as Node | null;
    if (!node) return false;
    if (el.contains(node)) return true;
    return (options.inside ?? []).some((x) => elementOf(x)?.contains(node) ?? false);
  };
  const dismiss = (reason: DismissReason) => {
    if (!open) return;
    close();
    if (reason === "escape") {
      const back = opener as HTMLElement | null;
      if (back?.isConnected && typeof back.focus === "function") back.focus();
    }
    options.onDismiss(reason);
  };

  const onPointerDown = (e: Event) => !inside(e.target) && dismiss("outside");
  const onKeyDown = (e: Event) => {
    if (!isKeyboardEvent(e) || e.key !== "Escape" || options.escape === false) return;
    e.stopPropagation(); // not the editor's own Escape handling as well
    dismiss("escape");
  };
  const onBlur = (e: Event) => e.target === win && dismiss("blur");
  // Focus moving to another element outside. (Into nothing, as when the focused item is removed or
  // a separator is clicked, or into another window, which `blur` covers, isn't leaving.)
  const onFocusOut = (e: Event) => {
    const to = (e as FocusEvent).relatedTarget;
    if (to && !inside(to)) dismiss("focus");
  };
  win.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("blur", onBlur);
  el.addEventListener("focusout", onFocusOut);

  function close(): void {
    if (!open) return;
    open = false;
    win.removeEventListener("pointerdown", onPointerDown, true);
    win.removeEventListener("keydown", onKeyDown, true);
    win.removeEventListener("blur", onBlur);
    el.removeEventListener("focusout", onFocusOut);
  }

  function place(): void {
    const anchor = options.anchor;
    if (!anchor) return;
    const margin = options.margin ?? 4;
    // Measured at the window's corner, so its width isn't squeezed by where it happened to be.
    el.style.left = "0px";
    el.style.top = "0px";
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = win.innerWidth, vh = win.innerHeight;
    const point = isPoint(anchor);
    const r = point ? { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y } : anchor.getBoundingClientRect();
    const gap = options.gap ?? (point ? 0 : 4);
    let left = options.align === "end" ? r.right - w : r.left;
    let top: number;
    if (point) top = r.top;
    else {
      const below = r.bottom + gap, above = r.top - gap - h;
      const fitsBelow = below + h <= vh - margin, fitsAbove = above >= margin;
      const side = options.side === "above" ? (fitsAbove || !fitsBelow ? "above" : "below") : fitsBelow || !fitsAbove ? "below" : "above";
      top = side === "above" ? above : below;
    }
    left = Math.max(margin, Math.min(left, vw - w - margin));
    top = Math.max(margin, Math.min(top, vh - h - margin));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  place();
  if (options.focusFirst) el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  return { window: win, place, close };
}

/**
 * `openPopover` on `ref`'s element while `open` is true, from its first layout (before it's painted).
 * It's opened again when `open` turns on, when a point anchor moves or an element anchor changes, and
 * when `key` changes (a new menu at the same place); the latest `onDismiss` is called. The component
 * shouldn't set `left` / `top` on the element when it has an anchor: the popover places it.
 */
export function usePopover(ref: { readonly current: HTMLElement | null }, open: boolean, options: PopoverOptions & { readonly key?: unknown }): void {
  const latest = useRef(options);
  latest.current = options;
  const anchor = options.anchor;
  const at = anchor && isPoint(anchor) ? `${anchor.x},${anchor.y}` : anchor;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const popover = openPopover(el, { ...latest.current, onDismiss: (reason) => latest.current.onDismiss(reason) });
    return () => popover.close();
  }, [open, at, options.key]);
}
