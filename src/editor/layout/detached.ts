// Detached panel windows (ADR 0174): which of the layout's windows are open, opening and closing them,
// and keeping the layout and the real windows in step. The windows themselves come from
// `openChildWindow` (windows/childWindow.ts); `DetachedWindows.tsx` renders a dock layout into each.
//
// - Detach (a header menu) opens a window from the click and moves the panel into it.
// - A window the user closes closes its panels (they can be added again). Closing the main window
//   closes its windows too but keeps them in the layout, so they come back next time.
// - A layout holding windows (at start-up, or picked from the Layouts menu) opens them; where the
//   browser blocks a pop-up that wasn't started by a click, they wait in `pendingWindows` for the
//   banner's Open button (or Dock Here, which moves their panels into the main window).
import { computed, effect, signal } from "@preact/signals";
import { openChildWindow, type ChildWindowHandle } from "../windows/childWindow";
import { status } from "../state";
import { MAIN_WINDOW, closeWindow, detachPanel, instanceTitle, movePanelToWindow, setWindowBounds, type Layout, type LayoutWindow, type PanelInstanceId } from "./model";
import { layout } from "./store";

/** The open detached windows, by layout window id. */
export const openWindows = signal<ReadonlyMap<string, ChildWindowHandle>>(new Map());
/** Windows being opened (their page loading). */
const opening = new Set<string>();
/** Windows whose automatic opening was refused (pop-up blocked): they wait for a click. */
const refused = signal<ReadonlySet<string>>(new Set());
/** Set while the main window's page goes away: its windows close then, but stay in the layout. */
let mainClosing = false;
if (typeof window !== "undefined") window.addEventListener("pagehide", () => (mainClosing = true), { capture: true });

/** The layout's windows that aren't open (nor opening): shown in a banner to open or dock. */
export const pendingWindows = computed<LayoutWindow[]>(() => {
  refused.value;
  const open = openWindows.value;
  return (layout.value.windows ?? []).filter((w) => !open.has(w.id) && !opening.has(w.id));
});

/** A window's title: its panels' titles. */
export function windowTitle(l: Layout, win: LayoutWindow): string {
  const titles = win.docks.flatMap((d) => d.groups.map((g) => instanceTitle(l, g.active)));
  return `${titles.join(", ") || "Panels"} · Myco Engine`;
}

function setOpen(id: string, handle: ChildWindowHandle | null): void {
  const next = new Map(openWindows.peek());
  if (handle) next.set(id, handle);
  else next.delete(id);
  openWindows.value = next;
}

/**
 * Open the layout window `id` now. Call it from a click (browsers block other pop-ups); returns false when
 * it was refused (the status bar says why, unless `quiet`).
 */
export function openLayoutWindow(id: string, quiet = false): boolean {
  const win = (layout.peek().windows ?? []).find((w) => w.id === id);
  if (!win || openWindows.peek().has(id) || opening.has(id)) return true;
  let reason: string | null = null;
  const pending = openChildWindow({ title: windowTitle(layout.peek(), win), bounds: win.bounds, onRefused: (r) => (reason = r) });
  if (!pending) {
    refused.value = new Set([...refused.peek(), id]);
    if (!quiet && reason) status.value = { kind: "error", text: reason };
    return false;
  }
  opening.add(id);
  refused.value = new Set([...refused.peek()].filter((x) => x !== id));
  pending.then(
    (handle) => {
      opening.delete(id);
      if (!(layout.peek().windows ?? []).some((w) => w.id === id)) return handle.close(); // gone while it loaded
      setOpen(id, handle);
      const remember = () => {
        if (!handle.closed.peek()) layout.value = setWindowBounds(layout.peek(), id, handle.bounds());
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      handle.window.addEventListener("resize", () => {
        clearTimeout(timer);
        timer = setTimeout(remember, 300);
      });
      handle.window.addEventListener("pagehide", remember);
      const stop = effect(() => {
        if (!handle.closed.value) return;
        stop();
        setOpen(id, null);
        // Closed by the user: its panels close with it. Closed with the main window: kept for next time.
        if (!mainClosing) layout.value = closeWindow(layout.peek(), id);
      });
    },
    (err: unknown) => {
      opening.delete(id);
      refused.value = new Set([...refused.peek(), id]);
      status.value = { kind: "error", text: `Couldn't open a window: ${err instanceof Error ? err.message : String(err)}` };
    },
  );
  return true;
}

/** Detach `panel` into a new window (from a click: Detach in a header menu). */
export function detachToWindow(panel: PanelInstanceId, from?: Window): void {
  const before = layout.peek();
  const { layout: next, windowId } = detachPanel(before, panel, defaultBounds(from));
  if (!windowId) return;
  layout.value = next;
  if (!openLayoutWindow(windowId)) layout.value = before; // blocked: the panel stays where it was
}

/** Where a new window opens: near the window it came from, a medium size. */
function defaultBounds(from: Window | undefined = typeof window === "undefined" ? undefined : window): LayoutWindow["bounds"] {
  if (!from) return undefined;
  return { x: from.screenX + 80, y: from.screenY + 80, w: 520, h: 600 };
}

/** Move every panel of window `id` into the main window (the banner's Dock Here, for windows that won't open). */
export function dockWindowInMain(id: string): void {
  let next = layout.peek();
  const win = (next.windows ?? []).find((w) => w.id === id);
  if (!win) return;
  for (const panel of win.docks.flatMap((d) => d.groups.flatMap((g) => g.panels))) next = movePanelToWindow(next, panel, MAIN_WINDOW);
  layout.value = next;
}

/** Update every open window's bounds in the layout (before saving it). */
export function captureWindowBounds(): void {
  let next = layout.peek();
  for (const [id, handle] of openWindows.peek()) if (!handle.closed.peek()) next = setWindowBounds(next, id, handle.bounds());
  layout.value = next;
}

// Keep the real windows in step with the layout: close windows it no longer has (their last panel
// closed, or another layout applied); try to open the ones it has (works on desktop; a browser may
// refuse without a click, and the banner offers it then); retitle windows as their panels change.
let started = false;
export function startDetachedWindows(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  effect(() => {
    const l = layout.value;
    const ids = new Set((l.windows ?? []).map((w) => w.id));
    for (const [id, handle] of openWindows.value) {
      if (!ids.has(id)) handle.close();
      else {
        const win = l.windows!.find((w) => w.id === id)!;
        handle.document.title = windowTitle(l, win);
      }
    }
    for (const id of ids) if (!openWindows.peek().has(id) && !opening.has(id) && !refused.peek().has(id)) queueMicrotask(() => openLayoutWindow(id, true));
  });
}
