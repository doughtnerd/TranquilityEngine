// Detached panel windows' groundwork (ADR 0174, "Detached windows (second phase)"). A detached window
// is a same-origin child page (panel-window.html: an empty page with one root element) opened with
// `window.open`; the main window's JavaScript renders into its `container` with Preact (`render` or a
// portal, see ChildWindowPortal), so its panels read the same signals as the main window's: there is
// no state to sync. This module keeps the child looking and behaving like part of the editor:
//
// - the editor's stylesheets are copied into the child's <head> and kept in step (Vite dev injects
//   and rewrites <style> tags at runtime, production uses <link>s; Monaco adds its own);
// - the theme (the custom properties, `data-theme` and colour scheme theme.ts sets on <html>, and the
//   UI scale with them) is mirrored onto the child's <html>;
// - the child is registered as an editor window (editorWindows.ts), so whatever installs per window
//   (the shell's shortcuts, undo/redo, the active history following focus) works there too, and a bare
//   Alt press is forwarded to the main window, whose menu bar takes the focus;
// - every child closes when the main window's page goes away (`pagehide`), and a child closed by the
//   user is reported through its `closed` signal.
//
// On desktop, Tauri's `on_new_window` handler (src-tauri/src/lib.rs) turns `window.open` into a linked
// Tauri window; in a browser it is a normal pop-up, which browsers only allow from a user gesture, so
// `openChildWindow` must be called synchronously from one (a click or key handler).
import { signal, type ReadonlySignal } from "@preact/signals";
import { isEditable } from "../editable";
import { dialogOpenAnywhere, registerEditorWindow } from "./editorWindows";

/** A window's position (screen pixels, its outer top-left corner) and content size (CSS pixels). */
export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChildWindowOptions {
  /** The window's title (the document's: Tauri titles its window from it). */
  title: string;
  /** Where to open it; the browser or OS places it when left out (or for missing fields). */
  bounds?: Partial<WindowBounds>;
  /** Called with a user-facing reason when the window couldn't be opened (pop-up blocked), for a status message. */
  onRefused?: (reason: string) => void;
  /** How long to wait for the child's page to load before giving up, in ms (default 10 s). */
  timeout?: number;
}

/** A detached window, once its page has loaded. */
export interface ChildWindowHandle {
  readonly window: Window;
  readonly document: Document;
  /** The element to render the window's content into (it fills the window). */
  readonly container: HTMLElement;
  /** Close the window (does nothing if it's closed). */
  close(): void;
  /** True once the window has closed, whoever closed it (the user, `close`, the main window going away). */
  readonly closed: ReadonlySignal<boolean>;
  /** Where the window is now, for saving with a layout. */
  bounds(): WindowBounds;
}

/** The child's page, beside editor.html (vite.editor.config.ts builds it). */
export const PANEL_WINDOW_PAGE = "panel-window.html";
/** The element in panel-window.html that `container` is. */
export const PANEL_WINDOW_ROOT = "panel-window-root";

/** What `onRefused` says when the browser blocked the pop-up. */
export const POPUP_BLOCKED = "The browser blocked the new window: allow pop-ups for the editor and try again.";

/** The `window.open` features for `bounds`: a pop-up (no tabs or toolbars), placed and sized when given. Exported for tests. */
export function windowFeatures(bounds?: Partial<WindowBounds>): string {
  const parts = ["popup"];
  const px = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);
  const w = px(bounds?.w), h = px(bounds?.h), x = px(bounds?.x), y = px(bounds?.y);
  if (w !== null && w > 0) parts.push(`width=${w}`);
  if (h !== null && h > 0) parts.push(`height=${h}`);
  if (x !== null) parts.push(`left=${x}`);
  if (y !== null) parts.push(`top=${y}`);
  return parts.join(",");
}

/** A window's bounds as `windowFeatures` takes them (outer position, inner size). Exported for tests. */
export function boundsOf(win: Pick<Window, "screenX" | "screenY" | "innerWidth" | "innerHeight">): WindowBounds {
  return { x: win.screenX, y: win.screenY, w: win.innerWidth, h: win.innerHeight };
}

// --- Open children and the main window's pagehide ---------------------------------------------------

const open = new Set<OpenEntry>();
let closingWithPage = false;

function closeAllWithPage(): void {
  for (const child of [...open]) {
    child.dispose();
    try {
      child.window.close();
    } catch {
      // already gone
    }
  }
}

/** Close every detached window when the main window's page goes away (installed with the first child). */
function closeChildrenWithPage(main: Window): void {
  if (closingWithPage) return;
  closingWithPage = true;
  main.addEventListener("pagehide", closeAllWithPage);
}

/** Every detached window open now (the raw windows, including ones still loading). */
export function openChildWindows(): Window[] {
  return [...open].map((c) => c.window);
}

/** Close every detached window (as the main window's pagehide does). */
export function closeAllChildWindows(): void {
  closeAllWithPage();
}

/**
 * Open a detached window. Call it synchronously from a user gesture: `window.open` happens before
 * this returns. Returns null when the window couldn't be opened (the pop-up was blocked; `onRefused`
 * says why); otherwise a promise of the window's handle once its page has loaded (rejected, with the
 * window closed, if it doesn't load within `timeout` or is closed first).
 */
export function openChildWindow(options: ChildWindowOptions, main: Window = window): Promise<ChildWindowHandle> | null {
  let child: Window | null = null;
  try {
    child = main.open(new URL(PANEL_WINDOW_PAGE, main.location.href).href, "_blank", windowFeatures(options.bounds));
  } catch {
    child = null;
  }
  if (!child || child.closed) {
    options.onRefused?.(POPUP_BLOCKED);
    return null;
  }
  const win = child;
  closeChildrenWithPage(main);
  const entry: OpenEntry = { window: win, dispose: () => {} };
  open.add(entry);
  return waitForPage(win, options.timeout ?? 10_000).then(
    (doc) => setUp(main, win, doc, options, entry),
    (err: unknown) => {
      open.delete(entry);
      win.close();
      throw err;
    },
  );
}

/**
 * Resolves with the child's document once panel-window.html has loaded in it. The window returned
 * by `window.open` first holds an initial about:blank document, replaced when the page loads (its
 * `load` listeners are lost with it), so this polls.
 */
function waitForPage(win: Window, timeout: number): Promise<Document> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (win.closed) return reject(new Error("The window was closed before it opened."));
      let doc: Document | null = null;
      try {
        doc = win.document;
      } catch {
        doc = null; // not reachable yet (a desktop webview still linking it), or not same-origin: wait for the timeout
      }
      if (doc && doc.readyState === "complete" && doc.getElementById(PANEL_WINDOW_ROOT)) return resolve(doc);
      if (Date.now() - start > timeout) return reject(new Error("The new window didn't load (or isn't the editor's page)."));
      setTimeout(check, 16);
    };
    check();
  });
}

type OpenEntry = { window: Window; dispose: () => void };

function setUp(main: Window, win: Window, doc: Document, options: ChildWindowOptions, entry: OpenEntry): ChildWindowHandle {
  doc.title = options.title;
  const container = doc.getElementById(PANEL_WINDOW_ROOT)!;
  const closed = signal(false);
  const cleanups: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    open.delete(entry);
    for (const c of cleanups.splice(0).reverse()) {
      try {
        c();
      } catch {
        // the child's document may be gone
      }
    }
    closed.value = true;
  };
  entry.dispose = dispose;

  cleanups.push(syncStyles(main.document, doc));
  cleanups.push(syncRootAttributes(main.document.documentElement, doc.documentElement));
  cleanups.push(forwardMenuKey(win, main));
  cleanups.push(registerEditorWindow(win));

  // Closed by the user (or the OS): the child's pagehide, confirmed once it has really closed, with a
  // slow poll as a backstop (pagehide doesn't fire everywhere when an OS window is destroyed).
  const confirmClosed = () => setTimeout(() => win.closed && dispose(), 0);
  win.addEventListener("pagehide", confirmClosed);
  const poll = setInterval(() => win.closed && dispose(), 500);
  cleanups.push(() => clearInterval(poll));

  return {
    window: win,
    document: doc,
    container,
    closed,
    close: () => {
      dispose();
      if (!win.closed) win.close();
    },
    bounds: () => boundsOf(win),
  };
}

// --- Stylesheets ------------------------------------------------------------------------------------

/** Whether `node` is one of the stylesheets copied into children: a <style>, or a <link rel="stylesheet">. Exported for tests. */
export function isStyleNode(node: Node): node is HTMLStyleElement | HTMLLinkElement {
  const el = node as Element;
  if (el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "style") return true;
  return tag === "link" && /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute("rel") ?? "");
}

/**
 * Copy `from`'s stylesheets (in its <head>) into `to`'s <head>, in order, and keep them in step: added,
 * removed, reordered and rewritten (HMR changes a <style>'s text, or swaps a <link>'s href) as they
 * change. Copies are marked `data-myco-copied`. Returns a function that stops following (the copies stay).
 */
export function syncStyles(from: Document, to: Document): () => void {
  const copies = new Map<Node, HTMLStyleElement | HTMLLinkElement>();
  const anchor = to.createComment(" the editor's stylesheets ");
  const reconcile = () => {
    const sources = Array.from(from.head.childNodes).filter(isStyleNode);
    const keep = new Set(sources);
    for (const [src, copy] of copies) {
      if (keep.has(src as HTMLStyleElement)) continue;
      copy.remove();
      copies.delete(src);
    }
    // Copies go after the child's own nodes (behind a marker comment), in the main window's order.
    if (!anchor.parentNode) to.head.append(anchor);
    let before: Node | null = anchor.nextSibling;
    for (const src of sources) {
      let copy = copies.get(src);
      if (!copy) {
        copy = to.createElement(src.tagName.toLowerCase() as "style" | "link");
        copy.setAttribute("data-myco-copied", "");
        copies.set(src, copy);
      }
      const link = src.tagName.toLowerCase() === "link";
      copyAttributes(src, copy, link ? ["data-myco-copied", "href"] : ["data-myco-copied"]);
      if (link) {
        const href = (src as HTMLLinkElement).href;
        if (href && (copy as HTMLLinkElement).href !== href) (copy as HTMLLinkElement).href = href;
      } else if (copy.textContent !== src.textContent) {
        copy.textContent = src.textContent;
      }
      if (copy !== before) to.head.insertBefore(copy, before);
      before = copy.nextSibling;
    }
  };
  reconcile();
  const View = from.defaultView as (Window & typeof globalThis) | null;
  const Observer = View?.MutationObserver ?? (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (!Observer) return () => {};
  const observer = new Observer(reconcile);
  observer.observe(from.head, { childList: true, subtree: true, characterData: true, attributes: true });
  return () => observer.disconnect();
}

/** Set `to`'s attributes to `from`'s (except `keep`, which stays as it is on `to`). */
function copyAttributes(from: Element, to: Element, keep: readonly string[] = []): void {
  for (const { name } of Array.from(to.attributes)) if (!keep.includes(name) && !from.hasAttribute(name)) to.removeAttribute(name);
  for (const { name, value } of Array.from(from.attributes)) if (to.getAttribute(name) !== value) to.setAttribute(name, value);
}

// --- Theme ------------------------------------------------------------------------------------------

/**
 * Mirror `from`'s attributes onto `to` (the main <html> onto the child's) and keep them in step: theme.ts
 * keeps the theme's custom properties, the fonts, the UI scale and the colour scheme in <html>'s `style`,
 * and its kind in `data-theme`. Returns a function that stops following.
 */
export function syncRootAttributes(from: HTMLElement, to: HTMLElement): () => void {
  const copy = () => copyAttributes(from, to);
  copy();
  const View = from.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  const Observer = View?.MutationObserver ?? (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (!Observer) return () => {};
  const observer = new Observer(copy);
  observer.observe(from, { attributes: true });
  return () => observer.disconnect();
}

// --- The menu bar's Alt key ---------------------------------------------------------------------------

/**
 * Tracks whether Alt was pressed and released on its own (the menu bar's focus key, MenuBar.tsx):
 * anything else while it's held (another key, a click, the wheel) makes it a modifier. Exported for tests.
 */
export function bareAltTracker(): { down(e: Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "shiftKey">): void; used(): void; up(e: Pick<KeyboardEvent, "key">): boolean } {
  let alone = false;
  return {
    down: (e) => void (alone = e.key === "Alt" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey),
    used: () => void (alone = false),
    up: (e) => {
      const was = e.key === "Alt" && alone;
      alone = false;
      return was;
    },
  };
}

/**
 * The menu bar lives in the main window and listens there for a bare Alt (MenuBar.tsx). Pressed in a
 * child, it focuses the main window and replays the Alt press there, so the menu bar takes the focus as
 * if it had been pressed in the main window. (Keep MenuBar's own Alt listener on the main window only,
 * or it would run twice.) Returns a function that stops.
 */
export function forwardMenuKey(child: Window, main: Window): () => void {
  const alt = bareAltTracker();
  const down = (e: KeyboardEvent) => alt.down(e);
  const used = () => alt.used();
  const up = (e: KeyboardEvent) => {
    if (!alt.up(e)) return;
    const target = e.target as Element | null;
    if (dialogOpenAnywhere() || isEditable(target) || target?.closest?.(".monaco-editor")) return;
    e.preventDefault(); // not the system menu
    main.focus();
    const init = { key: "Alt", code: e.code || "AltLeft", altKey: false, bubbles: true, cancelable: true };
    main.dispatchEvent(new (main as Window & typeof globalThis).KeyboardEvent("keydown", { ...init, altKey: true }));
    main.dispatchEvent(new (main as Window & typeof globalThis).KeyboardEvent("keyup", init));
  };
  child.addEventListener("keydown", down, true);
  child.addEventListener("keyup", up, true);
  child.addEventListener("pointerdown", used, true);
  child.addEventListener("wheel", used, true);
  return () => {
    child.removeEventListener("keydown", down, true);
    child.removeEventListener("keyup", up, true);
    child.removeEventListener("pointerdown", used, true);
    child.removeEventListener("wheel", used, true);
  };
}
