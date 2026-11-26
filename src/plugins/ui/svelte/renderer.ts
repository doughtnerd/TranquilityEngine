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
 *   `onfocus`, `onblur`, `onpointerenter`, `onpointerleave` (and `onmouseenter`/`onmouseleave`). A handler
 *   gets a `UIHostEvent` whose `target`/`currentTarget` are the node (so `e.currentTarget.value` reads a
 *   field, as on the web) and whose `element` is the hosted UI element.
 * - **Bindings** go through the patched `bind` hook (`patches/svelte+5.59.2.patch`): `bind:value` on
 *   `input`. `bind:this` gives the node, which has the Element subset below.
 * - **Nodes offer an Element subset** for actions, attachments and `bind:this`: `setAttribute`/
 *   `getAttribute`/`removeAttribute`/`hasAttribute`, `classList`, `style`, `addEventListener`/
 *   `removeEventListener`, `focus`/`blur`, `getBoundingClientRect`, `value`, `tagName`, `parentElement`,
 *   `children`, `textContent`, and `element` (the hosted UI element).
 *
 * Svelte builds a template instance as a detached subtree and inserts it; the hosted elements are made
 * when a subtree is connected to a mounted view, and the subtree is styled once, at once. An `insert` of a
 * node already in the same view is a move (a keyed `{#each}` reorder keeps its GameObjects).
 */
/// <reference path="./svelte-modules.d.ts" />
import { createRenderer } from "svelte/renderer";
import { flushSync, mount, unmount, type Component } from "svelte";
import { proxy } from "svelte/internal/client";
import { Color, Vector2 } from "../../../engine/core/math";
import { uiTagOfHtml } from "../../../engine/ui/host/htmlTags";
import { setUIHostStyles, UIHostEvent, type UIHostElement, type UIHostEventType, type UIHostSource, type UIHostTree } from "../../../engine/ui/host/UIHost";
import type { UIStylesheet, UITag } from "../../../engine/ui/document/types";

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
};

/** Attributes HTML has that aren't UI fields: kept on the node (getAttribute sees them), never given to the cascade. */
const HTML_ONLY = new Set(["type", "name", "for", "alt", "title", "role", "tabindex", "autocomplete", "lang", "dir", "hidden", "draggable", "spellcheck", "inputmode", "autofocus", "form", "method", "action"]);

type Handler = (this: unknown, e: unknown) => void;

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

/** An element: what Svelte creates for a tag, and what `bind:this`, actions and attachments receive. */
export class UIRenderElement extends UINodeBase {
  /** @internal */ readonly _uiTag: UITag;
  /** @internal */ readonly _attrs = new Map<string, unknown>();
  /** @internal */ _children: UINode[] = [];
  /** @internal */ readonly _listeners = new Map<UIHostEventType, Set<Handler>>();
  /** @internal */ _dispatchers = new Map<UIHostEventType, (e: UIHostEvent) => void>();
  /** @internal */ _hosted: UIHostElement | null = null;
  /** @internal Set on the container a view mounts into: the tree it hosts. */ _tree: UIHostTree | null = null;
  /** @internal An input's value set before its element was made (a binding, a script). */ _pendingValue: string | null = null;
  readonly classList: RenderClassList = new RenderClassList(this);
  readonly style: RenderStyle = new RenderStyle(this);

  constructor(readonly localName: string) {
    super();
    const ui = uiTagOfHtml(localName);
    if (!ui) warnOnce(`<${localName}> isn't an HTML tag the UI knows; it renders as a Panel (a <div>).`);
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

  /** Run this node's listeners of `event.type` now (no bubbling yet), as if the event happened. Returns false if a listener called `preventDefault`. */
  dispatchEvent(event: { type: string; defaultPrevented?: boolean }): boolean {
    const ui = EVENTS[event.type];
    const set = ui ? this._listeners.get(ui) : undefined;
    for (const h of [...(set ?? [])]) {
      h.call(this, event);
      if ((event as { _stopped?: boolean })._stopped) break;
    }
    return !event.defaultPrevented;
  }

  /** Click it, as a script can on the web: its `click` listeners run now with a `UIHostEvent` (the UI core isn't involved). */
  click(): void {
    if (this._hosted) {
      const e = new UIHostEvent("click", this._hosted);
      e.target = this;
      e.currentTarget = this;
      this.dispatchEvent(e);
    } else this.dispatchEvent({ type: "click", defaultPrevented: false });
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

  addEventListener(type: string, handler: Handler): void {
    renderer.addEventListener(this, type, handler);
  }

  removeEventListener(type: string, handler: Handler): void {
    renderer.removeEventListener(this, type, handler);
  }

  focus(): void {
    this._hosted?.focus();
  }

  blur(): void {
    this._hosted?.blur();
  }

  /** Its box in its canvas's UI pixels from the last layout (zero size before it's laid out). */
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } {
    const r = this._hosted?.rect() ?? { x: 0, y: 0, width: 0, height: 0 };
    return { ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height };
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

/** Whether `compounds[0..i]` matches `el`, its ancestors staying inside `scope`. */
function matchesNode(compounds: NodeCompound[], i: number, el: UIRenderElement, scope: UIRenderElement): boolean {
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

function attachDispatcher(el: UIRenderElement, type: UIHostEventType): void {
  if (!el._hosted || el._dispatchers.has(type)) return;
  const fn = (e: UIHostEvent) => {
    e.currentTarget = el;
    e.target = el;
    for (const h of [...(el._listeners.get(type) ?? [])]) {
      h.call(el, e);
      if (e._stopped) break;
    }
  };
  el._dispatchers.set(type, fn);
  el._hosted.on(type, fn);
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
  for (const type of node._listeners.keys()) attachDispatcher(node, type);
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
    if (owner) return refreshText(owner);
    dematerialize(node, tree);
    if (parent instanceof UIRenderElement) refreshTextOf(parent);
  },
  addEventListener(el, type, handler) {
    const ui = EVENTS[type];
    if (!ui) {
      warnOnce(`on${type} has no UI event; UI elements have onclick, oninput, onchange, onsubmit, onfocus, onblur, onpointerenter and onpointerleave.`);
      return;
    }
    let set = el._listeners.get(ui);
    if (!set) el._listeners.set(ui, (set = new Set()));
    set.add(handler as Handler);
    attachDispatcher(el, ui);
  },
  removeEventListener(el, type, handler) {
    const ui = EVENTS[type];
    if (ui) el._listeners.get(ui)?.delete(handler as Handler);
  },
  // The patch's hook (patches/svelte+5.59.2.patch): element bindings under a custom renderer.
  bind(node, name, get, set) {
    if (name === "value" && node._uiTag === "InputField") return bindValue(node, get, set);
    warnOnce(`bind:${name} on <${node.localName}> isn't supported yet; UI elements bind value on <input>.`);
  },
});

export default renderer;

// --- Styles ---------------------------------------------------------------------------------------

/**
 * What a compiled component (or a `.css` file it imports) calls when it's imported: its CSS (`css: 'external'`),
 * parsed into rule data when it compiled, joins every view's cascade.
 */
export function addStyles(file: string, css: UIStylesheet): void {
  setUIHostStyles(file, css);
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
