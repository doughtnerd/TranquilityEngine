/**
 * The UI core's external tree host (ADR 0423): ordinary UI elements that another library (the UI
 * plugin's Svelte renderer) creates, changes, moves and removes, styled by the cascade. Internal to the UI
 * plugin, not game API. Since ADR 0423 wave D retired UI documents, it's the only maker of UI elements.
 *
 * - A `UIHostTree` owns a canvas node under a parent node (a `UIView`'s), and every element made in it
 *   is a node with one UI component under that canvas: the node tree is the UI tree, so the UI core lays it
 *   out, draws it and routes the pointer to it.
 * - Elements are HTML-like: a tag as written (`div`, `button`), attributes (component fields in
 *   kebab-case, ADR 0077), `id`, classes and an inline `style`, matched by the stylesheets every hosted
 *   tree in the process shares (`setUIHostStyles`: Svelte's scoped rules match only their component's
 *   elements through its hash class, and `:global` rules reach every view, as global CSS reaches a page).
 * - Styling is the styled tree's (`document/styledTree.ts`, ADR 0438): the host tells it what changed and it decides what
 *   restyles. A new subtree is styled when it's made (`restyle`); attribute, class and pseudo-class changes are
 *   restyled in the late sync of the frame they happen in, after the flush hooks (`onFlush`) ran, so a
 *   change a click handler queued in a microtask shows in the frame of the click.
 * - Events come from the UI core's interaction log (ADR 0309) with DOM names (`click`, `input`,
 *   `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`…), dispatched once a frame
 *   (`engine.UIEventDispatch`): right after UI input routing, before behaviors' `update`. ADR 0426: they travel
 *   through the element's ancestors in capture, target and bubble phases; one that bubbles out of the tree's canvas
 *   unstopped goes on to the renderer (`onUIHostBubbleOut`: Svelte's body, document and window).
 * - The editor finds the hosted element of a picked component with `uiHostElementOf`, with the template
 *   location it was made from (`source`), and follows changes with `onUIHostChanged`.
 * - Geometry and played keyframes (ADR 0423, for Svelte's transitions and `animate:`): reading an element's box
 *   (`layoutNow`, then `bounds`) lays the UI out first when something changed, as reading layout does in the DOM;
 *   `computedStyle` gives its values as CSS text; `animate` plays keyframes on the UI animator (ADR 0422 wave 4).
 *
 * - Node references written by element id (`nav-up="play"`, `first-selected`, ADR 0340) are resolved in the tree.
 *
 * UI components are made only here (ADR 0421, amended by 0423).
 */
import { Color } from "../../core/math";
import { defineBuiltinSystem } from "../../core/systems";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { UICanvas, UIInputField, UIText, isFocusableUI, type UIComponentType } from "../components";
import { clickUI, controlValue, defaultAttributeWritten, writeControlValue } from "../formModel";
import { uiContentAttributes, uiDefaultAttribute, uiTypeOfTag } from "../elementKinds";
import { uiInteractions } from "../interactions";
import { boundsOf, transformRect } from "../transform2d";
import { backdropFilterFields, filterStepsOf, filterText, type UIFilterFields } from "../filters";
import type { ResolvedValue, StyleTarget, UIStylesheet, UITag } from "../document/types";
import type { UIElementStyle, UISheetSource, UIStyledTree } from "../document/styledTree";
// The UI animator's frame system is part of the host's frame (registered with the host's own systems, before any World
// is made), though only the styled tree calls it.
import "../animation/UIAnimator";
import type { UIAnimationEvent, UIPlayback, UIPlayHooks } from "../animation/UIAnimator";
import { addUIEventFrontEnd, addUIListener, dispatchUIEventNow, dispatchUIEvents, propagate, removeUIListener, runUIListeners, uiEventBubbles, uiEventCancelable, UIEventBase, uiEventRecord, uiListenerOptions, type UIEventRecord, type UIListener } from "../events";
import { uiScrollIntoViewArg, uiScrollSizes, uiScrollToArgs, isScrollable, type UIScrollIntoViewOptions, type UIScrollToArgs } from "../scrolling";

type Support = typeof import("../document/styledTree");
type ComponentClass = new () => UIComponentType;

let support: Support | null = null;
let loading: Promise<Support> | null = null;

/**
 * Load the styled tree and the cascade behind it (ADR 0423, 0438: without the CSS parser, since components' styles arrive
 * parsed). Trees can be made once it resolves.
 */
export function loadUIHostSupport(): Promise<void> {
  if (support) return Promise.resolve();
  loading ??= import("../document/styledTree").then(
    (m) => (support = m),
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading.then(() => undefined);
}

function requireSupport(): Support {
  if (!support) throw new Error("The UI host's cascade isn't loaded: await loadUIHostSupport() first.");
  return support;
}

/**
 * Whether `target` matches a selector list in the cascade's grammar (ADR 0422 wave 5), as `UIView.query` reads it:
 * the Svelte renderer's nodes answer `querySelector`, `matches` and `closest` with it (ADR 0423). Throws for a selector
 * outside that grammar. The cascade must be loaded.
 */
export function matchesUISelector(selector: string, target: StyleTarget): boolean {
  return requireSupport().matchesSelector(selector, target);
}

// --- Styles ---------------------------------------------------------------------------------------

/**
 * Each registered stylesheet by its file, in registration order: rule data, parsed when its component compiled. Every
 * tree's styled tree reads it (ADR 0438), with cascade order across the files and what they use.
 */
const registeredSheets: { version: number; readonly files: Map<string, UIStylesheet> } & UISheetSource = { version: 0, files: new Map() };

/**
 * Set (or with null, remove) the stylesheet `file` contributes to every hosted tree: a Svelte component's
 * CSS (`css: 'external'`) or an imported `.css` file, as rule data parsed when it compiled (ADR 0423: games
 * ship no CSS parser). Registering a file again replaces it (hot reload), keeping its place in the cascade
 * order; registering equal data again changes nothing.
 */
export function setUIHostStyles(file: string, css: UIStylesheet | null): void {
  const styleSources = registeredSheets.files;
  const current = styleSources.get(file);
  if (css === null) {
    if (current === undefined) return;
    styleSources.delete(file);
  } else {
    if (current === css || (current && sameSheet(current, css))) return;
    styleSources.set(file, css);
  }
  registeredSheets.version++;
}

/** Rule data equal to what's registered: a module evaluated again (a relink) with the same CSS. */
function sameSheet(a: UIStylesheet, b: UIStylesheet): boolean {
  return a.rules.length === b.rules.length && JSON.stringify(a) === JSON.stringify(b);
}

// --- Events ---------------------------------------------------------------------------------------

export type UIHostEventType =
  | "click" | "input" | "change" | "submit" | "focus" | "blur" | "pointerenter" | "pointerleave"
  | "transitionend" | "animationstart" | "animationiteration" | "animationend"
  // ADR 0426: the DOM's pointer, keyboard, focus and drag events; ADR 0427: scrolling.
  | "dblclick" | "contextmenu" | "pointerdown" | "pointerup" | "pointermove" | "pointerover" | "pointerout" | "pointercancel"
  | "wheel" | "keydown" | "keyup" | "focusin" | "focusout" | "scroll" | "scrollend"
  | "dragstart" | "drag" | "dragenter" | "dragover" | "dragleave" | "drop" | "dragend"
  // ADR 0428: a form's reset.
  | "reset";

/**
 * A UI event on a hosted element (ADR 0423): what an `onclick`, `oninput`… handler gets. ADR 0426: the DOM's
 * propagation and cancellation members and pointer, wheel and keyboard fields (`UIEventBase`).
 */
export class UIHostEvent extends UIEventBase {
  declare readonly type: UIHostEventType;
  /** What the handler is listening on; a renderer sets it to its own node (as the DOM's `currentTarget`). */
  currentTarget: unknown;
  /** The element the event happened on; a renderer sets it to its own node (as the DOM's `target`). */
  target: unknown;
  /** The other element of pointer over/out/enter/leave, focus changes and drag enter/leave: a hosted element (a renderer sets its node), or null. */
  relatedTarget: unknown;
  /** `transitionend` (ADR 0422 wave 4): the property whose transition finished (kebab-case); "" otherwise. */
  readonly propertyName: string;
  /** Animation events: the animation's name; "" otherwise. */
  readonly animationName: string;
  /** Transition and animation events: seconds it had run, its delay not counted; 0 otherwise. */
  readonly elapsedTime: number;

  constructor(
    type: UIHostEventType,
    /** The hosted element the event happened on. */
    readonly element: UIHostElement,
    /** A transition or animation event's details. */
    detail?: Pick<UIAnimationEvent, "propertyName" | "animationName" | "elapsedTime">,
    /** ADR 0426: the record it comes from (pointer and key data; `preventDefault` cancels its default action). */
    record: UIEventRecord | null = null,
    /** The hosted element of `relatedTarget`. */
    related: UIHostElement | null = null,
  ) {
    super(type, record, { bubbles: uiEventBubbles(type), cancelable: uiEventCancelable(type), on: element._comp });
    this.currentTarget = element;
    this.target = element;
    this.relatedTarget = related;
    this.propertyName = detail?.propertyName ?? "";
    this.animationName = detail?.animationName ?? "";
    this.elapsedTime = detail?.elapsedTime ?? 0;
  }

  /** An input field's text (null for other elements). */
  get value(): string | null {
    return this.element.value;
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

/** A hosted UI element: a node with one UI component, styled by the cascade. */
export class UIHostElement {
  /** @internal */ _node!: GameObject;
  /** @internal */ _comp!: UIComponentType;
  /** @internal Its style state (ADR 0438), the styled tree's: its selector target, resolved style and generated elements. */ _style!: UIElementStyle<UIHostElement>;
  /** @internal */ _attributes: ReadonlyMap<string, string> = new Map();
  /** @internal */ _parent: UIHostElement | null = null;
  /** @internal */ _children: UIHostElement[] = [];
  /** @internal */ _alive = true;
  /** @internal */ _listeners = new Map<UIHostEventType, UIListener<UIHostListener>[]>();
  /** @internal The field's value changed since the last `change` event. */ _edited = false;
  /** @internal Content attributes last written (`uiContentAttributes`). */ _content = new Map<string, string>();

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
    return this._style.target.id;
  }

  get classes(): readonly string[] {
    return this._style.target.classes;
  }

  /**
   * What selectors match it (ADR 0438): its id, classes, attributes, pseudo-class `state` (hover, pressed, focus,
   * disabled, form states), parent and children, as the styled tree keeps them. The same object for its whole life, so
   * a resolved value inherited `from` a target names its element.
   */
  get styleTarget(): StyleTarget {
    return this._style.target;
  }

  /** Its resolved style by field, with where each value comes from (variables and the cascade's keys included); empty until styled. */
  get resolvedStyle(): ReadonlyMap<string, ResolvedValue> {
    return this._style.resolved;
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

  /** Input fields: their text (ADR 0428: any control's value as text, as the DOM's `value`); null for other elements. Setting it isn't a player change (no events). */
  get value(): string | null {
    return controlValue(this._comp);
  }

  set value(value: string) {
    writeControlValue(this._comp, value);
  }

  /**
   * The DOM's `click()`: a bubbling `click` dispatched now with HTML's activation (a checkbox toggles before its
   * handlers and back if one prevents it, a submit button submits its form), whose `input`, `change` or `submit` follow
   * at once. Nothing on a control that isn't interactable.
   */
  click(): void {
    clickUI(this.tree.world, this._comp);
  }

  /**
   * Give it focus (buttons, input fields and ADR 0428's controls; an input field starts typing, as a click does). As the
   * DOM's `focus()`, the element that had focus gets `blur` and `focusout`, then this one `focus` and `focusin`, at once.
   */
  focus(): void {
    const c = this._comp;
    if (!isFocusableUI(c) || c.focused) return;
    const world = this.tree.world;
    const previous = uiInteractions(world).focused;
    c.focused = true;
    if (!c.focused) return; // it can't take focus (inert, inactive)
    if (previous && previous !== c) dispatchUIEventNow(world, uiEventRecord("blur", previous, { related: c }));
    dispatchUIEventNow(world, uiEventRecord("focus", c, { related: previous }));
  }

  /** Take its focus away (`blur` and `focusout` at once, as the DOM's `blur()`). */
  blur(): void {
    const c = this._comp;
    if (!isFocusableUI(c) || !c.focused) return;
    c.focused = false;
    dispatchUIEventNow(this.tree.world, uiEventRecord("blur", c, { related: null }));
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

  /**
   * Where it's drawn, in its canvas's UI pixels: its laid-out box through its own and its ancestors' transforms
   * (ADR 0422 wave 3), as the axis-aligned rectangle around it, not cut down by clips (as the DOM's
   * `getBoundingClientRect`). Its box when nothing transforms it; null when it isn't laid out.
   */
  bounds(): { x: number; y: number; width: number; height: number } | null {
    const layout = uiInteractions(this.tree.world).layout;
    if (!layout || this._comp instanceof UICanvas) return this.rect();
    const e = layout.elements().find((l) => l.comp === this._comp);
    if (!e) return null;
    return e.transform ? boundsOf(transformRect(e.transform, e)) : { x: e.x, y: e.y, width: e.width, height: e.height };
  }

  /**
   * Its values as CSS text by camel-case property, as the DOM's `getComputedStyle` gives them (ADR 0423: what Svelte's
   * transitions and `animate:` read through the renderer's `measure` hook): sizes, edges, transforms and origins in
   * px from the last layout (`layoutNow` first for an up-to-date one), the transform as `translate() rotate() scale()`
   * (`none` when it has none), colours as `rgba()`. Properties UI elements don't have read as their CSS initial value.
   */
  computedStyle(): Record<string, string> {
    const c = this._comp as unknown as Record<string, unknown>;
    const r = this.rect();
    const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
    /** A length field in px, its % of `of`; null for `auto`/`none`. */
    const lenPx = (v: unknown, of: number): number | null => {
      if (typeof v === "number") return v;
      if (typeof v !== "string" || v === "auto" || v === "none") return null;
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return null;
      return v.trim().endsWith("%") ? (n / 100) * of : n;
    };
    const px = (n: number) => `${Math.round(n * 1e4) / 1e4}px`;
    const width = r?.width ?? lenPx(c.width, 0) ?? 0;
    const height = r?.height ?? lenPx(c.height, 0) ?? 0;
    const len = (v: unknown, of: number) => {
      const n = lenPx(v, of);
      return n === null ? String(v ?? "auto") : px(n);
    };
    const side = (field: string, all: string) => px(c[field] === null || c[field] === undefined ? num(c[all]) : num(c[field]));
    const rgba = (v: unknown, none = "rgba(0, 0, 0, 0)") =>
      v instanceof Color ? `rgba(${Math.round(v.r * 255)}, ${Math.round(v.g * 255)}, ${Math.round(v.b * 255)}, ${Math.round(v.a * 1000) / 1000})` : none;
    const tx = lenPx(c.translateX, width) ?? 0, ty = lenPx(c.translateY, height) ?? 0;
    const rotate = num(c.rotate), sx = num(c.scaleX, 1), sy = num(c.scaleY, 1);
    const parts: string[] = [];
    if (tx !== 0 || ty !== 0) parts.push(`translate(${px(tx)}, ${px(ty)})`);
    if (rotate !== 0) parts.push(`rotate(${rotate}deg)`);
    if (sx !== 1 || sy !== 1) parts.push(`scale(${sx}, ${sy})`);
    // ADR 0430: the full matrix, applied after the three.
    if (typeof c.transformMatrix === "string" && c.transformMatrix.trim() !== "") parts.push(c.transformMatrix.trim());
    const hasBorder = "borderWidth" in c;
    const border = (s: string) => (hasBorder ? side(`border${s}Width`, "borderWidth") : "0px");
    return {
      display: String(c.display ?? "flex"),
      position: String(c.positionType ?? "relative"),
      boxSizing: "border-box",
      width: px(width),
      height: px(height),
      minWidth: len(c.minWidth, width),
      minHeight: len(c.minHeight, height),
      maxWidth: len(c.maxWidth, width),
      maxHeight: len(c.maxHeight, height),
      top: len(c.top, 0),
      right: len(c.right, 0),
      bottom: len(c.bottom, 0),
      left: len(c.left, 0),
      paddingTop: side("paddingTop", "padding"),
      paddingRight: side("paddingRight", "padding"),
      paddingBottom: side("paddingBottom", "padding"),
      paddingLeft: side("paddingLeft", "padding"),
      marginTop: side("marginTop", "margin"),
      marginRight: side("marginRight", "margin"),
      marginBottom: side("marginBottom", "margin"),
      marginLeft: side("marginLeft", "margin"),
      borderTopWidth: border("Top"),
      borderRightWidth: border("Right"),
      borderBottomWidth: border("Bottom"),
      borderLeftWidth: border("Left"),
      opacity: String(num(c.opacity, 1)),
      visibility: c.visible === false ? "hidden" : "visible",
      overflow: String(c.overflow ?? "visible"),
      zIndex: num(c.zIndex) === 0 ? "auto" : String(c.zIndex),
      transform: parts.length ? parts.join(" ") : "none",
      transformOrigin: `${px(lenPx(c.transformOriginX, width) ?? width / 2)} ${px(lenPx(c.transformOriginY, height) ?? height / 2)}`,
      backgroundColor: rgba(c.backgroundColor),
      color: rgba(c.color, "rgba(0, 0, 0, 1)"),
      fontSize: px(num(c.fontSize, 16)),
      // ADR 0430: the filter fields as CSS (their fixed order); SVG stroke properties belong to SVG shapes, not elements.
      filter: filterText(filterStepsOf(c as Partial<UIFilterFields>)),
      // ADR 0432: the backdrop fields as CSS, the same way.
      backdropFilter: filterText(filterStepsOf(backdropFilterFields(c))),
      zoom: "1",
      strokeLinecap: "butt",
      strokeWidth: "1px",
    };
  }

  /**
   * Play keyframes on it (ADR 0423: a Svelte transition's or `animate:`'s, through the renderer's `animate` hook) on the
   * UI animator (ADR 0422 wave 4: the tween backend, on unscaled time): each keyframe is CSS declarations by property
   * (camel or kebab case), evenly spaced over `duration` seconds, and the last one's values stay until `stop()`. Values
   * convert as a stylesheet's do (its variables included); a declaration it can't animate is warned about once and
   * left out. `hooks.onFrame` runs each frame it plays, `hooks.onEnd` once at its end.
   */
  animate(keyframes: readonly Readonly<Record<string, string>>[], duration: number, hooks: UIPlayHooks): UIPlayback {
    return this.tree._styles.play(this, keyframes, duration, hooks);
  }

  /**
   * Listen to a UI event (`click`, `input`, `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`, and
   * ADR 0426's pointer, key, focus and drag events, ADR 0427's `scroll`/`scrollend`), or to stylesheet animation (ADR
   * 0422 wave 4: `transitionend`, `animationstart`, `animationiteration`, `animationend`, the frame after they
   * happened). `capture` hears it on the way down to its target; `once` removes the listener once it ran.
   */
  on(type: UIHostEventType, listener: UIHostListener, options?: { capture?: boolean; once?: boolean } | boolean): void {
    const o = uiListenerOptions(options);
    let list = this._listeners.get(type);
    if (!list) this._listeners.set(type, (list = []));
    addUIListener(list, listener, o.capture, o.once);
  }

  off(type: UIHostEventType, listener: UIHostListener, options?: { capture?: boolean } | boolean): void {
    removeUIListener(this._listeners.get(type), listener, uiListenerOptions(options).capture);
  }

  /**
   * Dispatch `event` (whose `element` is this element) now through this element's ancestors in the tree, in capture,
   * target and bubble phases (ADR 0426); one that bubbles out of the canvas unstopped goes on to `onUIHostBubbleOut`.
   */
  dispatch(event: UIHostEvent): void {
    const path: UIHostElement[] = [];
    for (let at: UIHostElement | null = this; at; at = at._parent) path.push(at);
    propagate(event, path, (el, phase) => {
      const list = el._listeners.get(event.type);
      if (!list?.length) return;
      runUIListeners(list, phase, event, (fn) => {
        try {
          fn(event);
        } catch (err) {
          console.error(`[myco] a UI "${event.type}" handler on <${el.tag}> threw:`, err);
        }
      });
    });
    for (const hook of [...bubbleOutHooks]) hook(event, this.tree);
  }

  // --- Scrolling (ADR 0427) ---------------------------------------------------------------------

  /** How far its content is scrolled down and right, in UI pixels (`scrollY`, `scrollX`); set them to scroll. */
  get scrollTop(): number {
    return isScrollable(this._comp) ? this._comp.scrollY : 0;
  }

  set scrollTop(value: number) {
    uiScrollToArgs(this.tree.world, this._comp, [{ top: value, behavior: "instant" }], false);
  }

  get scrollLeft(): number {
    return isScrollable(this._comp) ? this._comp.scrollX : 0;
  }

  set scrollLeft(value: number) {
    uiScrollToArgs(this.tree.world, this._comp, [{ left: value, behavior: "instant" }], false);
  }

  /** Its content's extent and its padding box, from the last layout (UI pixels). */
  get scrollWidth(): number {
    return uiScrollSizes(this.tree.world, this._comp).scrollWidth;
  }

  get scrollHeight(): number {
    return uiScrollSizes(this.tree.world, this._comp).scrollHeight;
  }

  get clientWidth(): number {
    return uiScrollSizes(this.tree.world, this._comp).clientWidth;
  }

  get clientHeight(): number {
    return uiScrollSizes(this.tree.world, this._comp).clientHeight;
  }

  /** Scroll its content to `x`, `y` (or `{ left, top, behavior }`). */
  scrollTo(...args: UIScrollToArgs): void {
    uiScrollToArgs(this.tree.world, this._comp, args, false);
  }

  /** Scroll its content by `dx`, `dy` (or `{ left, top, behavior }`). */
  scrollBy(...args: UIScrollToArgs): void {
    uiScrollToArgs(this.tree.world, this._comp, args, true);
  }

  /** Scroll its scrolling ancestors so it shows (`block`, `inline`: `start`, `center`, `end`, `nearest`). */
  scrollIntoView(options?: boolean | UIScrollIntoViewOptions): void {
    uiScrollIntoViewArg(this.tree.world, this._comp, options);
  }

  toString(): string {
    const t = this._style.target;
    return `<${this.tag}${t.id ? ` id="${t.id}"` : ""}${t.classes.length ? ` class="${t.classes.join(" ")}"` : ""}>`;
  }
}

// --- Registries -----------------------------------------------------------------------------------

/** Live trees, for the frame systems. */
const liveTrees = new Set<UIHostTree>();
/** Counts changes to every hosted tree, so `layoutNow` lays out again only after one. */
let hostVersion = 0;
/** When each World was last laid out by `layoutNow`. */
const lastLayout = new WeakMap<World, { frame: number; version: number }>();
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

const frameHooks = new Set<(world: World) => void>();
const bubbleOutHooks = new Set<(event: UIHostEvent, tree: UIHostTree) => void>();

/**
 * ADR 0426: call `hook` after every event dispatched in a hosted tree, with the tree. A renderer carries on the ones that
 * bubble and weren't stopped past its view's root (Svelte's `<svelte:body>`, `<svelte:document>`, `<svelte:window>`),
 * and notes the types its UI dispatched. Returns a function that stops it.
 */
export function onUIHostBubbleOut(hook: (event: UIHostEvent, tree: UIHostTree) => void): () => void {
  bubbleOutHooks.add(hook);
  return () => bubbleOutHooks.delete(hook);
}

const editHooks = new Set<(el: UIHostElement) => void>();

/**
 * ADR 0429: call `hook` with an editable text element the player edited (the UI core wrote the edit into its runs'
 * components), right before its `input` event is dispatched: a renderer brings its own nodes up to date there, so the
 * event's listeners (`bind:textContent`) read the edited text. Returns a function that stops it.
 */
export function onUIHostEdit(hook: (el: UIHostElement) => void): () => void {
  editHooks.add(hook);
  return () => editHooks.delete(hook);
}

/**
 * Run `hook(world)` each frame in every World that has a hosted tree in play (not in the editor's edit mode), right
 * after the frame's UI events: a renderer delivers its global events there (`<svelte:window>` keys, `resize`).
 * Returns a function that stops it.
 */
export function onUIHostFrame(hook: (world: World) => void): () => void {
  frameHooks.add(hook);
  return () => frameHooks.delete(hook);
}

/** The drawing canvas's size in CSS pixels at `world`'s last UI layout (what screen canvases cover), or null before one. */
export function uiHostViewport(world: World): { width: number; height: number } | null {
  const v = uiInteractions(world).layout?.viewport;
  return v ? { width: v.width, height: v.height } : null;
}

/**
 * The canvas of `world`'s first hosted tree at its last UI layout: its size in UI pixels (what `@media` matches, ADR
 * 0422 wave 5) and `scale`, the drawing canvas's CSS pixels per UI pixel. Null before a layout, or without a tree.
 */
export function uiHostCanvas(world: World): { width: number; height: number; scale: number } | null {
  const layout = uiInteractions(world).layout;
  if (!layout) return null;
  for (const tree of treesOf(world)) {
    const c = layout.canvases().find((l) => l.comp === tree.root._comp);
    if (c) return { width: c.width, height: c.height, scale: c.scale };
  }
  return null;
}

/** The hosted element that has `world`'s focus (ADR 0340), or null. */
export function uiHostFocused(world: World): UIHostElement | null {
  const c = uiInteractions(world).focused;
  return c ? uiHostElementOf(c) : null;
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

function walk(el: UIHostElement, fn: (el: UIHostElement) => void): void {
  fn(el);
  for (const c of el._children) walk(c, fn);
}

/** `walk`, with the generated `::before`/`::after` elements (ADR 0432) too. */
function walkAll(el: UIHostElement, fn: (el: UIHostElement) => void): void {
  fn(el);
  const s = el._style;
  if (s.before) walkAll(s.before, fn);
  for (const c of el._children) walkAll(c, fn);
  if (s.after) walkAll(s.after, fn);
}

/**
 * A tree of hosted UI elements under a canvas, the root, made under `parent` (a `UIView`'s node). The
 * element operations are what a DOM-like renderer needs: create (under a parent, before a sibling), set
 * attributes, set text, move, remove, listen. Await `loadUIHostSupport()` before making one.
 */
export class UIHostTree {
  /** The canvas every element is under. Its fields belong to the tree's owner (a `UIView` copies its own onto it). */
  readonly root: UIHostElement;
  /** @internal ADR 0438: what keeps its elements styled (invalidation, the cascade, pseudo-elements). */
  readonly _styles: UIStyledTree<UIHostElement>;
  private readonly flushHooks = new Set<() => void>();
  private shapeChanged = false;
  private disposed = false;

  constructor(
    readonly world: World,
    parent: GameObject,
    /** What relative asset paths in attributes resolve against when an element has no source file. */
    readonly file: string,
  ) {
    const S = requireSupport();
    const root = new UIHostElement(this, "Canvas", "Canvas", null, false);
    root._node = world._createNode("Canvas", parent.entity);
    root._comp = world._addComponent(root._node.entity, UICanvas);
    elementByComponent.set(root._comp, root);
    this.root = root;
    this._styles = new S.UIStyledTree<UIHostElement>(
      {
        world,
        file,
        sheets: registeredSheets,
        makeGenerated: (origin, which, uiTag) => this.makeGenerated(origin, which, uiTag),
        makeLabel: (box, tag) => this.makeLabel(box, tag),
        destroyGenerated: (g) => this.destroyGenerated(g),
        changed: (shape) => {
          hostVersion++;
          if (shape) this.shapeChanged = true;
        },
      },
      root,
    );
    liveTrees.add(this);
    notifyChanged(this);
  }

  /** False once disposed (its owner went away) or its canvas node was destroyed. */
  get isValid(): boolean {
    return !this.disposed && this.root._node.isValid;
  }

  /**
   * Make an element of `uiTag` written as `tag` under `parent` (null: the canvas), before `before` (null:
   * last). `attributes` are as written: fields in kebab-case, `id`, `class`, `style`. `written` is every attribute as
   * the author wrote it (HTML-only ones too, `data-*`, `type`), which attribute selectors match (ADR 0422 wave 5);
   * absent: `attributes`. Not styled yet: call `restyle` on the top of a subtree once it's made.
   */
  create(tag: string, uiTag: UITag, parent: UIHostElement | null, before: UIHostElement | null, attributes: ReadonlyMap<string, string>, options: { source?: UIHostSource | null; synthetic?: boolean; written?: ReadonlyMap<string, string> } = {}): UIHostElement {
    const p = parent ?? this.root;
    const el = new UIHostElement(this, tag, uiTag, options.source ?? null, options.synthetic ?? false);
    el._node = this.world._createNode(attributes.get("id") || tag, p._node.entity);
    // The host is the maker of UI components (ADR 0421 as amended by 0423): `addComponent` refuses them.
    el._comp = this.world._addComponent(el._node.entity, uiTypeOfTag(uiTag));
    // ADR 0429: text the renderer made between a text element's inline children: a run of it, not an element.
    if (el.synthetic && el._comp instanceof UIText && p._comp instanceof UIText) el._comp._textPiece = true;
    // ADR 0432: a `<br>` is a forced line break, whatever the white space rules (a text that is only a line break is not).
    if (el._comp instanceof UIText && tag.toLowerCase() === "br") el._comp._lineBreak = true;
    el._parent = p;
    this.writeAttributes(el, attributes);
    this._styles.attach(el, attributes, options.written);
    elementByComponent.set(el._comp, el);
    this.place(el, p, before);
    this._styles.inserted(el, true);
    this.shapeChanged = true;
    hostVersion++;
    return el;
  }

  /**
   * Replace an element's attributes (all of them, as the renderer now has them, and `written` as in `create`); restyled
   * in this frame's late sync, with its siblings when the styles have sibling or structural selectors.
   */
  setAttributes(el: UIHostElement, attributes: ReadonlyMap<string, string>, written?: ReadonlyMap<string, string>): void {
    if (!el._alive) return;
    this.writeAttributes(el, attributes);
    this._styles.attributesChanged(el, attributes, written);
    hostVersion++;
  }

  /** Write a Text's text (or an input field's value): content, never style. */
  setText(el: UIHostElement, text: string): void {
    if (!el._alive) return;
    const c = el._comp;
    if (c instanceof UIText) {
      if ((c.text === "") !== (text === "")) this._styles.emptinessChanged(el); // `:empty`, `:has(:empty)`
      c.text = text;
    } else if (c instanceof UIInputField) c.value = text;
    hostVersion++;
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
    }
    this._styles.detached(el, from);
    this.place(el, p, before);
    this._styles.inserted(el, false);
    this.shapeChanged = true;
    hostVersion++;
  }

  /** Remove an element and its subtree: hidden now, destroyed at the end of the frame (at once outside a frame). */
  remove(el: UIHostElement): void {
    if (!el._alive || el === this.root) return;
    const parent = el._parent;
    if (parent) {
      const i = parent._children.indexOf(el);
      if (i >= 0) parent._children.splice(i, 1);
    }
    walkAll(el, (e) => {
      e._alive = false;
      e._listeners.clear();
    });
    this._styles.removed(el, parent);
    if (el._node.isValid) {
      el._node.setActive(false);
      this.world._destroyNode(el._node.entity);
      this.world.applyDestroys(); // now outside a frame, at its end inside one
    }
    this.shapeChanged = true;
    hostVersion++;
  }

  /** Resolve an element's style (and its subtree's) now: a new subtree shows styled before the next frame. */
  restyle(el: UIHostElement): void {
    if (!el._alive) return;
    this._styles.restyle(el);
    hostVersion++;
  }

  /**
   * Lay the UI out now, as reading geometry does in the DOM (ADR 0423: `getBoundingClientRect` and the renderer's
   * `measure` hook, which Svelte's transitions and `animate:` read right after changing the tree): pending restyles run,
   * then the UI core that lays this World out (its pointer router) lays it out again. Nothing happens when no hosted
   * tree changed since the last time in this frame, or when nothing lays the World out (a headless World).
   */
  layoutNow(): void {
    if (!this.isValid) return;
    this._styles.restylePending();
    const world = this.world;
    const frame = world.time.frameCount;
    const last = lastLayout.get(world);
    if (last && last.frame === frame && last.version === hostVersion) return;
    uiInteractions(world).layout?.relayout?.();
    lastLayout.set(world, { frame, version: hostVersion });
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
    this._styles.dispose();
    this.flushHooks.clear();
    walk(this.root, (e) => {
      e._alive = false;
      e._listeners.clear();
    });
    const node = this.root._node;
    if (node.isValid) {
      this.world._destroyNode(node.entity);
      if (flush) this.world.applyDestroys();
    }
    notifyChanged(this);
  }

  // --- Frame ------------------------------------------------------------------------------------

  /**
   * @internal ADR 0426: one of the frame's records on an element of this tree, as the DOM events it is: a field's
   * change is `input` (and `change` once committed, by Enter or focus leaving), focus `focus` then `focusin`, a blur
   * `blur` then `focusout`; the rest under their own names. A button's `hover` is left to `pointerenter`.
   */
  _dispatchRecord(r: UIEventRecord, el: UIHostElement): void {
    if (!this.isValid || this.world.inEditMode(this.root._node.entity)) return;
    const types: UIHostEventType[] = [];
    const field = el._comp instanceof UIInputField ? el._comp : null;
    switch (r.type) {
      case "hover":
      case "cancel":
        return;
      case "change":
        // A field's typing is `input`, and `change` once committed; another control's change (ADR 0428) is itself.
        if (!field) {
          types.push("change");
          break;
        }
        el._edited = true;
        types.push("input");
        break;
      case "submit":
        if (!field) {
          types.push("submit"); // ADR 0428: a form's
          break;
        }
        if (!uiInteractions(this.world).happened(field, "submit")) return; // its Enter was prevented
        // As on the web, `change` fires when an edit is committed: Enter, or focus leaving the field.
        if (el._edited) types.push("change");
        el._edited = false;
        types.push("submit");
        break;
      case "blur":
        if (field && el._edited) types.push("change");
        el._edited = false;
        types.push("blur", "focusout");
        break;
      case "focus":
        types.push("focus", "focusin");
        break;
      default:
        types.push(r.type as UIHostEventType);
    }
    // ADR 0429: an editable text's edit: the renderer brings its nodes up to date before anyone hears `input`.
    if (r.type === "input" && el._comp instanceof UIText) for (const hook of editHooks) hook(el);
    let related = r.data.related ? uiHostElementOf(r.data.related) : null;
    while (related?.synthetic && related._parent) related = related._parent;
    for (const type of types) {
      if (!el._alive) return;
      el.dispatch(new UIHostEvent(type, el, undefined, type === r.type ? r : null, related));
    }
  }

  /** @internal After UI input routing and the frame's event records, before behaviors' update: last frame's transition and animation events (ADR 0422 wave 4), on their targets. */
  _collectEvents(): void {
    if (!this.isValid || this.world.inEditMode(this.root._node.entity)) return;
    for (const { element: el, event } of this._styles.takeEvents()) {
      if (el._alive && (el._listeners.get(event.type)?.length ?? 0) > 0) el.dispatch(new UIHostEvent(event.type, el, event));
    }
  }

  /** @internal Late update, before the restyle: the flush hooks (queued renderer updates). */
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

  /** @internal After the flush: stylesheet, language, preferences, canvas size, pseudo-class, attribute and class restyles (ADR 0438). */
  _lateSync(): void {
    if (!this.isValid) return;
    this._styles.sync();
    if (this.shapeChanged) {
      this.shapeChanged = false;
      notifyChanged(this);
    }
  }

  /** @internal */
  _query<F extends boolean>(selector: string, within: UIHostElement, first: F): F extends true ? UIHostElement | null : UIHostElement[];
  _query(selector: string, within: UIHostElement, first: boolean): UIHostElement | null | UIHostElement[] {
    const out = this._styles.query(selector, within, first);
    return first ? (out[0] ?? null) : out;
  }

  // --- Inside ---------------------------------------------------------------------------------------

  private place(el: UIHostElement, parent: UIHostElement, before: UIHostElement | null): void {
    const siblings = parent._children;
    let i = before ? siblings.indexOf(before) : -1;
    if (i < 0) i = siblings.length;
    siblings.splice(i, 0, el);
    // Node order is layout and draw order; a generated `::before` (ADR 0432) stays first, an `::after` last.
    this.world._setSiblingIndex(el._node.entity, i + (parent._style.before ? 1 : 0));
  }

  /** The attributes as set, and its content attributes' fields (ADR 0428); the styled tree takes the rest. */
  private writeAttributes(el: UIHostElement, attributes: ReadonlyMap<string, string>): void {
    el._attributes = attributes;
    const comp = el._comp as unknown as Record<string, unknown>;
    const defaultAttribute = uiDefaultAttribute(el.uiTag);
    // In the kind table's order, so a select's `multiple` and a radio's `name` are on it before its options are made or
    // its `checked` applies (ADR 0436). Only attributes that changed are written.
    for (const name of uiContentAttributes(el.uiTag)) {
      const value = attributes.get(name);
      const before = el._content.get(name);
      if (value === undefined) el._content.delete(name);
      else el._content.set(name, value);
      if (value === before) continue;
      const v = value !== undefined ? contentValue(comp[name], value) : requireSupport().defaultFieldValue(el._comp.constructor as ComponentClass, name);
      // HTML's default (`value`, `checked`, `selected`): the form-control model's dirty rules say whether the current
      // value follows it, so a player's (or a script's) change stays.
      if (name === defaultAttribute) defaultAttributeWritten(el._comp, defaultAttribute, v as string | number | boolean);
      else comp[name] = v;
    }
  }

  /** ADR 0432: a generated `::before`/`::after` for the styled tree: a node under `el`'s (first or last), not among its children. */
  private makeGenerated(el: UIHostElement, which: "before" | "after", uiTag: UITag): UIHostElement {
    const g = new UIHostElement(this, `::${which}`, uiTag, null, true);
    g._node = this.world._createNode(`::${which}`, el._node.entity);
    g._comp = this.world._addComponent(g._node.entity, uiTypeOfTag(uiTag));
    if (g._comp instanceof UIText) g._comp._pseudo = which;
    g._parent = el;
    elementByComponent.set(g._comp, g);
    this.world._setSiblingIndex(g._node.entity, which === "before" ? 0 : Number.MAX_SAFE_INTEGER);
    return g;
  }

  /** ADR 0432: the text label a generated box holds, its only child. */
  private makeLabel(box: UIHostElement, tag: string): UIHostElement {
    const label = new UIHostElement(this, tag, "Text", null, true);
    label._node = this.world._createNode(tag, box._node.entity);
    label._comp = this.world._addComponent(label._node.entity, UIText);
    label._parent = box;
    elementByComponent.set(label._comp, label);
    box._children = [label];
    return label;
  }

  private destroyGenerated(g: UIHostElement): void {
    walkAll(g, (e) => {
      e._alive = false;
    });
    const parent = g._parent;
    if (parent?._children.includes(g)) parent._children = parent._children.filter((c) => c !== g); // a label
    if (g._node.isValid) {
      g._node.setActive(false);
      this.world._destroyNode(g._node.entity);
      this.world.applyDestroys();
    }
  }
}

/**
 * A content attribute's text as its field's value, by the field's current type (ADR 0428): a boolean is true unless
 * written `false` (a bare `checked` is ""), a number is read as one (unreadable keeps the field's), text is itself.
 */
function contentValue(current: unknown, text: string): unknown {
  if (typeof current === "boolean") return text !== "false";
  if (typeof current === "number") {
    const n = Number(text);
    return text.trim() !== "" && Number.isFinite(n) ? n : current;
  }
  return text;
}

// ADR 0426: the frame's event records on hosted elements go to their tree.
addUIEventFrontEnd((r) => {
  let el = r.target ? uiHostElementOf(r.target) : null;
  if (!el) return false;
  // A label the renderer made for a text node isn't an element of the component: its events are its parent's (as a text node's are).
  if (el.synthetic && (r.type === "pointerenter" || r.type === "pointerleave")) return true; // its parent has its own
  while (el.synthetic && el._parent) el = el._parent;
  let related = r.data.related ? uiHostElementOf(r.data.related) : null;
  while (related?.synthetic && related._parent) related = related._parent;
  if ((r.type === "pointerover" || r.type === "pointerout") && related === el) return true; // between a label and its parent
  el.tree._dispatchRecord(r, el);
  return true;
});

function treesOf(world: World): UIHostTree[] {
  return [...liveTrees].filter((t) => t.world === world && t.isValid);
}

// Right after UI input routing (which runs as the frame begins) and before behaviors' update: every UI event record of
// the frame, in order (ADR 0309, 0426), each to the front end that owns its target (a hosted element's tree).
defineBuiltinSystem({ name: "engine.UIEventDispatch", phase: "update", after: ["engine.Lobby", "engine.PredictionSmooth"], before: ["engine.InputFrame", "engine.UpdateScripts"], run: (w) => dispatchUIEvents(w) });
// Then the trees' own events (transition and animation events), before behaviors' update.
defineBuiltinSystem({ name: "engine.UIHostEvents", phase: "update", after: ["engine.Lobby", "engine.PredictionSmooth", "engine.UIEventDispatch"], before: ["engine.UpdateScripts"], run: (w) => treesOf(w).forEach((t) => t._collectEvents()) });
// Then the renderers' per-frame hooks (global events), before behaviors' update.
defineBuiltinSystem({
  name: "engine.UIHostFrame",
  phase: "update",
  after: ["engine.UIHostEvents"],
  before: ["engine.UpdateScripts"],
  run: (w) => {
    if (!frameHooks.size || !treesOf(w).some((t) => !w.inEditMode(t.root._node.entity))) return;
    for (const hook of [...frameHooks]) {
      try {
        hook(w);
      } catch (err) {
        console.error("[myco] a UI host frame hook threw:", err);
      }
    }
  },
});
// After behaviors' lateUpdate and before the UI sync: renderers flush the updates their handlers queued (Svelte's microtasks).
defineBuiltinSystem({ name: "engine.UIHostFlush", phase: "lateUpdate", after: ["engine.LateUpdateScripts"], run: (w) => treesOf(w).forEach((t) => t._flush()) });
// Then restyles, so the flushed changes show this frame.
defineBuiltinSystem({ name: "engine.UIHostSync", phase: "lateUpdate", after: ["engine.UIHostFlush"], run: (w) => treesOf(w).forEach((t) => t._lateSync()) });
