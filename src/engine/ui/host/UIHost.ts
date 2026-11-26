/**
 * The UI core's external tree host (ADR 0419): ordinary UI elements that another library (the UI
 * plugin's Svelte renderer) creates, changes, moves and removes, styled by the same cascade as UI
 * documents. Internal to the UI plugin, not game API.
 *
 * - A `UIHostTree` owns a canvas node under a parent node (a `UIView`'s), and every element made in it
 *   is a node with one UI component under that canvas: the node tree is the UI tree, as for documents,
 *   so the UI core lays it out, draws it and routes the pointer to it unchanged.
 * - Elements are document-like: a tag as written (`div`, `button`), attributes (component fields in
 *   kebab-case, ADR 0077), `id`, classes and an inline `style`, matched by the stylesheets every hosted
 *   tree in the process shares (`setUIHostStyles`: Svelte's scoped rules match only their component's
 *   elements through its hash class, and `:global` rules reach every view, as global CSS reaches a page).
 * - A new subtree is styled when it's made (`restyle`); attribute, class and pseudo-class changes are
 *   restyled in the late sync of the frame they happen in, after the flush hooks (`onFlush`) ran, so a
 *   change a click handler queued in a microtask shows in the frame of the click.
 * - Events come from the UI core's interaction log (ADR 0309) with DOM names (`click`, `input`,
 *   `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`), at the same point in the frame
 *   UI document handlers run: right after UI input routing, before behaviors' `update`.
 * - The editor finds the hosted element of a picked component with `uiHostElementOf`, with the template
 *   location it was made from (`source`), and follows changes with `onUIHostChanged`.
 *
 * UI components are made only here and by UI document builds (ADR 0417, amended by 0419).
 */
import { Color, Vector2 } from "../../core/math";
import { defineBuiltinSystem } from "../../core/systems";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { Locale } from "../../localisation/Locale";
import { UIButton, UICanvas, UIInputField, UIText, type UIComponentType } from "../components";
import { uiPseudoState, uiTypeOfTag } from "../elementKinds";
import { uiInteractions } from "../interactions";
import { parseSelectorQuery } from "../document/selectorQuery";
import type { MarkupAttribute, MarkupElement, ResolvedValue, Selector, StyleTarget, UIPseudo, UIStylesheet, UITag } from "../document/types";

type Cascade = typeof import("../document/cascade");
type ComponentClass = new () => UIComponentType;

let cascade: Cascade | null = null;
let loading: Promise<Cascade> | null = null;

/**
 * Load the cascade (ADR 0419: without the CSS parser, since components' styles arrive parsed). Trees can
 * be made once it resolves.
 */
export function loadUIHostSupport(): Promise<void> {
  if (cascade) return Promise.resolve();
  loading ??= import("../document/cascade").then(
    (m) => (cascade = m),
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading.then(() => undefined);
}

function requireCascade(): Cascade {
  if (!cascade) throw new Error("The UI host's cascade isn't loaded: await loadUIHostSupport() first.");
  return cascade;
}

function warn(message: string): void {
  console.warn(`[myco] ${message}`);
}

// --- Styles ---------------------------------------------------------------------------------------

/** Each registered stylesheet by its file, in registration order: rule data, parsed when its component compiled. */
const styleSources = new Map<string, UIStylesheet>();
let styleVersion = 0;
let parsedVersion = -1;
let parsedSheets: UIStylesheet[] = [];
let sheetsUsePseudo = false;
let sheetsUseLang = false;

/**
 * Set (or with null, remove) the stylesheet `file` contributes to every hosted tree: a Svelte component's
 * CSS (`css: 'external'`) or an imported `.css` file, as rule data parsed when it compiled (ADR 0419: games
 * ship no CSS parser). Registering a file again replaces it (hot reload), keeping its place in the cascade
 * order; registering equal data again changes nothing.
 */
export function setUIHostStyles(file: string, css: UIStylesheet | null): void {
  const current = styleSources.get(file);
  if (css === null) {
    if (current === undefined) return;
    styleSources.delete(file);
  } else {
    if (current === css || (current && sameSheet(current, css))) return;
    styleSources.set(file, css);
  }
  styleVersion++;
}

/** Rule data equal to what's registered: a module evaluated again (a relink) with the same CSS. */
function sameSheet(a: UIStylesheet, b: UIStylesheet): boolean {
  return a.rules.length === b.rules.length && JSON.stringify(a) === JSON.stringify(b);
}

/** The registered stylesheets, with cascade order across them. */
function hostSheets(): readonly UIStylesheet[] {
  if (parsedVersion === styleVersion) return parsedSheets;
  const P = requireCascade();
  let order = 0;
  const sheets: UIStylesheet[] = [];
  for (const [file, source] of styleSources) {
    const sheet = { ...source, file, rules: source.rules.map((r, i) => ({ ...r, order: order + i })) };
    order += sheet.rules.length;
    for (const p of sheet.problems) warnOnce(p.message);
    sheets.push(sheet);
  }
  parsedSheets = sheets;
  parsedVersion = styleVersion;
  sheetsUsePseudo = P.usesPseudo(sheets);
  sheetsUseLang = P.usesLang(sheets);
  return sheets;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  warn(message);
}

// --- Events ---------------------------------------------------------------------------------------

export type UIHostEventType = "click" | "input" | "change" | "submit" | "focus" | "blur" | "pointerenter" | "pointerleave";

/** A UI event on a hosted element (ADR 0419): what an `onclick`, `oninput`… handler gets. */
export class UIHostEvent {
  /** What the handler is listening on; a renderer sets it to its own node (as the DOM's `currentTarget`). */
  currentTarget: unknown;
  /** The element the event happened on; a renderer sets it to its own node (as the DOM's `target`). */
  target: unknown;
  private prevented = false;
  private stopped = false;

  constructor(
    readonly type: UIHostEventType,
    /** The hosted element the event happened on. */
    readonly element: UIHostElement,
  ) {
    this.currentTarget = element;
    this.target = element;
  }

  /** An input field's text (null for other elements). */
  get value(): string | null {
    return this.element.value;
  }

  /** The list item a row is for: always undefined (Svelte's `{#each}` closes over its item). Kept for UI document handlers' shape. */
  get item(): undefined {
    return undefined;
  }

  get defaultPrevented(): boolean {
    return this.prevented;
  }

  /** Recorded only: UI events have no default actions to cancel yet. */
  preventDefault(): void {
    this.prevented = true;
  }

  /** Stops the remaining handlers on the element (events don't bubble yet, so that's all it stops). */
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

export type UIHostListener = (event: UIHostEvent) => void;

// --- Elements -------------------------------------------------------------------------------------

/** Where an element was written (Svelte's dev-mode template location; line 1-based, column 0-based). */
export interface UIHostSource {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

interface MutableTarget extends StyleTarget {
  id: string | null;
  classes: string[];
  state: Record<UIPseudo, boolean>;
  parent: MutableTarget | null;
  lang: string;
}

/** Attributes that are content, written straight to their field (never converted as style, so typed text stays as typed). */
const CONTENT_ATTRIBUTES: Readonly<Partial<Record<UITag, readonly string[]>>> = { InputField: ["value", "placeholder"], Text: ["text"] };

const ZERO = { start: 0, end: 0 };

/** A hosted UI element: a node with one UI component, styled by the cascade like a UI document's element. */
export class UIHostElement {
  /** @internal */ _node!: GameObject;
  /** @internal */ _comp!: UIComponentType;
  /** @internal */ _target!: MutableTarget;
  /** @internal */ _markup!: MarkupElement;
  /** @internal */ _attributes: ReadonlyMap<string, string> = new Map();
  /** @internal */ _parent: UIHostElement | null = null;
  /** @internal */ _children: UIHostElement[] = [];
  /** @internal */ _resolved: Map<string, ResolvedValue> = new Map();
  /** @internal */ _applied = new Set<string>();
  /** @internal */ _alive = true;
  /** @internal */ _listeners = new Map<UIHostEventType, Set<UIHostListener>>();
  /** @internal Last frame's hover, for `pointerleave`. */ _hovered = false;
  /** @internal The field's value changed since the last `change` event. */ _edited = false;
  /** @internal Content attributes last written (`CONTENT_ATTRIBUTES`). */ _content = new Map<string, string>();

  /** @internal */
  constructor(
    readonly tree: UIHostTree,
    /** The tag as written (`div`, `button`), which selectors match. */
    readonly tag: string,
    /** The UI element it is. */
    readonly uiTag: UITag,
    /** Where it was written, when the renderer knows (dev builds). */
    readonly source: UIHostSource | null,
    /** Made by the renderer, not written: a button's label from its text. */
    readonly synthetic: boolean,
  ) {}

  get node(): GameObject {
    return this._node;
  }

  get component(): UIComponentType {
    return this._comp;
  }

  get parent(): UIHostElement | null {
    return this._parent;
  }

  get children(): readonly UIHostElement[] {
    return this._children;
  }

  get id(): string | null {
    return this._target.id;
  }

  get classes(): readonly string[] {
    return this._target.classes;
  }

  /** Its attributes as last set (inline `style` included). */
  get attributes(): ReadonlyMap<string, string> {
    return this._attributes;
  }

  get isValid(): boolean {
    return this._alive && this._node.isValid;
  }

  /** Its component as `type`; throws if it's another kind. */
  as<T extends UIComponentType>(type: abstract new (...args: never[]) => T): T {
    if (this._comp instanceof type) return this._comp;
    throw new Error(`<${this.tag}> is a ${this._comp.constructor.name}, not a ${type.name}.`);
  }

  /** The first element inside this one a selector matches, or null. */
  query(selector: string): UIHostElement | null {
    return this.tree._query(selector, this, true);
  }

  /** Every element inside this one a selector matches, in tree order. */
  queryAll(selector: string): UIHostElement[] {
    return this.tree._query(selector, this, false);
  }

  /** Input fields: their text; null for other elements. Setting it isn't a player change (no events). */
  get value(): string | null {
    return this._comp instanceof UIInputField ? this._comp.value : null;
  }

  set value(value: string) {
    if (this._comp instanceof UIInputField) this._comp.value = value;
  }

  /** Give it focus (buttons and input fields; an input field starts typing, as a click does). */
  focus(): void {
    const c = this._comp;
    if (c instanceof UIButton || c instanceof UIInputField) c.focused = true;
  }

  /** Take its focus away. */
  blur(): void {
    const c = this._comp;
    if ((c instanceof UIButton || c instanceof UIInputField) && c.focused) c.focused = false;
  }

  /** Its box in its canvas's UI pixels from the UI core's last layout, or null when it isn't laid out (a headless World). */
  rect(): { x: number; y: number; width: number; height: number } | null {
    const layout = uiInteractions(this.tree.world).layout;
    if (!layout) return null;
    if (this._comp instanceof UICanvas) {
      const c = layout.canvases().find((l) => l.comp === this._comp);
      return c ? { x: 0, y: 0, width: c.width, height: c.height } : null;
    }
    const e = layout.elements().find((l) => l.comp === this._comp);
    return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null;
  }

  /** Listen to a UI event (`click`, `input`, `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`). */
  on(type: UIHostEventType, listener: UIHostListener): void {
    let set = this._listeners.get(type);
    if (!set) this._listeners.set(type, (set = new Set()));
    set.add(listener);
    if (type === "pointerleave") this._hovered = this._comp instanceof UIButton && this._comp.hovered;
  }

  off(type: UIHostEventType, listener: UIHostListener): void {
    this._listeners.get(type)?.delete(listener);
  }

  /** Run this element's listeners of `event.type` now (what the frame does for the events the UI core recorded). */
  dispatch(event: UIHostEvent): void {
    const set = this._listeners.get(event.type);
    if (!set?.size) return;
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[myco] a UI "${event.type}" handler on <${this.tag}> threw:`, err);
      }
      if (event._stopped) break;
    }
  }

  toString(): string {
    const t = this._target;
    return `<${this.tag}${t.id ? ` id="${t.id}"` : ""}${t.classes.length ? ` class="${t.classes.join(" ")}"` : ""}>`;
  }
}

// --- Registries -----------------------------------------------------------------------------------

/** Live trees, for the frame systems. */
const liveTrees = new Set<UIHostTree>();
/** Each hosted element by its component, for the editor's picking. */
const elementByComponent = new WeakMap<UIComponentType, UIHostElement>();
const changeListeners = new Set<(tree: UIHostTree) => void>();

/** @internal Editor: the live hosted element a UI component (from picking) belongs to, or null. */
export function uiHostElementOf(component: UIComponentType): UIHostElement | null {
  const el = elementByComponent.get(component);
  return el && el._alive ? el : null;
}

/** @internal Editor: call `listener` after a tree is made, changes shape, or is removed. Returns a function that stops it. */
export function onUIHostChanged(listener: (tree: UIHostTree) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChanged(tree: UIHostTree): void {
  for (const fn of [...changeListeners]) {
    try {
      fn(tree);
    } catch (err) {
      console.error("[myco] a UI host change listener threw:", err);
    }
  }
}

// --- Trees ----------------------------------------------------------------------------------------

/** Default field values per component class, for fields the cascade stops setting. */
const defaults = new Map<ComponentClass, UIComponentType>();
function defaultOf(type: ComponentClass, field: string): unknown {
  let d = defaults.get(type);
  if (!d) defaults.set(type, (d = new type()));
  const v = (d as unknown as Record<string, unknown>)[field];
  if (v instanceof Color) return new Color(v.r, v.g, v.b, v.a);
  if (v instanceof Vector2) return new Vector2(v.x, v.y);
  return v;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Color && b instanceof Color) return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  if (a instanceof Vector2 && b instanceof Vector2) return a.x === b.x && a.y === b.y;
  return a === b;
}

function walk(el: UIHostElement, fn: (el: UIHostElement) => void): void {
  fn(el);
  for (const c of el._children) walk(c, fn);
}

/**
 * A tree of hosted UI elements under a canvas, the root, made under `parent` (a `UIView`'s node). The
 * element operations are what a DOM-like renderer needs: create (under a parent, before a sibling), set
 * attributes, set text, move, remove, listen. Await `loadUIHostSupport()` before making one.
 */
export class UIHostTree {
  /** The canvas every element is under. Its fields belong to the tree's owner (a `UIView` copies its own onto it). */
  readonly root: UIHostElement;
  private readonly dirty = new Set<UIHostElement>();
  private readonly flushHooks = new Set<() => void>();
  private styledVersion = -1;
  private localeEpoch = Locale.epoch;
  private shapeChanged = false;
  private disposed = false;
  private readonly selectorCache = new Map<string, readonly Selector[]>();

  constructor(
    readonly world: World,
    parent: GameObject,
    /** What relative asset paths in attributes resolve against when an element has no source file. */
    readonly file: string,
  ) {
    requireCascade();
    const root = new UIHostElement(this, "Canvas", "Canvas", null, false);
    root._node = world._createNode("Canvas", parent.entity);
    root._comp = world._addComponent(root._node.entity, UICanvas);
    root._target = { tag: "Canvas", id: null, classes: [], state: { hover: false, pressed: false, focus: false, disabled: false }, parent: null, lang: Locale.language };
    root._markup = this.markup(root, new Map());
    elementByComponent.set(root._comp, root);
    this.root = root;
    hostSheets();
    this.resolve(root); // `:root` variables, which its children inherit
    this.styledVersion = styleVersion;
    liveTrees.add(this);
    notifyChanged(this);
  }

  /** False once disposed (its owner went away) or its canvas node was destroyed. */
  get isValid(): boolean {
    return !this.disposed && this.root._node.isValid;
  }

  /**
   * Make an element of `uiTag` written as `tag` under `parent` (null: the canvas), before `before` (null:
   * last). `attributes` are as written: fields in kebab-case, `id`, `class`, `style`. Not styled yet: call
   * `restyle` on the top of a subtree once it's made.
   */
  create(tag: string, uiTag: UITag, parent: UIHostElement | null, before: UIHostElement | null, attributes: ReadonlyMap<string, string>, options: { source?: UIHostSource | null; synthetic?: boolean } = {}): UIHostElement {
    const p = parent ?? this.root;
    const el = new UIHostElement(this, tag, uiTag, options.source ?? null, options.synthetic ?? false);
    el._node = this.world._createNode(attributes.get("id") || tag, p._node.entity);
    // The host is the second maker of UI components (ADR 0417 as amended by 0419): `addComponent` still refuses them.
    el._comp = this.world._addComponent(el._node.entity, uiTypeOfTag(uiTag));
    el._parent = p;
    el._target = { tag, id: null, classes: [], state: { hover: false, pressed: false, focus: false, disabled: false }, parent: p._target, lang: Locale.language };
    this.applyAttributes(el, attributes);
    elementByComponent.set(el._comp, el);
    this.place(el, p, before);
    this.shapeChanged = true;
    return el;
  }

  /** Replace an element's attributes (all of them, as the renderer now has them); restyled in this frame's late sync. */
  setAttributes(el: UIHostElement, attributes: ReadonlyMap<string, string>): void {
    if (!el._alive) return;
    this.applyAttributes(el, attributes);
    this.dirty.add(el);
  }

  /** Write a Text's text (or an input field's value): content, never style. */
  setText(el: UIHostElement, text: string): void {
    if (!el._alive) return;
    const c = el._comp;
    if (c instanceof UIText) c.text = text;
    else if (c instanceof UIInputField) c.value = text;
  }

  /** Move an element to `parent` (null: the canvas), before `before` (null: last). */
  move(el: UIHostElement, parent: UIHostElement | null, before: UIHostElement | null): void {
    if (!el._alive) return;
    const p = parent ?? this.root;
    const from = el._parent!;
    const i = from._children.indexOf(el);
    if (i >= 0) from._children.splice(i, 1);
    if (from !== p) {
      this.world._setParent(el._node.entity, p._node.entity, false);
      el._parent = p;
      el._target.parent = p._target;
      this.dirty.add(el); // descendant selectors may match differently
    }
    this.place(el, p, before);
    this.shapeChanged = true;
  }

  /** Remove an element and its subtree: hidden now, destroyed at the end of the frame (at once outside a frame). */
  remove(el: UIHostElement): void {
    if (!el._alive || el === this.root) return;
    const parent = el._parent;
    if (parent) {
      const i = parent._children.indexOf(el);
      if (i >= 0) parent._children.splice(i, 1);
    }
    walk(el, (e) => {
      e._alive = false;
      e._listeners.clear();
      this.dirty.delete(e);
    });
    if (el._node.isValid) {
      el._node.setActive(false);
      this.world._destroyNode(el._node.entity);
      this.world.applyDestroys(); // now outside a frame, at its end inside one
    }
    this.shapeChanged = true;
  }

  /** Resolve an element's style (and its subtree's) now: a new subtree shows styled before the next frame. */
  restyle(el: UIHostElement): void {
    if (!el._alive) return;
    hostSheets();
    this.resolve(el);
  }

  /** Run `hook` each frame before the tree restyles (the renderer flushes its queued updates there). Returns a function that stops it. */
  onFlush(hook: () => void): () => void {
    this.flushHooks.add(hook);
    return () => this.flushHooks.delete(hook);
  }

  /** The first element a selector matches (the canvas excluded), or null. */
  query(selector: string): UIHostElement | null {
    return this._query(selector, this.root, true);
  }

  /** Every element a selector matches, in tree order. */
  queryAll(selector: string): UIHostElement[] {
    return this._query(selector, this.root, false);
  }

  /** Remove the whole tree (its canvas included). `flush` false while the World is flushing destroys. */
  dispose(flush = true): void {
    if (this.disposed) return;
    this.disposed = true;
    liveTrees.delete(this);
    this.flushHooks.clear();
    walk(this.root, (e) => {
      e._alive = false;
      e._listeners.clear();
    });
    this.dirty.clear();
    const node = this.root._node;
    if (node.isValid) {
      this.world._destroyNode(node.entity);
      if (flush) this.world.applyDestroys();
    }
    notifyChanged(this);
  }

  // --- Frame ------------------------------------------------------------------------------------

  /** @internal After UI input routing, before behaviors' update: the frame's events for this tree's elements, in tree order. */
  _collectEvents(): void {
    if (!this.isValid || this.world.inEditMode(this.root._node.entity)) return;
    const log = uiInteractions(this.world);
    const events: UIHostEvent[] = [];
    walk(this.root, (el) => {
      if (!el._alive || el._listeners.size === 0) return;
      const c = el._comp;
      const has = (t: UIHostEventType) => (el._listeners.get(t)?.size ?? 0) > 0;
      const push = (t: UIHostEventType) => {
        if (has(t)) events.push(new UIHostEvent(t, el));
      };
      if (c instanceof UIButton) {
        if (log.happened(c, "blur")) push("blur");
        if (log.happened(c, "focus")) push("focus");
        if (c.clicked) push("click");
        if (log.happened(c, "hover")) push("pointerenter");
        const hovered = c.hovered;
        if (el._hovered && !hovered) push("pointerleave");
        el._hovered = hovered;
      } else if (c instanceof UIInputField) {
        const blurred = log.happened(c, "blur");
        const submitted = log.happened(c, "submit");
        if (log.happened(c, "change")) {
          el._edited = true;
          push("input");
        }
        // As on the web, `change` fires when an edit is committed: Enter, or focus leaving the field.
        if (el._edited && (blurred || submitted)) {
          el._edited = false;
          push("change");
        }
        if (submitted) push("submit");
        if (blurred) push("blur");
        if (log.happened(c, "focus")) push("focus");
      }
    });
    for (const e of events) if (e.element._alive) e.element.dispatch(e);
  }

  /** @internal Late update, before the UI document sync: the flush hooks (queued renderer updates). */
  _flush(): void {
    if (!this.isValid) return;
    for (const hook of [...this.flushHooks]) {
      try {
        hook();
      } catch (err) {
        console.error("[myco] a UI host flush hook threw:", err);
      }
    }
  }

  /** @internal After the flush: stylesheet, language, pseudo-class, attribute and class restyles. */
  _lateSync(): void {
    if (!this.isValid) return;
    hostSheets();
    if (this.styledVersion !== styleVersion) {
      this.styledVersion = styleVersion;
      this.dirty.add(this.root);
    }
    if (this.localeEpoch !== Locale.epoch) {
      this.localeEpoch = Locale.epoch;
      const language = Locale.language;
      walk(this.root, (el) => {
        el._target.lang = language;
      });
      if (sheetsUseLang) this.dirty.add(this.root);
    }
    walk(this.root, (el) => {
      const state = uiPseudoState(el._comp);
      const s = el._target.state;
      if (state.hover !== s.hover || state.pressed !== s.pressed || state.focus !== s.focus || state.disabled !== s.disabled) {
        el._target.state = state;
        if (sheetsUsePseudo) this.dirty.add(el);
      }
    });
    if (this.dirty.size) {
      const dirty = [...this.dirty].filter((e) => e._alive);
      this.dirty.clear();
      const set = new Set(dirty);
      for (const el of dirty) {
        let covered = false;
        for (let p = el._parent; p && !covered; p = p._parent) covered = set.has(p);
        if (!covered) this.resolve(el);
      }
    }
    if (this.shapeChanged) {
      this.shapeChanged = false;
      notifyChanged(this);
    }
  }

  /** @internal */
  _query<F extends boolean>(selector: string, within: UIHostElement, first: F): F extends true ? UIHostElement | null : UIHostElement[];
  _query(selector: string, within: UIHostElement, first: boolean): UIHostElement | null | UIHostElement[] {
    const selectors = this.selectors(selector);
    const P = requireCascade();
    const out: UIHostElement[] = [];
    const visit = (el: UIHostElement): boolean => {
      if (!el._alive) return false;
      if (selectors.some((s) => P.matchSelector(s, el._target))) {
        out.push(el);
        if (first) return true;
      }
      for (const c of el._children) if (visit(c)) return true;
      return false;
    };
    for (const c of within._children) if (visit(c)) break;
    return first ? (out[0] ?? null) : out;
  }

  // --- Inside ---------------------------------------------------------------------------------------

  private selectors(selector: string): readonly Selector[] {
    let cached = this.selectorCache.get(selector);
    if (!cached) {
      try {
        cached = parseSelectorQuery(selector);
      } catch (err) {
        throw new Error(`Bad selector "${selector}": ${(err as Error).message}.`);
      }
      this.selectorCache.set(selector, cached);
    }
    return cached;
  }

  private place(el: UIHostElement, parent: UIHostElement, before: UIHostElement | null): void {
    const siblings = parent._children;
    let i = before ? siblings.indexOf(before) : -1;
    if (i < 0) i = siblings.length;
    siblings.splice(i, 0, el);
    this.world._setSiblingIndex(el._node.entity, i); // node order is layout and draw order
  }

  private applyAttributes(el: UIHostElement, attributes: ReadonlyMap<string, string>): void {
    el._attributes = attributes;
    el._target.id = attributes.get("id") || null;
    el._target.classes = (attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
    const comp = el._comp as unknown as Record<string, unknown>;
    for (const name of CONTENT_ATTRIBUTES[el.uiTag] ?? []) {
      const value = attributes.get(name);
      const before = el._content.get(name);
      // Written when the attribute changes, so a player's typing stays until the component sets the attribute again.
      if (value !== undefined && value !== before) comp[name] = value;
      else if (value === undefined && before !== undefined) comp[name] = defaultOf(el._comp.constructor as ComponentClass, name);
      if (value === undefined) el._content.delete(name);
      else el._content.set(name, value);
    }
    el._markup = this.markup(el, attributes);
  }

  /** What the cascade reads attributes from (ADR 0077 §2: attributes beat rules; an inline style beats attributes). */
  private markup(el: UIHostElement, attributes: ReadonlyMap<string, string>): MarkupElement {
    const attrs: MarkupAttribute[] = [];
    const content = CONTENT_ATTRIBUTES[el.uiTag] ?? [];
    for (const [name, value] of attributes) {
      if (name === "style" || content.includes(name)) continue;
      attrs.push({ name, value, span: ZERO, valueSpan: ZERO });
    }
    const style = attributes.get("style");
    if (style) {
      for (const decl of splitDeclarations(style)) attrs.push({ name: decl.name, value: decl.value, span: ZERO, valueSpan: ZERO });
    }
    return { kind: "element", tag: el.uiTag, attributes: attrs, children: [], text: null, template: null, span: ZERO, openTagSpan: ZERO, file: el.source?.file ?? this.file };
  }

  private resolve(el: UIHostElement): void {
    const P = requireCascade();
    const type = el._comp.constructor as ComponentClass;
    const sheets = parsedSheets;
    const parentResolved = el._parent?._resolved ?? null;
    const resolved = el === this.root ? new Map<string, ResolvedValue>() : P.resolveStyle(el._target, el._markup, type, sheets, parentResolved, warn);
    if (el === this.root) {
      // The canvas takes no style (its fields are its owner's), but `:root` variables start here for its children.
      for (const [k, v] of P.resolveStyle(el._target, el._markup, type, sheets, null, () => {})) if (k.startsWith("--")) resolved.set(k, v);
    }
    const comp = el._comp as unknown as Record<string, unknown>;
    const fields = P.fieldsOf(type);
    const content = new Set(CONTENT_ATTRIBUTES[el.uiTag] ?? []);
    const next = new Set<string>();
    for (const [name, rv] of resolved) {
      if (name.startsWith("--") || content.has(name) || !fields.has(name)) continue;
      next.add(name);
      const prev = el._resolved.get(name);
      if (prev && el._applied.has(name) && prev.source === rv.source && sameValue(prev.value, rv.value)) continue;
      comp[name] = P.cloneValue(rv.value);
    }
    for (const name of el._applied) if (!next.has(name)) comp[name] = defaultOf(type, name);
    // A button's hover and pressed colours come from `:hover` / `:pressed` backgrounds, so the drawing shows them.
    if (sheetsUsePseudo && el._comp instanceof UIButton) {
      const at = (state: Partial<Record<UIPseudo, boolean>>) =>
        P.resolveStyle({ ...el._target, state: { ...el._target.state, hover: false, pressed: false, ...state } }, el._markup, type, sheets, parentResolved, () => {}).get("backgroundColor");
      const base = at({});
      const hover = at({ hover: true });
      const pressed = at({ hover: true, pressed: true });
      if (hover && hover.source !== base?.source && hover.value) el._comp.hoverColor = P.cloneValue(hover.value) as Color;
      if (pressed && pressed.source !== base?.source && pressed.value) el._comp.pressedColor = P.cloneValue(pressed.value) as Color;
    }
    el._resolved = resolved;
    el._applied = next;
    for (const child of el._children) this.resolve(child);
  }
}

/** `a: b; c: url(x;y)` → declarations, splitting on semicolons outside parentheses and quotes. */
function splitDeclarations(style: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const take = (end: number) => {
    const decl = style.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) {
      const name = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (name) out.push({ name, value });
    }
    start = end + 1;
  };
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) take(i);
  }
  take(style.length);
  return out;
}

function treesOf(world: World): UIHostTree[] {
  return [...liveTrees].filter((t) => t.world === world && t.isValid);
}

// Right after UI input routing and the UI documents' handlers, before behaviors' update.
defineBuiltinSystem({ name: "engine.UIHostEvents", phase: "update", after: ["engine.Lobby", "engine.PredictionSmooth", "engine.UIDocumentEvents"], before: ["engine.UpdateScripts"], run: (w) => treesOf(w).forEach((t) => t._collectEvents()) });
// After behaviors' lateUpdate and before the UI sync: renderers flush the updates their handlers queued (Svelte's microtasks).
defineBuiltinSystem({ name: "engine.UIHostFlush", phase: "lateUpdate", after: ["engine.LateUpdateScripts"], before: ["engine.UIDocumentSync"], run: (w) => treesOf(w).forEach((t) => t._flush()) });
// Then restyles, so the flushed changes show this frame.
defineBuiltinSystem({ name: "engine.UIHostSync", phase: "lateUpdate", after: ["engine.UIHostFlush"], run: (w) => treesOf(w).forEach((t) => t._lateSync()) });
