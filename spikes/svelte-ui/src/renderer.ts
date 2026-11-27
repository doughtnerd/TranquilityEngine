/**
 * SPIKE, not production code. A Svelte 5 custom renderer (svelte 5.59.2, `svelte/renderer`) whose
 * nodes are UI document elements, through the external tree host in `host.ts`.
 *
 * - Tags are lowercase in Svelte (a capitalised tag is a Svelte component): `canvas`, `panel`, `text`,
 *   `image`, `button`, `input-field` map to `Canvas`, `Panel`, `Text`, `Image`, `Button`, `InputField`.
 * - Attributes are UI document attributes (`flex-direction="column"`, `font-size={24}`), converted by
 *   the document cascade like markup attributes. `id`, `class` (Svelte's `class:` toggles arrive as one
 *   whole `class` string) and `style` (`style=` and `style:x` arrive as one `style` string) go to the
 *   cascade too. Typed values are passed as CSS text (a `Color` becomes `rgba(…)`).
 * - Text nodes inside `<text>` are its `text`. Anywhere else, a text node with something other than
 *   whitespace is a Text element of its own (a button's label, as markup's `<Button>Play</Button>`).
 *   Comments (Svelte's anchors) and whitespace text are plumbing: never built.
 * - Events go to the document's handler layer: `onclick` → `click`, `oninput`/`onchange` → `change`,
 *   `onsubmit` → `submit`, `onfocus`/`onblur`, `onpointerenter`/`onmouseenter` → `hover`. Handlers get
 *   the `UIEvent` (element, document, item), not a DOM event.
 */
import { createRenderer } from "svelte/renderer";
import { flushSync, mount, unmount, type Component } from "svelte";
import { Color, Vector2 } from "../../../src/engine/core/math";
import type { UIDocument, UIDocumentElement, UIEvent, UIEventType } from "../../../src/engine/ui/UIDocument";
import type { UITag } from "../../../src/engine/ui/document/types";
import { ExternalTree, onBeforeUISync, type HostedSource } from "./host";

const TAGS: Readonly<Record<string, UITag>> = {
  canvas: "Canvas",
  panel: "Panel",
  text: "Text",
  image: "Image",
  button: "Button",
  "input-field": "InputField",
};

const EVENTS: Readonly<Record<string, UIEventType>> = {
  click: "click",
  input: "change",
  change: "change",
  submit: "submit",
  focus: "focus",
  blur: "blur",
  pointerenter: "hover",
  mouseenter: "hover",
  cancel: "cancel",
};

type Handler = (this: unknown, e: UIEvent) => void;

interface SBase {
  parent: SParent | null;
}
export interface SFragment extends SBase {
  readonly kind: "fragment";
  children: SNode[];
}
export interface SElement extends SBase {
  readonly kind: "element";
  readonly tag: string;
  readonly uiTag: UITag | null;
  readonly attrs: Map<string, unknown>;
  children: SNode[];
  listeners: Map<UIEventType, Set<Handler>>;
  dispatchers: Map<UIEventType, (e: UIEvent) => void>;
  hosted: UIDocumentElement | null;
  /** Set on the container a component is mounted into: the tree it hosts. */
  root: ExternalTree | null;
}
export interface SText extends SBase {
  readonly kind: "text";
  data: string;
  /** Its own Text element (outside `<text>`), when it has non-whitespace content. */
  hosted: UIDocumentElement | null;
}
export interface SComment extends SBase {
  readonly kind: "comment";
  data: string;
}
type SNode = SElement | SText | SComment | SFragment;
type SParent = SElement | SFragment;

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[svelte-ui] ${message}`);
}

function treeOf(node: SNode | null): ExternalTree | null {
  for (let n: SNode | null = node; n; n = n.parent) if (n.kind === "element" && n.root) return n.root;
  return null;
}

/** The hosted element children of `parent` attach to (null: the host itself, for the mount container). */
function hostedParent(parent: SParent): UIDocumentElement | null {
  return parent.kind === "element" && !parent.root ? parent.hosted : null;
}

/** Hosted siblings before `node`: its index among its parent's hosted children. */
function hostedIndex(node: SNode): number {
  let i = 0;
  for (const c of node.parent!.children) {
    if (c === node) break;
    if ((c.kind === "element" || c.kind === "text") && c.hosted) i++;
  }
  return i;
}

const isTextElement = (n: SNode | null): n is SElement => !!n && n.kind === "element" && n.uiTag === "Text";

function cssText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Color) return `rgba(${Math.round(value.r * 255)}, ${Math.round(value.g * 255)}, ${Math.round(value.b * 255)}, ${value.a})`;
  if (value instanceof Vector2) return `${value.x} ${value.y}`;
  return String(value);
}

function stringAttrs(el: SElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of el.attrs) {
    const s = cssText(v);
    if (s !== null) out.set(k, s);
  }
  return out;
}

function sourceOf(el: SElement): HostedSource | null {
  const meta = (el as unknown as { __svelte_meta?: { loc?: HostedSource } }).__svelte_meta;
  return meta?.loc ? { file: meta.loc.file, line: meta.loc.line, column: meta.loc.column } : null;
}

/**
 * Text content with whitespace collapsed as UI markup does (runs of spaces, tabs and line breaks become one
 * space, trimmed; U+00A0 kept). Svelte keeps a space where inline HTML would need it (`{label} <Price/>`).
 */
function collapse(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ").trim();
}

function textOf(el: SElement): string {
  return collapse(el.children.map((c) => (c.kind === "text" ? c.data : "")).join(""));
}

// --- Building and dropping hosted elements -------------------------------------------------------

function attachDispatcher(el: SElement, type: UIEventType, tree: ExternalTree): void {
  if (!el.hosted || el.dispatchers.has(type)) return;
  const fn = (e: UIEvent) => {
    for (const h of [...(el.listeners.get(type) ?? [])]) h.call(el, e);
  };
  el.dispatchers.set(type, fn);
  tree.listen(el.hosted, type, fn);
}

/** Build `node` (and its subtree) in `tree`. Returns the top element built, to restyle once. */
function materialize(node: SNode, tree: ExternalTree): UIDocumentElement | null {
  const parent = node.parent!;
  if (node.kind === "comment" || node.kind === "fragment") return null;
  if (node.kind === "text") {
    if (isTextElement(parent)) return null; // its parent's text
    if (!node.data.trim()) return null;
    const label = tree.create("Text", hostedParent(parent), hostedIndex(node), new Map(), null, true);
    node.hosted = label.element;
    tree.setText(label.element, collapse(node.data));
    return label.element;
  }
  if (!node.uiTag) {
    warnOnce(`<${node.tag}> isn't a UI element (canvas, panel, text, image, button, input-field); it and its children are skipped.`);
    return null;
  }
  if (isTextElement(parent)) {
    warnOnce(`<${node.tag}> inside <text> is skipped: a Text holds text only.`);
    return null;
  }
  const made = tree.create(node.uiTag, hostedParent(parent), hostedIndex(node), stringAttrs(node), sourceOf(node));
  node.hosted = made.element;
  node.dispatchers = new Map();
  for (const type of node.listeners.keys()) attachDispatcher(node, type, tree);
  for (const c of node.children) materialize(c, tree);
  if (node.uiTag === "Text") tree.setText(made.element, textOf(node));
  return made.element;
}

function forget(node: SNode): void {
  if (node.kind === "element") {
    node.hosted = null;
    node.dispatchers = new Map();
    node.children.forEach(forget);
  } else if (node.kind === "text") node.hosted = null;
}

function dematerialize(node: SNode, tree: ExternalTree): void {
  if ((node.kind === "element" || node.kind === "text") && node.hosted) tree.remove(node.hosted);
  forget(node);
}

function detach(node: SNode): void {
  const p = node.parent;
  if (!p) return;
  p.children.splice(p.children.indexOf(node), 1);
  node.parent = null;
}

/** A `<text>`'s content changed: write its text. */
function refreshTextElement(el: SElement | null, tree: ExternalTree | null): void {
  if (el && tree && el.hosted) tree.setText(el.hosted, textOf(el));
}

// --- The renderer ---------------------------------------------------------------------------------

const renderer = createRenderer<{ fragment: SFragment; element: SElement; text: SText; comment: SComment }>({
  createFragment: () => ({ kind: "fragment", parent: null, children: [] }),
  createElement: (name) => ({
    kind: "element",
    parent: null,
    tag: name,
    uiTag: TAGS[name] ?? null,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    dispatchers: new Map(),
    hosted: null,
    root: null,
  }),
  createText: (data) => ({ kind: "text", parent: null, data, hosted: null }),
  createComment: (data) => ({ kind: "comment", parent: null, data }),
  getNodeType: (node) => node.kind,
  getText: (node) => node.data,
  setText(node, text) {
    node.data = text;
    const parent = node.parent;
    const tree = treeOf(node);
    if (!tree) return;
    if (isTextElement(parent)) return refreshTextElement(parent, tree);
    const blank = !text.trim();
    if (node.hosted && blank) dematerialize(node, tree);
    else if (node.hosted) tree.setText(node.hosted, collapse(text));
    else if (!blank && parent) {
      const made = materialize(node, tree);
      if (made) tree.restyle(made);
    }
  },
  getAttribute: (el, name) => {
    const v = el.attrs.get(name);
    return v === undefined || v === null ? null : String(v);
  },
  setAttribute(el, key, value) {
    el.attrs.set(key, value);
    const tree = treeOf(el);
    if (el.hosted && tree) tree.setAttributes(el.hosted, stringAttrs(el));
  },
  removeAttribute(el, name) {
    el.attrs.delete(name);
    const tree = treeOf(el);
    if (el.hosted && tree) tree.setAttributes(el.hosted, stringAttrs(el));
  },
  hasAttribute: (el, name) => el.attrs.has(name),
  getFirstChild: (el) => el.children[0] ?? null,
  getLastChild: (el) => el.children[el.children.length - 1] ?? null,
  getNextSibling(node) {
    const p = node.parent;
    if (!p) return null;
    return p.children[p.children.indexOf(node) + 1] ?? null;
  },
  getParent: (node) => node.parent,
  insert(parent, node, anchor) {
    if (node.kind === "fragment") {
      for (const c of [...node.children]) renderer.insert(parent, c, anchor);
      return;
    }
    const oldParent = node.parent;
    const oldTree = treeOf(node);
    detach(node);
    const at = anchor ? parent.children.indexOf(anchor as SNode) : -1;
    if (at < 0) parent.children.push(node);
    else parent.children.splice(at, 0, node);
    node.parent = parent;
    const tree = treeOf(parent);
    // Text inside <text>: the parents' texts change.
    if (isTextElement(oldParent)) refreshTextElement(oldParent, oldTree);
    if (isTextElement(parent)) {
      if (node.kind === "text" && node.hosted && oldTree) dematerialize(node, oldTree);
      return refreshTextElement(parent, tree);
    }
    const hosted = node.kind === "element" || node.kind === "text" ? node.hosted : null;
    if (hosted && tree && tree === oldTree) {
      tree.move(hosted, hostedParent(parent), hostedIndex(node)); // a keyed {#each} reorder
      return;
    }
    if (hosted && oldTree) dematerialize(node, oldTree);
    if (tree) {
      const made = materialize(node, tree);
      if (made) tree.restyle(made);
    }
  },
  remove(node) {
    const parent = node.parent;
    const tree = treeOf(node);
    detach(node);
    if (tree) dematerialize(node, tree);
    if (isTextElement(parent)) refreshTextElement(parent, tree);
  },
  addEventListener(el, type, handler) {
    const ui = EVENTS[type];
    if (!ui) {
      warnOnce(`on${type} has no UI event; UI elements have click, change (input), submit, focus, blur, hover (pointerenter) and cancel.`);
      return;
    }
    let set = el.listeners.get(ui);
    if (!set) el.listeners.set(ui, (set = new Set()));
    set.add(handler as Handler);
    const tree = treeOf(el);
    if (tree) attachDispatcher(el, ui, tree);
  },
  removeEventListener(el, type, handler) {
    const ui = EVENTS[type];
    if (ui) el.listeners.get(ui)?.delete(handler as Handler);
  },
});

export default renderer;

// --- Mounting: what the plugin's `ui.render(selector, Component, props)` would be -----------------

export interface Rendered<P> {
  readonly tree: ExternalTree;
  readonly container: SElement;
  /** Props as a `$state`-like object: assign to update (the component re-renders on the next flush). */
  readonly props: P;
  unmount(): void;
}

/** Render a Svelte component into the element `selector` matches in a built document. */
export function render<P extends Record<string, unknown>>(doc: UIDocument, selector: string, component: Component<P>, props: P, file = "svelte"): Rendered<P> {
  const host = doc.query(selector);
  if (!host) throw new Error(`render("${selector}"): no element matches.`);
  const tree = new ExternalTree(doc, host, file);
  const container = renderer.createElement("panel");
  container.root = tree;
  container.hosted = host;
  const instance = mount(component, { target: container as never, props, renderer } as never);
  flushSync();
  const stop = onBeforeUISync(() => flushSync());
  return {
    tree,
    container,
    props,
    unmount() {
      stop();
      unmount(instance);
    },
  };
}
