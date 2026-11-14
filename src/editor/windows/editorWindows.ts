// The editor's windows (ADR 0174, detached windows): the main window and the detached panel windows
// it has open. Code that must listen in every window the editor's UI renders in (the shell's
// keyboard shortcuts, the active history following focus) subscribes with `forEachEditorWindow`
// instead of listening on the global `window` alone; childWindow.ts registers each child it opens.
import { signal, type ReadonlySignal } from "@preact/signals";
import { isWindowLike } from "./dom";

const mainWindow = (): Window | null => {
  const w = (globalThis as { window?: unknown }).window;
  return isWindowLike(w) ? w : null;
};

const children = signal<readonly Window[]>([]);
type Subscriber = (win: Window) => void | (() => void);
const subscribers = new Set<{ fn: Subscriber; cleanups: Map<Window, () => void> }>();

/** The detached windows open now (not the main window), in the order they opened. */
export const childWindows: ReadonlySignal<readonly Window[]> = children;

/** The main window and every detached window open now. */
export function editorWindows(): Window[] {
  const main = mainWindow();
  return [...(main ? [main] : []), ...children.peek()];
}

/** The documents of `editorWindows()` (skipping a child whose document can't be read, e.g. mid-close). */
export function editorDocuments(): Document[] {
  const docs: Document[] = [];
  for (const w of editorWindows()) {
    try {
      if (w.document) docs.push(w.document);
    } catch {
      // closed or navigated away
    }
  }
  return docs;
}

/** Whether `win` is one of the editor's windows. */
export function isEditorWindow(win: Window): boolean {
  return win === mainWindow() || children.peek().includes(win);
}

function attach(sub: { fn: Subscriber; cleanups: Map<Window, () => void> }, win: Window): void {
  if (sub.cleanups.has(win)) return;
  const cleanup = sub.fn(win);
  sub.cleanups.set(win, typeof cleanup === "function" ? cleanup : () => {});
}

function detach(sub: { cleanups: Map<Window, () => void> }, win: Window): void {
  const cleanup = sub.cleanups.get(win);
  if (!cleanup) return;
  sub.cleanups.delete(win);
  try {
    cleanup();
  } catch {
    // the window is gone; its listeners went with it
  }
}

/**
 * Run `fn` for the main window and every detached window, now and as they open; the function it
 * returns (if any) runs when that window closes or when the returned unsubscribe is called.
 */
export function forEachEditorWindow(fn: Subscriber): () => void {
  const sub = { fn, cleanups: new Map<Window, () => void>() };
  subscribers.add(sub);
  for (const w of editorWindows()) attach(sub, w);
  return () => {
    subscribers.delete(sub);
    for (const w of [...sub.cleanups.keys()]) detach(sub, w);
  };
}

/**
 * `forEachEditorWindow` for the detached windows only: for code that already listens on the main
 * window or document itself and adds the same listeners in each child.
 */
export function forEachChildWindow(fn: Subscriber): () => void {
  const main = mainWindow();
  return forEachEditorWindow((win) => (win === main ? undefined : fn(win)));
}

/** Add a detached window (childWindow.ts, once its page has loaded). Returns its removal, for when it closes. */
export function registerEditorWindow(win: Window): () => void {
  if (isEditorWindow(win)) return () => {};
  children.value = [...children.peek(), win];
  for (const sub of subscribers) attach(sub, win);
  return () => {
    if (!children.peek().includes(win)) return;
    children.value = children.peek().filter((w) => w !== win);
    for (const sub of subscribers) detach(sub, win);
  };
}

/** Whether a dialog (`.dialog`) is open in any editor window. */
export function dialogOpenAnywhere(): boolean {
  return editorDocuments().some((d) => !!d.querySelector?.(".dialog"));
}
