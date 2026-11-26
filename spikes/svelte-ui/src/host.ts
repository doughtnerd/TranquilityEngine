/**
 * SPIKE, not production code. The "external tree host" a Svelte plugin would need from the UI core,
 * prototyped from outside `src/` by reaching into `UIDocument` internals. Every internal it touches is
 * marked `INTERNAL:` below; together they are the surface README.md §1 proposes as a public API.
 *
 * Model (ADR 0077 §6): a document's element (`<Panel id="shop"/>`) hosts a tree another library
 * renders. The hosted elements are real `UIDocumentElement`s of that document, so they get its
 * stylesheets (class/id/descendant selectors, pseudo-classes), `ui.query`, element handlers, the
 * `UIEvents` buffer, inheritance and the editor's per-element plumbing, exactly as markup elements do.
 * What differs: their "markup" is synthesised from live attributes, and they have no static path (so
 * a document rebuild drops them, like list rows, and the host must mount again).
 */
import type { World } from "../../../src/engine/core/World";
import { defineBuiltinSystem } from "../../../src/engine/core/systems";
import type { GameObject } from "../../../src/engine/scene/GameObject";
import { UIDocument, UIDocumentElement, type UIEvent, type UIEventType } from "../../../src/engine/ui/UIDocument";
import { uiTypeOfTag } from "../../../src/engine/ui/elementKinds";
import type { MarkupAttribute, MarkupElement, UITag } from "../../../src/engine/ui/document/types";
import { Locale } from "../../../src/engine/localisation/Locale";

/** One hosted element: what a renderer node maps to. */
export interface HostedElement {
  readonly element: UIDocumentElement;
  readonly node: GameObject;
}

/** Where an element came from in a template (for the editor; Svelte dev mode supplies line/column). */
export interface HostedSource {
  file: string;
  line: number;
  column: number;
}

const ZERO = { start: 0, end: 0 };

/**
 * A tree hosted inside one element of a built document. Its element operations mirror what a DOM-like
 * renderer needs: create (under a parent, at an index), set attributes / classes / id, set text,
 * move, remove, listen.
 */
export class ExternalTree {
  /** Elements this tree made (and still has). */
  private readonly mine = new Set<UIDocumentElement>();
  private readonly sources = new WeakMap<UIDocumentElement, HostedSource>();
  /** The host's own children (from markup) stay first; hosted children follow. */
  private readonly ownChildren: number;
  private readonly world: World;

  constructor(
    readonly document: UIDocument,
    readonly host: UIDocumentElement,
    readonly file: string,
  ) {
    this.world = document._world;
    this.ownChildren = host.children.length;
  }

  /**
   * Make an element of `tag` under `parent` (null: the host) at `index` among that parent's hosted
   * children. Attributes are as written (`flex-direction`, `font-size`, `t:text`…), `id` and `class`
   * included. Not styled yet: call `restyle` once a subtree is made.
   */
  create(tag: UITag, parent: UIDocumentElement | null, index: number, attributes: ReadonlyMap<string, string>, source: HostedSource | null, synthetic = false): HostedElement {
    const p = parent ?? this.host;
    const type = uiTypeOfTag(tag);
    const el = new UIDocumentElement(this.document); // INTERNAL: the constructor is @internal
    const node = this.world._createNode(attributes.get("id") ?? tag, p.node.entity); // INTERNAL
    // INTERNAL: the only sanctioned way to make a UI component (ADR 0417) is a document build; a host is a second one.
    const comp = this.world._addComponent(node.entity, type);
    el._alive = true;
    el._node = node;
    el._comp = comp;
    el._parent = p;
    el._children = [];
    el._scope = null;
    el._list = null;
    el._applied = new Set();
    el._resolved = new Map();
    el._bindings = [];
    el._synthetic = synthetic;
    el._path = null; // no static path: not reused across a rebuild (like list rows)
    el._markup = this.markup(tag, attributes, source);
    if (source) this.sources.set(el, source);
    el._target = {
      tag,
      id: attributes.get("id") ?? null,
      classes: (attributes.get("class") ?? "").split(/\s+/).filter(Boolean),
      state: { hover: false, pressed: false, focus: false, disabled: false },
      parent: p._target,
      lang: Locale.language,
    };
    // INTERNAL: `elementByComponent` (editor picking, `UIDocument._elementOf`) is module-private; hosted
    // elements aren't registered, so the scene view can't pick them in this prototype.
    this.mine.add(el);
    this.place(el, p, index);
    return { element: el, node };
  }

  /** Replace an element's attributes (all of them, as the renderer now has them) and restyle it this frame. */
  setAttributes(el: UIDocumentElement, attributes: ReadonlyMap<string, string>): void {
    const old = el._markup;
    el._markup = this.markup(old.tag, attributes, null, old);
    // INTERNAL: a markup id never changes, so the style target's id is readonly; a hosted element's can (`id={x}`).
    (el._target as { id: string | null }).id = attributes.get("id") ?? null;
    el._target.classes = (attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
    el._markDirty(); // INTERNAL: restyled in the document's late sync
  }

  /** Write a text field (a Text's `text`): content, not style, so it never goes through the cascade. */
  setText(el: UIDocumentElement, text: string): void {
    (el.component as unknown as { text: string }).text = text;
  }

  /** Resolve an element's style (and its subtree's) now. */
  restyle(el: UIDocumentElement): void {
    // INTERNAL: `restyle` is private. Needed so a freshly mounted subtree has its fields before the next frame.
    (this.document as unknown as { restyle(el: UIDocumentElement): void }).restyle(el);
  }

  /** Move an element to `parent` (null: the host) at `index` among its hosted children. */
  move(el: UIDocumentElement, parent: UIDocumentElement | null, index: number): void {
    const p = parent ?? this.host;
    const from = el._parent!;
    from._children = from._children.filter((c) => c !== el);
    if (from !== p) {
      this.world._setParent(el.node.entity, p.node.entity, false); // INTERNAL
      el._parent = p;
      el._target.parent = p._target;
    }
    this.place(el, p, index);
    el._markDirty(); // descendant selectors may match differently
  }

  /** Remove an element and its subtree (destroyed at the end of the frame, hidden now). */
  remove(el: UIDocumentElement): void {
    const parent = el._parent;
    if (parent) parent._children = parent._children.filter((c) => c !== el);
    const drop = (e: UIDocumentElement) => {
      e._alive = false;
      e._handlers.clear();
      this.mine.delete(e);
      e._children.forEach(drop);
    };
    drop(el);
    if (el.node.isValid) {
      el.node.setActive(false);
      this.world._destroyNode(el.node.entity); // INTERNAL
      this.world.applyDestroys();
    }
  }

  /** Listen to a UI event on an element: the document's own handler layer (ADR 0077 §3, 0309). */
  listen(el: UIDocumentElement, type: UIEventType, handler: (e: UIEvent) => void): void {
    el.on(type, handler);
  }

  unlisten(el: UIDocumentElement, type: UIEventType, handler: (e: UIEvent) => void): void {
    el.off(type, handler);
  }

  /** Everything this tree made is gone (the document rebuilt, or the tree unmounted). */
  get alive(): boolean {
    return this.host.isValid;
  }

  /** The template position an element was made from (Svelte `dev: true` only), for the editor. */
  sourceOf(el: UIDocumentElement): HostedSource | null {
    return this.sources.get(el) ?? null;
  }

  get size(): number {
    return this.mine.size;
  }

  private place(el: UIDocumentElement, parent: UIDocumentElement, index: number): void {
    const offset = parent === this.host ? this.ownChildren : 0;
    const siblings = parent._children.filter((c) => c !== el);
    const i = Math.max(0, Math.min(offset + index, siblings.length));
    siblings.splice(i, 0, el);
    parent._children = siblings; // INTERNAL: the element tree the cascade, queries and event collection walk
    this.world._setSiblingIndex(el.node.entity, i); // INTERNAL: node order = layout order
  }

  /** Synthesised markup: what the cascade reads attributes from (ADR 0077 §2: attributes beat rules). */
  private markup(tag: UITag, attributes: ReadonlyMap<string, string>, source: HostedSource | null, old?: MarkupElement): MarkupElement {
    const attrs: MarkupAttribute[] = [];
    for (const [name, value] of attributes) {
      if (name === "style") continue;
      attrs.push({ name, value, span: ZERO, valueSpan: ZERO });
    }
    // An inline `style="a: b; c: d"` (Svelte's `style=` and `style:` directives) is attribute-level, last, so it wins.
    const style = attributes.get("style");
    if (style) {
      for (const decl of style.split(";")) {
        const colon = decl.indexOf(":");
        if (colon < 0) continue;
        const name = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1).trim();
        if (name) attrs.push({ name, value, span: ZERO, valueSpan: ZERO });
      }
    }
    const file = source?.file ?? old?.file ?? this.file; // also what relative asset paths resolve against
    return { kind: "element", tag, attributes: attrs, children: [], text: null, template: null, span: ZERO, openTagSpan: ZERO, file };
  }
}

// --- Frame integration ---------------------------------------------------------------------------

const flushers = new Set<() => void>();

/**
 * Svelte batches DOM updates in a microtask. A game frame runs inside one requestAnimationFrame
 * callback, so a handler's `count++` would reach the UI tree only after that frame was drawn. The
 * plugin flushes right before the documents' late sync (bindings and restyles), so changes made in
 * handlers, `update` or `lateUpdate` show the same frame.
 */
export function onBeforeUISync(flush: () => void): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

// INTERNAL: built-in systems are engine-only; a plugin would use the plugin system API (ADR 0135).
defineBuiltinSystem({
  name: "spike.SvelteFlush",
  phase: "lateUpdate",
  after: ["engine.LateUpdateScripts"],
  before: ["engine.UIDocumentSync"],
  run: () => flushers.forEach((f) => f()),
});
