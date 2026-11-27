/**
 * The Svelte renderer's global targets (ADR 0423, the patch's `globalTarget(kind)` hook): what `<svelte:window>`,
 * `<svelte:document>` and `<svelte:body>` stand for in a canvas game. They're objects with `addEventListener`,
 * `removeEventListener` and `dispatchEvent`, the readable state below, and the bindings the renderer's `bind` hook
 * hands them.
 *
 * - **Events.** Each frame, right after the UI's own events (`onUIHostFrame`), they get what the engine's device
 *   snapshot (ADR 0310) reports, after the UI's claims: `keydown`/`keyup` for keys the game sees (none while a text
 *   field is typing, nor a key a UI router claimed), `pointerdown`/`pointerup` (and `mousedown`/`mouseup`) for
 *   buttons pressed outside UI that takes the pointer, `pointermove`/`mousemove` and `wheel`. They go to the body,
 *   then the document, then the window, as a DOM event bubbles from the body; `stopPropagation` ends that.
 *   ADR 0426: UI events that bubble out of a view's canvas unstopped carry on through the body, the document and the
 *   window (`_continue`), as a DOM event bubbles out of an element; a type the UI dispatched in a frame isn't fed to
 *   them from the devices too (a click on a button reaches `<svelte:window onclick>` once, from the button).
 *   The window also gets `resize` when the canvas's size changes, and `online`/`offline`; the document,
 *   `visibilitychange`. Events come in play, not in the editor's edit mode.
 * - **The canvas is the window, in UI pixels** (the coordinator's units ruling, ADR 0422 wave 5): `innerWidth`/
 *   `innerHeight` (and `outerWidth`/`outerHeight`, the same: a game has no window chrome) are the UI canvas's size
 *   after the canvas scaler, the units of `getBoundingClientRect` and canvas `@media`; `devicePixelRatio` is device
 *   pixels per UI pixel. `matchMedia(query)` evaluates against the same canvas (so Svelte's `MediaQuery` follows
 *   canvas `@media`), with `change` events when its result flips. The canvas is the first `UIView`'s in the active
 *   World (each view's own `@media` rules match its own canvas); before a layout, the drawing canvas's CSS size.
 * - **State and bindings.** `window`: the sizes and pixel ratio above, `online`, and
 *   `scrollX`/`scrollY` (always 0: nothing scrolls the page). `document`: `activeElement` (the node with the UI's
 *   focus, ADR 0340, else the body), `visibilityState`, `fullscreenElement`/`pointerLockElement` (null), and
 *   `title`, which a `<title>` in `<svelte:head>` sets: the page's title in a browser build and the window's in a
 *   desktop build (the Tauri webview shows the page's title). Bindings are read-only, as on the web (`scrollX`/
 *   `scrollY` writes are ignored).
 */
import { World } from "../../../engine/core/World";
import { devices, KEYBOARD_DEVICE, POINTER_DEVICE } from "../../../engine/input/devices";
import { onUIHostFrame, uiHostCanvas, uiHostFocused, uiHostViewport, type UIHostElement } from "../../../engine/ui/host/UIHost";
import { matchMediaQueries, parseMediaQueryList } from "../../../engine/ui/document/mediaQuery";
import type { UIMediaQuery } from "../../../engine/ui/document/types";

export type GlobalKind = "window" | "document" | "body";

type Listener = (this: unknown, e: unknown) => void;

/** Key names as `Input` has them (lower-case `KeyboardEvent.key`) back to the DOM's `key`. */
const DOM_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter", "Tab", "Backspace", "Delete", "Shift", "Control", "Alt", "Meta", "Home", "End", "PageUp", "PageDown",
    "Insert", "CapsLock", "NumLock", "ScrollLock", "ContextMenu", "Pause", "PrintScreen", "AltGraph", "Dead", "Unidentified",
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ].map((k) => [k.toLowerCase(), k]),
);

function domKey(name: string): string {
  if (name === "space") return " ";
  return DOM_KEYS[name] ?? name;
}

/** The DOM's `code` for a key, where the key name says it (letters, digits, named keys); "" otherwise. */
function domCode(name: string): string {
  if (/^[a-z]$/.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  if (name === "space") return "Space";
  if (name === "shift" || name === "control" || name === "alt" || name === "meta") return `${DOM_KEYS[name]}Left`;
  return DOM_KEYS[name] ?? "";
}

/** A global event: keyboard, pointer, wheel or a plain one (`resize`), with the DOM's fields for its kind. */
export class UIGlobalEvent {
  target: unknown = null;
  currentTarget: unknown = null;
  readonly timeStamp: number;
  readonly bubbles: boolean;
  private prevented = false;
  private stopped = false;
  [field: string]: unknown;

  constructor(readonly type: string, init: Record<string, unknown> = {}, bubbles = false) {
    Object.assign(this, init);
    this.bubbles = bubbles;
    this.timeStamp = typeof performance !== "undefined" ? performance.now() : 0;
  }

  get defaultPrevented(): boolean {
    return this.prevented;
  }

  /** Recorded only: global events have no default actions in a game. */
  preventDefault(): void {
    this.prevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }

  stopImmediatePropagation(): void {
    this.stopped = true;
  }

  /** @internal */
  get _stopped(): boolean {
    return this.stopped;
  }
}

interface Binding {
  readonly name: string;
  readonly read: () => unknown;
  readonly set: (value: unknown) => void;
  last: unknown;
}

/** A global target: listeners and bindings, fed by the frame hook. */
export class UIGlobalTarget {
  /** @internal */ readonly _listeners = new Map<string, Map<Listener, { once: boolean }>>();
  /** @internal */ readonly _bindings = new Set<Binding>();

  constructor(
    /** `window`, `document` or `body`. */
    readonly kind: GlobalKind,
    /** @internal */ protected readonly globals: UIGlobals,
  ) {}

  get nodeName(): string {
    return this.kind === "body" ? "BODY" : this.kind === "document" ? "#document" : "";
  }

  addEventListener(type: string, listener: Listener | null, options?: boolean | { once?: boolean }): void {
    if (typeof listener !== "function") return;
    let set = this._listeners.get(type);
    if (!set) this._listeners.set(type, (set = new Map()));
    if (!set.has(listener)) set.set(listener, { once: typeof options === "object" && !!options?.once });
    this.globals._changed();
  }

  removeEventListener(type: string, listener: Listener | null): void {
    if (listener) this._listeners.get(type)?.delete(listener);
    this.globals._changed();
  }

  /** Run this target's listeners of `event.type` now. Returns false if one called `preventDefault`. */
  dispatchEvent(event: { type: string; defaultPrevented?: boolean; target?: unknown; currentTarget?: unknown }): boolean {
    try {
      event.target ??= this;
      event.currentTarget = this;
    } catch {
      // a host event with read-only fields
    }
    const set = this._listeners.get(event.type);
    for (const [fn, opts] of [...(set ?? [])]) {
      if (opts.once) set!.delete(fn);
      try {
        fn.call(this, event);
      } catch (err) {
        console.error(`[myco] a <svelte:${this.kind}> "${event.type}" handler threw:`, err);
      }
      if ((event as { _stopped?: boolean })._stopped) break;
    }
    return !event.defaultPrevented;
  }

  /** @internal ADR 0426: run this target's `type` listeners for a UI event bubbling up from a view (its `target` stays the node it happened on). */
  _run(type: string, event: { currentTarget?: unknown; _stopped?: boolean }): void {
    const set = this._listeners.get(type);
    if (!set?.size) return;
    try {
      event.currentTarget = this;
    } catch {
      // an event with read-only fields
    }
    for (const [fn, opts] of [...set]) {
      if (opts.once) set.delete(fn);
      try {
        fn.call(this, event);
      } catch (err) {
        console.error(`[myco] a <svelte:${this.kind}> "${type}" handler threw:`, err);
      }
      if (event._stopped) break;
    }
  }

  /** @internal Whether anything listens to `type`. */
  _has(type: string): boolean {
    return (this._listeners.get(type)?.size ?? 0) > 0;
  }

  /** @internal The renderer's `bind` hook for this target: a read-only binding of `name`, or undefined when it has none. */
  _bind(name: string, set: (value: unknown) => void): (() => void) | undefined {
    const read = this.globals._reader(this.kind, name);
    if (!read) return undefined;
    const b: Binding = { name, read, set, last: read() };
    set(b.last);
    this._bindings.add(b);
    this.globals._changed();
    return () => {
      this._bindings.delete(b);
      this.globals._changed();
    };
  }
}

/** The window: the canvas's sizes and pixel ratio in UI pixels, `matchMedia`, connection and `resize`. */
export class UIGlobalWindow extends UIGlobalTarget {
  get innerWidth(): number {
    return canvasOf(World.active).width;
  }
  get innerHeight(): number {
    return canvasOf(World.active).height;
  }
  get outerWidth(): number {
    return canvasOf(World.active).width;
  }
  get outerHeight(): number {
    return canvasOf(World.active).height;
  }
  /** Device pixels per UI pixel. */
  get devicePixelRatio(): number {
    return canvasOf(World.active).ratio;
  }
  get scrollX(): number {
    return 0;
  }
  get scrollY(): number {
    return 0;
  }
  get document(): UIGlobalDocument {
    return this.globals.document;
  }

  /** A media query list evaluated against the canvas in UI pixels, as canvas `@media` rules are (ADR 0422 wave 5). */
  matchMedia(query: string): UIMediaQueryList {
    return new UIMediaQueryList(String(query), this.globals);
  }
}

/**
 * What the window's `matchMedia` returns: whether a media query matches the canvas now (`matches`), and `change` events
 * (to listeners and `onchange`) when that flips, checked once a frame while something listens. A global target, so the
 * renderer hands its listeners straight to it, as Svelte's `MediaQuery` adds them.
 */
export class UIMediaQueryList extends UIGlobalTarget {
  /** The query as given. */
  readonly media: string;
  private changeHandler: ((this: UIMediaQueryList, e: UIGlobalEvent) => void) | null = null;
  private readonly queries: readonly UIMediaQuery[];
  /** @internal The result last reported (or read when listening started). */ _last: boolean;

  constructor(query: string, globals: UIGlobals) {
    super("window", globals);
    this.media = query;
    this.queries = parseMediaQueryList(query);
    this._last = this.matches;
  }

  get matches(): boolean {
    return matchMediaQueries(this.queries, canvasOf(World.active).media);
  }

  get onchange(): ((this: UIMediaQueryList, e: UIGlobalEvent) => void) | null {
    return this.changeHandler;
  }

  set onchange(handler: ((this: UIMediaQueryList, e: UIGlobalEvent) => void) | null) {
    this.changeHandler = typeof handler === "function" ? handler : null;
    this.listened();
  }

  override addEventListener(type: string, listener: Listener | null, options?: boolean | { once?: boolean }): void {
    if (!this._has("change") && !this.changeHandler) this._last = this.matches;
    super.addEventListener(type, listener, options);
    this.listened();
  }

  override removeEventListener(type: string, listener: Listener | null): void {
    super.removeEventListener(type, listener);
    this.listened();
  }

  /** The old Safari form of `addEventListener("change", listener)`. */
  addListener(listener: Listener | null): void {
    this.addEventListener("change", listener);
  }

  removeListener(listener: Listener | null): void {
    this.removeEventListener("change", listener);
  }

  /** Checked each frame only while something listens. */
  private listened(): void {
    if (this._has("change") || this.changeHandler) this.globals._media.add(this);
    else this.globals._media.delete(this);
    this.globals._changed();
  }

  /** @internal Once a frame while listened to: a `change` event when the result flipped. */
  _check(): void {
    const now = this.matches;
    if (now === this._last) return;
    this._last = now;
    const e = new UIGlobalEvent("change", { matches: now, media: this.media });
    this.dispatchEvent(e);
    if (typeof this.onchange === "function") {
      try {
        this.onchange.call(this, e);
      } catch (err) {
        console.error(`[myco] a matchMedia("${this.media}") onchange handler threw:`, err);
      }
    }
  }
}

/** The document: the focused node, visibility, the title. */
export class UIGlobalDocument extends UIGlobalTarget {
  private titleText = typeof document !== "undefined" ? document.title : "";

  get title(): string {
    return this.titleText;
  }

  /** What `<title>` in `<svelte:head>` sets: the page's title (the window's, in a desktop build). */
  set title(value: string) {
    this.titleText = value === null || value === undefined ? "" : String(value);
    if (typeof document !== "undefined") document.title = this.titleText;
  }

  get activeElement(): unknown {
    return this.globals._activeElement(World.active);
  }
  get visibilityState(): string {
    return visibility();
  }
  get hidden(): boolean {
    return visibility() === "hidden";
  }
  get fullscreenElement(): null {
    return null;
  }
  get pointerLockElement(): null {
    return null;
  }
  get body(): UIGlobalTarget {
    return this.globals.body;
  }
  get head(): unknown {
    return this.globals.head;
  }
  get defaultView(): UIGlobalWindow {
    return this.globals.window;
  }
}

function pixelRatio(): number {
  const r = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  return typeof r === "number" && r > 0 && Number.isFinite(r) ? r : 1;
}

function online(): boolean {
  const n = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return typeof n?.onLine === "boolean" ? n.onLine : true;
}

function visibility(): string {
  return typeof document !== "undefined" && typeof document.visibilityState === "string" ? document.visibilityState : "visible";
}

/**
 * The canvas the window stands for: the first `UIView`'s canvas in UI pixels after the canvas scaler, with device pixels
 * per UI pixel, and the size `@media` matches (null before a layout). Before a layout, the drawing canvas's CSS size (or
 * the page's) at the device's pixel ratio.
 */
function canvasOf(world: World | null): { width: number; height: number; ratio: number; media: { width: number; height: number } | null } {
  const c = world ? uiHostCanvas(world) : null;
  if (c) return { width: c.width, height: c.height, ratio: pixelRatio() * c.scale, media: { width: c.width, height: c.height } };
  const v = world ? uiHostViewport(world) : null;
  if (v && (v.width > 0 || v.height > 0)) return { width: v.width, height: v.height, ratio: pixelRatio(), media: null };
  const w = globalThis as { innerWidth?: number; innerHeight?: number };
  return { width: w.innerWidth ?? 0, height: w.innerHeight ?? 0, ratio: pixelRatio(), media: null };
}

const KEY_EVENTS = ["keydown", "keyup"];
const POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "pointermove", "mousemove", "wheel"];

/** The renderer's three global targets and the frame hook that feeds them. */
export class UIGlobals {
  readonly window: UIGlobalWindow;
  readonly document: UIGlobalDocument;
  readonly body: UIGlobalTarget;
  private stopFrame: (() => void) | null = null;
  private lastFrame = -1;
  /** ADR 0426: the event types the UI dispatched to a view in a device frame. */
  private uiTypes = { frame: -1, types: new Set<string>() };
  private last: { width: number; height: number; online: boolean; visibility: string } | null = null;
  /** @internal `matchMedia` lists something listens to: checked each frame. */
  readonly _media = new Set<UIMediaQueryList>();

  constructor(
    /** The element `<svelte:head>` content goes into. */
    readonly head: unknown,
    /** The renderer node of a hosted element (for `activeElement`). */
    private readonly nodeOf: (el: UIHostElement) => unknown,
  ) {
    this.window = new UIGlobalWindow("window", this);
    this.document = new UIGlobalDocument("document", this);
    this.body = new UIGlobalTarget("body", this);
  }

  /** The target for `kind`. */
  target(kind: GlobalKind): UIGlobalTarget {
    return kind === "window" ? this.window : kind === "document" ? this.document : this.body;
  }

  /** @internal What a binding of `name` on `kind` reads, or null when there's no such binding. */
  _reader(kind: GlobalKind, name: string): (() => unknown) | null {
    if (kind === "window") {
      switch (name) {
        case "innerWidth":
        case "outerWidth":
          return () => canvasOf(World.active).width;
        case "innerHeight":
        case "outerHeight":
          return () => canvasOf(World.active).height;
        case "devicePixelRatio":
          return () => canvasOf(World.active).ratio;
        case "online":
          return online;
        case "scrollX":
        case "scrollY":
          return () => 0;
      }
    } else if (kind === "document") {
      switch (name) {
        case "activeElement":
          return () => this._activeElement(World.active);
        case "visibilityState":
          return visibility;
        case "fullscreenElement":
        case "pointerLockElement":
          return () => null;
      }
    }
    return null;
  }

  /** @internal The node with `world`'s UI focus, else the body (as the DOM's `activeElement`). */
  _activeElement(world: World | null): unknown {
    const el = world ? uiHostFocused(world) : null;
    return (el && this.nodeOf(el)) ?? this.body;
  }

  /** @internal A listener or binding came or went: run the frame hook only while something needs it. */
  _changed(): void {
    const needed = this._media.size > 0 || [this.window, this.document, this.body].some((t) => t._bindings.size > 0 || [...t._listeners.values()].some((s) => s.size > 0));
    if (needed && !this.stopFrame) {
      this.last = null;
      this.stopFrame = onUIHostFrame((w) => this.frame(w));
    } else if (!needed && this.stopFrame) {
      this.stopFrame();
      this.stopFrame = null;
    }
  }

  /**
   * @internal ADR 0426: a UI event dispatched in a view, as its DOM `types`: when it bubbles and wasn't stopped, on
   * through the body, the document and the window. Either way the devices don't feed those types this frame.
   */
  _continue(event: { bubbles?: boolean; _stopped?: boolean; eventPhase?: number; currentTarget?: unknown }, types: readonly string[]): void {
    if (this.uiTypes.frame !== devices.frame) this.uiTypes = { frame: devices.frame, types: new Set() };
    for (const t of types) this.uiTypes.types.add(t);
    if (!event.bubbles || event._stopped) return;
    for (const target of [this.body, this.document, this.window]) {
      try {
        event.eventPhase = 3;
      } catch {
        // read-only
      }
      for (const t of types) target._run(t, event);
      if (event._stopped) break;
    }
    try {
      event.eventPhase = 0;
    } catch {
      // read-only
    }
  }

  /** Bubble `make()` from the body through the document to the window, to the targets listening to `type`. */
  private bubble(type: string, make: () => UIGlobalEvent): void {
    if (this.uiTypes.frame === devices.frame && this.uiTypes.types.has(type)) return; // the UI's dispatch reached them (ADR 0426)
    const chain = [this.body, this.document, this.window].filter((t) => t._has(type));
    if (!chain.length) return;
    const e = make();
    e.target = this.body;
    for (const t of chain) {
      t.dispatchEvent(e);
      if (e._stopped) break;
    }
  }

  private frame(world: World): void {
    if (devices.frame === this.lastFrame) return; // once per Engine frame, whatever the number of Worlds
    this.lastFrame = devices.frame;
    const mods = () => ({ shiftKey: devices.isHeld("shift"), ctrlKey: devices.isHeld("control"), altKey: devices.isHeld("alt"), metaKey: devices.isHeld("meta") });
    const listensKeys = KEY_EVENTS.some((t) => this.body._has(t) || this.document._has(t) || this.window._has(t));
    const listensPointer = POINTER_EVENTS.some((t) => this.body._has(t) || this.document._has(t) || this.window._has(t));
    if (listensKeys || listensPointer) {
      for (const ev of devices.events) {
        if (ev.device === KEYBOARD_DEVICE && listensKeys) {
          const name = ev.control.slice("<Keyboard>/".length);
          const type = ev.value ? "keydown" : "keyup";
          this.bubble(type, () => new UIGlobalEvent(type, { key: domKey(name), code: domCode(name), repeat: false, isComposing: false, location: 0, ...mods() }, true));
        } else if (ev.device === POINTER_DEVICE && listensPointer) {
          const button = Number(ev.control.slice("<Pointer>/button".length)) || 0;
          const down = ev.value > 0;
          const init = () => ({ button, buttons: down ? 1 << button : 0, clientX: devices.pointerX, clientY: devices.pointerY, pointerId: 1, pointerType: "mouse", isPrimary: true, ...mods() });
          this.bubble(down ? "pointerdown" : "pointerup", () => new UIGlobalEvent(down ? "pointerdown" : "pointerup", init(), true));
          this.bubble(down ? "mousedown" : "mouseup", () => new UIGlobalEvent(down ? "mousedown" : "mouseup", init(), true));
        }
      }
      if (listensPointer && (devices.movementX !== 0 || devices.movementY !== 0)) {
        const init = () => ({ clientX: devices.pointerX, clientY: devices.pointerY, movementX: devices.movementX, movementY: devices.movementY, pointerId: 1, pointerType: "mouse", isPrimary: true, ...mods() });
        this.bubble("pointermove", () => new UIGlobalEvent("pointermove", init(), true));
        this.bubble("mousemove", () => new UIGlobalEvent("mousemove", init(), true));
      }
      if (listensPointer && (devices.scrollX !== 0 || devices.scrollY !== 0)) {
        this.bubble("wheel", () => new UIGlobalEvent("wheel", { deltaX: devices.scrollX, deltaY: devices.scrollY, deltaZ: 0, deltaMode: 0, clientX: devices.pointerX, clientY: devices.pointerY, ...mods() }, true));
      }
    }
    const size = canvasOf(world);
    const now = { width: size.width, height: size.height, online: online(), visibility: visibility() };
    const was = this.last;
    this.last = now;
    if (was) {
      if (was.width !== now.width || was.height !== now.height) this.window.dispatchEvent(new UIGlobalEvent("resize"));
      if (was.online !== now.online) this.window.dispatchEvent(new UIGlobalEvent(now.online ? "online" : "offline"));
      if (was.visibility !== now.visibility) this.document.dispatchEvent(new UIGlobalEvent("visibilitychange", {}, true));
    }
    for (const t of [this.window, this.document]) {
      for (const b of [...t._bindings]) {
        const v = b.read();
        if (v === b.last) continue;
        b.last = v;
        b.set(v);
      }
    }
    for (const m of [...this._media]) m._check();
  }
}
