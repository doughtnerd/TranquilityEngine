// Owner-document helpers for UI that may render in a detached panel window (ADR 0174). A detached
// window is a same-origin child the main window's JavaScript renders into, so a component's code
// runs in the main window's realm while its elements live in the child's document. Code that
// listens on the global `window` / `document`, measures against `innerWidth`, reads
// `document.activeElement` or tests `instanceof HTMLInputElement` (the main realm's constructor:
// false for an input in the child) breaks there. These helpers find the right window and document
// from an element or an event instead.

// The main window's globals, read lazily (unit tests run without a DOM).
const mainDocument = () => (globalThis as { document?: Document }).document as Document;
const mainWindow = () => (globalThis as { window?: Window }).window as Window;

/** Anything with an owner document: a DOM node, or an event target that may be a node, a document or a window. */
type Owned = EventTarget | Node | null | undefined;

/** Whether `x` looks like a Window (duck-typed: `instanceof Window` is per realm). */
export function isWindowLike(x: unknown): x is Window {
  return !!x && typeof x === "object" && (x as Window).window === x && "document" in (x as object);
}

/** Whether `x` looks like a Document (duck-typed). */
function isDocumentLike(x: unknown): x is Document {
  return !!x && typeof x === "object" && (x as Node).nodeType === 9;
}

/** The document `target` belongs to (a node's owner document, a document itself, a window's document); the main document otherwise. */
export function ownerDocumentOf(target: Owned): Document {
  if (isDocumentLike(target)) return target;
  if (isWindowLike(target)) return target.document;
  const doc = (target as Node | null | undefined)?.ownerDocument;
  return doc ?? mainDocument();
}

/** The window `target` belongs to (see `ownerDocumentOf`); the main window otherwise. */
export function ownerWindowOf(target: Owned): Window {
  if (isWindowLike(target)) return target;
  return ownerDocumentOf(target)?.defaultView ?? mainWindow();
}

/** The window an event happened in: its target's, else the view of a UI event, else the main window. */
export function eventWindow(e: Event): Window {
  const target = e.target;
  if (target && (isWindowLike(target) || isDocumentLike(target) || (target as Node).ownerDocument)) return ownerWindowOf(target);
  return (e as UIEvent).view ?? mainWindow();
}

/** The focused element in `target`'s document (`document.activeElement`, per window). */
export function activeElementOf(target: Owned): Element | null {
  return ownerDocumentOf(target).activeElement;
}

/** The viewport size of `target`'s window, to keep a menu or popover on screen. */
export function viewportOf(target: Owned): { width: number; height: number } {
  const win = ownerWindowOf(target);
  return { width: win.innerWidth, height: win.innerHeight };
}

/** An element's lower-case tag name, whatever realm made it (null for non-elements). */
export function tagOf(target: unknown): string | null {
  const el = target as Element | null;
  return el && el.nodeType === 1 && typeof el.tagName === "string" ? el.tagName.toLowerCase() : null;
}

/** An element of tag `tag` (realm-independent `instanceof HTMLXElement`). */
export function isTag<K extends keyof HTMLElementTagNameMap>(target: unknown, tag: K): target is HTMLElementTagNameMap[K] {
  return tagOf(target) === tag;
}

/** Whether `target` is an Element (realm-independent `instanceof Element`). */
export function isElement(target: unknown): target is Element {
  return tagOf(target) !== null;
}

/**
 * Listen on `target`'s window for the lifetime of the returned cleanup: the window-level listeners
 * of menus closing on outside clicks, drags following the pointer and Escape keys.
 */
export function listenOnWindowOf<K extends keyof WindowEventMap>(
  target: Owned,
  type: K,
  listener: (e: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): () => void {
  const win = ownerWindowOf(target);
  win.addEventListener(type, listener as EventListener, options);
  return () => win.removeEventListener(type, listener as EventListener, options);
}

/** Whether `e` is a keyboard event (realm-independent `instanceof KeyboardEvent`: an event in a detached window is that window's). */
export function isKeyboardEvent(e: Event): e is KeyboardEvent {
  return typeof e.type === "string" && e.type.startsWith("key") && "key" in e;
}
