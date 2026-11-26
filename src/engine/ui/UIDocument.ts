/**
 * UI documents (ADR 0077): a `UIDocument` component builds a markup file's elements (`*.ui.xml`) as
 * its node's children, styled by the document's stylesheets (`*.ui.css`), and gives scripts a
 * web-like API over them: `query`, `queryAll`, `data` for `{name}` bindings, `list()` for repeated
 * rows, and element handlers (`on("click", …)`) over the polled state and the `UIEvents` buffer. Handlers hear events
 * through capture, target and bubble phases, as the DOM's do (ADR 0422), and elements scroll (ADR 0423).
 *
 * Localised text (ADR 0356 §4): `t:<field>="key"` sets a text field to the key's message in the
 * current language, its arguments read like `{name}` bindings (the row's item, then `data`) and the key
 * itself may hold bindings (`t:text="weapon.{id}.name"`); `translate="no"` marks text as deliberately
 * unlocalised; stylesheets match the language with `:lang()`. All of it follows `Locale.epoch`.
 *
 * Documents are the only way to make game UI (ADR 0417): the UI components (`UICanvas`, `UIPanel`,
 * `UIText`, `UIImage`, `UIButton`, `UIInputField`) are made only by a document's build, and
 * `addComponent` and scene files refuse them. Rows made at runtime come from `list()`.
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
import { projectFileKind } from "../scene/projectFiles";
import type { GameObject } from "../scene/GameObject";
import { UIButton, UICanvas, UIInputField, type UIComponentType } from "./components";
import { uiPseudoState, uiTypeOfTag } from "./elementKinds";
import { uiInteractions, type UIInteractionType } from "./interactions";
import { childPaths, labelPath } from "./documentSource";
import type { BindingPart, MarkupAttribute, MarkupElement, ResolvedValue, Selector, SourceProblem, StyleTarget, UIPseudo, UIStylesheet, UITag } from "./document/types";
import { Locale, localeMessageNames, type MessageArg } from "../localisation/Locale";
import { takeUIAnimationEvents, uiAnimating, uiAnimationOwnerGone, uiAnimationReady, uiAnimator, type UIResolvedAnimation, type UIResolvedTransition, type UIStyleWrite } from "./animation/UIAnimator";
import { addUIEventFrontEnd, addUIListener, dispatchUIEvents, propagate, removeUIListener, runUIListeners, uiEventBubbles, uiEventCancelable, UIEventBase, uiListenerOptions, type UIDataTransfer, type UIEventRecord, type UIListener } from "./events";
import { uiScrollIntoViewArg, uiScrollSizes, uiScrollToArgs, isScrollable, type UIScrollIntoViewOptions, type UIScrollToArgs } from "./scrolling";
import type { UIAnimationSpec, UITransitionSpec } from "./document/animationValues";

export type { SourceProblem, UITag } from "./document/types";
export type { UIDataTransfer } from "./events";
export type { UIScrollIntoViewOptions } from "./scrolling";

type ComponentClass = new () => UIComponentType;

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

// --- Events -------------------------------------------------------------------------------------

export type UIEventType =
  | "click" | "change" | "submit" | "hover" | "focus" | "blur" | "cancel" | "transitionend" | "animationstart" | "animationiteration" | "animationend"
  // ADR 0422: the DOM's pointer, keyboard, focus and drag events; ADR 0423: scrolling.
  | "dblclick" | "contextmenu" | "pointerdown" | "pointerup" | "pointermove" | "pointerover" | "pointerout" | "pointerenter" | "pointerleave" | "pointercancel"
  | "wheel" | "keydown" | "keyup" | "focusin" | "focusout" | "scroll" | "scrollend"
  | "dragstart" | "drag" | "dragenter" | "dragover" | "dragleave" | "drop" | "dragend";

/**
 * One UI event of the frame. ADR 0422: it travels through the target's ancestors in the document as a DOM event does
 * (capture from the root down, the target, then bubbling back up for the types that bubble), with the DOM's
 * propagation and cancellation members and its pointer, wheel and keyboard fields.
 */
export interface UIEvent {
  readonly type: UIEventType;
  /** The element it happened on (the same as `target`). */
  readonly element: UIDocumentElement;
  readonly document: UIDocument;
  /** The list item of the row the element is in (`list()`), or undefined outside rows. */
  readonly item: unknown;
  /** `transitionend` (ADR 0418 wave 4): the property whose transition finished (kebab-case, `background-color`). */
  readonly propertyName?: string;
  /** `animationstart`, `animationiteration`, `animationend`: the animation's name (its `@keyframes`). */
  readonly animationName?: string;
  /** Transition and animation events: seconds it had run, its delay not counted. */
  readonly elapsedTime?: number;
  /** ADR 0422: the element it happened on. */
  readonly target: UIDocumentElement;
  /** The element whose handler is running (null outside dispatch). */
  readonly currentTarget: UIDocumentElement | null;
  /** The other element of `pointerover`/`pointerout`/enter/leave, `focus`/`blur`/`focusin`/`focusout` and `dragenter`/`dragleave`, when it's in a document; else null. */
  readonly relatedTarget: UIDocumentElement | null;
  /** 1 capturing, 2 at the target, 3 bubbling. */
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  /** Cancel the engine's default action: focus on press, scrolling by the wheel, keys or a touch drag, a drag starting, submit on Enter. */
  preventDefault(): void;
  /** No further element hears the event. */
  stopPropagation(): void;
  /** No further handler hears it, on this element or another. */
  stopImmediatePropagation(): void;
  /** Pointer events: where, in the canvas's UI pixels (as `rect` boxes are). */
  readonly clientX: number;
  readonly clientY: number;
  /** Pointer events: where, in the target's own pixels from its corner. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Pointer events: where, in the drawing canvas's CSS pixels. */
  readonly canvasX: number;
  readonly canvasY: number;
  /** The button that changed (0 left, 1 middle, 2 right; -1 for moves), and the buttons held (1 left, 2 right, 4 middle). */
  readonly button: number;
  readonly buttons: number;
  /** `mouse`, `touch` or `pen`. */
  readonly pointerType: string;
  /** Clicks: how many in a row (2 for a `dblclick`). */
  readonly detail: number;
  /** `wheel`: how far, in CSS pixels. */
  readonly deltaX: number;
  readonly deltaY: number;
  /** Keys: the DOM's `key` (`"a"`, `"Enter"`, `"ArrowUp"`) and `code` (`"KeyA"`). */
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** Drag events: the drag's data. */
  readonly dataTransfer: UIDataTransfer | null;
}

export type UIEventHandler = (event: UIEvent) => void;

/** ADR 0422: `on`'s options: `capture` runs the handler while the event travels down to its target; `once` removes it after it runs. */
export interface UIEventHandlerOptions {
  readonly capture?: boolean;
  readonly once?: boolean;
}

/** A document's UI event (ADR 0422): the shared event object with the document's elements as targets. */
class UIDocumentEvent extends UIEventBase implements UIEvent {
  declare readonly type: UIEventType;
  currentTarget: UIDocumentElement | null = null;
  readonly propertyName?: string;
  readonly animationName?: string;
  readonly elapsedTime?: number;

  constructor(
    type: UIEventType,
    readonly element: UIDocumentElement,
    readonly document: UIDocument,
    record: UIEventRecord | null,
    readonly relatedTarget: UIDocumentElement | null = null,
    detail: { propertyName?: string; animationName?: string; elapsedTime?: number } = {},
  ) {
    super(type, record, { bubbles: uiEventBubbles(type), cancelable: uiEventCancelable(type), on: element._comp });
    if (detail.propertyName !== undefined) this.propertyName = detail.propertyName;
    if (detail.animationName !== undefined) this.animationName = detail.animationName;
    if (detail.elapsedTime !== undefined) this.elapsedTime = detail.elapsedTime;
  }

  get target(): UIDocumentElement {
    return this.element;
  }

  get item(): unknown {
    return this.element.item;
  }
}

/**
 * The frame's UI events from documents (ADR 0077), for systems: clicks, changes, submits and hovers
 * (the pointer moving onto a button), as the UI core recorded them (ADR 0309); focus and blur (the
 * pointer or keyboard and gamepad navigation moving focus) and cancel (on the document's root, ADR
 * 0340), and last frame's stylesheet animation events (`transitionend`, `animationstart`, `animationiteration`,
 * `animationend`, ADR 0418 wave 4). Filled right after UI input routing, before behaviors' `update`; cleared at the
 * end of the frame.
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
  /** A key attribute (`t:text="weapon.{id}.name"`, ADR 0356 §4): the key, with `{name}` bindings picking it per row. */
  readonly key?: readonly BindingPart[];
  /** A key binding's text content: shown while the key resolves nowhere. */
  fallback?: readonly BindingPart[] | null;
  /** A key binding's last message: reused while the epoch, the key and its arguments are unchanged. */
  cache?: { epoch: number; key: string; names: readonly string[] | null; args: readonly unknown[]; value: string };
  /** The last value written, to write only changes (so typing in a bound field isn't overwritten). */
  last: unknown;
  written: boolean;
}

interface MutableTarget extends StyleTarget {
  readonly tag: UITag;
  classes: string[];
  state: Record<UIPseudo, boolean>;
  parent: MutableTarget | null;
  lang: string;
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
  /** @internal */ _handlers = new Map<UIEventType, UIListener<UIEventHandler>[]>();
  /** @internal */ _alive = true;
  /** @internal True for a button's label made from its text content. */ _synthetic = false;
  /** @internal Its static path (the rule is `documentSource.ts`'s); null in list rows and inside them. */ _path: string | null = null;
  /** @internal Styled at least once since it was built (a first style starts no transitions). */ _styled = false;

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
   * Call `handler` when the element is clicked (buttons, by the pointer or `submit`), its value changes
   * or Enter is pressed in it (input fields), the pointer moves onto it (`hover`, buttons), it gets or
   * loses focus from the player (`focus`, `blur`: buttons and input fields), or, on the document's
   * root, the player presses `cancel` (Escape, the east button) with focus on its canvas. Handlers run
   * once per frame, right after UI input routing and before behaviors' `update`, exactly when the
   * matching polled state is true. They're dropped with the element.
   *
   * Stylesheet animation (ADR 0418 wave 4): `transitionend` when a property's transition finishes, and
   * `animationstart`, `animationiteration` and `animationend` for keyframe animations, the frame after
   * they happened (the event names the property or animation, and the seconds it had run).
   *
   * ADR 0422: events travel through the element's ancestors as DOM events do, so a handler on a list hears clicks on
   * its rows: `{ capture: true }` hears them on the way down, before the target; others at the target and on the way
   * back up (for the types that bubble: `click`, `change`, `submit`, the pointer and key events, `wheel`, `focusin`/
   * `focusout`, drags). Also: `pointerdown`/`pointerup`/`pointermove`/`pointerover`/`pointerout`/`pointerenter`/
   * `pointerleave`/`pointercancel` (on the element under the pointer that stops it, ADR 0385), `dblclick`,
   * `contextmenu`, `wheel`, `keydown`/`keyup` (on the focused element), `focusin`/`focusout`, `scroll`/`scrollend`
   * (ADR 0423, the frame after it scrolled), and UI drags (`dragstart`, `drag`, `dragenter`, `dragover`, `dragleave`,
   * `drop`, `dragend`, from a `draggable` element). `preventDefault` cancels the engine's default action.
   */
  on(type: UIEventType, handler: UIEventHandler, options?: UIEventHandlerOptions | boolean): this {
    const o = uiListenerOptions(options);
    let list = this._handlers.get(type);
    if (!list) this._handlers.set(type, (list = []));
    addUIListener(list, handler, o.capture, o.once);
    return this;
  }

  /** Remove a handler (added with the same `capture`), or every handler of `type` when none is given. */
  off(type: UIEventType, handler?: UIEventHandler, options?: UIEventHandlerOptions | boolean): this {
    if (!handler) this._handlers.delete(type);
    else removeUIListener(this._handlers.get(type), handler, uiListenerOptions(options).capture);
    return this;
  }

  // --- Scrolling (ADR 0423) ---------------------------------------------------------------------

  /** How far its content is scrolled down, in UI pixels (its component's `scrollY`); set it to scroll. */
  get scrollTop(): number {
    return isScrollable(this._comp) ? this._comp.scrollY : 0;
  }

  set scrollTop(value: number) {
    uiScrollToArgs(this.document._world, this._comp, [{ top: value, behavior: "instant" }], false);
  }

  /** How far its content is scrolled right (`scrollX`). */
  get scrollLeft(): number {
    return isScrollable(this._comp) ? this._comp.scrollX : 0;
  }

  set scrollLeft(value: number) {
    uiScrollToArgs(this.document._world, this._comp, [{ left: value, behavior: "instant" }], false);
  }

  /** Its content's width and height, at least its padding box, from the last layout (UI pixels). */
  get scrollWidth(): number {
    return uiScrollSizes(this.document._world, this._comp).scrollWidth;
  }

  get scrollHeight(): number {
    return uiScrollSizes(this.document._world, this._comp).scrollHeight;
  }

  /** Its padding box's width and height, where its content scrolls. */
  get clientWidth(): number {
    return uiScrollSizes(this.document._world, this._comp).clientWidth;
  }

  get clientHeight(): number {
    return uiScrollSizes(this.document._world, this._comp).clientHeight;
  }

  /** Scroll its content to `x`, `y` (or `{ left, top, behavior }`): `smooth` animates, `instant` jumps, `auto` follows `scroll-behavior`. */
  scrollTo(...args: UIScrollToArgs): void {
    uiScrollToArgs(this.document._world, this._comp, args, false);
  }

  /** Scroll its content by `dx`, `dy` (or `{ left, top, behavior }`). */
  scrollBy(...args: UIScrollToArgs): void {
    uiScrollToArgs(this.document._world, this._comp, args, true);
  }

  /** Scroll its scrolling ancestors so it shows: `block` and `inline` `start`, `center`, `end` or `nearest` (`true`: start, `false`: end). */
  scrollIntoView(options?: boolean | UIScrollIntoViewOptions): void {
    uiScrollIntoViewArg(this.document._world, this._comp, options);
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
    return this._comp instanceof UIInputField && this._comp.changed;
  }

  /** Input fields: true for the frame Enter was pressed in it. */
  get submitted(): boolean {
    return this._comp instanceof UIInputField && this._comp.submitted;
  }

  /** Buttons and input fields: true while it has focus. */
  get focused(): boolean {
    return (this._comp instanceof UIButton || this._comp instanceof UIInputField) && this._comp.focused;
  }

  /** The document's root: true for the frame the player pressed `cancel` with focus on its canvas. */
  get canceled(): boolean {
    return this === this.document.root && this.document._canceled();
  }

  /** Input fields: the text in it; null for other elements. Setting it doesn't count as a change. */
  get value(): string | null {
    return this._comp instanceof UIInputField ? this._comp.value : null;
  }

  set value(value: string) {
    if (!(this._comp instanceof UIInputField)) throw new Error(`${this.describe()} has no value: only InputField elements do.`);
    this._comp.value = value;
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
  /** The sheets declare transitions, animations or `@keyframes` (ADR 0418 wave 4). */
  private animates = false;
  /** The sheets use `:lang()`: a language change restyles the tree (ADR 0356 §4). */
  private langRules = false;
  /** `Locale.epoch` the tree was last brought up to date with. */
  private localeEpoch = -1;
  private problemList: SourceProblem[] = [];
  /** The text of each file the build read, to rebuild when one changes. */
  private sources = new Map<string, unknown>();
  private builtFrom: string | null = null;
  private lists = new Map<string, { items: readonly unknown[]; setup?: (row: UIDocumentElement, item: never) => void; options?: UIListOptions<never> }>();
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private selectorCache = new Map<string, readonly Selector[]>();

  /** Resolves once the document has been built (at once if it already is), with its stylesheets' animation support loaded. */
  get ready(): Promise<void> {
    const built = this.builtFrom !== null ? Promise.resolve() : (this.readyPromise ??= new Promise<void>((resolve) => (this.readyResolve = resolve)));
    return built.then(() => (this.animates && this.node.isValid ? uiAnimationReady(this._world) : undefined));
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
    // Rows by key, in order: a repeated (or missing) key keeps every row it had, so none is orphaned.
    const old = new Map<unknown, UIDocumentElement[]>();
    state.rows.forEach((row, i) => {
      const same = old.get(state.keys[i]);
      if (same) same.push(row);
      else old.set(state.keys[i], [row]);
    });
    const rows: UIDocumentElement[] = [];
    const keys: unknown[] = [];
    const fresh: [UIDocumentElement, T][] = [];
    const seen = new Set<unknown>();
    let repeated: unknown = undefined;
    let repeats = false;
    const world = this._world;
    world._batch(() => {
      items.forEach((item, index) => {
        const key = keyOf(item, index);
        if (seen.has(key) && !repeats) {
          repeats = true;
          repeated = key;
        }
        seen.add(key);
        let row = old.get(key)?.shift();
        if (row && row.isValid) {
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
    for (const same of old.values()) for (const row of same) this.removeElement(row);
    if (repeats && !this.warnedRepeats.has(selector)) {
      this.warnedRepeats.add(selector);
      const what = repeated === undefined ? "items have no key" : `key ${typeof repeated === "string" ? JSON.stringify(repeated) : String(repeated)} repeats`;
      warn(`${this.document}: list("${selector}"): ${what}; give each item its own key, or rows are matched by order among the repeats.`);
    }
    // Rows go after the host's own children, in item order.
    const own = host._children.filter((c) => !state.rows.includes(c) && !rows.includes(c));
    host._children = [...own, ...rows];
    rows.forEach((row, i) => world._setSiblingIndex(row._node.entity, own.length + i));
    state.rows = rows;
    state.keys = keys;
    for (const row of rows) this.updateBindings(row);
    if (this.rootElement) this.resolveReferences(this.rootElement);
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

  /** @internal Editor: the live document element a UI component belongs to, or null (removed). */
  static _elementOf(component: UIComponentType): UIDocumentElement | null {
    const el = elementByComponent.get(component);
    return el && el._alive ? el : null;
  }

  /**
   * @internal Editor: an element's cascade as if its pseudo-class state were `state` (the rest as it
   * is now), without writing anything: where a button's `:hover` / `:pressed` colours come from.
   */
  _resolveAt(el: UIDocumentElement, state: Partial<Record<UIPseudo, boolean>>): ReadonlyMap<string, ResolvedValue> {
    if (!parsers) return new Map();
    return parsers.resolveStyle({ ...el._target, state: { ...el._target.state, ...state } }, el._markup, el._comp.constructor as ComponentClass, this.sheets, el._parent?._resolved ?? null, () => {});
  }

  /** @internal The `document` value the tree was last built from, or null before a build (`documentSource.ts`). */
  get _builtFrom(): string | null {
    return this.builtFrom;
  }

  /** @internal Editor: the stylesheets of the last build, in cascade order. */
  get _sheets(): readonly UIStylesheet[] {
    return this.sheets;
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
    uiAnimationOwnerGone(this._world, this);
    // Called while the World flushes its destroys: queue the tree (that flush picks it up), never flush again here.
    this.teardown(null, false);
  }

  // --- Building ---------------------------------------------------------------------------------

  private rebuild(): void {
    const P = parsers;
    if (!P) return;
    const reuse = new Map<string, UIDocumentElement>();
    if (this.rootElement) collectReusable(this.rootElement, reuse);
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
      this.sources.set(p, Assets.get(p));
      return projectFileKind(p) === "text" ? Assets.text(p) : null;
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
        this.langRules = P.usesLang(this.sheets);
        this.animates = P.usesAnimation(this.sheets);
        if (this.animates) void uiAnimator(this._world).open(); // the tween backend loads while the tree builds
        this.localeEpoch = Locale.epoch;
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
    if (this.rootElement) this.resolveReferences(this.rootElement);
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
    const type = uiTypeOfTag(markup.tag);
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
    el._styled = false;
    el._target = {
      tag: markup.tag,
      id: idAttr,
      classes: classAttr.split(/\s+/).filter(Boolean),
      state: { hover: false, pressed: false, focus: false, disabled: false },
      parent: parent?._target ?? null,
      lang: Locale.language,
    };
    const parentNode = parent ? parent._node : this.node;
    const node = world._createNode(idAttr ?? markup.tag, parentNode.entity);
    el._node = node;
    // The one place UI components are made (ADR 0417): `addBehavior` refuses them, so the build adds through the World.
    el._comp = world._addComponent(node.entity, type);
    el._path = scope || parent?._path === null ? null : path; // list rows and what's inside them have none
    elementByComponent.set(el._comp, el);

    // Bindings: key attributes (`t:text`, ADR 0356 §4), bound attributes, and the text content (a Text's text, an
    // InputField's value). A button's `t:text` is its label's.
    const fields = P.fieldsOf(type);
    el._bindings = [];
    let labelKey: MarkupAttribute | null = null;
    for (const a of markup.attributes) {
      const keyField = P.keyAttributeField(a);
      if (keyField !== null) {
        if (markup.tag === "Button" && keyField === "text") {
          labelKey = a;
          continue;
        }
        const info = fields.get(keyField);
        if (info && P.isTextField(info)) el._bindings.push({ field: keyField, info, parts: [], key: P.parseBindings(a.value), fallback: null, last: undefined, written: false });
        else warn(`${markup.file}: <${markup.tag} ${a.name}>: <${markup.tag}> has no text field "${keyField}" to localise; ignored.`);
        continue;
      }
      const name = P.attributeField(a);
      if (!name || !P.hasBinding(a.value)) continue;
      const info = fields.get(name);
      if (info) el._bindings.push({ field: name, info, parts: P.parseBindings(a.value), last: undefined, written: false });
      else warn(`${markup.file}: <${markup.tag}> has no field "${a.name}".`);
    }
    const textField = markup.tag === "Text" ? "text" : markup.tag === "InputField" ? "value" : null;
    if (textField && markup.text !== null) {
      // With a key attribute on the same field, the content shows only while the key resolves nowhere.
      const keyed = el._bindings.find((b) => b.key && b.field === textField);
      if (keyed) keyed.fallback = P.parseBindings(markup.text);
      else el._bindings.push({ field: textField, info: fields.get(textField)!, parts: P.parseBindings(markup.text), last: undefined, written: false });
    }

    this.restyle(el);

    // A button's text content (or its `t:text`) is its label: a Text child.
    if (markup.tag === "Button" && (markup.text !== null || labelKey)) {
      const label: MarkupElement = { kind: "element", tag: "Text", attributes: labelKey ? [labelKey] : [], children: [], text: markup.text, template: null, span: markup.span, openTagSpan: markup.openTagSpan, file: markup.file };
      const child = this.build(label, el, null, reuse, labelPath(path));
      child._synthetic = true;
      el._children.push(child);
    }
    const paths = scope ? null : childPaths(path, markup.children);
    markup.children.forEach((childMarkup, i) => el._children.push(this.build(childMarkup, el, null, scope ? null : reuse, paths?.[i] ?? "")));
    return el;
  }

  /**
   * Node references the markup names by element id (ADR 0340): `nav-up`, `nav-down`, `nav-left`,
   * `nav-right` and, on the root, `first-selected`. Set once the tree (and its list rows) is built; an id
   * is looked up in the element's own list row first, then in the whole document.
   */
  private resolveReferences(from: UIDocumentElement): void {
    const P = parsers!;
    walk(from, (el) => {
      if (!el._alive) return;
      for (const a of el._markup.attributes) {
        const field = P.referenceField(a);
        if (!field) continue;
        const where = `${el._markup.file}: <${el._markup.tag} ${a.name}="${a.value}">`;
        if (!P.fieldsOf(el._comp.constructor as ComponentClass).has(field)) {
          this.warnOnce(`${where}: <${el._markup.tag}> has no field "${a.name}".`);
          continue;
        }
        const id = a.value.trim();
        const target = id ? this.elementById(id, el) : null;
        if (id && !target) this.warnOnce(`${where}: there's no element with id "${id}".`);
        (el._comp as unknown as Record<string, unknown>)[field] = target?._node ?? null;
      }
    });
  }

  private elementById(id: string, near: UIDocumentElement): UIDocumentElement | null {
    const find = (root: UIDocumentElement): UIDocumentElement | null => {
      let found: UIDocumentElement | null = null;
      walk(root, (el) => {
        if (!found && el._alive && el._target.id === id) found = el;
      });
      return found;
    };
    let row: UIDocumentElement | null = near;
    while (row && !row._scope) row = row._parent;
    return (row && find(row)) ?? (this.rootElement ? find(this.rootElement) : null);
  }

  private readonly warned = new Set<string>();
  /** Lists already warned about repeated keys (once per selector). */
  private readonly warnedRepeats = new Set<string>();

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    warn(message);
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
    const writes: UIStyleWrite[] = [];
    const write = (name: string, value: unknown) => {
      writes.push({ field: name, before: comp[name], after: value });
      comp[name] = value;
    };
    for (const [name, rv] of resolved) {
      if (name.startsWith("--") || bound.has(name) || !fields.has(name)) continue;
      next.add(name);
      const prev = el._resolved.get(name);
      if (prev && el._applied.has(name) && prev.source === rv.source && sameValue(prev.value, rv.value)) continue;
      write(name, P.cloneValue(rv.value));
    }
    for (const name of el._applied) if (!next.has(name)) write(name, defaultOf(type, name));
    // Transitions and keyframe animations (ADR 0418 wave 4): the animator takes what changed from here.
    const transitions = resolved.get(P.TRANSITION_KEY)?.value as readonly UITransitionSpec[] | undefined;
    const animations = resolved.get(P.ANIMATION_KEY)?.value as readonly UIAnimationSpec[] | undefined;
    const first = !el._styled;
    el._styled = true;
    if (transitions?.length || animations?.length || uiAnimating(this._world, el._comp)) {
      const sheets = this.sheets;
      uiAnimator(this._world).styled(
        { owner: this, element: el, comp: el._comp, fields, animate: !this._world.inEditMode(el._node.entity) },
        writes,
        first,
        transitions?.map((spec): UIResolvedTransition => ({ spec, fields: P.transitionFields(spec.property, fields) })) ?? null,
        animations?.map((spec): UIResolvedAnimation => ({ spec, tracks: () => P.keyframeTracks(sheets, spec.name, type, resolved, el._markup.file, warn) })) ?? null,
      );
    }
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
      }
    }
    for (const child of el._children) this.updateBindings(child);
  }

  /** A binding name's value in an element's scope: the innermost row's item, then `data`; dotted names read fields. */
  private lookup(el: UIDocumentElement, name: string): unknown {
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
  }

  /** Literal parts with `{name}` bindings filled in (left as written while there's no value). */
  private fill(el: UIDocumentElement, parts: readonly BindingPart[]): string {
    let text = "";
    for (const part of parts) {
      if ("text" in part) text += part.text;
      else {
        const v = this.lookup(el, part.binding);
        text += v === undefined ? `{${part.binding}}` : String(v);
      }
    }
    return text;
  }

  /**
   * A key attribute's value (ADR 0356 §4): the message of the key (its `{name}` parts filled from the row, then `data`)
   * in the current language, with the arguments the message uses looked up in the same scope; the element's text
   * content while the key resolves nowhere. Formatted again only when `Locale.epoch`, the key or an argument changed.
   */
  private keyValue(el: UIDocumentElement, b: Binding & { key: readonly BindingPart[] }): string {
    const key = this.fill(el, b.key);
    const epoch = Locale.epoch;
    const c = b.cache;
    const names = c && c.epoch === epoch && c.key === key ? c.names : localeMessageNames(key);
    if (names === null && b.fallback) return this.fill(el, b.fallback);
    const args = names?.map((n) => this.lookup(el, n)) ?? [];
    if (c && c.epoch === epoch && c.key === key && c.args.length === args.length && c.args.every((v, i) => v === args[i])) return c.value;
    const value = names === null ? Locale.t(key) : Locale.t(key, Object.fromEntries(names.map((n, i) => [n, args[i] as MessageArg])));
    b.cache = { epoch, key, names, args, value };
    return value;
  }

  private bindingValue(el: UIDocumentElement, b: Binding, P: Parsers): unknown {
    if (b.key) return this.keyValue(el, b as Binding & { key: readonly BindingPart[] });
    const lookup = (name: string): unknown => this.lookup(el, name);
    // A whole-value binding of a non-text field passes values of the right type straight through.
    if (b.parts.length === 1 && "binding" in b.parts[0]) {
      const v = lookup(b.parts[0].binding);
      if (v === undefined) return P.boundValue(`{${b.parts[0].binding}}`, b.info, el._markup.file);
      if ((b.info.type === Number && typeof v === "number") || (b.info.type === Boolean && typeof v === "boolean") || (b.info.type === Color && v instanceof Color) || (b.info.type === Vector2 && v instanceof Vector2)) return v;
      return P.boundValue(String(v), b.info, el._markup.file);
    }
    return P.boundValue(this.fill(el, b.parts), b.info, el._markup.file);
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

  /**
   * @internal After UI input routing, before behaviors' update: the frame's events the UI core
   * recorded for this document's elements (ADR 0309), in document order, then their handlers.
   */
  _collectEvents(): void {
    const root = this.rootElement;
    if (!root) return;
    const world = this._world;
    if (world.inEditMode(this.node.entity)) return; // a scene being edited: no events (ADR 0026)
    const log = uiInteractions(world);
    const events: UIEvent[] = [];
    const own: UIDocumentEvent[] = [];
    if (this._canceled()) own.push(new UIDocumentEvent("cancel", root, this, null));
    // Last frame's transition and animation events (ADR 0418 wave 4), in the order they happened.
    for (const { element, event } of takeUIAnimationEvents(world, this)) {
      const el = element as UIDocumentElement;
      if (el._alive) own.push(new UIDocumentEvent(event.type, el, this, null, null, event));
    }
    events.push(...own);
    // The buffer's other events, as the polled state has them (ADR 0309); their handlers run from the frame's records.
    walk(root, (el) => {
      if (!el._alive) return;
      const c = el._comp;
      const types: readonly UIInteractionType[] = c instanceof UIButton ? BUTTON_EVENTS : c instanceof UIInputField ? FIELD_EVENTS : [];
      for (const type of types) {
        if (type === "click" ? (c as UIButton).clicked : log.happened(c as UIButton | UIInputField, type)) events.push(new UIDocumentEvent(type as UIEventType, el, this, null));
      }
    });
    if (events.length) world._buffer(UIEvents).push(...events);
    // Cancel and animation events don't bubble: their target's handlers.
    for (const e of own) if (e.element._alive) this.dispatch(e);
  }

  /**
   * @internal ADR 0422: one of the frame's records on an element of this document: its event (or events: a focus
   * change is `focus` then `focusin`, a blur `blur` then `focusout`) through the element's ancestors.
   */
  _dispatchRecord(r: UIEventRecord, el: UIDocumentElement): void {
    const world = this._world;
    if (world.inEditMode(this.node.entity)) return; // a scene being edited: no events (ADR 0026)
    if (r.type === "cancel") return; // the root's, from the polled state
    if (r.type === "submit" && !uiInteractions(world).happened(el._comp as UIInputField, "submit")) return; // its Enter was prevented
    let related = r.data.related ? UIDocument._elementOf(r.data.related) : null;
    while (related?._synthetic && related._parent) related = related._parent;
    const types: readonly UIEventType[] = r.type === "focus" ? ["focus", "focusin"] : r.type === "blur" ? ["blur", "focusout"] : [r.type as UIEventType];
    for (const type of types) {
      if (!el._alive) return;
      this.dispatch(new UIDocumentEvent(type, el, this, type === r.type ? r : null, related));
    }
  }

  /** Run `e` through its target's ancestors in this document (capture, target, bubble). */
  private dispatch(e: UIDocumentEvent): void {
    const path: UIDocumentElement[] = [];
    for (let at: UIDocumentElement | null = e.element; at; at = at._parent) path.push(at);
    propagate(e, path, (el, phase) => {
      const list = el._handlers.get(e.type);
      if (!list?.length) return;
      e.currentTarget = el;
      runUIListeners(list, phase, e, (h) => {
        try {
          h(e);
        } catch (err) {
          console.error(`[myco] a UI "${e.type}" handler on ${el} threw:`, err);
        }
      });
    });
    e.currentTarget = null;
  }

  /** @internal True in the frame the player pressed `cancel` on the document's canvas: its root, or the canvas above it (ADR 0340). */
  _canceled(): boolean {
    const root = this.rootElement;
    if (!root?._alive) return false;
    let canvas: UICanvas | null = root._comp instanceof UICanvas ? root._comp : null;
    for (let n: GameObject | null = this.node; !canvas && n; n = n.parent) canvas = n.getComponent(UICanvas);
    return !!canvas && canvas.canceled;
  }

  /** @internal After behaviors' lateUpdate: hot reload, bindings, pseudo-class and class restyles. */
  _lateSync(): void {
    if (this.builtFrom !== null && (this.document !== this.builtFrom || this.sourcesChanged())) {
      this.rebuild();
      return;
    }
    const root = this.rootElement;
    if (!root) return;
    // A language change (ADR 0356 §4): `:lang()` rules match again; key bindings format again below.
    if (this.localeEpoch !== Locale.epoch) {
      this.localeEpoch = Locale.epoch;
      const language = Locale.language;
      walk(root, (el) => {
        el._target.lang = language;
      });
      if (this.langRules) this._styleDirty.add(root);
    }
    this.updateBindings(root);
    walk(root, (el) => {
      const state = uiPseudoState(el._comp);
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

/** The events each kind can have, in the order a frame's are reported. */
const BUTTON_EVENTS: readonly UIInteractionType[] = ["blur", "focus", "click", "hover"];
const FIELD_EVENTS: readonly UIInteractionType[] = ["blur", "focus", "change", "submit"];

function walk(el: UIDocumentElement, fn: (el: UIDocumentElement) => void): void {
  fn(el);
  for (const c of el._children) walk(c, fn);
}

/** Static elements by their path, so a rebuild hands their handlers to the new elements. */
function collectReusable(el: UIDocumentElement, out: Map<string, UIDocumentElement>): void {
  if (el._path === null) return; // rows (and what's in them) are made again by list()
  out.set(el._path, el);
  for (const c of el._children) collectReusable(c, out);
}

function dropElement(el: UIDocumentElement): void {
  el._alive = false;
  el._handlers.clear();
}

function destroyNode(node: GameObject, flush = true): void {
  if (!node.isValid) return;
  const world = node.world;
  world._destroyNode(node.entity);
  if (flush) world.applyDestroys(); // outside a frame (the editor, tests): now
}

function documentsOf(world: World): UIDocument[] {
  return [...liveDocuments].filter((d) => d.node.isValid && d._world === world);
}

// ADR 0422: the frame's event records on documents' elements go to their document.
addUIEventFrontEnd((r) => {
  let el = r.target ? elementByComponent.get(r.target) : undefined;
  if (!el?._alive) return false;
  // A button's label made from its text isn't written in the markup: its events are the button's (as a text node's are its element's).
  if (el._synthetic && (r.type === "pointerenter" || r.type === "pointerleave")) return true; // its button has its own
  while (el._synthetic && el._parent) el = el._parent;
  let related = r.data.related ? elementByComponent.get(r.data.related) : undefined;
  while (related?._synthetic && related._parent) related = related._parent;
  if ((r.type === "pointerover" || r.type === "pointerout") && related === el) return true; // between a label and its button
  el.document._dispatchRecord(r, el);
  return true;
});

// Right after UI input routing (which runs as the frame begins) and before behaviors' update: documents' buffer and
// their own events, then every UI event record of the frame (ADR 0422: documents' and hosted trees', in order).
defineBuiltinSystem({
  name: "engine.UIDocumentEvents",
  phase: "update",
  after: ["engine.Lobby", "engine.PredictionSmooth"],
  before: ["engine.UpdateScripts"],
  run: (w) => {
    documentsOf(w).forEach((d) => d._collectEvents());
    dispatchUIEvents(w);
  },
});
// After behaviors' lateUpdate, before render sync: bindings and restyles show this frame.
defineBuiltinSystem({ name: "engine.UIDocumentSync", phase: "lateUpdate", after: ["engine.LateUpdateScripts"], run: (w) => documentsOf(w).forEach((d) => d._lateSync()) });
