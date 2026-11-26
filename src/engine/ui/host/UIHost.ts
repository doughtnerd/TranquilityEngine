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
 *   `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`…), at the same point in the frame
 *   UI document handlers run: right after UI input routing, before behaviors' `update`. ADR 0422: they travel
 *   through the element's ancestors in capture, target and bubble phases; one that bubbles out of the tree's canvas
 *   unstopped goes on to the renderer (`onUIHostBubbleOut`: Svelte's body, document and window).
 * - The editor finds the hosted element of a picked component with `uiHostElementOf`, with the template
 *   location it was made from (`source`), and follows changes with `onUIHostChanged`.
 * - Geometry and played keyframes (ADR 0419, for Svelte's transitions and `animate:`): reading an element's box
 *   (`layoutNow`, then `bounds`) lays the UI out first when something changed, as reading layout does in the DOM;
 *   `computedStyle` gives its values as CSS text; `animate` plays keyframes on the UI animator (ADR 0418 wave 4).
 *
 * UI components are made only here and by UI document builds (ADR 0417, amended by 0419).
 */
import { Color, Vector2 } from "../../core/math";
import { defineBuiltinSystem } from "../../core/systems";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { Locale } from "../../localisation/Locale";
import { UIButton, UICanvas, UIInputField, UIText, isFocusableUI, type UIComponentType } from "../components";
import { clickUI, setUIValue, uiValueOf } from "../formControls";
import { samePseudoState, uiPseudoState, uiTypeOfTag } from "../elementKinds";
import { uiInteractions } from "../interactions";
import { boundsOf, transformRect } from "../transform2d";
import { filterStepsOf, filterText, type UIFilterFields } from "../filters";
import type { MarkupAttribute, MarkupElement, ResolvedValue, Selector, StyleTarget, UIMediaEnvironment, UIPseudo, UIPseudoState, UIStylesheet, UITag } from "../document/types";
import type { UIAnimationSpec, UITransitionSpec } from "../document/animationValues";
import { takeUIAnimationEvents, uiAnimating, uiAnimationOwnerGone, uiAnimator, type UIAnimationEvent, type UIAnimationStop, type UIPlayback, type UIPlayHooks, type UIResolvedAnimation, type UIResolvedTransition, type UIStyleWrite } from "../animation/UIAnimator";
import { addUIEventFrontEnd, addUIListener, propagate, removeUIListener, runUIListeners, uiEventBubbles, uiEventCancelable, UIEventBase, uiListenerOptions, type UIEventRecord, type UIListener } from "../events";
import { uiScrollIntoViewArg, uiScrollSizes, uiScrollToArgs, isScrollable, type UIScrollIntoViewOptions, type UIScrollToArgs } from "../scrolling";

type Cascade = typeof import("./hostSupport");
type ComponentClass = new () => UIComponentType;

let cascade: Cascade | null = null;
let loading: Promise<Cascade> | null = null;

/**
 * Load the cascade (ADR 0419: without the CSS parser, since components' styles arrive parsed). Trees can
 * be made once it resolves.
 */
export function loadUIHostSupport(): Promise<void> {
  if (cascade) return Promise.resolve();
  loading ??= import("./hostSupport").then(
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
/** Structural pseudo-classes or sibling combinators (ADR 0418 wave 5): tree changes restyle siblings. */
let sheetsUseStructure = false;
/** `@media` rules (ADR 0418 wave 5): a canvas size change restyles the tree. */
let sheetsUseMedia = false;

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
  sheetsUseStructure = P.usesStructure(sheets);
  sheetsUseMedia = P.usesMedia(sheets);
  return sheets;
}

const warned = new Set<string>();
/** What `UIHostElement.animate` warned about, by tag, property and reason. */
const animateWarned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  warn(message);
}

// --- Events ---------------------------------------------------------------------------------------

export type UIHostEventType =
  | "click" | "input" | "change" | "submit" | "focus" | "blur" | "pointerenter" | "pointerleave"
  | "transitionend" | "animationstart" | "animationiteration" | "animationend"
  // ADR 0422: the DOM's pointer, keyboard, focus and drag events; ADR 0423: scrolling.
  | "dblclick" | "contextmenu" | "pointerdown" | "pointerup" | "pointermove" | "pointerover" | "pointerout" | "pointercancel"
  | "wheel" | "keydown" | "keyup" | "focusin" | "focusout" | "scroll" | "scrollend"
  | "dragstart" | "drag" | "dragenter" | "dragover" | "dragleave" | "drop" | "dragend"
  // ADR 0424: a form's reset.
  | "reset";

/**
 * A UI event on a hosted element (ADR 0419): what an `onclick`, `oninput`… handler gets. ADR 0422: the DOM's
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
  /** `transitionend` (ADR 0418 wave 4): the property whose transition finished (kebab-case); "" otherwise. */
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
    /** ADR 0422: the record it comes from (pointer and key data; `preventDefault` cancels its default action). */
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

  /** The list item a row is for: always undefined (Svelte's `{#each}` closes over its item). Kept for UI document handlers' shape. */
  get item(): undefined {
    return undefined;
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
  state: UIPseudoState;
  parent: MutableTarget | null;
  lang: string;
  media: UIMediaEnvironment | null;
}

/**
 * An element's style target. Its attributes (as the renderer wrote them), child elements and text are read when a
 * selector asks (ADR 0418 wave 5), so they're always the element's current ones.
 */
function targetOf(el: UIHostElement, tag: string, parent: MutableTarget | null): MutableTarget {
  return {
    tag,
    id: null,
    classes: [],
    state: { hover: false, pressed: false, focus: false, disabled: false },
    parent,
    lang: Locale.language,
    media: null,
    get attributes() {
      return el._written;
    },
    get children() {
      return el._childTargets();
    },
    get content() {
      return el._hasContent();
    },
  };
}

/** Attributes that are content, written straight to their field (never converted as style, so typed text stays as typed). */
const CONTENT_ATTRIBUTES: Readonly<Partial<Record<UITag, readonly string[]>>> = {
  InputField: ["value", "placeholder"],
  Text: ["text"],
  // ADR 0424: what the player changes, written only when the attribute does (so a toggle or a drag stays until then).
  TextArea: ["value", "placeholder"],
  Toggle: ["checked", "indeterminate"],
  Radio: ["checked"],
  Slider: ["value"],
  Select: ["value"],
  Option: ["selected"],
};

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
  /** @internal */ _listeners = new Map<UIHostEventType, UIListener<UIHostListener>[]>();
  /** @internal The field's value changed since the last `change` event. */ _edited = false;
  /** @internal Content attributes last written (`CONTENT_ATTRIBUTES`). */ _content = new Map<string, string>();
  /** @internal Styled at least once (a first style starts no transitions, ADR 0418 wave 4). */ _styled = false;
  /** @internal The attributes as written, which attribute selectors match (ADR 0418 wave 5). */ _written: ReadonlyMap<string, string> = new Map();
  /** @internal Its child elements' targets, until its children change. */ _childTargetList: MutableTarget[] | null = null;

  /** @internal Its child elements' style targets, in order (text labels aren't elements). */
  _childTargets(): MutableTarget[] {
    return (this._childTargetList ??= this._children.filter((c) => !c.synthetic && c._alive).map((c) => c._target));
  }

  /** @internal It has text: a text element's own, or text beside its children (a label made from it). */
  _hasContent(): boolean {
    if (this._comp instanceof UIText && this._comp.text !== "") return true;
    return this._children.some((c) => c.synthetic && c._alive);
  }

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

  /** Input fields: their text (ADR 0424: any control's value as text, as the DOM's `value`); null for other elements. Setting it isn't a player change (no events). */
  get value(): string | null {
    return uiValueOf(this._comp);
  }

  set value(value: string) {
    setUIValue(this._comp, value);
  }

  /**
   * The DOM's `click()`: a bubbling `click` dispatched now with HTML's activation (a checkbox toggles before its
   * handlers and back if one prevents it, a submit button submits its form), whose `input`, `change` or `submit` follow
   * at once. Nothing on a control that isn't interactable.
   */
  click(): void {
    clickUI(this.tree.world, this._comp);
  }

  /** Give it focus (buttons, input fields and ADR 0424's controls; an input field starts typing, as a click does). */
  focus(): void {
    const c = this._comp;
    if (isFocusableUI(c)) c.focused = true;
  }

  /** Take its focus away. */
  blur(): void {
    const c = this._comp;
    if (isFocusableUI(c) && c.focused) c.focused = false;
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
   * (ADR 0418 wave 3), as the axis-aligned rectangle around it, not cut down by clips (as the DOM's
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
   * Its values as CSS text by camel-case property, as the DOM's `getComputedStyle` gives them (ADR 0419: what Svelte's
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
    // ADR 0426: the full matrix, applied after the three.
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
      // ADR 0426: the filter fields as CSS (their fixed order); SVG stroke properties belong to SVG shapes, not elements.
      filter: filterText(filterStepsOf(c as Partial<UIFilterFields>)),
      zoom: "1",
      strokeLinecap: "butt",
      strokeWidth: "1px",
    };
  }

  /**
   * Play keyframes on it (ADR 0419: a Svelte transition's or `animate:`'s, through the renderer's `animate` hook) on the
   * UI animator (ADR 0418 wave 4: the tween backend, on unscaled time): each keyframe is CSS declarations by property
   * (camel or kebab case), evenly spaced over `duration` seconds, and the last one's values stay until `stop()`. Values
   * convert as a stylesheet's do (its variables included); a declaration it can't animate is warned about once and
   * left out. `hooks.onFrame` runs each frame it plays, `hooks.onEnd` once at its end.
   */
  animate(keyframes: readonly Readonly<Record<string, string>>[], duration: number, hooks: UIPlayHooks): UIPlayback {
    const P = requireCascade();
    const type = this._comp.constructor as ComponentClass;
    const fields = P.fieldsOf(type);
    const vars = new Map<string, string>();
    for (const [k, v] of this._resolved) if (k.startsWith("--")) vars.set(k, String(v.value));
    const file = this.source?.file ?? this.tree.file;
    const tracks = new Map<string, UIAnimationStop[]>();
    const n = keyframes.length;
    keyframes.forEach((frame, i) => {
      const offset = n === 1 ? 1 : i / (n - 1);
      for (const [property, value] of Object.entries(frame)) {
        if (value === undefined || value === null || String(value).trim() === "") continue;
        const name = property === "cssFloat" ? "float" : property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
        const raw = P.substituteVars(String(value), vars);
        const values = raw === undefined ? "uses a variable that isn't defined." : P.keyframeValues(P.propertyField(name), raw, fields, file);
        if (typeof values === "string") {
          const later = /^backdrop-filter$/.test(name) ? " backdrop-filter isn't supported (ADR 0426); the rest of the animation runs." : /^stroke|^fill/.test(name) ? " SVG paint applies to shapes inside an <svg> (ADR 0426); the rest of the animation runs." : "";
          // Once per tag, property and reason (a transition's keyframes hold a new value each frame).
          const key = `${this.tag}|${name}|${values}`;
          if (!animateWarned.has(key)) {
            animateWarned.add(key);
            warn(`<${this.tag}> can't animate ${name}: "${raw ?? value}" ${values}${later}`);
          }
          continue;
        }
        for (const [field, v] of values) {
          let list = tracks.get(field);
          if (!list) tracks.set(field, (list = []));
          const stop = { offset, value: P.cloneValue(v), timing: null };
          if (list.length && list[list.length - 1].offset === offset) list[list.length - 1] = stop;
          else list.push(stop);
        }
      }
    });
    return uiAnimator(this.tree.world).play(
      { owner: this.tree, element: this, comp: this._comp, fields, animate: this._alive && !this.tree.world.inEditMode(this._node.entity) },
      "transition",
      tracks,
      duration,
      hooks,
    );
  }

  /**
   * Listen to a UI event (`click`, `input`, `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`, and
   * ADR 0422's pointer, key, focus and drag events, ADR 0423's `scroll`/`scrollend`), or to stylesheet animation (ADR
   * 0418 wave 4: `transitionend`, `animationstart`, `animationiteration`, `animationend`, the frame after they
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
   * target and bubble phases (ADR 0422); one that bubbles out of the canvas unstopped goes on to `onUIHostBubbleOut`.
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

  // --- Scrolling (ADR 0423) ---------------------------------------------------------------------

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
    const t = this._target;
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
 * ADR 0422: call `hook` after every event dispatched in a hosted tree, with the tree. A renderer carries on the ones that
 * bubble and weren't stopped past its view's root (Svelte's `<svelte:body>`, `<svelte:document>`, `<svelte:window>`),
 * and notes the types its UI dispatched. Returns a function that stops it.
 */
export function onUIHostBubbleOut(hook: (event: UIHostEvent, tree: UIHostTree) => void): () => void {
  bubbleOutHooks.add(hook);
  return () => bubbleOutHooks.delete(hook);
}

const editHooks = new Set<(el: UIHostElement) => void>();

/**
 * ADR 0425: call `hook` with an editable text element the player edited (the UI core wrote the edit into its runs'
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
 * 0418 wave 5) and `scale`, the drawing canvas's CSS pixels per UI pixel. Null before a layout, or without a tree.
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
  /**
   * Elements made since styles were last resolved (a late sync, or `layoutNow` reading layout) when the sheets use
   * structural selectors: restyling them for the siblings made after them starts no transitions (they're new). Once
   * styles are resolved they're settled, as an element's are in the DOM once its style has been read.
   */
  private readonly fresh = new Set<UIHostElement>();
  /** The next late sync restyles for the canvas's first known size: nothing transitions (ADR 0418 wave 5). */
  private firstMedia = false;

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
    root._target = targetOf(root, "Canvas", null);
    root._target.media = this.canvasSize(root._comp);
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
   * last). `attributes` are as written: fields in kebab-case, `id`, `class`, `style`. `written` is every attribute as
   * the author wrote it (HTML-only ones too, `data-*`, `type`), which attribute selectors match (ADR 0418 wave 5);
   * absent: `attributes`. Not styled yet: call `restyle` on the top of a subtree once it's made.
   */
  create(tag: string, uiTag: UITag, parent: UIHostElement | null, before: UIHostElement | null, attributes: ReadonlyMap<string, string>, options: { source?: UIHostSource | null; synthetic?: boolean; written?: ReadonlyMap<string, string> } = {}): UIHostElement {
    const p = parent ?? this.root;
    const el = new UIHostElement(this, tag, uiTag, options.source ?? null, options.synthetic ?? false);
    el._node = this.world._createNode(attributes.get("id") || tag, p._node.entity);
    // The host is the second maker of UI components (ADR 0417 as amended by 0419): `addComponent` still refuses them.
    el._comp = this.world._addComponent(el._node.entity, uiTypeOfTag(uiTag));
    // ADR 0425: text the renderer made between a text element's inline children: a run of it, not an element.
    if (el.synthetic && el._comp instanceof UIText && p._comp instanceof UIText) el._comp._textPiece = true;
    el._parent = p;
    el._target = targetOf(el, tag, p._target);
    this.applyAttributes(el, attributes, options.written);
    elementByComponent.set(el._comp, el);
    this.place(el, p, before);
    if (sheetsUseStructure) this.fresh.add(el);
    this.childrenChanged(p);
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
    this.applyAttributes(el, attributes, written);
    this.dirty.add(sheetsUseStructure && el._parent ? el._parent : el);
    hostVersion++;
  }

  /** Write a Text's text (or an input field's value): content, never style. */
  setText(el: UIHostElement, text: string): void {
    if (!el._alive) return;
    const c = el._comp;
    if (c instanceof UIText) {
      if (sheetsUseStructure && (c.text === "") !== (text === "")) this.dirty.add(el); // `:empty`
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
      el._target.parent = p._target;
      this.dirty.add(el); // descendant selectors may match differently
      this.childrenChanged(from);
    }
    this.place(el, p, before);
    this.childrenChanged(p);
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
    walk(el, (e) => {
      e._alive = false;
      e._listeners.clear();
      this.dirty.delete(e);
      this.fresh.delete(e);
    });
    if (parent) this.childrenChanged(parent);
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
    hostSheets();
    this.resolve(el);
    hostVersion++;
  }

  /**
   * Lay the UI out now, as reading geometry does in the DOM (ADR 0419: `getBoundingClientRect` and the renderer's
   * `measure` hook, which Svelte's transitions and `animate:` read right after changing the tree): pending restyles run,
   * then the UI core that lays this World out (its pointer router) lays it out again. Nothing happens when no hosted
   * tree changed since the last time in this frame, or when nothing lays the World out (a headless World).
   */
  layoutNow(): void {
    if (!this.isValid) return;
    hostSheets();
    this.resolveDirty();
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
    uiAnimationOwnerGone(this.world, this);
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

  /**
   * @internal ADR 0422: one of the frame's records on an element of this tree, as the DOM events it is: a field's
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
        // A field's typing is `input`, and `change` once committed; another control's change (ADR 0424) is itself.
        if (!field) {
          types.push("change");
          break;
        }
        el._edited = true;
        types.push("input");
        break;
      case "submit":
        if (!field) {
          types.push("submit"); // ADR 0424: a form's
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
    // ADR 0425: an editable text's edit: the renderer brings its nodes up to date before anyone hears `input`.
    if (r.type === "input" && el._comp instanceof UIText) for (const hook of editHooks) hook(el);
    let related = r.data.related ? uiHostElementOf(r.data.related) : null;
    while (related?.synthetic && related._parent) related = related._parent;
    for (const type of types) {
      if (!el._alive) return;
      el.dispatch(new UIHostEvent(type, el, undefined, type === r.type ? r : null, related));
    }
  }

  /** @internal After UI input routing and the frame's event records, before behaviors' update: last frame's transition and animation events (ADR 0418 wave 4), on their targets. */
  _collectEvents(): void {
    if (!this.isValid || this.world.inEditMode(this.root._node.entity)) return;
    for (const { element, event } of takeUIAnimationEvents(this.world, this)) {
      const el = element as UIHostElement;
      if (el._alive && (el._listeners.get(event.type)?.length ?? 0) > 0) el.dispatch(new UIHostEvent(event.type, el, event));
    }
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
    // ADR 0418 wave 5: `@media` rules match again when the canvas (last frame's layout) changes size.
    const size = this.canvasSize();
    const was = this.root._target.media;
    if (size && (!was || was.width !== size.width || was.height !== size.height)) {
      this.root._target.media = size;
      if (sheetsUseMedia) {
        this.dirty.add(this.root);
        if (!was) this.firstMedia = true; // the view's first size isn't a change to animate
      }
    }
    walk(this.root, (el) => {
      const state = uiPseudoState(el._comp);
      const s = el._target.state;
      if (!samePseudoState(state, s)) {
        el._target.state = state;
        if (sheetsUsePseudo) this.dirty.add(el);
      }
    });
    this.resolveDirty();
    this.firstMedia = false;
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

  /** Restyle the elements changed since the last restyle (a subtree once, from its top); new elements are settled after. */
  private resolveDirty(): void {
    if (!this.dirty.size) {
      this.fresh.clear();
      return;
    }
    const dirty = [...this.dirty].filter((e) => e._alive);
    this.dirty.clear();
    const set = new Set(dirty);
    for (const el of dirty) {
      let covered = false;
      for (let p = el._parent; p && !covered; p = p._parent) covered = set.has(p);
      if (!covered) this.resolve(el);
    }
    this.fresh.clear();
    hostVersion++;
  }

  private selectors(selector: string): readonly Selector[] {
    let cached = this.selectorCache.get(selector);
    if (!cached) {
      try {
        cached = requireCascade().parseSelectorQuery(selector);
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

  /** `parent`'s children were added, removed or reordered: with structural selectors, it restyles with them (ADR 0418 wave 5). */
  private childrenChanged(parent: UIHostElement): void {
    parent._childTargetList = null;
    if (sheetsUseStructure && parent._alive) this.dirty.add(parent);
  }

  /** The canvas's size in UI pixels at the World's last layout, which `@media` matches (null before one). */
  private canvasSize(canvas: UIComponentType = this.root._comp): UIMediaEnvironment | null {
    const c = uiInteractions(this.world).layout?.canvases().find((l) => l.comp === canvas);
    return c ? { width: c.width, height: c.height } : null;
  }

  private applyAttributes(el: UIHostElement, attributes: ReadonlyMap<string, string>, written?: ReadonlyMap<string, string>): void {
    el._attributes = attributes;
    el._written = written ?? attributes;
    el._target.id = attributes.get("id") || null;
    el._target.classes = (attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
    const comp = el._comp as unknown as Record<string, unknown>;
    for (const name of CONTENT_ATTRIBUTES[el.uiTag] ?? []) {
      const value = attributes.get(name);
      const before = el._content.get(name);
      // Written when the attribute changes, so a player's typing stays until the component sets the attribute again.
      if (value !== undefined && value !== before) comp[name] = contentValue(comp[name], value);
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
    const writes: UIStyleWrite[] = [];
    const write = (name: string, value: unknown) => {
      writes.push({ field: name, before: comp[name], after: value });
      comp[name] = value;
    };
    for (const [name, rv] of resolved) {
      if (name.startsWith("--") || content.has(name) || !fields.has(name)) continue;
      next.add(name);
      const prev = el._resolved.get(name);
      if (prev && el._applied.has(name) && prev.source === rv.source && sameValue(prev.value, rv.value)) continue;
      write(name, P.cloneValue(rv.value));
    }
    for (const name of el._applied) if (!next.has(name)) write(name, defaultOf(type, name));
    // Transitions and keyframe animations (ADR 0418 wave 4): the animator takes what changed from here.
    const transitions = resolved.get(P.TRANSITION_KEY)?.value as readonly UITransitionSpec[] | undefined;
    const animations = resolved.get(P.ANIMATION_KEY)?.value as readonly UIAnimationSpec[] | undefined;
    const first = !el._styled || this.fresh.has(el) || this.firstMedia;
    el._styled = true;
    if (transitions?.length || animations?.length || uiAnimating(this.world, el._comp)) {
      uiAnimator(this.world).styled(
        { owner: this, element: el, comp: el._comp, fields, animate: !this.world.inEditMode(el._node.entity) },
        writes,
        first,
        transitions?.map((spec): UIResolvedTransition => ({ spec, fields: P.transitionFields(spec.property, fields) })) ?? null,
        animations?.map((spec): UIResolvedAnimation => ({ spec, tracks: () => P.keyframeTracks(sheets, spec.name, type, resolved, el._markup.file, warn) })) ?? null,
      );
    }
    // A button's hover and pressed colours come from `:hover` / `:pressed` backgrounds, so the drawing shows them.
    if (sheetsUsePseudo && el._comp instanceof UIButton) {
      // The target itself, in another state for a moment: its siblings know it by identity (structural selectors).
      const at = (state: Partial<Record<UIPseudo, boolean>>) => {
        const saved = el._target.state;
        el._target.state = { ...saved, hover: false, pressed: false, ...state };
        try {
          return P.resolveStyle(el._target, el._markup, type, sheets, parentResolved, () => {}).get("backgroundColor");
        } finally {
          el._target.state = saved;
        }
      };
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

/**
 * A content attribute's text as its field's value, by the field's current type (ADR 0424): a boolean is true unless
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

// ADR 0422: the frame's event records on hosted elements go to their tree.
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

// Right after UI input routing and the UI documents' handlers, before behaviors' update.
defineBuiltinSystem({ name: "engine.UIHostEvents", phase: "update", after: ["engine.Lobby", "engine.PredictionSmooth", "engine.UIDocumentEvents"], before: ["engine.UpdateScripts"], run: (w) => treesOf(w).forEach((t) => t._collectEvents()) });
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
defineBuiltinSystem({ name: "engine.UIHostFlush", phase: "lateUpdate", after: ["engine.LateUpdateScripts"], before: ["engine.UIDocumentSync"], run: (w) => treesOf(w).forEach((t) => t._flush()) });
// Then restyles, so the flushed changes show this frame.
defineBuiltinSystem({ name: "engine.UIHostSync", phase: "lateUpdate", after: ["engine.UIHostFlush"], run: (w) => treesOf(w).forEach((t) => t._lateSync()) });
