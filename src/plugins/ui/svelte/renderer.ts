/**
 * The engine's Svelte renderer (ADR 0419): `createRenderer` from `svelte/renderer`, whose nodes become UI
 * core elements through the UI core's external tree host (`engine/ui/host/UIHost.ts`). Compiled UI
 * components import it (`experimental.customRenderer`, as `myco/ui-renderer`); `UIView` loads it on demand,
 * so games without Svelte UI never download Svelte.
 *
 * - **Tags are HTML names**, mapped onto UI elements (`engine/ui/host/htmlTags.ts`): `div`, `section`,
 *   `nav`… → Panel; `span`, `p`, `h1`–`h6`, `label` → Text; `img` → Image; `button` → Button; `input` →
 *   InputField. Unknown tags warn once and are Panels. The cascade matches the tag as written.
 * - **Attributes are component fields** in kebab-case (ADR 0077), converted by the cascade as markup
 *   attributes are; `class`, `id` and `style` (Svelte's `class:` and `style:` arrive inside them) feed the
 *   cascade. Typed values pass as CSS text (a `Color` becomes `rgba(…)`). `img src` is the image, and
 *   `disabled` makes a button or field not interactable. HTML-only attributes (`type`, `name`, `for`,
 *   `alt`, `title`, `role`, `tabindex`, `aria-*`, `data-*`) stay on the node and don't reach the cascade.
 * - **Text.** Text inside a Text element (and inside elements nested in one, as `<p>Hi <b>you</b></p>`) is
 *   its text. Anywhere else, text with something other than whitespace is a Text element of its own (a
 *   button's label). Whitespace is collapsed as UI markup does. Comments (Svelte's anchors) are never built.
 * - **Events** are the UI core's (ADR 0309) with DOM names: `onclick`, `oninput`, `onchange`, `onsubmit`,
 *   `onfocus`, `onblur`, `onpointerenter`, `onpointerleave` (and `onmouseenter`/`onmouseleave`), and (ADR 0422)
 *   `onpointerdown`/`up`/`move`/`over`/`out`/`cancel` (and their `onmouse…` names), `ondblclick`, `oncontextmenu`,
 *   `onwheel`, `onkeydown`/`onkeyup` (on the focused element), `onfocusin`/`onfocusout`, `onscroll`/`onscrollend`
 *   (ADR 0423) and drags, as event attributes or legacy `on:` directives (with their modifiers). They travel through
 *   the nodes' ancestors in capture (`onclickcapture`, `addEventListener(…, { capture: true })`), target and bubble
 *   phases, then, bubbling out of the view, through `<svelte:body>`, `<svelte:document>` and `<svelte:window>`. A
 *   handler gets a `UIHostEvent` whose `target` is the node it happened on and `currentTarget` the node listening
 *   (so `e.currentTarget.value` reads a field, as on the web), and whose `element` is the hosted UI element. Listeners
 *   of any other type are kept for `dispatchEvent` (an action's custom event), which propagates the same way.
 * - **The patch's hooks** (`patches/svelte+5.59.2.patch`, `docs/architecture/svelte-patch.md`): `bind`
 *   (`bind:value` on `input`; the window's and document's bindings), `globalTarget` (`<svelte:window>`,
 *   `<svelte:document>` and `<svelte:body>` are `globalTargets.ts`'s targets, fed from the device snapshot and
 *   the canvas; `<svelte:head>` content goes into a head node nothing shows, and its `<title>` sets the page's
 *   title) and `addStyles` (`css: 'injected'`, as rule data parsed when the component compiled).
 * - **Nodes offer an Element subset** for actions, attachments and `bind:this`: `setAttribute`/
 *   `getAttribute`/`removeAttribute`/`hasAttribute`/`getAttributeNames`, `classList`, `style` (also by
 *   camel-case property), `dataset`, `addEventListener`/`removeEventListener`/`dispatchEvent`, `focus`/`blur`
 *   (the UI's focus, ADR 0340), `getBoundingClientRect` (transformed, in canvas UI pixels), `closest`/`matches`/
 *   `querySelector`/`querySelectorAll`, `contains`, `parentElement`/`parentNode`/`children`/`childNodes`/
 *   `firstElementChild`/`lastElementChild`/`nextElementSibling`/`previousElementSibling` (and the node
 *   versions), `value`, `tagName`, `textContent`, `innerHTML` (read-only), `isConnected`, `element` (the
 *   hosted UI element), and (ADR 0423) `scrollTop`/`scrollLeft`, `scrollWidth`/`scrollHeight`/`clientWidth`/
 *   `clientHeight`, `scrollTo`, `scrollBy` and `scrollIntoView`.
 * - **`t()`** from "myco" is reactive in components: the renderer installs a reactive read of `Locale.epoch`.
 *
 * Svelte builds a template instance as a detached subtree and inserts it; the hosted elements are made
 * when a subtree is connected to a mounted view, and the subtree is styled once, at once. An `insert` of a
 * node already in the same view is a move (a keyed `{#each}` reorder keeps its GameObjects).
 */
/// <reference path="./svelte-modules.d.ts" />
import { createRenderer } from "svelte/renderer";
import { flushSync, mount, unmount, type Component } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import { proxy } from "svelte/internal/client";
import { Color, Vector2 } from "../../../engine/core/math";
import { onLocaleEpoch } from "../../../engine/localisation/Locale";
import { setLocaleTracker } from "../../../engine/localisation/t";
import { uiTagOfHtml } from "../../../engine/ui/host/htmlTags";
import { onUIHostBubbleOut, setUIHostStyles, UIHostElement, UIHostEvent, type UIHostEventType, type UIHostSource, type UIHostTree } from "../../../engine/ui/host/UIHost";
import { addUIListener, removeUIListener, runUIListeners, uiListenerOptions, type UIListener } from "../../../engine/ui/events";
import type { UIStylesheet, UITag } from "../../../engine/ui/document/types";
import { UIGlobals, UIGlobalTarget, type GlobalKind } from "./globalTargets";

const EVENTS: Readonly<Record<string, UIHostEventType>> = {
  click: "click",
  input: "input",
  change: "change",
  submit: "submit",
  focus: "focus",
  blur: "blur",
  pointerenter: "pointerenter",
  pointerleave: "pointerleave",
  mouseenter: "pointerenter",
  mouseleave: "pointerleave",
  // ADR 0422: the pointer (with the mouse names browsers also fire), keys, focus moving, drags; ADR 0423: scrolling.
  pointerdown: "pointerdown",
  pointerup: "pointerup",
  pointermove: "pointermove",
  pointerover: "pointerover",
  pointerout: "pointerout",
  pointercancel: "pointercancel",
  mousedown: "pointerdown",
  mouseup: "pointerup",
  mousemove: "pointermove",
  mouseover: "pointerover",
  mouseout: "pointerout",
  dblclick: "dblclick",
  contextmenu: "contextmenu",
  wheel: "wheel",
  keydown: "keydown",
  keyup: "keyup",
  focusin: "focusin",
  focusout: "focusout",
  scroll: "scroll",
  scrollend: "scrollend",
  dragstart: "dragstart",
  drag: "drag",
  dragenter: "dragenter",
  dragover: "dragover",
  dragleave: "dragleave",
  drop: "drop",
  dragend: "dragend",
  // ADR 0418 wave 4: stylesheet animation events, the frame after they happen.
  transitionend: "transitionend",
  animationstart: "animationstart",
  animationiteration: "animationiteration",
  animationend: "animationend",
};

/** Tags that belong in a page's head (`<svelte:head>`), not in a UI. */
const HEAD_TAGS = new Set(["head", "meta", "link", "base", "script", "style", "noscript", "title"]);

/** Attributes HTML has that aren't UI fields: kept on the node (getAttribute sees them), never given to the cascade. */
const HTML_ONLY = new Set(["type", "name", "for", "alt", "title", "role", "tabindex", "autocomplete", "lang", "dir", "hidden", "spellcheck", "inputmode", "autofocus", "form", "method", "action"]);

type Handler = (this: unknown, e: unknown) => void;

/** What propagation reads of an event (a `UIHostEvent`, or an event object a script made). */
type Propagating = { type: string; bubbles?: boolean; eventPhase?: number; _stopped?: boolean; _stoppedNow?: boolean; _passive?: boolean; target?: unknown; currentTarget?: unknown };

/**
 * ADR 0422: run `type`'s listeners on `el` for a phase (1 capture, 2 target, 3 bubble), `this` being the node. A
 * listener added with `once` is removed first; `stopImmediatePropagation` ends the run.
 */
function runListeners(el: UIRenderElement, type: string, event: Propagating, phase: 1 | 2 | 3): void {
  const list = el._listeners.get(type);
  if (!list?.length) return;
  try {
    event.currentTarget = el;
  } catch {
    // an event whose fields are read-only
  }
  runUIListeners(list, phase, event, (h) => h.call(el, event));
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[myco] ${message}`);
}

// --- Nodes ----------------------------------------------------------------------------------------

abstract class UINodeBase {
  /** @internal */ _parent: UIRenderElement | UIRenderFragment | null = null;

  /** The parent element, as the DOM's `parentElement` (null at the top of a view, or detached). */
  get parentElement(): UIRenderElement | null {
    const p = this._parent;
    return p instanceof UIRenderElement && !p._tree ? p : null;
  }

  /** Its parent (the view's mount node at the top of a view). */
  get parentNode(): UIRenderElement | UIRenderFragment | null {
    return this._parent;
  }

  get nextSibling(): UINode | null {
    const p = this._parent;
    return p ? (p._children[p._children.indexOf(this as unknown as UINode) + 1] ?? null) : null;
  }

  get previousSibling(): UINode | null {
    const p = this._parent;
    return p ? (p._children[p._children.indexOf(this as unknown as UINode) - 1] ?? null) : null;
  }

  get nextElementSibling(): UIRenderElement | null {
    let n = this.nextSibling;
    while (n && !(n instanceof UIRenderElement)) n = n.nextSibling;
    return n;
  }

  get previousElementSibling(): UIRenderElement | null {
    let n = this.previousSibling;
    while (n && !(n instanceof UIRenderElement)) n = n.previousSibling;
    return n;
  }
}

/** A fragment: a container Svelte fills and then inserts as a whole. */
export class UIRenderFragment {
  /** @internal */ _parent: null = null;
  /** @internal */ _children: UINode[] = [];
}

/** A text node. */
export class UIRenderText extends UINodeBase {
  readonly nodeType = 3;
  /** @internal Its own Text element (outside a Text), when it has non-whitespace content. */ _hosted: UIHostElement | null = null;
  constructor(public data: string) {
    super();
  }

  get textContent(): string {
    return this.data;
  }
}

/** A comment: Svelte's anchors. Never built. */
export class UIRenderComment extends UINodeBase {
  readonly nodeType = 8;
  constructor(public data: string) {
    super();
  }
}

/** An element's classes, as the DOM's `classList`: changes rewrite its `class` attribute. */
class RenderClassList {
  constructor(private readonly el: UIRenderElement) {}
  private get list(): string[] {
    return (this.el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
  private write(list: string[]): void {
    this.el.setAttribute("class", list.join(" "));
  }
  contains(name: string): boolean {
    return this.list.includes(name);
  }
  add(...names: string[]): void {
    const list = this.list;
    const add = names.filter((n) => !list.includes(n));
    if (add.length) this.write([...list, ...add]);
  }
  remove(...names: string[]): void {
    const list = this.list;
    const kept = list.filter((n) => !names.includes(n));
    if (kept.length !== list.length) this.write(kept);
  }
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const want = force ?? !has;
    if (want && !has) this.add(name);
    else if (!want && has) this.remove(name);
    return want;
  }
  get length(): number {
    return this.list.length;
  }
  get value(): string {
    return this.list.join(" ");
  }
  toString(): string {
    return this.value;
  }
}

/** An element's inline style, as the DOM's `style`: changes rewrite its `style` attribute. */
class RenderStyle {
  constructor(private readonly el: UIRenderElement) {}
  private read(): Map<string, string> {
    const out = new Map<string, string>();
    for (const decl of (this.el.getAttribute("style") ?? "").split(";")) {
      const colon = decl.indexOf(":");
      if (colon > 0) out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
    return out;
  }
  private write(map: Map<string, string>): void {
    const text = [...map].map(([k, v]) => `${k}: ${v}`).join("; ");
    if (text) this.el.setAttribute("style", text);
    else this.el.removeAttribute("style");
  }
  get cssText(): string {
    return this.el.getAttribute("style") ?? "";
  }
  set cssText(text: string) {
    if (text) this.el.setAttribute("style", text);
    else this.el.removeAttribute("style");
  }
  getPropertyValue(name: string): string {
    return this.read().get(name) ?? "";
  }
  setProperty(name: string, value: string | null): void {
    const map = this.read();
    if (value === null || value === "") map.delete(name);
    else map.set(name, value);
    this.write(map);
  }
  removeProperty(name: string): string {
    const map = this.read();
    const old = map.get(name) ?? "";
    map.delete(name);
    this.write(map);
    return old;
  }
}

/** `backgroundColor` → `background-color` (`cssFloat` → `float`). */
function kebab(name: string): string {
  return name === "cssFloat" ? "float" : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** A `RenderStyle` that also reads and writes properties by camel-case name, as a `CSSStyleDeclaration` does. */
function styleProxy(style: RenderStyle): RenderStyle {
  return new Proxy(style, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key in target) return Reflect.get(target, key, receiver);
      return target.getPropertyValue(kebab(key));
    },
    set(target, key, value, receiver) {
      if (typeof key !== "string" || key in target) return Reflect.set(target, key, value, receiver);
      target.setProperty(kebab(key), value === null || value === undefined ? null : String(value));
      return true;
    },
  });
}

/** `fooBar` ↔ `data-foo-bar`. */
function datasetProxy(el: UIRenderElement): Record<string, string | undefined> {
  const attr = (key: string) => `data-${kebab(key)}`;
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_, key) => (typeof key === "string" ? (el.getAttribute(attr(key)) ?? undefined) : undefined),
    set: (_, key, value) => {
      if (typeof key === "string") el.setAttribute(attr(key), String(value));
      return true;
    },
    deleteProperty: (_, key) => {
      if (typeof key === "string") el.removeAttribute(attr(key));
      return true;
    },
    has: (_, key) => typeof key === "string" && el.hasAttribute(attr(key)),
    ownKeys: () => el.getAttributeNames().filter((n) => n.startsWith("data-")).map((n) => n.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())),
    getOwnPropertyDescriptor: (_, key) => (typeof key === "string" && el.hasAttribute(attr(key)) ? { value: el.getAttribute(attr(key)), enumerable: true, configurable: true, writable: true } : undefined),
  });
}

/** An element: what Svelte creates for a tag, and what `bind:this`, actions and attachments receive. */
export class UIRenderElement extends UINodeBase {
  /** @internal */ readonly _uiTag: UITag;
  /** @internal */ readonly _attrs = new Map<string, unknown>();
  /** @internal */ _children: UINode[] = [];
  /** @internal Listeners by DOM event type (any type: a UI event's, or one an action dispatches). */ readonly _listeners = new Map<string, UIListener<Handler>[]>();
  /** @internal The host listeners (capture and bubble) relaying each UI event type to this node's listeners. */ _dispatchers = new Map<UIHostEventType, [(e: UIHostEvent) => void, (e: UIHostEvent) => void]>();
  /** @internal */ _hosted: UIHostElement | null = null;
  /** @internal Set on the container a view mounts into: the tree it hosts. */ _tree: UIHostTree | null = null;
  /** @internal An input's value set before its element was made (a binding, a script). */ _pendingValue: string | null = null;
  readonly classList: RenderClassList = new RenderClassList(this);
  /** Its inline style, as the DOM's `CSSStyleDeclaration`: `style.color = "red"`, `style.setProperty("--x", "1")`. */
  readonly style: RenderStyle = styleProxy(new RenderStyle(this));
  /** Its `data-*` attributes by camel-case name, as the DOM's `dataset`. */
  readonly dataset: Record<string, string | undefined> = datasetProxy(this);

  constructor(readonly localName: string) {
    super();
    const ui = uiTagOfHtml(localName);
    // Head content (`<svelte:head>`) is warned about where it's inserted.
    if (!ui && !HEAD_TAGS.has(localName)) warnOnce(`<${localName}> isn't an HTML tag the UI knows; it renders as a Panel (a <div>).`);
    this._uiTag = ui ?? "Panel";
  }

  get tagName(): string {
    return this.localName.toUpperCase();
  }

  get nodeName(): string {
    return this.tagName;
  }

  /** The hosted UI element, once the node is in a mounted view (null before, and after it's removed). */
  get element(): UIHostElement | null {
    return this._hosted;
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(value: string) {
    this.setAttribute("class", value);
  }

  readonly nodeType = 1;

  get children(): UIRenderElement[] {
    return this._children.filter((c): c is UIRenderElement => c instanceof UIRenderElement);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): UIRenderElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): UIRenderElement | null {
    return this.children.at(-1) ?? null;
  }

  get firstChild(): UINode | null {
    return this._children[0] ?? null;
  }

  get lastChild(): UINode | null {
    return this._children.at(-1) ?? null;
  }

  /** In a mounted view. */
  get isConnected(): boolean {
    return treeOf(this) !== null;
  }

  /** The `document` global target (`<svelte:document>`'s). */
  get ownerDocument(): unknown {
    return globals.document;
  }

  /** Every child node, text and comments included. */
  get childNodes(): readonly (UIRenderElement | UIRenderText | UIRenderComment)[] {
    return this._children;
  }

  get textContent(): string {
    return this._children.map((c) => (c instanceof UIRenderText || c instanceof UIRenderElement ? c.textContent : "")).join("");
  }

  /** Replace its children with one text node (an action or attachment writing text, as on the web). */
  set textContent(text: string) {
    for (const c of [...this._children]) renderer.remove(c);
    if (text !== "" && text !== null && text !== undefined) renderer.insert(this, new UIRenderText(String(text)), null);
  }

  /** Its content as HTML (read-only): the tree Svelte rendered, as a DOM's `innerHTML` would show it. */
  get innerHTML(): string {
    return this._children.map(serialize).join("");
  }

  get outerHTML(): string {
    return serialize(this);
  }

  /** The first element inside this one a selector matches (tags, `#id`, `.class`, `[attr]`, `[attr=value]`, descendant and child combinators). */
  querySelector(selector: string): UIRenderElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): UIRenderElement[] {
    const selectors = parseNodeSelectors(selector);
    const out: UIRenderElement[] = [];
    const visit = (el: UIRenderElement) => {
      for (const c of el._children) {
        if (!(c instanceof UIRenderElement)) continue;
        if (selectors.some((s) => matchesNode(s, s.length - 1, c, this))) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }

  /** Whether a selector matches it (the selectors `querySelector` takes). */
  matches(selector: string): boolean {
    const scope = mountOf(this);
    return this !== scope && parseNodeSelectors(selector).some((s) => matchesNode(s, s.length - 1, this, scope));
  }

  /** Itself or its nearest ancestor a selector matches (within its view), or null. */
  closest(selector: string): UIRenderElement | null {
    const scope = mountOf(this);
    const selectors = parseNodeSelectors(selector);
    for (let el: UIRenderElement | null = this; el && el !== scope; el = el._parent instanceof UIRenderElement ? el._parent : null) {
      const at = el;
      if (selectors.some((s) => matchesNode(s, s.length - 1, at, scope))) return at;
    }
    return null;
  }

  /** Whether `node` is this element or inside it. */
  contains(node: unknown): boolean {
    for (let n = node as UINode | UIRenderFragment | null; n; n = n._parent) if (n === this) return true;
    return false;
  }

  getAttributeNames(): string[] {
    return [...this._attrs.keys()].filter((k) => this.getAttribute(k) !== null);
  }

  /**
   * Dispatch `event` now (any type), as if it happened here (ADR 0422): through this node's ancestors in capture,
   * target and (when `event.bubbles`) bubble phases, then, out of a mounted view, `<svelte:body>`, `<svelte:document>`
   * and `<svelte:window>`. Returns false if a listener called `preventDefault`.
   */
  dispatchEvent(event: { type: string; defaultPrevented?: boolean; target?: unknown; currentTarget?: unknown; bubbles?: boolean }): boolean {
    const e = event as Propagating;
    try {
      e.target ??= this;
    } catch {
      // an event whose fields are read-only
    }
    const path: UIRenderElement[] = [];
    for (let n: UIRenderElement | UIRenderFragment | null = this; n instanceof UIRenderElement; n = n._parent) {
      path.push(n);
      if (n._tree) break; // the view's mount node: the canvas
    }
    const setPhase = (p: number) => {
      try {
        e.eventPhase = p;
      } catch {
        // read-only
      }
    };
    for (let i = path.length - 1; i >= 1 && !e._stopped; i--) {
      setPhase(1);
      runListeners(path[i], e.type, e, 1);
    }
    if (!e._stopped) {
      setPhase(2);
      runListeners(path[0], e.type, e, 2);
    }
    if (e.bubbles) {
      for (let i = 1; i < path.length && !e._stopped; i++) {
        setPhase(3);
        runListeners(path[i], e.type, e, 3);
      }
      if (!e._stopped && path[path.length - 1]._tree) globals._continue(e, [e.type]);
    }
    setPhase(0);
    return !event.defaultPrevented;
  }

  /** Click it, as a script can on the web: a bubbling `click` (a `UIHostEvent`) dispatched now (the UI core isn't involved). */
  click(): void {
    if (this._hosted) {
      const e = new UIHostEvent("click", this._hosted);
      e.target = this;
      this.dispatchEvent(e);
    } else this.dispatchEvent({ type: "click", defaultPrevented: false, bubbles: true });
  }

  getAttribute(name: string): string | null {
    const v = this._attrs.get(name);
    return v === undefined || v === null || v === false ? null : v === true ? "" : String(v);
  }

  setAttribute(name: string, value: unknown): void {
    renderer.setAttribute(this, name, value);
  }

  removeAttribute(name: string): void {
    renderer.removeAttribute(this, name);
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  addEventListener(type: string, handler: Handler, options?: boolean | { once?: boolean; capture?: boolean; passive?: boolean }): void {
    renderer.addEventListener(this, type, handler, options);
  }

  removeEventListener(type: string, handler: Handler, options?: boolean | { capture?: boolean }): void {
    renderer.removeEventListener(this, type, handler, options as never);
  }

  // --- Scrolling (ADR 0423): the hosted element's, once there is one ---------------------------------

  /** How far its content is scrolled down, in UI pixels; set it to scroll. */
  get scrollTop(): number {
    return this._hosted?.scrollTop ?? 0;
  }

  set scrollTop(value: number) {
    if (this._hosted) this._hosted.scrollTop = value;
  }

  /** How far its content is scrolled right. */
  get scrollLeft(): number {
    return this._hosted?.scrollLeft ?? 0;
  }

  set scrollLeft(value: number) {
    if (this._hosted) this._hosted.scrollLeft = value;
  }

  /** Its content's extent and its padding box from the last layout (UI pixels; 0 before). */
  get scrollWidth(): number {
    return this._hosted?.scrollWidth ?? 0;
  }

  get scrollHeight(): number {
    return this._hosted?.scrollHeight ?? 0;
  }

  get clientWidth(): number {
    return this._hosted?.clientWidth ?? 0;
  }

  get clientHeight(): number {
    return this._hosted?.clientHeight ?? 0;
  }

  /** Scroll its content to `x`, `y` (or `{ left, top, behavior }`). */
  scrollTo(x?: number | { left?: number; top?: number; behavior?: "auto" | "smooth" | "instant" }, y?: number): void {
    this._hosted?.scrollTo(x, y);
  }

  /** Scroll its content by `dx`, `dy` (or `{ left, top, behavior }`). */
  scrollBy(x?: number | { left?: number; top?: number; behavior?: "auto" | "smooth" | "instant" }, y?: number): void {
    this._hosted?.scrollBy(x, y);
  }

  /** Scroll its scrolling ancestors so it shows (`{ block, inline, behavior }`, or `true`/`false` for start/end). */
  scrollIntoView(options?: boolean | { block?: "start" | "center" | "end" | "nearest"; inline?: "start" | "center" | "end" | "nearest"; behavior?: "auto" | "smooth" | "instant" }): void {
    this._hosted?.scrollIntoView(options);
  }

  /** Give it the UI's focus (buttons and input fields; ADR 0340), as a script does: no focus event. */
  focus(): void {
    this._hosted?.focus();
  }

  blur(): void {
    this._hosted?.blur();
  }

  /**
   * Its box in its canvas's UI pixels from the last layout, through its transforms (ADR 0418 wave 3: the
   * axis-aligned rectangle around the transformed box, not cut by clips). Zero size before it's laid out.
   */
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } {
    const r = this._hosted?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height };
  }

  /** Input fields: their text (what the player typed). Setting it isn't a player change. */
  get value(): string {
    return this._hosted?.value ?? this._pendingValue ?? this.getAttribute("value") ?? "";
  }

  set value(value: string) {
    const v = value === null || value === undefined ? "" : String(value);
    if (this._hosted) this._hosted.value = v;
    else this._pendingValue = v;
  }
}

type UINode = UIRenderElement | UIRenderText | UIRenderComment;
type UIParent = UIRenderElement | UIRenderFragment;

// --- The Element subset's HTML and selectors -----------------------------------------------------

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function serialize(node: UINode): string {
  if (node instanceof UIRenderText) return escapeText(node.data);
  if (node instanceof UIRenderComment) return `<!--${node.data}-->`;
  let attrs = "";
  for (const name of node._attrs.keys()) {
    const v = node.getAttribute(name);
    if (v !== null) attrs += ` ${name}${v === "" ? "" : `="${escapeAttr(v)}"`}`;
  }
  const open = `<${node.localName}${attrs}>`;
  return VOID.has(node.localName) ? open : `${open}${node.innerHTML}</${node.localName}>`;
}

/** A compound of a node selector: all of it must match. */
interface NodeCompound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
  /** The combinator before this compound (null for the first). */
  combinator: " " | ">" | null;
}

const nodeSelectorCache = new Map<string, NodeCompound[][]>();

/** A small selector parser for `querySelector`: tags, `*`, `#id`, `.class`, `[attr]`, `[attr=value]`, descendant and child combinators, comma lists. */
function parseNodeSelectors(text: string): NodeCompound[][] {
  const cached = nodeSelectorCache.get(text);
  if (cached) return cached;
  const out: NodeCompound[][] = [];
  for (const part of text.split(",")) {
    const compounds: NodeCompound[] = [];
    const tokens = part.trim().replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
    let combinator: " " | ">" | null = null;
    for (const token of tokens) {
      if (token === ">") {
        combinator = ">";
        continue;
      }
      const c: NodeCompound = { tag: null, id: null, classes: [], attrs: [], combinator: compounds.length ? (combinator ?? " ") : null };
      combinator = null;
      const re = /([#.]?)([\w-]+|\*)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g;
      for (let m = re.exec(token); m; m = re.exec(token)) {
        if (m[3] !== undefined) c.attrs.push({ name: m[3], value: m[4] ?? null });
        else if (m[1] === "#") c.id = m[2];
        else if (m[1] === ".") c.classes.push(m[2]);
        else if (m[2] !== "*") c.tag = m[2].toLowerCase();
      }
      compounds.push(c);
    }
    if (compounds.length) out.push(compounds);
  }
  nodeSelectorCache.set(text, out);
  return out;
}

function matchesCompound(c: NodeCompound, el: UIRenderElement): boolean {
  if (c.tag && c.tag !== el.localName.toLowerCase()) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  if (c.classes.length) {
    const classes = (el.getAttribute("class") ?? "").split(/\s+/);
    if (!c.classes.every((k) => classes.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null || (a.value !== null && v !== a.value)) return false;
  }
  return true;
}

/** The mount node of the view `el` is in, or null when it's detached. */
function mountOf(el: UIRenderElement): UIRenderElement | null {
  for (let n: UIRenderElement | UIRenderFragment | null = el; n; n = n._parent) if (n instanceof UIRenderElement && n._tree) return n;
  return null;
}

/** Whether `compounds[0..i]` matches `el`, its ancestors staying inside `scope` (null: all of them). */
function matchesNode(compounds: NodeCompound[], i: number, el: UIRenderElement, scope: UIRenderElement | null): boolean {
  if (!matchesCompound(compounds[i], el)) return false;
  if (i === 0) return true;
  const up = (n: UIRenderElement) => (n._parent instanceof UIRenderElement && n._parent !== scope ? n._parent : null);
  if (compounds[i].combinator === ">") {
    const p = up(el);
    return !!p && matchesNode(compounds, i - 1, p, scope);
  }
  for (let p = up(el); p; p = up(p)) if (matchesNode(compounds, i - 1, p, scope)) return true;
  return false;
}

// --- Building and dropping hosted elements -------------------------------------------------------

function treeOf(node: UINode | UIRenderFragment | null): UIHostTree | null {
  for (let n: UINode | UIRenderFragment | null = node; n; n = n._parent) if (n instanceof UIRenderElement && n._tree) return n._tree.isValid ? n._tree : null;
  return null;
}

const isTextKind = (n: unknown): n is UIRenderElement => n instanceof UIRenderElement && n._uiTag === "Text";
const isLeafKind = (n: UIRenderElement) => n._uiTag === "Image" || n._uiTag === "InputField";

/** The outermost Text element `node` is inside, within its run of Text ancestors (it holds the text), or null. */
function textOwner(node: UINode): UIRenderElement | null {
  let owner: UIRenderElement | null = null;
  for (let p = node._parent; p instanceof UIRenderElement && !p._tree; p = p._parent) {
    if (!isTextKind(p)) break;
    owner = p;
  }
  return owner;
}

/** The hosted element `parent`'s children attach to (null: the canvas, for the mount container); undefined: children aren't built there. */
function hostedParent(parent: UIParent): UIHostElement | null | undefined {
  if (!(parent instanceof UIRenderElement)) return undefined;
  if (parent._tree) return null;
  return parent._hosted ?? undefined;
}

/** The next hosted sibling after `node`: what its element goes before (null: last). */
function hostedBefore(node: UINode): UIHostElement | null {
  const siblings = node._parent!._children;
  for (let i = siblings.indexOf(node) + 1; i < siblings.length; i++) {
    const s = siblings[i];
    if ((s instanceof UIRenderElement || s instanceof UIRenderText) && s._hosted) return s._hosted;
  }
  return null;
}

function cssText(value: unknown): string | null {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return "";
  if (value instanceof Color) return `rgba(${Math.round(value.r * 255)}, ${Math.round(value.g * 255)}, ${Math.round(value.b * 255)}, ${value.a})`;
  if (value instanceof Vector2) return `${value.x} ${value.y}`;
  return String(value);
}

/** The attributes the hosted element gets: HTML-only ones dropped, HTML's names mapped onto fields. */
function hostAttributes(el: UIRenderElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of el._attrs) {
    const s = cssText(v);
    if (s === null || HTML_ONLY.has(k) || k.startsWith("aria-") || k.startsWith("data-")) continue;
    if (k === "src" && el._uiTag === "Image") out.set("image", s);
    else if (k === "disabled") {
      if (el._uiTag === "Button" || el._uiTag === "InputField") out.set("interactable", "false");
    } else out.set(k, s);
  }
  return out;
}

function sourceOf(el: UIRenderElement): UIHostSource | null {
  const meta = (el as unknown as { __svelte_meta?: { loc?: UIHostSource } }).__svelte_meta;
  return meta?.loc ? { file: meta.loc.file, line: meta.loc.line, column: meta.loc.column } : null;
}

/** Text with whitespace collapsed as UI markup does (runs of spaces, tabs and line breaks become one space, trimmed; U+00A0 kept). */
function collapse(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ").trim();
}

/** The DOM event types each UI event is delivered as (`pointerenter` also as `mouseenter`). */
const DOM_TYPES_OF = new Map<UIHostEventType, string[]>();
for (const [dom, ui] of Object.entries(EVENTS)) DOM_TYPES_OF.set(ui, [...(DOM_TYPES_OF.get(ui) ?? []), dom]);

/**
 * ADR 0422: relay a UI event type from `el`'s hosted element to its listeners, each phase: a capture listener on the
 * host runs the node's capture listeners (while capturing, and first at the target), a bubble one its others. The
 * event's `target` and `relatedTarget` become nodes.
 */
function attachDispatcher(el: UIRenderElement, type: UIHostEventType): void {
  if (!el._hosted || el._dispatchers.has(type)) return;
  const make = (phase: 1 | 3) => (e: UIHostEvent) => {
    e.currentTarget = el;
    e.target = hostedNodes.get(e.element) ?? el;
    if (e.relatedTarget instanceof UIHostElement) e.relatedTarget = hostedNodes.get(e.relatedTarget) ?? null;
    for (const dom of DOM_TYPES_OF.get(type) ?? []) {
      runListeners(el, dom, e, phase);
      if (e._stoppedNow) break;
    }
  };
  const pair: [(e: UIHostEvent) => void, (e: UIHostEvent) => void] = [make(1), make(3)];
  el._dispatchers.set(type, pair);
  el._hosted.on(type, pair[0], { capture: true });
  el._hosted.on(type, pair[1]);
}

/** Build `node` (and its subtree) in `tree`. Returns the top element built, to restyle once. */
function materialize(node: UINode, tree: UIHostTree): UIHostElement | null {
  const parent = node._parent!;
  if (node instanceof UIRenderComment) return null;
  const owner = textOwner(node);
  if (owner) {
    refreshText(owner);
    return null;
  }
  const hp = hostedParent(parent);
  if (hp === undefined) return null;
  if (node instanceof UIRenderText) {
    if (!node.data.trim()) return null;
    const label = tree.create("#text", "Text", hp, hostedBefore(node), new Map(), { synthetic: true });
    node._hosted = label;
    tree.setText(label, collapse(node.data));
    return label;
  }
  if (parent instanceof UIRenderElement && isLeafKind(parent)) {
    warnOnce(`<${node.localName}> inside <${parent.localName}> isn't shown: a <${parent.localName}> has no children.`);
    return null;
  }
  const made = tree.create(node.localName, node._uiTag, hp, hostedBefore(node), hostAttributes(node), { source: sourceOf(node) });
  node._hosted = made;
  node._dispatchers = new Map();
  hostedNodes.set(made, node);
  for (const type of node._listeners.keys()) if (EVENTS[type]) attachDispatcher(node, EVENTS[type]);
  if (node._pendingValue !== null) {
    made.value = node._pendingValue;
    node._pendingValue = null;
  }
  for (const c of node._children) materialize(c, tree);
  if (node._uiTag === "Text") refreshText(node);
  return made;
}

/** Forget the hosted elements of a subtree (its elements were removed with their parent's). */
function forget(node: UINode): void {
  if (node instanceof UIRenderElement) {
    if (node._hosted && node._uiTag === "InputField") node._pendingValue = node._hosted.value;
    node._hosted = null;
    node._dispatchers = new Map();
    node._children.forEach(forget);
  } else if (node instanceof UIRenderText) node._hosted = null;
}

function dematerialize(node: UINode, tree: UIHostTree | null): void {
  if ((node instanceof UIRenderElement || node instanceof UIRenderText) && node._hosted && tree) tree.remove(node._hosted);
  forget(node);
}

/**
 * A removed `<video>` or `<audio>` keeps no listeners, as Svelte's DOM runtime removes them from media elements (which
 * can still fire after they're removed); other removed elements keep theirs, as on the web.
 */
function dropMediaListeners(node: UINode): void {
  if (!(node instanceof UIRenderElement)) return;
  if (node.localName === "video" || node.localName === "audio") node._listeners.clear();
  node._children.forEach(dropMediaListeners);
}

function detach(node: UINode): void {
  const p = node._parent;
  if (!p) return;
  const i = p._children.indexOf(node);
  if (i >= 0) p._children.splice(i, 1);
  node._parent = null;
}

/** A Text element's content changed: write its text. */
function refreshText(el: UIRenderElement | null): void {
  if (!el?._hosted) return;
  el._hosted.tree.setText(el._hosted, collapse(el.textContent));
}

function refreshTextOf(node: UINode | null): void {
  if (!node) return;
  refreshText(isTextKind(node) && !textOwner(node) ? node : textOwner(node));
}

// --- Bindings ------------------------------------------------------------------------------------

function bindValue(node: UIRenderElement, get: () => unknown, set: (value: unknown) => void): () => void {
  const value = get();
  const text = value === null || value === undefined ? "" : String(value);
  if (node.value !== text) node.value = text;
  const onInput = () => set(node.value);
  node.addEventListener("input", onInput);
  return () => node.removeEventListener("input", onInput);
}

// --- The renderer ---------------------------------------------------------------------------------

const renderer = createRenderer<{ fragment: UIRenderFragment; element: UIRenderElement; text: UIRenderText; comment: UIRenderComment }>({
  createFragment: () => new UIRenderFragment(),
  createElement: (name) => new UIRenderElement(name),
  createText: (data) => new UIRenderText(data),
  createComment: (data) => new UIRenderComment(data),
  getNodeType: (node) => (node instanceof UIRenderElement ? "element" : node instanceof UIRenderText ? "text" : node instanceof UIRenderComment ? "comment" : "fragment"),
  getText: (node) => node.data,
  setText(node, text) {
    node.data = text;
    const owner = textOwner(node);
    if (owner) return refreshText(owner);
    const tree = treeOf(node);
    if (!tree || !node._parent) return;
    const blank = !text.trim();
    if (node._hosted && blank) dematerialize(node, tree);
    else if (node._hosted) tree.setText(node._hosted, collapse(text));
    else if (!blank) {
      const made = materialize(node, tree);
      if (made) tree.restyle(made);
    }
  },
  getAttribute: (el, name) => el.getAttribute(name),
  setAttribute(el, key, value) {
    if (value === undefined || value === null || value === false) return renderer.removeAttribute(el, key);
    el._attrs.set(key, value);
    if (el._hosted) el._hosted.tree.setAttributes(el._hosted, hostAttributes(el));
  },
  removeAttribute(el, name) {
    if (!el._attrs.delete(name)) return;
    if (el._hosted) el._hosted.tree.setAttributes(el._hosted, hostAttributes(el));
  },
  hasAttribute: (el, name) => el.hasAttribute(name),
  getFirstChild: (el) => el._children[0] ?? null,
  getLastChild: (el) => el._children[el._children.length - 1] ?? null,
  getNextSibling(node) {
    const p = node._parent;
    if (!p) return null;
    return p._children[p._children.indexOf(node) + 1] ?? null;
  },
  getParent: (node) => node._parent,
  insert(parent, node, anchor) {
    if (parent === head && node instanceof UIRenderElement) warnOnce(`<${node.localName}> in <svelte:head> is ignored: in a game, only <title> means something (the window's title).`);
    if (node instanceof UIRenderFragment) {
      for (const c of [...node._children]) renderer.insert(parent, c, anchor);
      return;
    }
    const oldParent = node._parent;
    const oldTree = treeOf(node);
    const hadOwner = textOwner(node);
    detach(node);
    if (hadOwner) refreshText(hadOwner);
    const at = anchor ? parent._children.indexOf(anchor as UINode) : -1;
    if (at < 0) parent._children.push(node);
    else parent._children.splice(at, 0, node);
    node._parent = parent;
    const tree = treeOf(node);
    const owner = textOwner(node);
    if (owner) {
      if ((node instanceof UIRenderElement || node instanceof UIRenderText) && node._hosted) dematerialize(node, oldTree);
      return refreshText(owner);
    }
    const hosted = node instanceof UIRenderElement || node instanceof UIRenderText ? node._hosted : null;
    const hp = hostedParent(parent);
    if (hosted && tree && tree === oldTree && hp !== undefined) {
      tree.move(hosted, hp, hostedBefore(node)); // a keyed {#each} reorder: the same GameObject
      return;
    }
    if (hosted) dematerialize(node, oldTree);
    else if (oldParent && !oldTree) forget(node);
    if (tree) {
      const made = materialize(node, tree);
      if (made) tree.restyle(made);
    }
  },
  remove(node) {
    const parent = node._parent;
    const tree = treeOf(node);
    const owner = textOwner(node);
    detach(node);
    dropMediaListeners(node);
    if (owner) return refreshText(owner);
    dematerialize(node, tree);
    if (parent instanceof UIRenderElement) refreshTextOf(parent);
  },
  addEventListener(el, type, handler, options) {
    // `<svelte:window>`, `<svelte:document>` and `<svelte:body>` (the patch's `globalTarget`)
    if (isGlobal(el)) return el.addEventListener(type, handler as Handler, options as { once?: boolean });
    const ui = EVENTS[type];
    // Any type is kept, for `dispatchEvent` (an action's custom event); only the UI's events happen by themselves.
    if (!ui && !el._listeners.has(type)) warnIfNotYet(type);
    let list = el._listeners.get(type);
    if (!list) el._listeners.set(type, (list = []));
    const o = uiListenerOptions(options); // ADR 0422: capture, once and passive
    addUIListener(list, handler as Handler, o.capture, o.once, o.passive);
    if (ui) attachDispatcher(el, ui);
  },
  removeEventListener(el, type, handler, options?: unknown) {
    if (isGlobal(el)) return el.removeEventListener(type, handler as Handler);
    removeUIListener(el._listeners.get(type), handler as Handler, uiListenerOptions(options).capture);
  },
  // The patch's hooks (patches/svelte+5.59.2.patch): element bindings under a custom renderer, and bindings on the global targets.
  bind(node, name, get, set) {
    if (isGlobal(node)) {
      const stop = node._bind(name, set);
      if (!stop) warnOnce(`bind:${name} on <svelte:${node.kind}> isn't something a game has.`);
      return stop;
    }
    if (name === "value" && node._uiTag === "InputField") return bindValue(node, get, set);
    warnOnce(`bind:${name} on <${node.localName}> isn't supported yet; UI elements bind value on <input>.`);
  },
  // What <svelte:window>, <svelte:document> and <svelte:body> stand for, and what <svelte:head> content goes into.
  globalTarget(kind) {
    return kind === "head" ? head : globals.target(kind as GlobalKind);
  },
  // `css: 'injected'`: the rule data parsed when the component compiled (`injectStyles`), keyed by its scoping hash.
  addStyles(hash) {
    const data = injected.get(hash);
    if (data) setUIHostStyles(`svelte-injected:${hash}`, data);
    else warnOnce(`A component's injected CSS (${hash}) wasn't parsed when it compiled, and games have no CSS parser: compile it with the engine's compileSvelteUI, or use css: 'external'.`);
  },
});

export default renderer;

/** Whether a node the runtime hands the renderer is a global target (`globalTarget`), not an element. */
function isGlobal(node: unknown): node is UIGlobalTarget {
  return node instanceof UIGlobalTarget;
}

/** The renderer node of each hosted element (for `document.activeElement`). */
const hostedNodes = new WeakMap<UIHostElement, UIRenderElement>();
/** What `<svelte:head>` content goes into: never shown (only `<title>` means something, through `document.title`). */
const head = new UIRenderElement("head");
/** `<svelte:window>`, `<svelte:document>` and `<svelte:body>`. */
const globals = new UIGlobals(head, (el) => hostedNodes.get(el) ?? null);

/** DOM events UI elements don't have (ADR 0422's set covers the pointer as pointer and mouse events, not touch events). */
const NOT_YET = new Set(["keypress", "touchstart", "touchmove", "touchend", "touchcancel", "auxclick", "beforeinput", "compositionstart", "compositionend"]);
/** Warn (once per type) about a DOM event no UI element has; other types are custom events an action dispatches. */
function warnIfNotYet(type: string): void {
  if (NOT_YET.has(type)) warnOnce(`on${type} doesn't happen on UI elements; touches arrive as pointer events (onpointerdown, onpointermove, onpointerup), and keys as onkeydown and onkeyup.`);
}

// ADR 0422: UI events that bubble out of a view's canvas go on through <svelte:body>, <svelte:document> and <svelte:window>
// (and the types the UI dispatched aren't fed to them again from the devices that frame).
onUIHostBubbleOut((e, tree) => {
  if (!mountedTrees.has(tree)) return;
  globals._continue(e, DOM_TYPES_OF.get(e.type) ?? [e.type]);
});

/** Trees a view is mounted on. */
const mountedTrees = new WeakSet<UIHostTree>();

// `t()` from "myco" follows the language inside components: a reactive read of Locale.epoch.
setLocaleTracker(createSubscriber((update) => onLocaleEpoch(update)));

// --- Styles ---------------------------------------------------------------------------------------

/**
 * What a compiled component (or a `.css` file it imports) calls when it's imported: its CSS (`css: 'external'`),
 * parsed into rule data when it compiled, joins every view's cascade.
 */
export function addStyles(file: string, css: UIStylesheet): void {
  setUIHostStyles(file, css);
}

/** `css: 'injected'` styles parsed when their component compiled, by scoping hash: what the `addStyles` hook registers when one is created. */
const injected = new Map<string, UIStylesheet>();

/**
 * What a compiled component with `css: 'injected'` calls when it's imported: its CSS as rule data (parsed when it
 * compiled; games ship no CSS parser), registered by the renderer's `addStyles` hook once the component is created.
 */
export function injectStyles(hash: string, css: UIStylesheet): void {
  injected.set(hash, css);
}

// --- Mounting: what `UIView` does ----------------------------------------------------------------

/** A mounted component. */
export interface MountedView {
  /** The node the component is mounted into (it stands for the canvas): its Element subset reads the rendered tree. */
  readonly target: UIRenderElement;
  /** The props the component sees, reactive: assigning a key (or changing something inside one) updates it on the next flush. */
  readonly props: Record<string, unknown>;
  /** Apply queued updates now (Svelte batches them in a microtask). */
  flush(): void;
  unmount(): void;
}

/** A component module's component: its default export, or the value itself. */
export function componentOf(module: unknown): Component<Record<string, unknown>> | null {
  if (typeof module === "function") return module as Component<Record<string, unknown>>;
  const d = (module as { default?: unknown } | null)?.default;
  return typeof d === "function" ? (d as Component<Record<string, unknown>>) : null;
}

/** Mount `component` on `tree`'s canvas with `props` (made reactive). */
export function mountView(tree: UIHostTree, component: Component<Record<string, unknown>>, props: Record<string, unknown>): MountedView {
  const container = new UIRenderElement("div");
  container._tree = tree;
  container._hosted = tree.root;
  mountedTrees.add(tree);
  hostedNodes.set(tree.root, container);
  const reactive = proxy({ ...props }) as Record<string, unknown>;
  const instance = mount(component, { target: container as never, props: reactive, renderer } as never);
  flushSync();
  let mounted = true;
  return {
    target: container,
    props: reactive,
    flush: () => {
      if (mounted) flushSync();
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      void unmount(instance);
      flushSync();
    },
  };
}
