/**
 * UI documents (ADR 0077): a `UIDocument` component builds a markup file's elements (`*.ui.xml`) as
 * its node's children, styled by the document's stylesheets (`*.ui.css`), and gives scripts a
 * web-like API over them: `query`, `queryAll`, `data` for `{name}` bindings, `list()` for repeated
 * rows, and element handlers (`on("click", …)`) over the polled state and the `UIEvents` buffer.
 *
 * The nodes it builds belong to the document: they aren't in the scene file, and they're rebuilt when
 * the document, a document it uses or a stylesheet changes. The parsers (`htmlparser2`, `css-tree`)
 * load the first time a World has a document (`loadUIDocumentSupport`, which scene loading awaits
 * for scenes that reference one), so games without documents never download them.
 */
import { Component } from "../core/Component";
import { defineBuffer } from "../core/data";
import { Color, Vector2 } from "../core/math";
import { AssetRef, component, field, type FieldInfo } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import { Assets, normalizeAssetPath } from "../scene/Assets";
import type { GameObject } from "../scene/GameObject";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType } from "./components";
import type { BindingPart, MarkupElement, ResolvedValue, Selector, SourceProblem, StyleTarget, UIPseudo, UIStylesheet, UITag } from "./document/types";

export type { SourceProblem, UITag } from "./document/types";

type Parsers = typeof import("./document/parsers");
let parsers: Parsers | null = null;
let loading: Promise<Parsers> | null = null;

/**
 * Load the document parsers. Scene loading awaits this for scenes with documents, so they build as the
 * scene is instantiated; a document added later builds once it resolves.
 */
export function loadUIDocumentSupport(): Promise<void> {
  if (parsers) return Promise.resolve();
  loading ??= import("./document/parsers").then(
    (m) => (parsers = m),
    (err: unknown) => {
      loading = null; // tried again next time
      throw err;
    },
  );
  return loading.then(() => undefined);
}

type ComponentClass = new () => UIComponentType;
const TAG_TYPES: Readonly<Record<UITag, ComponentClass>> = {
  Canvas: UICanvas,
  Panel: UIPanel,
  Text: UIText,
  Image: UIImage,
  Button: UIButton,
  InputField: UIInputField,
};

// --- Events -------------------------------------------------------------------------------------

export type UIEventType = "click" | "change" | "submit" | "hover";

/** One UI event of the frame. */
export interface UIEvent {
  readonly type: UIEventType;
  readonly element: UIDocumentElement;
  readonly document: UIDocument;
  /** The list item of the row the element is in (`list()`), or undefined outside rows. */
  readonly item: unknown;
}

export type UIEventHandler = (event: UIEvent) => void;

/**
 * The frame's UI events from documents (ADR 0077), for systems: clicks, changes, submits and hovers
 * (the pointer moving onto a button). Filled right after UI input routing, before behaviors' `update`;
 * cleared at the end of the frame.
 */
export const UIEvents = defineBuffer<UIEvent>("engine.UIEvents");

// --- Elements -----------------------------------------------------------------------------------

/** An element's classes: changing them restyles it (and its descendants) this frame. */
export class UIClassList {
  /** @internal */
  constructor(private readonly element: UIDocumentElement) {}

  private get list(): string[] {
    return this.element._target.classes;
  }

  contains(name: string): boolean {
    return this.list.includes(name);
  }

  add(...names: string[]): void {
    let changed = false;
    for (const n of names) {
      if (!this.list.includes(n)) {
        this.list.push(n);
        changed = true;
      }
    }
    if (changed) this.element._markDirty();
  }

  remove(...names: string[]): void {
    const before = this.list.length;
    for (const n of names) {
      const i = this.list.indexOf(n);
      if (i >= 0) this.list.splice(i, 1);
    }
    if (this.list.length !== before) this.element._markDirty();
  }

  /** Add or remove a class (`force` true adds, false removes). Returns whether it's there afterwards. */
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const want = force ?? !has;
    if (want && !has) this.add(name);
    else if (!want && has) this.remove(name);
    return want;
  }

  values(): readonly string[] {
    return [...this.list];
  }

  get length(): number {
    return this.list.length;
  }

  toString(): string {
    return this.list.join(" ");
  }
}

interface Binding {
  readonly field: string;
  readonly info: FieldInfo;
  readonly parts: readonly BindingPart[];
  /** The last value written, to write only changes (so typing in a bound field isn't overwritten). */
  last: unknown;
  written: boolean;
}

interface MutableTarget extends StyleTarget {
  classes: string[];
  state: Record<UIPseudo, boolean>;
  parent: MutableTarget | null;
}

/** A list row's data: `{field}` bindings inside it read the item first. */
interface RowScope {
  item: unknown;
  index: number;
}

interface ListState {
  rows: UIDocumentElement[];
  keys: unknown[];
}

/**
 * An element of a UI document: its node and component, its classes, queries inside it, handlers, and
 * its polled state. Get one with `ui.query(selector)`.
 */
export class UIDocumentElement {
  readonly classList: UIClassList;

  /** @internal */ _node!: GameObject;
  /** @internal */ _comp!: UIComponentType;
  /** @internal */ _markup!: MarkupElement;
  /** @internal */ _target!: MutableTarget;
  /** @internal */ _parent: UIDocumentElement | null = null;
  /** @internal */ _children: UIDocumentElement[] = [];
  /** @internal */ _resolved: Map<string, ResolvedValue> = new Map();
  /** @internal Fields the cascade last wrote. */ _applied = new Set<string>();
  /** @internal */ _bindings: Binding[] = [];
  /** @internal */ _scope: RowScope | null = null;
  /** @internal Rows `list()` made in this element. */ _list: ListState | null = null;
  /** @internal */ _handlers = new Map<UIEventType, UIEventHandler[]>();
  /** @internal */ _alive = true;
  /** @internal */ _wasHovered = false;
  /** @internal */ _lastValue: string | null = null;
  /** @internal */ _changeFrame = -1;
  /** @internal True for a button's label made from its text content. */ _synthetic = false;
  /** @internal Its place among the document's static elements (`""` for the root, `/#id`, `/Panel[1]`, `/label`…); null in list rows. */ _path: string | null = null;

  /** @internal */
  constructor(readonly document: UIDocument) {
    this.classList = new UIClassList(this);
  }

  /** Its node (a child of the document's node, or of another element's). */
  get node(): GameObject {
    return this._node;
  }

  /** Its UI component. `as(Type)` gives it typed. */
  get component(): UIComponentType {
    return this._comp;
  }

  /** The element name in the markup (`Button`). */
  get tag(): UITag {
    return this._target.tag;
  }

  get id(): string | null {
    return this._target.id;
  }

  get parent(): UIDocumentElement | null {
    return this._parent;
  }

  /** Child elements, in order (list rows included). */
  get children(): readonly UIDocumentElement[] {
    return this._children;
  }

  /** The list item of the row it's in (`list()`), or undefined outside rows. */
  get item(): unknown {
    for (let e: UIDocumentElement | null = this; e; e = e._parent) if (e._scope) return e._scope.item;
    return undefined;
  }

  /** False once the element was removed (its row dropped, or the document rebuilt without it). */
  get isValid(): boolean {
    return this._alive && this._node.isValid;
  }

  /** Its component as `type`: `element.as(UIButton).interactable = false`. Throws if it's another kind. */
  as<T extends UIComponentType>(type: abstract new (...args: never[]) => T): T {
    if (this._comp instanceof type) return this._comp;
    throw new Error(`${this.describe()} is a ${this._comp.constructor.name}, not a ${type.name}.`);
  }

  /** The first element inside this one (not itself) a selector matches, or null. */
  query(selector: string): UIDocumentElement | null {
    return this.document._query(selector, this, true);
  }

  /** Every element inside this one (not itself) a selector matches, in document order. */
  queryAll(selector: string): UIDocumentElement[] {
    return this.document._query(selector, this, false);
  }

  /**
   * Call `handler` when the element is clicked (buttons), its value changes or Enter is pressed in it
   * (input fields), or the pointer moves onto it (`hover`, buttons). Handlers run once per frame,
   * right after UI input routing and before behaviors' `update`, exactly when the matching polled
   * state is true. They're dropped with the element.
   */
  on(type: UIEventType, handler: UIEventHandler): this {
    const list = this._handlers.get(type);
    if (list) list.push(handler);
    else this._handlers.set(type, [handler]);
    return this;
  }

  /** Remove a handler, or every handler of `type` when none is given. */
  off(type: UIEventType, handler?: UIEventHandler): this {
    if (!handler) this._handlers.delete(type);
    else {
      const list = this._handlers.get(type);
      const i = list ? list.indexOf(handler) : -1;
      if (list && i >= 0) list.splice(i, 1);
    }
    return this;
  }

  /** Buttons: true for the frame a click finished on it. */
  get clicked(): boolean {
    return this._comp instanceof UIButton && this._comp.clicked;
  }

  /** Buttons: true from the press on it until release. */
  get pressed(): boolean {
    return this._comp instanceof UIButton && this._comp.pressed;
  }

  /** Buttons: true while the pointer is over it. */
  get hovered(): boolean {
    return this._comp instanceof UIButton && this._comp.hovered;
  }

  /** Input fields: true for the frame the player changed its value. */
  get changed(): boolean {
    return this._changeFrame === this._comp._world.time.frameCount;
  }

  /** Input fields: true for the frame Enter was pressed in it. */
  get submitted(): boolean {
    return this._comp instanceof UIInputField && this._comp.submitted;
  }

  /** Input fields: true while it takes the keyboard. */
  get focused(): boolean {
    return this._comp instanceof UIInputField && this._comp.focused;
  }

  /** Input fields: the text in it; null for other elements. Setting it doesn't count as a change. */
  get value(): string | null {
    return this._comp instanceof UIInputField ? this._comp.value : null;
  }

  set value(value: string) {
    if (!(this._comp instanceof UIInputField)) throw new Error(`${this.describe()} has no value: only InputField elements do.`);
    this._comp.value = value;
    this._lastValue = value;
  }

  toString(): string {
    return this.describe();
  }

  /** @internal Editor (ADR 0077 wave B): fields a `{name}` binding or the text content writes, which the cascade leaves alone. */
  _boundFields(): string[] {
    return this._bindings.map((b) => b.field);
  }

  /** @internal */
  _markDirty(): void {
    this.document._styleDirty.add(this);
  }

  private describe(): string {
    const t = this._target;
    return `<${t.tag}${t.id ? ` id="${t.id}"` : ""}${t.classes.length ? ` class="${t.classes.join(" ")}"` : ""}>`;
  }
}

// --- The component ------------------------------------------------------------------------------

/** Built documents, for the frame systems. */
const liveDocuments = new Set<UIDocument>();

/** Each built element by its component, for the editor's picking (ADR 0077 wave B). */
const elementByComponent = new WeakMap<UIComponentType, UIDocumentElement>();

/** Called after a document builds or rebuilds, and after its tree is removed (editor: the hierarchy follows). */
const buildListeners = new Set<(doc: UIDocument) => void>();
function notifyBuilt(doc: UIDocument): void {
  for (const fn of [...buildListeners]) {
    try {
      fn(doc);
    } catch (err) {
      console.error("[myco] a UI document build listener threw:", err);
    }
  }
}

/** Default field values per component class, for fields the cascade stops setting. */
const defaults = new Map<ComponentClass, UIComponentType>();
function defaultOf(type: ComponentClass, field: string): unknown {
  let d = defaults.get(type);
  if (!d) {
    d = new type();
    defaults.set(type, d);
  }
  return cloneValue((d as unknown as Record<string, unknown>)[field]);
}

function cloneValue(value: unknown): unknown {
  if (value instanceof Color) return new Color(value.r, value.g, value.b, value.a);
  if (value instanceof Vector2) return new Vector2(value.x, value.y);
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Color && b instanceof Color) return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  if (a instanceof Vector2 && b instanceof Vector2) return a.x === b.x && a.y === b.y;
  return a === b;
}

function warn(message: string): void {
  console.warn(`[myco] ${message}`);
}

export interface UIListOptions<T> {
  /** How rows are matched to items when `list()` is called again: a field name, or a function. Default: the index. */
  key?: keyof T | ((item: T, index: number) => unknown);
}

/**
 * Builds a UI document (`*.ui.xml`, ADR 0077) as this node's children. Scripts reach its elements with
 * `query`/`queryAll`, fill `{name}` bindings through `data`, and repeat a `<Template>` with `list()`.
 */
@component("engine.UIDocument")
export class UIDocument extends Component {
  /** The markup file (`asset:ui/menu.ui.xml`). */
  @field(AssetRef, { kind: "uidocument" }) document = "";

  /** Values for `{name}` bindings, checked each frame: `ui.data.score += 10` updates the text. */
  data: Record<string, unknown> = {};

  /** @internal Elements whose classes changed: restyled in the late sync. */ _styleDirty = new Set<UIDocumentElement>();
  private rootElement: UIDocumentElement | null = null;
  private sheets: UIStylesheet[] = [];
  private pseudo = false;
  private problemList: SourceProblem[] = [];
  /** The text of each file the build read, to rebuild when one changes. */
  private sources = new Map<string, unknown>();
  private builtFrom: string | null = null;
  private lists = new Map<string, { items: readonly unknown[]; setup?: (row: UIDocumentElement, item: never) => void; options?: UIListOptions<never> }>();
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private selectorCache = new Map<string, readonly Selector[]>();

  /** Resolves once the document has been built (at once if it already is). */
  get ready(): Promise<void> {
    if (this.builtFrom !== null) return Promise.resolve();
    return (this.readyPromise ??= new Promise<void>((resolve) => (this.readyResolve = resolve)));
  }

  /** The document's root element, or null before it's built (or when it has none). */
  get root(): UIDocumentElement | null {
    return this.rootElement;
  }

  /** Problems found in the markup and stylesheets at the last build (each is also logged once). */
  get problems(): readonly SourceProblem[] {
    return this.problemList;
  }

  /** The first element a selector matches (the root included), or null. */
  query(selector: string): UIDocumentElement | null {
    return this._query(selector, null, true);
  }

  /** Every element a selector matches, in document order. */
  queryAll(selector: string): UIDocumentElement[] {
    return this._query(selector, null, false);
  }

  /**
   * One row per item, made from the `<Template>` of the element `selector` matches, inside it after its
   * own children. `{field}` in a row reads the item's fields (then `data`). `setup(row, item)` runs once
   * per new row: add row handlers there. Calling it again reuses rows by `key` (default: index),
   * makes rows for new items and removes the rest. Returns the rows, in item order.
   */
  list<T>(selector: string, items: readonly T[], setup?: (row: UIDocumentElement, item: T) => void, options: UIListOptions<T> = {}): UIDocumentElement[] {
    this.lists.set(selector, { items, setup: setup as never, options: options as never });
    const host = this.query(selector);
    if (!host) {
      if (this.rootElement) warn(`${this.document}: list("${selector}") matches no element.`);
      return [];
    }
    const template = host._markup.template;
    if (!template) {
      warn(`${this.document}: list("${selector}"): ${host} has no <Template>.`);
      return [];
    }
    const keyOf = (item: T, index: number): unknown => {
      const k = options.key;
      if (k === undefined) return index;
      if (typeof k === "function") return k(item, index);
      return (item as Record<PropertyKey, unknown>)[k as PropertyKey];
    };
    const state = (host._list ??= { rows: [], keys: [] });
    const old = new Map<unknown, UIDocumentElement>();
    state.rows.forEach((row, i) => old.set(state.keys[i], row));
    const rows: UIDocumentElement[] = [];
    const keys: unknown[] = [];
    const fresh: [UIDocumentElement, T][] = [];
    const world = this._world;
    world._batch(() => {
      items.forEach((item, index) => {
        const key = keyOf(item, index);
        let row = old.get(key);
        if (row && row.isValid) {
          old.delete(key);
          row._scope!.item = item;
          row._scope!.index = index;
        } else {
          row = this.build(template, host, { item, index }, null, "");
          fresh.push([row, item]);
        }
        rows.push(row);
        keys.push(key);
      });
    });
    for (const row of old.values()) this.removeElement(row);
    // Rows go after the host's own children, in item order.
    const own = host._children.filter((c) => !state.rows.includes(c) && !rows.includes(c));
    host._children = [...own, ...rows];
    rows.forEach((row, i) => world._setSiblingIndex(row._node.entity, own.length + i));
    state.rows = rows;
    state.keys = keys;
    for (const row of rows) this.updateBindings(row);
    for (const [row, item] of fresh) {
      try {
        setup?.(row, item);
      } catch (err) {
        console.error(`[myco] ${this.document}: list("${selector}") setup threw:`, err);
      }
    }
    return rows;
  }

  // --- Editor (ADR 0077 wave B) ------------------------------------------------------------------

  /** @internal Editor: call `listener` after any document builds, rebuilds or loses its tree. Returns a function that stops it. */
  static _onBuilt(listener: (doc: UIDocument) => void): () => void {
    buildListeners.add(listener);
    return () => buildListeners.delete(listener);
  }

  /** @internal Editor: the live document element a UI component belongs to, or null (hand-built UI, or removed). */
  static _elementOf(component: UIComponentType): UIDocumentElement | null {
    const el = elementByComponent.get(component);
    return el && el._alive ? el : null;
  }

  /** @internal Editor: the static element at `path` (see `UIDocumentElement._path`), or null. */
  _elementAt(path: string): UIDocumentElement | null {
    const root = this.rootElement;
    if (!root) return null;
    let found: UIDocumentElement | null = null;
    walk(root, (el) => {
      if (!found && el._alive && el._path === path) found = el;
    });
    return found;
  }

  /**
   * @internal Editor: an element's cascade as if its pseudo-class state were `state` (the rest as it
   * is now), without writing anything: where a button's `:hover` / `:pressed` colours come from.
   */
  _resolveAt(el: UIDocumentElement, state: Partial<Record<UIPseudo, boolean>>): ReadonlyMap<string, ResolvedValue> {
    if (!parsers) return new Map();
    return parsers.resolveStyle({ ...el._target, state: { ...el._target.state, ...state } }, el._markup, el._comp.constructor as ComponentClass, this.sheets, el._parent?._resolved ?? null, () => {});
  }

  /** @internal Editor: the markup file the tree was built from (project path), or null before a build. */
  get _markupPath(): string | null {
    return this.builtFrom === null ? null : normalizeAssetPath(this.builtFrom) || null;
  }

  /** @internal Editor: the stylesheets of the last build, in cascade order. */
  get _sheets(): readonly UIStylesheet[] {
    return this.sheets;
  }

  /** @internal Editor: every file the last build read (the markup, used documents, stylesheets). */
  get _files(): readonly string[] {
    return [...this.sources.keys()];
  }

  /** Rebuild from the files now (the engine does this by itself when one of them changes). */
  reload(): void {
    if (this.isActiveAndEnabled) this.rebuild();
  }

  // --- Lifecycle --------------------------------------------------------------------------------

  /** @internal The editor shows a document's elements in the scene being edited. */
  override get _activatesInEditMode(): boolean {
    return true;
  }

  /** @internal */
  override _onActivate(): void {
    liveDocuments.add(this);
    if (this.rootElement?.isValid) {
      this.rootElement._node.setActive(true);
      return;
    }
    if (parsers) this.rebuild();
    else {
      loadUIDocumentSupport().then(
        () => {
          if (this.isActiveAndEnabled && this.builtFrom === null) this.rebuild();
        },
        (err: unknown) => console.error("[myco] couldn't load the UI document parsers:", err),
      );
    }
  }

  /** @internal */
  override _onDeactivate(): void {
    liveDocuments.delete(this);
    if (this.rootElement?.isValid) this.rootElement._node.setActive(false);
  }

  /** @internal */
  override _onDetach(): void {
    liveDocuments.delete(this);
    // Called while the World flushes its destroys: queue the tree (that flush picks it up), never flush again here.
    this.teardown(null, false);
  }

  // --- Building ---------------------------------------------------------------------------------

  private rebuild(): void {
    const P = parsers;
    if (!P) return;
    const reuse = new Map<string, UIDocumentElement>();
    if (this.rootElement) collectReusable(this.rootElement, "", reuse);
    this.teardown(reuse);
    this.builtFrom = this.document;
    this.problemList = [];
    this.sources.clear();
    this.selectorCache.clear();
    const path = normalizeAssetPath(this.document);
    const read = (p: string): string | null => {
      if (!Assets.has(p)) {
        if (!this.sources.has(p)) this.sources.set(p, undefined); // rebuilt once the file appears
        return null;
      }
      const v = Assets.get(p);
      this.sources.set(p, v);
      return typeof v === "string" ? v : null;
    };
    if (path) {
      const text = read(path);
      if (text === null) this.problem(`UIDocument on "${this.node.name}": there's no document "${path}".`);
      else {
        const markup = P.parseMarkup(text, path, read);
        this.problemList.push(...markup.problems);
        let order = 0;
        this.sheets = [];
        for (const file of markup.styles) {
          const css = read(file);
          if (css === null) continue; // reported by the markup parser
          const sheet = P.parseStylesheet(css, file, order);
          order += sheet.rules.length;
          this.problemList.push(...sheet.problems);
          this.sheets.push(sheet);
        }
        this.pseudo = P.usesPseudo(this.sheets);
        for (const p of this.problemList) warn(p.message);
        if (markup.root) {
          const root = markup.root;
          this._world._batch(() => {
            this.rootElement = this.build(root, null, null, reuse, "");
          });
          this.updateBindings(this.rootElement!);
        }
      }
    }
    for (const el of reuse.values()) dropElement(el);
    // Lists made before the rebuild are made again, with their setup.
    for (const [selector, l] of [...this.lists]) this.list(selector, l.items as never[], l.setup, l.options);
    const resolve = this.readyResolve;
    this.readyPromise = null;
    this.readyResolve = null;
    resolve?.();
    notifyBuilt(this);
  }

  private problem(message: string): void {
    this.problemList.push({ message, line: 0, column: 0, span: { start: 0, end: 0 } });
    warn(message);
  }

  /** Remove the built tree. Elements in `reuse` keep their handlers for the rebuild; the rest are dropped. */
  private teardown(reuse: Map<string, UIDocumentElement> | null, flush = true): void {
    const root = this.rootElement;
    this.rootElement = null;
    this._styleDirty.clear();
    if (!root) return;
    const keep = new Set(reuse?.values());
    walk(root, (el) => {
      if (!keep.has(el)) dropElement(el);
    });
    destroyNode(root._node, flush);
    if (!reuse) notifyBuilt(this); // removed for good (a rebuild notifies once it's done)
  }

  /**
   * Build an element and its children as nodes. `parent` null builds the root under the document's
   * node. Rows pass their `scope`; static elements their path for reusing handles across rebuilds.
   */
  private build(markup: MarkupElement, parent: UIDocumentElement | null, scope: RowScope | null, reuse: Map<string, UIDocumentElement> | null, path: string): UIDocumentElement {
    const P = parsers!;
    const world = this._world;
    const type = TAG_TYPES[markup.tag];
    const idAttr = markup.attributes.find((a) => a.name === "id")?.value ?? null;
    const classAttr = markup.attributes.find((a) => a.name === "class")?.value ?? "";
    const reused = reuse?.get(path);
    if (reused) reuse!.delete(path);
    const el = reused ?? new UIDocumentElement(this);
    el._alive = true;
    el._markup = markup;
    el._parent = parent;
    el._children = [];
    el._scope = scope;
    el._list = null;
    el._applied = new Set();
    el._resolved = new Map();
    el._wasHovered = false;
    el._changeFrame = -1;
    el._target = {
      tag: markup.tag,
      id: idAttr,
      classes: classAttr.split(/\s+/).filter(Boolean),
      state: { hover: false, pressed: false, focus: false, disabled: false },
      parent: parent?._target ?? null,
    };
    const parentNode = parent ? parent._node : this.node;
    const node = world._createNode(idAttr ?? markup.tag, parentNode.entity);
    el._node = node;
    el._comp = node.addBehavior(type);
    el._path = scope || parent?._path === null ? null : path; // list rows and what's inside them have none
    elementByComponent.set(el._comp, el);

    // Bindings: bound attributes, and the text content (a Text's text, an InputField's value).
    const fields = P.fieldsOf(type);
    el._bindings = [];
    for (const a of markup.attributes) {
      const name = P.attributeField(a);
      if (!name || !P.hasBinding(a.value)) continue;
      const info = fields.get(name);
      if (info) el._bindings.push({ field: name, info, parts: P.parseBindings(a.value), last: undefined, written: false });
      else warn(`${markup.file}: <${markup.tag}> has no field "${a.name}".`);
    }
    const textField = markup.tag === "Text" ? "text" : markup.tag === "InputField" ? "value" : null;
    if (textField && markup.text !== null) el._bindings.push({ field: textField, info: fields.get(textField)!, parts: P.parseBindings(markup.text), last: undefined, written: false });

    this.restyle(el);
    if (el._comp instanceof UIInputField) el._lastValue = el._comp.value;

    // A button's text content is its label: a Text child.
    if (markup.tag === "Button" && markup.text !== null) {
      const label: MarkupElement = { kind: "element", tag: "Text", attributes: [], children: [], text: markup.text, template: null, span: markup.span, openTagSpan: markup.openTagSpan, file: markup.file };
      const child = this.build(label, el, null, reuse, `${path}/label`);
      child._synthetic = true;
      el._children.push(child);
    }
    const counts = new Map<string, number>();
    for (const childMarkup of markup.children) {
      const id = childMarkup.attributes.find((a) => a.name === "id")?.value;
      const n = counts.get(childMarkup.tag) ?? 0;
      counts.set(childMarkup.tag, n + 1);
      const childPath = scope ? "" : `${path}/${id ? `#${id}` : `${childMarkup.tag}[${n}]`}`;
      el._children.push(this.build(childMarkup, el, null, scope ? null : reuse, childPath));
    }
    return el;
  }

  /** Resolve an element's style and write the fields that changed; restyles its children too (inheritance). */
  private restyle(el: UIDocumentElement): void {
    const P = parsers!;
    const type = el._comp.constructor as ComponentClass;
    const parentResolved = el._parent?._resolved ?? null;
    const resolved = P.resolveStyle(el._target, el._markup, type, this.sheets, parentResolved, warn);
    const bound = new Set(el._bindings.map((b) => b.field));
    const comp = el._comp as unknown as Record<string, unknown>;
    const fields = P.fieldsOf(type);
    const next = new Set<string>();
    for (const [name, rv] of resolved) {
      if (name.startsWith("--") || bound.has(name) || !fields.has(name)) continue;
      next.add(name);
      const prev = el._resolved.get(name);
      if (prev && el._applied.has(name) && prev.source === rv.source && sameValue(prev.value, rv.value)) continue;
      comp[name] = P.cloneValue(rv.value);
    }
    for (const name of el._applied) if (!next.has(name)) comp[name] = defaultOf(type, name);
    // A button's hover and pressed colours come from `:hover` / `:pressed` backgrounds, so the drawing shows them.
    if (this.pseudo && el._comp instanceof UIButton) {
      const at = (state: Partial<Record<UIPseudo, boolean>>) =>
        P.resolveStyle({ ...el._target, state: { ...el._target.state, hover: false, pressed: false, ...state } }, el._markup, type, this.sheets, parentResolved, () => {}).get("backgroundColor");
      const base = at({});
      const hover = at({ hover: true });
      const pressed = at({ hover: true, pressed: true });
      if (hover && hover.source !== base?.source && hover.value) el._comp.hoverColor = P.cloneValue(hover.value) as Color;
      if (pressed && pressed.source !== base?.source && pressed.value) el._comp.pressedColor = P.cloneValue(pressed.value) as Color;
    }
    el._resolved = resolved;
    el._applied = next;
    for (const child of el._children) this.restyle(child);
  }

  /** Write bound values that changed, in an element and its descendants. */
  private updateBindings(el: UIDocumentElement): void {
    if (el._bindings.length) {
      const P = parsers!;
      const comp = el._comp as unknown as Record<string, unknown>;
      for (const b of el._bindings) {
        const value = this.bindingValue(el, b, P);
        if (value === undefined) continue;
        if (b.written && sameValue(b.last, value)) continue;
        b.last = value;
        b.written = true;
        comp[b.field] = P.cloneValue(value);
        if (b.field === "value" && el._comp instanceof UIInputField) el._lastValue = el._comp.value;
      }
    }
    for (const child of el._children) this.updateBindings(child);
  }

  private bindingValue(el: UIDocumentElement, b: Binding, P: Parsers): unknown {
    const lookup = (name: string): unknown => {
      const [head, ...rest] = name.split(".");
      let base: unknown = undefined;
      for (let e: UIDocumentElement | null = el; e; e = e._parent) {
        const item = e._scope?.item;
        if (item !== null && typeof item === "object" && head in (item as object)) {
          base = (item as Record<string, unknown>)[head];
          break;
        }
        if (e._scope) break; // the innermost row decides; then data
      }
      if (base === undefined) base = this.data?.[head];
      for (const key of rest) base = base !== null && typeof base === "object" ? (base as Record<string, unknown>)[key] : undefined;
      return base;
    };
    // A whole-value binding of a non-text field passes values of the right type straight through.
    if (b.parts.length === 1 && "binding" in b.parts[0]) {
      const v = lookup(b.parts[0].binding);
      if (v === undefined) return P.boundValue(`{${b.parts[0].binding}}`, b.info, el._markup.file);
      if ((b.info.type === Number && typeof v === "number") || (b.info.type === Boolean && typeof v === "boolean") || (b.info.type === Color && v instanceof Color) || (b.info.type === Vector2 && v instanceof Vector2)) return v;
      return P.boundValue(String(v), b.info, el._markup.file);
    }
    let text = "";
    for (const part of b.parts) {
      if ("text" in part) text += part.text;
      else {
        const v = lookup(part.binding);
        text += v === undefined ? `{${part.binding}}` : String(v); // left as written while there's no value
      }
    }
    return P.boundValue(text, b.info, el._markup.file);
  }

  private removeElement(el: UIDocumentElement): void {
    walk(el, dropElement);
    if (el._node.isValid) {
      el._node.setActive(false); // hidden now; destroyed at the end of the frame
      destroyNode(el._node);
    }
  }

  // --- Queries ----------------------------------------------------------------------------------

  /** @internal */
  _query<F extends boolean>(selector: string, within: UIDocumentElement | null, first: F): F extends true ? UIDocumentElement | null : UIDocumentElement[];
  _query(selector: string, within: UIDocumentElement | null, first: boolean): UIDocumentElement | null | UIDocumentElement[] {
    const selectors = this.selectors(selector);
    const out: UIDocumentElement[] = [];
    const start = within ? within._children : this.rootElement ? [this.rootElement] : [];
    const visit = (el: UIDocumentElement): boolean => {
      if (!el._alive) return false;
      if (selectors.some((s) => parsers!.matchSelector(s, el._target))) {
        out.push(el);
        if (first) return true;
      }
      for (const c of el._children) if (visit(c)) return true;
      return false;
    };
    for (const el of start) if (visit(el)) break;
    return first ? (out[0] ?? null) : out;
  }

  private selectors(selector: string): readonly Selector[] {
    let cached = this.selectorCache.get(selector);
    if (!cached) {
      if (!parsers) return [];
      const sheet = parsers.parseStylesheet(`${selector}{}`, "<query>");
      if (sheet.problems.length) throw new Error(`Bad selector "${selector}": ${sheet.problems.map((p) => p.message.replace(/^<query>:\d+:\d+: /, "")).join(" ")}`);
      cached = sheet.rules[0]?.selectors ?? [];
      this.selectorCache.set(selector, cached);
    }
    return cached;
  }

  // --- Frame ------------------------------------------------------------------------------------

  /** @internal After UI input routing, before behaviors' update: the frame's events, then their handlers. */
  _collectEvents(): void {
    const root = this.rootElement;
    if (!root) return;
    const world = this._world;
    if (world.inEditMode(this.node.entity)) return; // a scene being edited: no events (ADR 0026)
    const frame = world.time.frameCount;
    const events: UIEvent[] = [];
    walk(root, (el) => {
      if (!el._alive) return;
      const c = el._comp;
      if (c instanceof UIButton) {
        if (c.clicked) events.push({ type: "click", element: el, document: this, item: el.item });
        const hovered = c.hovered;
        if (hovered && !el._wasHovered) events.push({ type: "hover", element: el, document: this, item: el.item });
        el._wasHovered = hovered;
      } else if (c instanceof UIInputField) {
        if (c.value !== el._lastValue) {
          el._lastValue = c.value;
          el._changeFrame = frame;
          events.push({ type: "change", element: el, document: this, item: el.item });
        }
        if (c.submitted) events.push({ type: "submit", element: el, document: this, item: el.item });
      }
    });
    if (events.length === 0) return;
    const buffer = world._buffer(UIEvents);
    buffer.push(...events);
    for (const e of events) {
      const handlers = e.element._handlers.get(e.type);
      if (!handlers?.length) continue;
      for (const h of [...handlers]) {
        try {
          h(e);
        } catch (err) {
          console.error(`[myco] a UI "${e.type}" handler on ${e.element} threw:`, err);
        }
      }
    }
  }

  /** @internal After behaviors' lateUpdate: hot reload, bindings, pseudo-class and class restyles. */
  _lateSync(): void {
    if (this.builtFrom !== null && (this.document !== this.builtFrom || this.sourcesChanged())) {
      this.rebuild();
      return;
    }
    const root = this.rootElement;
    if (!root) return;
    this.updateBindings(root);
    walk(root, (el) => {
      if (el._comp instanceof UIInputField) el._lastValue = el._comp.value; // a script's change isn't the player's
      const state = pseudoState(el._comp);
      const s = el._target.state;
      if (state.hover !== s.hover || state.pressed !== s.pressed || state.focus !== s.focus || state.disabled !== s.disabled) {
        el._target.state = state;
        if (this.pseudo) this._styleDirty.add(el);
      }
    });
    if (this._styleDirty.size) {
      const dirty = [...this._styleDirty].filter((e) => e._alive);
      this._styleDirty.clear();
      // Restyle each dirty subtree once: skip elements under another dirty element.
      const set = new Set(dirty);
      for (const el of dirty) {
        let covered = false;
        for (let p = el._parent; p; p = p._parent) if (set.has(p)) covered = true;
        if (!covered) this.restyle(el);
      }
    }
  }

  private sourcesChanged(): boolean {
    for (const [path, value] of this.sources) {
      const now = Assets.has(path) ? Assets.get(path) : undefined;
      if (now !== value) return true;
    }
    return false;
  }
}

function pseudoState(c: UIComponentType): Record<UIPseudo, boolean> {
  const button = c instanceof UIButton ? c : null;
  return {
    hover: button?.hovered ?? false,
    pressed: button?.pressed ?? false,
    focus: c instanceof UIInputField && c.focused,
    disabled: !c.enabled || (button !== null && !button.interactable),
  };
}

function walk(el: UIDocumentElement, fn: (el: UIDocumentElement) => void): void {
  fn(el);
  for (const c of el._children) walk(c, fn);
}

/** Static elements by their path, so a rebuild hands their handlers to the new elements. */
function collectReusable(el: UIDocumentElement, path: string, out: Map<string, UIDocumentElement>): void {
  if (el._scope) return; // rows are made again by list()
  out.set(path, el);
  const counts = new Map<string, number>();
  for (const c of el._children) {
    if (c._scope) continue;
    if (c._synthetic) {
      collectReusable(c, `${path}/label`, out);
      continue;
    }
    const n = counts.get(c.tag) ?? 0;
    counts.set(c.tag, n + 1);
    collectReusable(c, `${path}/${c.id ? `#${c.id}` : `${c.tag}[${n}]`}`, out);
  }
}

function dropElement(el: UIDocumentElement): void {
  el._alive = false;
  el._handlers.clear();
}

function destroyNode(node: GameObject, flush = true): void {
  if (!node.isValid) return;
  const world = node.world;
  world._destroyNode(node.entity);
  if (flush && !world._inFrame) world._flushDestroyed(); // outside a frame (the editor, tests): now
}

function documentsOf(world: World): UIDocument[] {
  return [...liveDocuments].filter((d) => d.node.isValid && d._world === world);
}

// Right after UI input routing (which runs as the frame begins) and before behaviors' update.
defineBuiltinSystem({ name: "engine.UIDocumentEvents", phase: "update", after: ["engine.Lobby", "engine.PredictionSmooth"], before: ["engine.UpdateScripts"], run: (w) => documentsOf(w).forEach((d) => d._collectEvents()) });
// After behaviors' lateUpdate, before render sync: bindings and restyles show this frame.
defineBuiltinSystem({ name: "engine.UIDocumentSync", phase: "lateUpdate", after: ["engine.LateUpdateScripts"], run: (w) => documentsOf(w).forEach((d) => d._lateSync()) });
