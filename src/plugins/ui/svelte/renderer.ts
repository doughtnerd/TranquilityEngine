/**
 * The engine's Svelte renderer (ADR 0419): `createRenderer` from `svelte/renderer`, whose nodes become UI
 * core elements through the UI core's external tree host (`engine/ui/host/UIHost.ts`). Compiled UI
 * components import it (`experimental.customRenderer`, as `myco/ui-renderer`); `UIView` loads it on demand,
 * so games without Svelte UI never download Svelte.
 *
 * - **Tags are HTML names**, mapped onto UI elements (`engine/ui/host/htmlTags.ts`): `div`, `section`,
 *   `nav`… → Panel; `span`, `p`, `h1`–`h6`, `label` → Text; `img` → Image; `button` → Button; `input` →
 *   InputField; (ADR 0426) `svg` → Svg, `video` → Video, `audio` → Audio. Unknown tags warn once and are Panels. The
 *   cascade matches the tag as written.
 * - **Inline SVG (ADR 0426).** An `<svg>`'s descendants (`path`, `rect`, `circle`, `g`, `text`, `use`, gradients…) aren't
 *   UI elements: the renderer keeps them as nodes and writes the subtree as SVG text to the `<svg>`'s `UISvg.markup`
 *   whenever anything in it changes; the drawing layer rasterises it. Only the `<svg>` itself is styled by the cascade
 *   (its size, `color` for `currentColor`); shapes take their paint from attributes and inline styles. Pointer events on
 *   the `<svg>` go on to the shape under them (`svgShapeAt`: geometry and `pointer-events`), through its groups. Shapes
 *   have `getTotalLength()`/`getPointAtLength()`, and `draw` writes its stroke dashes into the subtree each frame.
 * - **Media (ADR 0426).** `<video>` and `<audio>` nodes have the media API (`play`, `pause`, `currentTime`, `duration`,
 *   `paused`, `ended`, `volume`, `muted`, `playbackRate`, `loop`…) over their `UIVideo`/`UIAudio`, media events
 *   (`onplay`, `onended`, `ontimeupdate`…) and Svelte's media bindings through `bind`. `src` (or a `<source>` child's),
 *   `autoplay`, `loop` and `muted` attributes are fields.
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
 *   title), `addStyles` (`css: 'injected'`, as rule data parsed when the component compiled), and `animate` and
 *   `measure` (`transition:`, `in:`, `out:`, `animate:` and `svelte/transition`: keyframes played on the UI animator,
 *   and geometry laid out when read; `animation.ts`).
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
import { SVG_CONTENT_TAGS, uiTagOfHtml, uiTagOfInput } from "../../../engine/ui/host/htmlTags";
import { UIAudio, UIForm, UIOption, UIRadio, UISvg, UIText, UIVideo } from "../../../engine/ui/components";
import { checkRadio, chooseOption, selectOf } from "../../../engine/ui/formControls";
import { applyAffine, invert, multiply } from "../../../engine/ui/transform2d";
import { distanceToOutline, flattenPath, insideFill, parseSvgTransform, pathLength, pointAtLength, shapePath, SVG_GEOMETRY_TAGS, viewBoxMap } from "../../../engine/ui/svg/svgGeometry";
import { UI_MEDIA_EVENTS, type UIMediaEvent, type UIMediaEventType } from "../../../engine/ui/media";
import { onUIHostBubbleOut, onUIHostEdit, setUIHostStyles, UIHostElement, UIHostEvent, type UIHostEventType, type UIHostSource, type UIHostTree } from "../../../engine/ui/host/UIHost";
import { addUIListener, removeUIListener, runUIListeners, uiListenerOptions, type UIListener } from "../../../engine/ui/events";
import type { UIStylesheet, UITag } from "../../../engine/ui/document/types";
import { UIGlobals, UIGlobalTarget, type GlobalKind } from "./globalTargets";
import { animateNode, animateSvgNode, measureNode } from "./animation";
import type { InlineHtmlNode } from "./htmlInline";

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
  // ADR 0424: a form's reset.
  reset: "reset",
  // ADR 0418 wave 4: stylesheet animation events, the frame after they happen.
  transitionend: "transitionend",
  animationstart: "animationstart",
  animationiteration: "animationiteration",
  animationend: "animationend",
};

/** Tags that belong in a page's head (`<svelte:head>`), not in a UI. */
const HEAD_TAGS = new Set(["head", "meta", "link", "base", "script", "style", "noscript", "title"]);

/** Attributes HTML has that aren't UI fields: kept on the node (getAttribute sees them), never given to the cascade. */
const HTML_ONLY = new Set(["type", "name", "for", "alt", "title", "role", "tabindex", "autocomplete", "lang", "dir", "hidden", "spellcheck", "inputmode", "autofocus", "form", "method", "action",
  // ADR 0425: a link's and an inline element's attributes stay on the node (a game handles a link's click itself).
  "href", "target", "rel", "download", "hreflang", "cite", "datetime"]);

type Handler = (this: unknown, e: unknown) => void;

/** What propagation reads of an event (a `UIHostEvent`, or an event object a script made). */
type Propagating = { type: string; bubbles?: boolean; eventPhase?: number; _stopped?: boolean; _stoppedNow?: boolean; _passive?: boolean; target?: unknown; currentTarget?: unknown };

/**
 * ADR 0422: run `type`'s listeners on `el` for a phase (1 capture, 2 target, 3 bubble), `this` being the node. A
 * listener added with `once` is removed first; `stopImmediatePropagation` ends the run.
 */
/**
 * Set an event's propagation field (`target`, `currentTarget`, `eventPhase`) as dispatch does: assigned on a plain or
 * engine event, defined on the instance for a DOM `Event` a script made (`new Event("blur")`), whose are read-only.
 */
function setEventField(event: object, key: "target" | "currentTarget" | "eventPhase", value: unknown): void {
  const e = event as Record<string, unknown>;
  try {
    e[key] = value;
  } catch {
    // read-only: defined below
  }
  if (e[key] === value) return;
  try {
    Object.defineProperty(event, key, { configurable: true, enumerable: true, get: () => value });
  } catch {
    // a frozen event keeps its own
  }
}

function runListeners(el: UIRenderElement, type: string, event: Propagating, phase: 1 | 2 | 3): void {
  const list = el._listeners.get(type);
  if (!list?.length) return;
  setEventField(event, "currentTarget", el);
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
    // As the DOM serialises it (`a: 1; b: 2;`); removing the last property leaves `style=""`, as there.
    this.el.setAttribute("style", [...map].map(([k, v]) => `${k}: ${v};`).join(" "));
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
    if (value === null || value === "") return void this.removeProperty(name);
    const map = this.read();
    map.set(name, value);
    this.write(map);
  }
  removeProperty(name: string): string {
    const map = this.read();
    const old = map.get(name);
    if (old === undefined) return ""; // nothing removed: the attribute stays as it is
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
  /** @internal The UI element it makes (ADR 0424: an `<input>`'s follows its `type`). */ _uiTag: UITag;
  /** @internal */ readonly _attrs = new Map<string, unknown>();
  /** @internal */ _children: UINode[] = [];
  /** @internal Listeners by DOM event type (any type: a UI event's, or one an action dispatches). */ readonly _listeners = new Map<string, UIListener<Handler>[]>();
  /** @internal The host listeners (capture and bubble) relaying each UI event type to this node's listeners. */ _dispatchers = new Map<UIHostEventType, [(e: UIHostEvent) => void, (e: UIHostEvent) => void]>();
  /** @internal */ _hosted: UIHostElement | null = null;
  /** @internal Set on the container a view mounts into: the tree it hosts. */ _tree: UIHostTree | null = null;
  /** @internal An input's value set before its element was made (a binding, a script). */ _pendingValue: string | null = null;
  /** @internal ADR 0424: `checked`, `indeterminate` and `selected` set before its element was made. */ _pendingState: Partial<Record<"checked" | "indeterminate" | "selected", boolean>> = {};
  /** @internal ADR 0426: inside an <svg>, the CSS a Svelte transition is writing now (`draw`'s stroke dashes), by kebab-case property. */ _svgAnim: Readonly<Record<string, string>> | null = null;
  /** @internal ADR 0426: a media element's media-event relays from its hosted element, by type. */ _mediaRelays = new Map<string, (e: UIMediaEvent) => void>();
  /** @internal ADR 0426: media properties a script set before the element was made (`volume`, `muted`, `playbackRate`, `currentTime`). */ _pendingMedia = new Map<string, number | boolean>();
  readonly classList: RenderClassList = new RenderClassList(this);
  /** Its inline style, as the DOM's `CSSStyleDeclaration`: `style.color = "red"`, `style.setProperty("--x", "1")`. */
  readonly style: RenderStyle = styleProxy(new RenderStyle(this));
  /** Its `data-*` attributes by camel-case name, as the DOM's `dataset`. */
  readonly dataset: Record<string, string | undefined> = datasetProxy(this);

  constructor(
    readonly localName: string,
    /** @internal The namespace it was created in, when the renderer is told (Svelte's `createElement(name, namespace)`); else worked out from where it is. */ readonly _namespace: string | null = null,
  ) {
    super();
    const ui = uiTagOfHtml(localName);
    // Head content (`<svelte:head>`) is warned about where it's inserted.
    // ADR 0426: an <svg>'s shapes are kept as its SVG document (warned about where they're inserted outside one).
    if (!ui && !HEAD_TAGS.has(localName) && !SVG_CONTENT_TAGS.has(localName.toLowerCase())) warnOnce(`<${localName}> isn't an HTML tag the UI knows; it renders as a Panel (a <div>).`);
    this._uiTag = ui ?? "Panel";
    // A select iterates over its options (`const [first] = select`), as the DOM's does; other elements aren't iterable.
    if (this._uiTag === "Select") Object.defineProperty(this, Symbol.iterator, { value: () => this.options[Symbol.iterator]() });
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

  set id(value: string) {
    this.setAttribute("id", value);
  }

  /**
   * Its namespace, as the DOM's: the one it was created in when the renderer was told (`createElement(name, namespace)`),
   * else an `xmlns` attribute's, else where it is: SVG inside an `<svg>` (HTML again inside a `<foreignObject>`), MathML
   * inside a `<math>`, HTML elsewhere.
   */
  get namespaceURI(): string {
    for (let n: UIRenderElement | null = this; n; n = n._parent instanceof UIRenderElement ? n._parent : null) {
      if (n._namespace) return n === this || n.localName.toLowerCase() !== "foreignobject" ? n._namespace : NAMESPACE_HTML;
      const xmlns = n.getAttribute("xmlns");
      if (xmlns) return xmlns;
      const tag = n.localName.toLowerCase();
      if (n !== this && tag === "foreignobject") return NAMESPACE_HTML;
      if (tag === "svg") return NAMESPACE_SVG;
      if (tag === "math") return NAMESPACE_MATHML;
    }
    return NAMESPACE_HTML;
  }

  // --- Reflected attributes, as the DOM's IDL attributes reflect them --------------------------------

  /** HTML's `hidden` (a boolean attribute). */
  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }

  set hidden(on: boolean) {
    this.reflectFlag("hidden", on);
  }

  /** HTML's `inert` (a boolean attribute). */
  get inert(): boolean {
    return this.hasAttribute("inert");
  }

  set inert(on: boolean) {
    this.reflectFlag("inert", on);
  }

  /** HTML's `disabled` (a boolean attribute; a disabled control isn't interactable, ADR 0424). */
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }

  set disabled(on: boolean) {
    this.reflectFlag("disabled", on);
  }

  /** `<details>`' and `<dialog>`'s `open` (a boolean attribute). */
  get open(): boolean {
    return this.hasAttribute("open");
  }

  set open(on: boolean) {
    this.reflectFlag("open", on);
  }

  /** HTML's `draggable`: `true`/`false` as written, else images (and links with an `href`) are draggable by default. */
  get draggable(): boolean {
    const v = this.getAttribute("draggable")?.toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    const tag = this.localName.toLowerCase();
    return tag === "img" || (tag === "a" && this.hasAttribute("href"));
  }

  set draggable(on: boolean) {
    this.setAttribute("draggable", on ? "true" : "false");
  }

  /** HTML's `translate`: `yes` (or "") and `no` as written, else its parent's (true at the top). */
  get translate(): boolean {
    for (let n: UIRenderElement | null = this; n; n = n._parent instanceof UIRenderElement ? n._parent : null) {
      const v = n.getAttribute("translate")?.toLowerCase();
      if (v === "yes" || v === "") return true;
      if (v === "no") return false;
    }
    return true;
  }

  set translate(on: boolean) {
    this.setAttribute("translate", on ? "yes" : "no");
  }

  /** An `<input>`'s type as the DOM reads it (lower case, `text` for none or one it doesn't know), a `<button>`'s (`submit` by default); else the attribute. */
  get type(): string {
    const tag = this.localName.toLowerCase();
    const v = this.getAttribute("type");
    if (tag === "input") {
      const t = (v ?? "").toLowerCase();
      return INPUT_TYPES.has(t) ? t : "text";
    }
    if (tag === "button") {
      const t = (v ?? "").toLowerCase();
      return t === "reset" || t === "button" ? t : "submit";
    }
    return v ?? "";
  }

  set type(value: string) {
    this.setAttribute("type", value);
  }

  get name(): string {
    return this.getAttribute("name") ?? "";
  }

  set name(value: string) {
    this.setAttribute("name", value);
  }

  get title(): string {
    return this.getAttribute("title") ?? "";
  }

  set title(value: string) {
    this.setAttribute("title", value);
  }

  get lang(): string {
    return this.getAttribute("lang") ?? "";
  }

  set lang(value: string) {
    this.setAttribute("lang", value);
  }

  get dir(): string {
    const v = this.getAttribute("dir")?.toLowerCase() ?? "";
    return v === "ltr" || v === "rtl" || v === "auto" ? v : "";
  }

  set dir(value: string) {
    this.setAttribute("dir", value);
  }

  /** HTML's `tabIndex`: the attribute as a number, else 0 for a focusable control and -1 for anything else. */
  get tabIndex(): number {
    const n = parseInt(this.getAttribute("tabindex") ?? "", 10);
    return Number.isFinite(n) ? n : FOCUSABLE_TAGS.has(this._uiTag) ? 0 : -1;
  }

  set tabIndex(n: number) {
    this.setAttribute("tabindex", String(Math.trunc(Number(n) || 0)));
  }

  private reflectFlag(name: string, on: boolean): void {
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
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

  /** Its content as HTML: the tree Svelte rendered, as a DOM's `innerHTML` would show it. */
  get innerHTML(): string {
    return this._children.map(serialize).join("");
  }

  /**
   * ADR 0425: replace its content with HTML, parsed by the inline HTML parser (phrasing elements inside a text element are
   * its runs; block elements are panels; scripts, styles and event attributes are dropped).
   */
  set innerHTML(html: string) {
    for (const c of [...this._children]) renderer.remove(c);
    if (html !== "" && html !== null && html !== undefined) renderer.insert(this, htmlFragment(String(html)), null);
  }

  /** ADR 0425: its text as shown: `textContent` with each `<br>` a line break. */
  get innerText(): string {
    return this._children.map((c) => (c instanceof UIRenderText ? c.data : c instanceof UIRenderElement ? (c.localName.toLowerCase() === "br" ? "\n" : c.innerText) : "")).join("");
  }

  set innerText(text: string) {
    this.textContent = text;
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

  /** The elements inside this one with a tag (`*` for every one), in order. */
  getElementsByTagName(tag: string): UIRenderElement[] {
    return this.querySelectorAll(tag === "*" ? "*" : String(tag));
  }

  /** The elements inside this one with every class in `names` (space-separated), in order. */
  getElementsByClassName(names: string): UIRenderElement[] {
    const classes = String(names).split(/\s+/).filter(Boolean);
    return classes.length ? this.querySelectorAll(classes.map((c) => `.${c}`).join("")) : [];
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
    if (e.target === undefined || e.target === null) setEventField(e, "target", this);
    const path: UIRenderElement[] = [];
    for (let n: UIRenderElement | UIRenderFragment | null = this; n instanceof UIRenderElement; n = n._parent) {
      path.push(n);
      if (n._tree) break; // the view's mount node: the canvas
    }
    const setPhase = (p: number) => {
      setEventField(e, "eventPhase", p);
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

  /**
   * Click it, as a script can on the web: a bubbling `click` dispatched now with HTML's activation, by the UI core (a
   * checkbox toggles before the click's listeners and back if one prevents it, then `input` and `change`; a submit
   * button submits its form; a label clicks its control). Nothing on a disabled control. Before it's in a mounted view,
   * only the `click` is dispatched.
   */
  click(): void {
    if (this._hosted) this._hosted.click();
    else this.dispatchEvent({ type: "click", defaultPrevented: false, bubbles: true });
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
   * axis-aligned rectangle around the transformed box, not cut by clips), laid out first when the view changed since
   * (as the DOM's is). Zero size when nothing lays the World out.
   */
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } {
    // ADR 0426: a shape inside an <svg> reports its <svg>'s box.
    const at = this._hosted ?? svgRootOf(this)?._hosted ?? null;
    at?.tree.layoutNow(); // as reading layout does in the DOM: changes made since the last layout count
    const r = at?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height };
  }

  /**
   * ADR 0426: an SVG shape's length in its user units (`path`, `rect`, `circle`, `ellipse`, `line`, `polyline`,
   * `polygon`; the arc length of its path, `svgGeometry.ts`), as `svelte/transition`'s `draw` reads it. 0 for other tags.
   */
  getTotalLength(): number {
    const tag = this.localName.toLowerCase();
    if (!SVG_GEOMETRY_TAGS.has(tag)) {
      warnOnce(`<${this.localName}>.getTotalLength(): only SVG shapes (path, rect, circle, ellipse, line, polyline, polygon) have a length.`);
      return 0;
    }
    return pathLength(shapePath(tag, (n) => this.getAttribute(n)));
  }

  /** ADR 0426: the point `distance` along an SVG shape, in its user units (the origin for other tags). */
  getPointAtLength(distance: number): { x: number; y: number } {
    const tag = this.localName.toLowerCase();
    return SVG_GEOMETRY_TAGS.has(tag) ? pointAtLength(shapePath(tag, (n) => this.getAttribute(n)), Number(distance) || 0) : { x: 0, y: 0 };
  }

  // --- Media (ADR 0426): `<video>` and `<audio>`, through their hosted `UIVideo`/`UIAudio` --------------------

  /** Start playing (resolves at once; a browser that refuses to play warns). */
  play(): Promise<void> {
    const m = mediaOf(this);
    if (m) return m.play();
    this._pendingMedia.set("paused", false);
    return Promise.resolve();
  }

  pause(): void {
    const m = mediaOf(this);
    if (m) m.pause();
    else this._pendingMedia.set("paused", true);
  }

  get paused(): boolean {
    const m = mediaOf(this);
    return m ? m.paused : this._pendingMedia.get("paused") !== false;
  }

  get ended(): boolean {
    return mediaOf(this)?.ended ?? false;
  }

  /** Seconds played; set it to seek. */
  get currentTime(): number {
    return mediaOf(this)?.currentTime ?? Number(this._pendingMedia.get("currentTime") ?? 0);
  }

  set currentTime(seconds: number) {
    const m = mediaOf(this);
    if (m) m.currentTime = Number(seconds) || 0;
    else this._pendingMedia.set("currentTime", Number(seconds) || 0);
  }

  /** Seconds; NaN until known. */
  get duration(): number {
    return mediaOf(this)?.duration ?? NaN;
  }

  get volume(): number {
    return mediaOf(this)?.volume ?? Number(this._pendingMedia.get("volume") ?? 1);
  }

  set volume(v: number) {
    setMediaField(this, "volume", Math.min(1, Math.max(0, Number(v))));
  }

  get muted(): boolean {
    return mediaOf(this)?.muted ?? this._pendingMedia.get("muted") === true;
  }

  set muted(v: boolean) {
    setMediaField(this, "muted", !!v);
  }

  get playbackRate(): number {
    return mediaOf(this)?.playbackRate ?? Number(this._pendingMedia.get("playbackRate") ?? 1);
  }

  set playbackRate(v: number) {
    setMediaField(this, "playbackRate", Number(v) || 1);
  }

  get loop(): boolean {
    return mediaOf(this)?.loop ?? this.hasAttribute("loop");
  }

  set loop(v: boolean) {
    if (v) this.setAttribute("loop", "");
    else this.removeAttribute("loop");
  }

  get readyState(): number {
    return mediaOf(this)?.media?.readyState ?? 0;
  }

  get seeking(): boolean {
    return mediaOf(this)?.media?.seeking ?? false;
  }

  get videoWidth(): number {
    return mediaOf(this)?.media?.videoWidth ?? 0;
  }

  get videoHeight(): number {
    return mediaOf(this)?.media?.videoHeight ?? 0;
  }

  /**
   * Input fields: their text (what the player typed). ADR 0424: a select's chosen value, a slider's number, a checkbox's
   * or radio's `value` ("on" without one), an option's (its text without one). Setting it isn't a player change.
   */
  get value(): string {
    if (this._uiTag === "Option" && !this._hosted) return this.getAttribute("value") ?? collapse(this.textContent);
    if ((this._uiTag === "Toggle" || this._uiTag === "Radio") && !this._hosted) return this.getAttribute("value") ?? "on";
    return this._hosted?.value ?? this._pendingValue ?? this.getAttribute("value") ?? "";
  }

  set value(value: string) {
    const v = value === null || value === undefined ? "" : String(value);
    if (this._hosted) this._hosted.value = v;
    else this._pendingValue = v;
  }

  /** ADR 0424: a slider's or number field's value as a number (NaN when it isn't one). */
  get valueAsNumber(): number {
    const v = this.value;
    return v.trim() === "" ? NaN : Number(v);
  }

  set valueAsNumber(n: number) {
    this.value = String(n);
  }

  /** A number field's or slider's `stepUp(n)`: its value `n` steps up, on its step from `min` and within `min`..`max` (no events, as on the web). */
  stepUp(n = 1): void {
    this.stepBy(Number(n));
  }

  /** `stepDown(n)`: `n` steps down. */
  stepDown(n = 1): void {
    this.stepBy(-Number(n));
  }

  private stepBy(n: number): void {
    const type = this.type;
    const stepText = this.getAttribute("step");
    if ((type !== "number" && type !== "range") || stepText?.toLowerCase() === "any") throw new Error(`InvalidStateError: stepUp() and stepDown() apply to number and range inputs with a step (this is type="${type}"${stepText ? ` step="${stepText}"` : ""})`);
    const step = parseFloat(stepText ?? "") > 0 ? parseFloat(stepText!) : 1;
    const range = type === "range";
    const min = parseFloat(this.getAttribute("min") ?? "");
    const max = parseFloat(this.getAttribute("max") ?? "");
    const lo = Number.isFinite(min) ? min : range ? 0 : -Infinity;
    const hi = Number.isFinite(max) ? max : range ? 100 : Infinity;
    const base = Number.isFinite(min) ? min : 0;
    const current = Number.isFinite(this.valueAsNumber) ? this.valueAsNumber : 0;
    // HTML: a value off the step moves only to the nearest step that way; one on a step moves n steps.
    const k = (current - base) / step;
    const onStep = Math.abs(k - Math.round(k)) < 1e-9;
    let next = onStep ? current + n * step : base + (n > 0 ? Math.ceil(k) : Math.floor(k)) * step;
    if (next > hi) next = base + Math.floor((hi - base) / step) * step;
    if (next < lo) next = base + Math.ceil((lo - base) / step) * step;
    const decimals = Math.max((String(step).split(".")[1] ?? "").length, (String(base).split(".")[1] ?? "").length);
    this.value = String(Number(next.toFixed(decimals)));
  }

  /** ADR 0424: a checkbox's or radio's state (a radio checked unchecks its group). Setting it isn't a player change. */
  get checked(): boolean {
    return this.state("checked");
  }

  set checked(on: boolean) {
    this.setState("checked", !!on);
  }

  /** ADR 0424: a checkbox shown as neither (a dash) until the player toggles it. */
  get indeterminate(): boolean {
    return this.state("indeterminate");
  }

  set indeterminate(on: boolean) {
    this.setState("indeterminate", !!on);
  }

  /** ADR 0424: an option chosen in its select. */
  get selected(): boolean {
    return this.state("selected");
  }

  set selected(on: boolean) {
    this.setState("selected", !!on);
  }

  /** ADR 0424: a select's options (as nodes), and the index of its chosen one (-1: none). */
  get options(): UIRenderElement[] {
    const out: UIRenderElement[] = [];
    const walk = (el: UIRenderElement) => {
      for (const c of el.children) {
        if (c._uiTag === "Option") out.push(c);
        else if (c._uiTag !== "Select") walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** A media element's `srcObject` (a `MediaStream` on the web), kept as given; the UI's media plays `src`. */
  srcObject: unknown = null;

  /** A select's chosen options. */
  get selectedOptions(): UIRenderElement[] {
    return this.options.filter((o) => o.selected);
  }

  get selectedIndex(): number {
    return this.options.findIndex((o) => o.selected);
  }

  set selectedIndex(i: number) {
    const options = this.options;
    if (options[i]) this.value = options[i].value;
  }

  /** ADR 0424: the form a control is in (null outside forms). */
  get form(): UIRenderElement | null {
    for (let n = this._parent; n instanceof UIRenderElement && !n._tree; n = n._parent) if (n._uiTag === "Form") return n;
    return null;
  }

  /** ADR 0424, forms: send `submit` as a submit button does (`requestSubmit`; `submit` sends none, as on the web). */
  requestSubmit(): void {
    const c = this._hosted?.component;
    if (c instanceof UIForm) c.requestSubmit();
  }

  submit(): void {
    // The DOM's `submit()` sends no event and a game has no page to send the form to: nothing happens.
  }

  /** ADR 0424, forms: send `reset`, then (unless prevented) put the controls back as they were made. */
  reset(): void {
    const c = this._hosted?.component;
    if (c instanceof UIForm) c.reset();
  }

  /** The hosted control's `checked`, `indeterminate` or `selected`, else what was set before it was made, else the attribute. */
  private state(name: "checked" | "indeterminate" | "selected"): boolean {
    const c = this._hosted?.component as unknown as Record<string, unknown> | undefined;
    if (c && typeof c[name] === "boolean") return c[name] as boolean;
    return this._pendingState[name] ?? this.hasAttribute(name);
  }

  private setState(name: "checked" | "indeterminate" | "selected", on: boolean): void {
    const c = this._hosted?.component;
    if (!c) {
      this._pendingState[name] = on;
      return;
    }
    if (name === "checked" && c instanceof UIRadio && on) checkRadio(c);
    else if (name === "selected" && c instanceof UIOption && on) {
      const select = selectOf(c);
      if (select && !select.multiple) chooseOption(select, c);
      else c.selected = true;
    } else if (name in c) (c as unknown as Record<string, boolean>)[name] = on;
  }
}

type UINode = UIRenderElement | UIRenderText | UIRenderComment;
type UIParent = UIRenderElement | UIRenderFragment;

// --- The Element subset's HTML and selectors -----------------------------------------------------

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const NAMESPACE_HTML = "http://www.w3.org/1999/xhtml";
const NAMESPACE_SVG = "http://www.w3.org/2000/svg";
const NAMESPACE_MATHML = "http://www.w3.org/1998/Math/MathML";
/** The `<input>` types HTML knows (what `input.type` reads back; anything else reads as `text`). */
const INPUT_TYPES = new Set(["text", "search", "tel", "url", "email", "password", "date", "month", "week", "time", "datetime-local", "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button", "hidden"]);
/** HTML's boolean attributes (present or absent; Svelte's list). */
const BOOLEAN_ATTRIBUTES = new Set(["allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "disabled", "formnovalidate", "indeterminate", "inert", "ismap", "loop", "multiple", "muted", "nomodule", "novalidate", "open", "playsinline", "readonly", "required", "reversed", "seamless", "selected", "webkitdirectory", "defer", "disablepictureinpicture", "disableremoteplayback", "hidden"]);

/** Whether `name` is a boolean attribute on `el`: one of HTML's, on an HTML element that isn't a custom element. */
function isBooleanAttribute(el: UIRenderElement, name: string): boolean {
  return BOOLEAN_ATTRIBUTES.has(name.toLowerCase()) && !el.localName.includes("-") && el.namespaceURI === NAMESPACE_HTML;
}

/** Enumerated attributes whose DOM property is a boolean: the keywords for false and true. */
const BOOLEAN_KEYWORDS: Readonly<Record<string, readonly [string, string]>> = { translate: ["no", "yes"], draggable: ["false", "true"], spellcheck: ["false", "true"] };
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
/** Elements with no children (ADR 0424: the form controls but a select, a label and a form; ADR 0426: an <svg>'s shapes are its document, and media). */
const LEAF_TAGS: ReadonlySet<UITag> = new Set(["Image", "InputField", "TextArea", "Toggle", "Radio", "Slider", "Progress", "Meter", "Svg", "Video", "Audio"]);
const isLeafKind = (n: UIRenderElement) => LEAF_TAGS.has(n._uiTag);
const isMediaNode = (n: unknown): n is UIRenderElement & { readonly _uiTag: "Video" | "Audio" } => n instanceof UIRenderElement && (n._uiTag === "Video" || n._uiTag === "Audio");

// --- Inline SVG (ADR 0426) -------------------------------------------------------------------------

/** The outermost `<svg>` above `node` (not itself): the hosted element its SVG document belongs to. Null outside one. */
function svgRootOf(node: UINode): UIRenderElement | null {
  let root: UIRenderElement | null = null;
  for (let p = node._parent; p instanceof UIRenderElement && !p._tree; p = p._parent) if (p._uiTag === "Svg") root = p;
  return root;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG subtree as XML: attributes as written (event handlers and the root's cascade attributes left out), `draw`'s CSS in `style`. */
function svgXml(n: UINode, root: boolean): string {
  if (n instanceof UIRenderText) return escapeText(n.data);
  if (!(n instanceof UIRenderElement)) return "";
  let attrs = "";
  let style = "";
  let xlink = false;
  for (const [k, v] of n._attrs) {
    if (v === null || v === undefined || v === false || typeof v === "function") continue;
    if (k.startsWith("on") || (root && (k === "class" || k === "id"))) continue;
    const text = cssText(v);
    if (text === null) continue;
    if (k === "style") {
      if (!root) style = text;
      continue;
    }
    if (k.startsWith("xlink:")) xlink = true;
    attrs += ` ${k}="${escapeAttr(text)}"`;
  }
  if (n._svgAnim) {
    const more = Object.entries(n._svgAnim).map(([k, v]) => `${k}: ${v}`).join("; ");
    style = style ? `${style.replace(/;\s*$/, "")}; ${more}` : more;
  }
  if (style) attrs += ` style="${escapeAttr(style)}"`;
  if (root) {
    if (!n._attrs.has("xmlns")) attrs += ` xmlns="${SVG_NS}"`;
    if (xlink && !n._attrs.has("xmlns:xlink")) attrs += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
  }
  const inner = n._children.map((c) => svgXml(c, false)).join("");
  return `<${n.localName}${attrs}>${inner}</${n.localName}>`;
}

/** Writes an `<svg>`'s SVG document to its hosted element, when it changed. */
function refreshSvg(svg: UIRenderElement | null): void {
  const comp = svg?._hosted?.isValid ? svg._hosted.component : null;
  if (!(comp instanceof UISvg)) return;
  const text = svgXml(svg!, true);
  if (comp.markup !== text) comp.markup = text;
}

/** A node changed: its `<svg>`'s document again, if it's in one (or is one). */
function svgChanged(node: UINode | UIParent | null): void {
  if (!node || node instanceof UIRenderFragment) return;
  refreshSvg(node instanceof UIRenderElement && node._uiTag === "Svg" && !svgRootOf(node) ? node : svgRootOf(node));
}

/** What a shape inherits (SVG's inherited paint properties), as attributes or inline style give them. */
interface SvgPaint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillRule: "nonzero" | "evenodd";
  pointerEvents: string;
  visible: boolean;
  strokeLinecap: string;
}

function svgProp(n: UIRenderElement, name: string): string | null {
  const style = n.getAttribute("style");
  if (style) {
    for (const decl of style.split(";")) {
      const i = decl.indexOf(":");
      if (i > 0 && decl.slice(0, i).trim() === name) return decl.slice(i + 1).trim();
    }
  }
  return n._svgAnim?.[name] ?? n.getAttribute(name);
}

function svgPaintOf(n: UIRenderElement, inherited: SvgPaint): SvgPaint {
  const width = parseFloat(svgProp(n, "stroke-width") ?? "");
  const rule = svgProp(n, "fill-rule");
  const visibility = svgProp(n, "visibility");
  return {
    fill: svgProp(n, "fill") ?? inherited.fill,
    stroke: svgProp(n, "stroke") ?? inherited.stroke,
    strokeWidth: Number.isFinite(width) ? width : inherited.strokeWidth,
    fillRule: rule === "evenodd" || rule === "nonzero" ? rule : inherited.fillRule,
    pointerEvents: svgProp(n, "pointer-events") ?? inherited.pointerEvents,
    visible: visibility === "hidden" || visibility === "collapse" ? false : visibility === "visible" ? true : inherited.visible,
    strokeLinecap: svgProp(n, "stroke-linecap") ?? inherited.strokeLinecap,
  };
}

const SVG_INITIAL: SvgPaint = { fill: "black", stroke: "none", strokeWidth: 1, fillRule: "nonzero", pointerEvents: "visiblePainted", visible: true, strokeLinecap: "butt" };

/** A shape's paint as computed style (`draw` reads `strokeLinecap` and `strokeWidth` through the `measure` hook). */
function svgComputedStyle(node: UIRenderElement): Record<string, string> {
  const chain: UIRenderElement[] = [];
  for (let n: UIRenderElement | UIRenderFragment | null = node; n instanceof UIRenderElement && !n._tree; n = n._parent) {
    chain.unshift(n);
    if (n._uiTag === "Svg" && !svgRootOf(n)) break;
  }
  let paint = SVG_INITIAL;
  for (const n of chain) paint = svgPaintOf(n, paint);
  return { fill: paint.fill, stroke: paint.stroke, strokeWidth: `${paint.strokeWidth}px`, strokeLinecap: paint.strokeLinecap, fillRule: paint.fillRule, pointerEvents: paint.pointerEvents, opacity: node.getAttribute("opacity") ?? "1", filter: "none", transform: "none" };
}

/**
 * ADR 0426: the shape of `svg` under a point of its box (its own pixels, from its corner), topmost first, by each shape's
 * geometry and `pointer-events` (`visiblePainted` by default: its fill where it's filled, its stroke where it's stroked).
 * Null: none (the `<svg>` itself is hit).
 */
function svgShapeAt(svg: UIRenderElement, x: number, y: number): UIRenderElement | null {
  const box = svg._hosted?.rect();
  if (!box) return null;
  const view = viewBoxMap(svg.getAttribute("viewBox"), svg.getAttribute("preserveAspectRatio"), box.width, box.height);
  let hit: UIRenderElement | null = null;
  const walk = (n: UIRenderElement, map: readonly [number, number, number, number, number, number], inherited: SvgPaint) => {
    if (svgProp(n, "display") === "none") return;
    const own = parseSvgTransform(n.getAttribute("transform"));
    const m = own ? multiply(map as never, own) : map;
    const paint = svgPaintOf(n, inherited);
    const tag = n.localName.toLowerCase();
    if (tag === "defs" || tag === "symbol" || tag === "clippath" || tag === "mask" || tag === "lineargradient" || tag === "radialgradient" || tag === "pattern" || tag === "marker") return;
    if (SVG_GEOMETRY_TAGS.has(tag) && paint.pointerEvents !== "none") {
      const inv = invert(m as never);
      if (inv) {
        const [ux, uy] = applyAffine(inv, x, y);
        const pe = paint.pointerEvents;
        const needsVisible = pe.startsWith("visible") || pe === "auto";
        if (!needsVisible || paint.visible) {
          const fillOn = pe === "fill" || pe === "visibleFill" || pe === "all" || pe === "visible" || ((pe === "visiblePainted" || pe === "painted" || pe === "auto") && paint.fill !== "none");
          const strokeOn = pe === "stroke" || pe === "visibleStroke" || pe === "all" || pe === "visible" || ((pe === "visiblePainted" || pe === "painted" || pe === "auto") && paint.stroke !== "none");
          const polys = flattenPath(shapePath(tag, (a) => n.getAttribute(a)));
          if ((fillOn && insideFill(polys, ux, uy, paint.fillRule)) || (strokeOn && paint.strokeWidth > 0 && distanceToOutline(polys, ux, uy) <= paint.strokeWidth / 2)) hit = n; // later shapes are on top
        }
      }
    }
    for (const c of n._children) if (c instanceof UIRenderElement) walk(c, m, paint);
  };
  const rootPaint = svgPaintOf(svg, SVG_INITIAL);
  for (const c of svg._children) if (c instanceof UIRenderElement) walk(c, view, rootPaint);
  return hit;
}

/** UI events with a pointer position (the ones an <svg> retargets to its shapes). */
const POSITIONED: ReadonlySet<string> = new Set(["click", "dblclick", "contextmenu", "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointercancel", "wheel", "dragstart", "drag", "dragenter", "dragover", "dragleave", "drop", "dragend"]);

/** The nodes from `svg` (excluded) down to `shape` (excluded). */
function svgPathBetween(svg: UIRenderElement, shape: UIRenderElement): UIRenderElement[] {
  const out: UIRenderElement[] = [];
  for (let p = shape._parent; p instanceof UIRenderElement && p !== svg; p = p._parent) out.unshift(p);
  return out;
}

// --- Media (ADR 0426) ------------------------------------------------------------------------------

/** A `<video>`'s or `<audio>`'s hosted component, once it's shown. */
function mediaOf(node: UIRenderElement): UIVideo | UIAudio | null {
  const c = node._hosted?.isValid ? node._hosted.component : null;
  return c instanceof UIVideo || c instanceof UIAudio ? c : null;
}

function setMediaField(node: UIRenderElement, field: "volume" | "muted" | "playbackRate", value: number | boolean): void {
  const m = mediaOf(node);
  if (m) {
    (m as unknown as Record<string, unknown>)[field] = value;
    m._player.refresh();
  } else node._pendingMedia.set(field, value);
}

const MEDIA_EVENT_SET: ReadonlySet<string> = new Set(UI_MEDIA_EVENTS);

/** Relays a media event type from the hosted component to the node's listeners (media events don't bubble). */
function attachMediaRelay(node: UIRenderElement, type: string): void {
  const m = mediaOf(node);
  if (!m || node._mediaRelays.has(type) || !MEDIA_EVENT_SET.has(type)) return;
  const relay = () => {
    const e = { type, target: node, currentTarget: node, bubbles: false, eventPhase: 2, defaultPrevented: false, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    runListeners(node, type, e, 2);
  };
  node._mediaRelays.set(type, relay);
  m.on(type as UIMediaEventType, relay);
}

function dropMediaRelays(node: UIRenderElement): void {
  const m = mediaOf(node);
  if (m) for (const [type, relay] of node._mediaRelays) m.off(type as UIMediaEventType, relay);
  node._mediaRelays.clear();
}

/** `bind:` on `<video>`/`<audio>`: the media element's two-way and read-only properties, through its events. */
const MEDIA_BINDINGS: Readonly<Record<string, { readonly events: readonly string[]; readonly twoWay: boolean }>> = {
  currentTime: { events: ["timeupdate", "seeked"], twoWay: true },
  paused: { events: ["play", "pause"], twoWay: true },
  volume: { events: ["volumechange"], twoWay: true },
  muted: { events: ["volumechange"], twoWay: true },
  playbackRate: { events: ["ratechange"], twoWay: true },
  duration: { events: ["durationchange", "loadedmetadata", "emptied"], twoWay: false },
  ended: { events: ["ended", "play"], twoWay: false },
  readyState: { events: ["loadedmetadata", "loadeddata", "canplay", "canplaythrough", "waiting", "emptied"], twoWay: false },
  seeking: { events: ["seeking", "seeked"], twoWay: false },
  videoWidth: { events: ["loadedmetadata", "resize"], twoWay: false },
  videoHeight: { events: ["loadedmetadata", "resize"], twoWay: false },
};

function bindMedia(node: UIRenderElement, name: string, get: () => unknown, set: (value: unknown) => void): (() => void) | undefined {
  const spec = MEDIA_BINDINGS[name];
  if (!spec) return undefined;
  const read = () => (node as unknown as Record<string, unknown>)[name];
  if (spec.twoWay) {
    const want = get();
    if (want === undefined || want === null) set(read());
    else if (name === "paused") {
      if (!!want !== node.paused) void (want ? node.pause() : node.play());
    } else if (name === "currentTime") {
      if (Math.abs(Number(want) - node.currentTime) > 1e-3) node.currentTime = Number(want);
    } else if (read() !== want) (node as unknown as Record<string, unknown>)[name] = want;
  } else set(read());
  const report = () => set(read());
  for (const type of spec.events) node.addEventListener(type, report);
  return () => {
    for (const type of spec.events) node.removeEventListener(type, report);
  };
}

/** ADR 0425: an inline run: a node whose parent is a text element or a run (below the mount). */
function isRun(node: UINode): boolean {
  const p = node._parent;
  return p instanceof UIRenderElement && !p._tree && !OWN_KIND_IN_TEXT.has(p._uiTag) && (isTextKind(p) || isRun(p));
}

/** ADR 0425: elements that stay what they are inside a text element (not drawn there yet: an <svg>'s shapes are its document). */
const OWN_KIND_IN_TEXT: ReadonlySet<UITag> = new Set(["Svg", "Video", "Audio"]);

/** ADR 0425: an element whose content is text and runs: a text element, or a run that isn't an image. */
function holdsText(n: UINode | UIParent | null): n is UIRenderElement {
  return n instanceof UIRenderElement && !n._tree && (n._uiTag === "Text" || (isRun(n) && n._uiTag !== "Image"));
}

/** ADR 0425: the UI element a node makes: a run is a Text (an image stays an Image), others their own. */
function hostedTag(el: UIRenderElement): UITag {
  if (!isRun(el)) return el._uiTag;
  if (OWN_KIND_IN_TEXT.has(el._uiTag)) {
    warnOnce(`<${el.localName}> inside a text element isn't drawn yet; put it beside the text.`);
    return el._uiTag;
  }
  return el._uiTag === "Image" ? "Image" : "Text";
}

/** ADR 0425: the text element a run belongs to (the outermost), or the element itself. */
function rootText(el: UIRenderElement): UIRenderElement {
  let r = el;
  while (isRun(r) && r._parent instanceof UIRenderElement) r = r._parent;
  return r;
}

/** ADR 0425: `contenteditable` on the text element (not `"false"`): its whitespace is kept as typed. */
function isEditable(el: UIRenderElement): boolean {
  const v = rootText(el).getAttribute("contenteditable");
  return v !== null && v !== "false";
}

/** ADR 0425: text inside a run with its whitespace collapsed (spaces at its ends stay, one each: the text's layout joins runs). */
function collapseInner(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ");
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
  // ADR 0426: an <svg>'s own attributes are its SVG document's (`refreshSvg`), but for its size and the cascade's.
  if (el._uiTag === "Svg") {
    for (const k of ["id", "class", "style", "width", "height"]) {
      const s = cssText(el._attrs.get(k));
      if (s === null) continue;
      out.set(k, (k === "width" || k === "height") && /^\s*-?[\d.]+px\s*$/.test(s) ? String(parseFloat(s)) : s);
    }
    return out;
  }
  // ADR 0426: media: `src` (or its first <source>'s), and HTML's boolean attributes as fields.
  if (el._uiTag === "Video" || el._uiTag === "Audio") {
    for (const k of ["id", "class", "style", "width", "height"]) {
      const s = cssText(el._attrs.get(k));
      if (s !== null) out.set(k, s);
    }
    const source = el.children.find((c) => c.localName.toLowerCase() === "source" && c.getAttribute("src"));
    const src = el.getAttribute("src") ?? source?.getAttribute("src") ?? null;
    if (src !== null) out.set("src", src);
    for (const k of ["autoplay", "loop", "muted"]) if (el.hasAttribute(k)) out.set(k, "true");
    if (el.hasAttribute("controls")) warnOnce(`<${el.localName} controls>: UI media elements have no built-in controls; draw your own with play() and pause().`);
    return out;
  }
  const tag = el._uiTag;
  for (const [k, v] of el._attrs) {
    const s = cssText(v);
    if (s === null || k.startsWith("aria-") || k.startsWith("data-")) continue;
    // ADR 0424: HTML attributes that are form elements' fields.
    if (k === "type") {
      if (tag === "Button") out.set("type", s);
      else if (tag === "InputField") out.set("type", uiTagOfInput(s).fieldType);
      continue;
    }
    // ADR 0425: an editable text element.
    if (k === "contenteditable") {
      if (tag === "Text" && !isRun(el)) out.set("content-editable", s === "false" ? "false" : "true");
      else if (!isRun(el)) warnOnce(`contenteditable on <${el.localName}>: only a text element (<p>, <span>, <h1>…) is editable in a game's UI.`);
      continue;
    }
    if (k === "name" && (tag === "Toggle" || tag === "Radio")) out.set("name", s);
    else if (k === "for" && tag === "Label") out.set("for", s);
    else if (k === "wrap" && tag === "TextArea") out.set("wrap", s === "off" ? "off" : "soft");
    else if (k === "maxlength" && (tag === "InputField" || tag === "TextArea")) out.set("max-length", s);
    else if (k === "value" && tag === "Progress" && s === "") continue;
    else if (HTML_ONLY.has(k)) continue;
    else if (k === "src" && tag === "Image") out.set("image", s);
    else if (k === "disabled") {
      if (FOCUSABLE_TAGS.has(tag)) out.set("interactable", "false");
    } else out.set(k, s);
  }
  return out;
}

/** ADR 0424: the UI elements HTML's `disabled` applies to (it makes them not interactable). */
const FOCUSABLE_TAGS: ReadonlySet<UITag> = new Set(["Button", "InputField", "TextArea", "Toggle", "Radio", "Slider", "Select", "Option"]);

/** Every attribute as written (HTML-only, `data-*` and `aria-*` ones too), which attribute selectors match (ADR 0418 wave 5). */
function writtenAttributes(el: UIRenderElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of el._attrs) {
    const s = cssText(v);
    if (s !== null) out.set(k, s);
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
    // ADR 0426: on an <svg>, a pointer event goes on to the shape under it, through the shapes' groups.
    const shape = el._uiTag === "Svg" && e.element === el._hosted && POSITIONED.has(type) ? svgShapeAt(el, e.offsetX, e.offsetY) : null;
    if (shape) e.target = shape;
    const run = (n: UIRenderElement, p: 1 | 2 | 3) => {
      for (const dom of DOM_TYPES_OF.get(type) ?? []) {
        runListeners(n, dom, e, p);
        if (e._stoppedNow) break;
      }
    };
    if (!shape) return run(el, phase);
    const between = svgPathBetween(el, shape);
    if (phase === 1) {
      run(el, 1);
      for (const n of between) if (!e._stopped) run(n, 1);
    } else {
      if (!e._stopped) run(shape, 2);
      for (let i = between.length - 1; i >= 0 && !e._stopped; i--) if (e.bubbles) run(between[i], 3);
      if (!e._stopped && e.bubbles) run(el, 3);
    }
    e.currentTarget = el;
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
  // ADR 0426: inside an <svg>, nodes are its SVG document, not UI elements.
  const svg = svgRootOf(node);
  if (svg) {
    refreshSvg(svg);
    return null;
  }
  // A media element's <source> and <track> children say what it plays; they aren't shown.
  if (isMediaNode(parent)) {
    if (parent._hosted) parent._hosted.tree.setAttributes(parent._hosted, hostAttributes(parent), writtenAttributes(parent));
    return null;
  }
  if (node instanceof UIRenderElement && SVG_CONTENT_TAGS.has(node.localName.toLowerCase()) && !uiTagOfHtml(node.localName)) {
    warnOnce(`<${node.localName}> outside an <svg> isn't drawn; it renders as a Panel (a <div>).`);
  }
  // ADR 0425: text in a text element (or a run) is its content: its text, or a text piece beside inline children.
  if (node instanceof UIRenderText && holdsText(parent)) {
    refreshText(parent);
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
  // ADR 0425: an element inside a text element is an inline run of it (a Text, or an inline image).
  const uiTag = hostedTag(node);
  if (uiTag !== node._uiTag) warnOnce(`<${node.localName}> inside a text element (<${rootText(node).localName}>) is drawn as inline text; only phrasing elements and images belong there.`);
  const made = tree.create(node.localName, uiTag, hp, hostedBefore(node), hostAttributes(node), { source: sourceOf(node), written: writtenAttributes(node) });
  node._hosted = made;
  node._dispatchers = new Map();
  hostedNodes.set(made, node);
  for (const type of node._listeners.keys()) if (EVENTS[type]) attachDispatcher(node, EVENTS[type]);
  if (node._pendingValue !== null) {
    made.value = node._pendingValue;
    node._pendingValue = null;
  }
  if (node._uiTag === "Svg") {
    refreshSvg(node);
    // Listeners on its shapes are heard through it (`svgShapeAt` retargets).
    const listen = (n: UINode) => {
      if (!(n instanceof UIRenderElement)) return;
      for (const type of n._listeners.keys()) if (EVENTS[type]) attachDispatcher(node, EVENTS[type]);
      n._children.forEach(listen);
    };
    node._children.forEach(listen);
    return made;
  }
  if (isMediaNode(node)) {
    const m = mediaOf(node);
    if (m) {
      for (const [k, v] of node._pendingMedia) {
        if (k === "paused") void (v ? m.pause() : m.play());
        else if (k === "currentTime") m.currentTime = Number(v);
        else (m as unknown as Record<string, unknown>)[k] = v;
      }
      node._pendingMedia.clear();
      for (const type of node._listeners.keys()) attachMediaRelay(node, type);
    }
    return made;
  }
  const text = holdsText(node);
  for (const c of node._children) if (!(text && c instanceof UIRenderText)) materialize(c, tree);
  if (text) refreshText(node);
  // ADR 0424: state a binding or script set before the element was made.
  const pending = node._pendingState;
  node._pendingState = {};
  for (const k of ["checked", "indeterminate", "selected"] as const) if (pending[k] !== undefined) node[k] = pending[k]!;
  return made;
}

/** Forget the hosted elements of a subtree (its elements were removed with their parent's). */
function forget(node: UINode): void {
  if (node instanceof UIRenderElement) {
    // What the player changed stays with the node, for when it's made again (ADR 0424: a control's value and state too).
    if (node._hosted && (node._uiTag === "InputField" || node._uiTag === "TextArea" || node._uiTag === "Slider" || node._uiTag === "Select")) node._pendingValue = node._hosted.value;
    if (node._hosted && (node._uiTag === "Toggle" || node._uiTag === "Radio")) node._pendingState = { checked: node.checked, indeterminate: node.indeterminate };
    if (node._mediaRelays.size) dropMediaRelays(node);
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

/**
 * A text element's (or run's) content changed: write its text. ADR 0425: with inline children, its text nodes become text
 * pieces (runs of it beside them) and its own text is empty; with text only, that's its text (collapsed: trimmed for a
 * text element, ends kept for a run, which the text's layout joins; kept as typed when editable). A `<br>` is a line break.
 */
function refreshText(el: UIRenderElement | null): void {
  if (!el?._hosted) return;
  const tree = el._hosted.tree;
  if (el.localName.toLowerCase() === "br") return tree.setText(el._hosted, "\n");
  // An empty Text with a `text` attribute shows the attribute, as written (spaces and line breaks kept).
  if (el._children.length === 0 && el.hasAttribute("text")) return;
  const editable = isEditable(el);
  if (el._children.some((c) => c instanceof UIRenderElement)) {
    tree.setText(el._hosted, "");
    for (const c of el._children) {
      if (!(c instanceof UIRenderText)) continue;
      const t = editable ? c.data : collapseInner(c.data);
      if (!c._hosted) {
        if (t === "") continue;
        c._hosted = tree.create("#text", "Text", el._hosted, hostedBefore(c), new Map(), { synthetic: true });
        tree.setText(c._hosted, t);
        tree.restyle(c._hosted);
      } else tree.setText(c._hosted, t);
    }
    return;
  }
  for (const c of el._children) {
    if (c instanceof UIRenderText && c._hosted) {
      tree.remove(c._hosted);
      c._hosted = null;
    }
  }
  const flat = el.textContent;
  tree.setText(el._hosted, editable ? flat : isRun(el) ? collapseInner(flat) : collapse(flat));
}

/**
 * ADR 0425: an editable text the player edited: its nodes take the text the UI core wrote into its runs' components (each
 * text piece's, or a text-only element's own), so its `input` listeners read what was typed.
 */
function reconcileEdit(el: UIRenderElement): void {
  const comp = el._hosted?.component;
  if (!(comp instanceof UIText) || el.localName.toLowerCase() === "br") return;
  if (el._children.some((c) => c instanceof UIRenderElement)) {
    for (const c of el._children) {
      if (c instanceof UIRenderText) {
        const piece = c._hosted?.component;
        if (piece instanceof UIText && piece.text !== c.data) c.data = piece.text;
      } else if (c instanceof UIRenderElement) reconcileEdit(c);
    }
    return;
  }
  if (el.textContent === comp.text) return;
  const texts = el._children.filter((c): c is UIRenderText => c instanceof UIRenderText);
  if (texts.length) {
    texts[0].data = comp.text;
    for (const t of texts.slice(1)) t.data = "";
  } else if (comp.text !== "") {
    const t = new UIRenderText(comp.text);
    t._parent = el;
    el._children.push(t);
  }
}

/** ADR 0426: an attribute changed: an <svg>'s document, or a media element's <source>. */
function attributeChanged(el: UIRenderElement): void {
  svgChanged(el);
  const p = el._parent;
  if (isMediaNode(p) && p._hosted && el.localName.toLowerCase() === "source") p._hosted.tree.setAttributes(p._hosted, hostAttributes(p), writtenAttributes(p));
}

function refreshTextOf(node: UINode | UIParent | null): void {
  if (holdsText(node)) refreshText(node);
}

/** ADR 0425: `el` and every text-holding element in it write their text again (`contenteditable` changed how it's kept). */
function refreshTexts(el: UIRenderElement): void {
  if (holdsText(el)) refreshText(el);
  for (const c of el._children) if (c instanceof UIRenderElement) refreshTexts(c);
}

// --- Inline HTML (ADR 0425): `{@html}`, `innerHTML`, `bind:innerHTML` ------------------------------------

/** What the inline HTML parser gives (`htmlInline.ts`): elements with their attributes, and text, scripts and handlers gone. */
export type { InlineHtmlNode };

/** The inline HTML parser, registered by compiled components that use `{@html}` or `bind:innerHTML` (so only those games load it). */
let htmlParser: ((html: string) => InlineHtmlNode[]) | null = null;

/**
 * ADR 0425: give the renderer the inline HTML parser (`myco/ui-html`'s `parseInlineHtml`). `compileSvelteUI` adds the call to
 * every component that uses `{@html}` or `bind:innerHTML`, so a game without either never loads the parser.
 */
export function useHtmlParser(parse: (html: string) => InlineHtmlNode[]): void {
  htmlParser = parse;
}

/** ADR 0425: an HTML string as detached renderer nodes in a fragment (an element's tag maps as the renderer maps tags). */
function htmlFragment(html: string): UIRenderFragment {
  const fragment = new UIRenderFragment();
  const nodes = htmlParser
    ? htmlParser(html)
    : (warnOnce("{@html} and innerHTML need the inline HTML parser, which compileSvelteUI adds to components that use them; showing the text without its tags."), [{ kind: "text" as const, text: html.replace(/<[^>]*>/g, "") }]);
  const build = (n: InlineHtmlNode, parent: UIRenderElement | UIRenderFragment): void => {
    const node = n.kind === "text" ? new UIRenderText(n.text) : new UIRenderElement(n.tag);
    if (node instanceof UIRenderElement && n.kind === "element") {
      for (const [k, v] of n.attributes) node._attrs.set(k, v);
      for (const c of n.children) build(c, node);
    }
    node._parent = parent;
    parent._children.push(node);
  };
  for (const n of nodes) build(n, fragment);
  return fragment;
}

/**
 * ADR 0425: `bind:textContent`, `bind:innerText` and `bind:innerHTML` on an editable text element: the bound value written
 * to its content when it differs (or, when the value is unset, the content read into it), and read back on each `input`.
 */
function bindContent(node: UIRenderElement, name: "textContent" | "innerText" | "innerHTML", get: () => unknown, set: (value: unknown) => void): () => void {
  const read = () => node[name];
  const v = get();
  if (v === undefined || v === null) set(read());
  else if (String(v) !== read()) node[name] = String(v);
  return listen(node, "input", () => set(read()));
}

// --- Bindings ------------------------------------------------------------------------------------

/** Listen for `type` on `node` while a binding lasts: the binding's cleanup. */
function listen(node: UIRenderElement, type: string, fn: () => void): () => void {
  // A capture listener runs first at its target: the bound state is set before the element's own handlers read it (as a
  // DOM binding's listener runs before Svelte's delegated handlers).
  node.addEventListener(type, fn, true);
  // ADR 0424: its form's reset puts it back without its own events; the binding reads it once the reset is done (as
  // Svelte's DOM bindings do, a microtask later).
  const form = node.form;
  const onReset = () => queueMicrotask(() => {
    if (node.isConnected) fn();
  });
  form?.addEventListener("reset", onReset);
  return () => {
    node.removeEventListener(type, fn, true);
    form?.removeEventListener("reset", onReset);
  };
}

/** Svelte's number coercion for `bind:value` on number and range inputs: "" is null, anything else a number. */
const toNumber = (text: string): number | null => (text === "" ? null : +text);

/**
 * `bind:value`: a field's text (a number, or null when empty, for `type="number"`), a slider's number, a text area's
 * text, a select's chosen option's value (its `value` attribute as given, any type) or, with `multiple`, an array of them.
 */
function bindValue(node: UIRenderElement, get: () => unknown, set: (value: unknown) => void): () => void {
  if (node._uiTag === "Select") return bindSelect(node, get, set);
  const value = get();
  const text = value === null || value === undefined ? "" : String(value);
  if (node.value !== text) node.value = text;
  // Read at each change: the type can change while bound (Svelte's DOM binding checks it each time too).
  const numeric = () => node._uiTag === "Slider" || (node._uiTag === "InputField" && String(node.getAttribute("type")).toLowerCase() === "number");
  return listen(node, "input", () => set(numeric() ? toNumber(node.value) : node.value));
}

/** An option node's value as given: its `value` attribute's own value (any type), else its text. */
function rawOptionValue(o: UIRenderElement): unknown {
  return o._attrs.has("value") ? o._attrs.get("value") : collapse(o.textContent);
}

/** ADR 0424: `bind:value` on a select: the option with the bound value is chosen; choosing sets it (an array with `multiple`). */
function bindSelect(node: UIRenderElement, get: () => unknown, set: (value: unknown) => void): () => void {
  const multiple = node.hasAttribute("multiple");
  const value = get();
  const options = node.options;
  if (value === undefined) {
    // Nothing bound yet: the bound state takes what's chosen, as Svelte's DOM binding does.
    const chosen = options.filter((o) => o.selected);
    if (multiple) set(chosen.map(rawOptionValue));
    else if (chosen[0] ?? options[0]) set(rawOptionValue(chosen[0] ?? options[0]));
  } else if (multiple) {
    const list = Array.isArray(value) ? value : [];
    for (const o of options) o.selected = list.includes(rawOptionValue(o));
  } else {
    const match = options.find((o) => rawOptionValue(o) === value);
    if (match) match.selected = true;
  }
  return listen(node, "change", () => {
    const chosen = node.options.filter((o) => o.selected).map(rawOptionValue);
    set(multiple ? chosen : chosen[0]);
  });
}

/** ADR 0424: `bind:checked` and `bind:indeterminate` on a checkbox (and `checked` on a radio). */
function bindState(node: UIRenderElement, name: "checked" | "indeterminate", get: () => unknown, set: (value: unknown) => void): () => void {
  const on = !!get();
  if (node[name] !== on) node[name] = on;
  return listen(node, "change", () => set(node[name]));
}

/** A checkbox's or radio's value as given: its `value` attribute's own value (any type), else "on". */
function rawControlValue(node: UIRenderElement): unknown {
  return node._attrs.has("value") ? node._attrs.get("value") : "on";
}

/**
 * ADR 0424: `bind:group`: a radio is checked while the bound value is its value, and checking it sets it; a checkbox is
 * checked while the bound array holds its value, and toggling it adds or removes it.
 */
function bindGroup(node: UIRenderElement, get: () => unknown, set: (value: unknown) => void): () => void {
  const value = get();
  const mine = rawControlValue(node);
  if (node._uiTag === "Radio") {
    const on = value === mine;
    if (node.checked !== on) node.checked = on;
    return listen(node, "change", () => {
      if (node.checked) set(rawControlValue(node));
    });
  }
  const list = Array.isArray(value) ? value : [];
  const on = list.includes(mine);
  if (node.checked !== on) node.checked = on;
  return listen(node, "change", () => {
    const now = Array.isArray(get()) ? (get() as unknown[]) : [];
    const v = rawControlValue(node);
    const without = now.filter((x) => x !== v);
    set(node.checked ? [...without, v] : without);
  });
}

/** ADR 0424: an `<input>`'s `type` changed what it is (a checkbox made a text field…): it's made again as that, in place. */
function retag(el: UIRenderElement): void {
  if (el.localName !== "input") return;
  const { tag, known } = uiTagOfInput(el.getAttribute("type"));
  if (!known) warnOnce(`<input type="${el.getAttribute("type")}"> isn't a control the UI has; it's a text field.`);
  if (tag === el._uiTag) return;
  // HTML keeps a field's value when its type changes between text-like types and range (a slider clamps it).
  const valued = (t: UITag) => t === "InputField" || t === "Slider";
  const keep = valued(el._uiTag) && valued(tag) ? el.value : null;
  el._uiTag = tag;
  const tree = el._hosted ? el._hosted.tree : null;
  if (!tree) return;
  dematerialize(el, tree);
  el._pendingValue = keep;
  el._pendingState = {};
  const made = materialize(el, tree);
  if (made) tree.restyle(made);
}

// --- The renderer ---------------------------------------------------------------------------------

const renderer = createRenderer<{ fragment: UIRenderFragment; element: UIRenderElement; text: UIRenderText; comment: UIRenderComment }>({
  createFragment: () => new UIRenderFragment(),
  // A namespace, if Svelte passes one (its custom-renderer `createElement` passes only the name today), is kept.
  createElement: (name: string, namespace?: string | null) => new UIRenderElement(name, namespace ?? null),
  createText: (data) => new UIRenderText(data),
  createComment: (data) => new UIRenderComment(data),
  getNodeType: (node) => (node instanceof UIRenderElement ? "element" : node instanceof UIRenderText ? "text" : node instanceof UIRenderComment ? "comment" : "fragment"),
  getText: (node) => node.data,
  setText(node, text) {
    node.data = text;
    if (svgRootOf(node)) return svgChanged(node);
    // ADR 0425: text in a text element (or a run) is its content.
    const p = node._parent;
    if (holdsText(p)) return refreshText(p);
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
    // Enumerated attributes whose DOM property is a boolean (`translate={false}`): Svelte sets the property on a DOM element,
    // which writes the keyword; under a renderer it hands over the boolean, so the keyword is written here.
    if (typeof value === "boolean" && key in BOOLEAN_KEYWORDS) value = BOOLEAN_KEYWORDS[key][value ? 1 : 0];
    // Any other boolean is HTML's boolean attribute ("" or absent) where the DOM element has one (`disabled={x}`), else
    // the word, as `setAttribute` writes it (`data-open={true}`, an SVG's or a custom element's `readonly={false}`).
    else if (typeof value === "boolean" && !isBooleanAttribute(el, key)) value = String(value);
    // A media element's `srcObject` is a property, never an attribute (Svelte's DOM path sets the property).
    if (key === "srcObject") {
      el.srcObject = value ?? null;
      return;
    }
    // `<option value={undefined}>`: Svelte's DOM writes an empty value, so the option's value isn't its label.
    if ((value === undefined || value === null) && key === "value" && el.localName === "option") value = "";
    if (value === undefined || value === null || value === false) return renderer.removeAttribute(el, key);
    el._attrs.set(key, value);
    if (key === "type") retag(el); // ADR 0424
    if (key === "contenteditable") refreshTexts(el); // ADR 0425: whitespace kept, or collapsed again
    if (el._hosted) el._hosted.tree.setAttributes(el._hosted, hostAttributes(el), writtenAttributes(el));
    attributeChanged(el);
  },
  removeAttribute(el, name) {
    if (!el._attrs.delete(name)) return;
    if (name === "type") retag(el);
    if (name === "contenteditable") refreshTexts(el);
    if (el._hosted) el._hosted.tree.setAttributes(el._hosted, hostAttributes(el), writtenAttributes(el));
    attributeChanged(el);
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
    const oldSvg = svgRootOf(node);
    // ADR 0425: a text node leaving a text element takes its text piece with it; an element that stops (or starts) being
    // an inline run is made again, as the UI element it is now.
    if (node instanceof UIRenderText && node._hosted && holdsText(oldParent)) dematerialize(node, oldTree);
    const wasRun = isRun(node);
    detach(node);
    if (oldParent !== parent) refreshTextOf(oldParent);
    const at = anchor ? parent._children.indexOf(anchor as UINode) : -1;
    if (at < 0) parent._children.push(node);
    else parent._children.splice(at, 0, node);
    node._parent = parent;
    const tree = treeOf(node);
    if (node instanceof UIRenderText && holdsText(parent)) return refreshText(parent);
    const hosted = node instanceof UIRenderElement || node instanceof UIRenderText ? node._hosted : null;
    const hp = hostedParent(parent);
    if (hosted && tree && tree === oldTree && hp !== undefined && isRun(node) === wasRun) {
      tree.move(hosted, hp, hostedBefore(node)); // a keyed {#each} reorder: the same GameObject
      return;
    }
    if (hosted) dematerialize(node, oldTree);
    else if (oldParent && !oldTree) forget(node);
    if (tree) {
      const made = materialize(node, tree);
      if (made) tree.restyle(made);
    }
    // ADR 0425: the text element may have inline children now (its text becomes text pieces beside them).
    refreshTextOf(parent);
    if (oldSvg && oldSvg !== svgRootOf(node)) refreshSvg(oldSvg);
  },
  remove(node) {
    const parent = node._parent;
    const tree = treeOf(node);
    const svg = svgRootOf(node);
    detach(node);
    if (svg) return refreshSvg(svg);
    if (isMediaNode(parent) && parent._hosted) parent._hosted.tree.setAttributes(parent._hosted, hostAttributes(parent), writtenAttributes(parent));
    dropMediaListeners(node);
    dematerialize(node, tree);
    refreshTextOf(parent);
  },
  addEventListener(el, type, handler, options) {
    // `<svelte:window>`, `<svelte:document>` and `<svelte:body>` (the patch's `globalTarget`)
    if (isGlobal(el)) return el.addEventListener(type, handler as Handler, options as { once?: boolean });
    const ui = EVENTS[type];
    // Any type is kept, for `dispatchEvent` (an action's custom event); only the UI's events happen by themselves.
    if (!ui && !el._listeners.has(type) && !(isMediaNode(el) && MEDIA_EVENT_SET.has(type))) warnIfNotYet(type);
    let list = el._listeners.get(type);
    if (!list) el._listeners.set(type, (list = []));
    const o = uiListenerOptions(options); // ADR 0422: capture, once and passive
    addUIListener(list, handler as Handler, o.capture, o.once, o.passive);
    if (ui) {
      // ADR 0426: a shape's listeners are heard through its <svg>.
      const svg = svgRootOf(el);
      attachDispatcher(svg ?? el, ui);
    }
    if (isMediaNode(el)) attachMediaRelay(el, type);
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
    const tag = node._uiTag;
    if (name === "value" && (tag === "InputField" || tag === "TextArea" || tag === "Slider" || tag === "Select")) return bindValue(node, get, set);
    // ADR 0424: checkboxes and radios.
    if ((name === "checked" && (tag === "Toggle" || tag === "Radio")) || (name === "indeterminate" && tag === "Toggle")) return bindState(node, name, get, set);
    if (name === "group" && (tag === "Toggle" || tag === "Radio")) return bindGroup(node, get, set);
    // `<details bind:open>` (and `<dialog>`): the `open` attribute, and its `toggle` events.
    if (name === "open" && (node.localName === "details" || node.localName === "dialog")) {
      node.open = !!get();
      return listen(node, "toggle", () => set(node.open));
    }
    // ADR 0425: an editable text's content.
    if ((name === "textContent" || name === "innerText" || name === "innerHTML") && tag === "Text") return bindContent(node, name, get, set);
    // ADR 0426: <video> and <audio>'s media bindings.
    if (isMediaNode(node)) {
      const stop = bindMedia(node, name, get, set);
      if (stop) return stop;
    }
    warnOnce(`bind:${name} on <${node.localName}> isn't supported yet; UI elements bind value (inputs, text areas, selects), checked, indeterminate and group, media properties on <video> and <audio>, and textContent, innerText and innerHTML on editable text elements.`);
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
  // `transition:`, `in:`, `out:` and `animate:` (`animation.ts`): keyframes on the UI animator, and geometry.
  // ADR 0426: inside an <svg>, a shape's keyframes (`draw`'s stroke dashes) are written into its SVG document each frame.
  animate: (node, keyframes, options) => {
    const svg = svgRootOf(node);
    if (!svg) return animateNode(node, keyframes, options);
    return animateSvgNode(svg._hosted, keyframes, options, (style) => {
      node._svgAnim = style;
      refreshSvg(svg);
    });
  },
  measure: (node) => measureNode(node, svgRootOf(node) ? svgComputedStyle(node) : undefined),
  // ADR 0425: `{@html}`: the string as new nodes (inline HTML parsed into runs inside a text element, block elements as panels).
  html: (_anchor, value) => htmlFragment(value),
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

// ADR 0425: the player edited an editable text: its nodes take the edit before its `input` listeners run.
onUIHostEdit((el) => {
  const node = hostedNodes.get(el);
  if (node) reconcileEdit(node);
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
