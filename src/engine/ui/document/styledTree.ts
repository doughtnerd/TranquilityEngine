/**
 * The styled tree (ADR 0438): everything that keeps a hosted UI tree's elements styled by the registered stylesheets.
 * The UI host (`host/UIHost.ts`, ADR 0423) keeps the DOM-like tree, its events and geometry, and tells the styled tree
 * what happened; the styled tree decides what restyles, resolves it through the cascade (`cascade.ts`) and writes it.
 *
 * - **Calls in.** An element was attached (made), inserted, detached (moved away) or removed; its attributes or its text's
 *   emptiness changed; restyle a subtree now (`restyle`), restyle what's pending (`restylePending`, before geometry is
 *   read), or the frame's late sync (`sync`): the environment (stylesheets, locale, UI preferences, canvas size and
 *   viewport) and every element's pseudo-state are checked there.
 * - **Out.** Field writes on the elements' components (transitions and keyframe animations through the UI animator, with
 *   this tree as the animator's owner), node references by element id (ADR 0340), part styles (`setUIPartStyles`), the
 *   paint states an element's rules name (`UIPanel._styledStates`, ADR 0437), and the generated `::before`/`::after`
 *   elements (ADR 0432), which the host makes and destroys when asked (`UIStyledTreeHost`).
 * - **Invalidation.** What the sheets use (pseudo-classes, `:lang()`, structural selectors, `@media`, viewport lengths,
 *   `:has()`, pseudo-elements) is a property of the sheet set (`UISheetSet`), which each tree picks up as it restyles, so
 *   a change restyles only what it can affect: a pseudo-state change the element, a tree change its siblings with
 *   structural selectors, a change inside a `:has()` anchor the anchor (`hasDirty`), alone unless what it passes on changed.
 *
 * Loaded on demand with the cascade (no CSS parser behind it: components' styles arrive as parsed rule data, ADR 0423).
 * Internal to the UI host.
 */
import { Color, Vector2 } from "../../core/math";
import type { FieldInfo } from "../../core/registry";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { Locale } from "../../localisation/Locale";
import { uiPreferencesVersion } from "../preferences";
import { UIInputField, UIPanel, UIText, type UICanvas, type UIComponentType } from "../components";
import { setUIPartStyles, type UIPartStyle } from "../formParts";
import { generatesPseudoElements, samePseudoState, uiContentAttributes, uiPartElements, uiPseudoState } from "../elementKinds";
import { uiInteractions } from "../interactions";
import type { UIPaintState, UIStyledStates } from "../paint";
import {
  takeUIAnimationEvents,
  uiAnimatedField,
  uiAnimating,
  uiAnimationOwnerGone,
  uiAnimator,
  type UIAnimationEvent,
  type UIAnimationStop,
  type UIPlayback,
  type UIPlayHooks,
  type UIResolvedAnimation,
  type UIResolvedTransition,
  type UIStyleWrite,
} from "../animation/UIAnimator";
import type { UIAnimationSpec, UITransitionSpec } from "./animationValues";
import {
  ANIMATION_KEY,
  CONTENT_KEY,
  INHERITED_FIELDS,
  TEXT_PIECE_TAG,
  TRANSITION_KEY,
  UNITS_KEY,
  cloneValue,
  couldAnchorHas,
  fieldsOf,
  hasUse,
  keyframeTracks,
  keyframeValues,
  matchSelector,
  parseColor,
  passedOnFields,
  passedOnValue,
  propertyField,
  pseudoElementsUsed,
  referenceField,
  resolveStyle,
  substituteVars,
  transitionFields,
  unitsOf,
  usesLang,
  usesMedia,
  usesPseudo,
  usesStructure,
  usesViewportUnits,
  withElementUnits,
  type UIElementUnits,
  type UIHasUse,
} from "./cascade";
import { parseSelectorQuery } from "./selectorQuery";
import { hasViewportUnits } from "./cssMath";
import { contentText, type UIContentPiece } from "./contentValue";
import type { MarkupAttribute, MarkupElement, ResolvedValue, Selector, StyleTarget, UIMediaEnvironment, UIPseudoElement, UIPseudoState, UIStylesheet, UITag } from "./types";

type ComponentClass = new () => UIComponentType;

function warn(message: string): void {
  console.warn(`[myco] ${message}`);
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  warn(message);
}

// --- Sheets -----------------------------------------------------------------------------------------

/** The registered stylesheets as their registry holds them (the UI host's `setUIHostStyles`): live, `version` counting changes. */
export interface UISheetSource {
  readonly version: number;
  readonly files: ReadonlyMap<string, UIStylesheet>;
}

/** One version of the registered sheets, with cascade order across them and what they use (what can make an element restyle). */
interface UISheetSet {
  readonly version: number;
  readonly sheets: readonly UIStylesheet[];
  readonly usePseudo: boolean;
  readonly useLang: boolean;
  /** Structural pseudo-classes or sibling combinators (ADR 0422 wave 5): tree changes restyle siblings. */
  readonly useStructure: boolean;
  /** `@media` rules (ADR 0422 wave 5): a canvas size or preferences change restyles the tree. */
  readonly useMedia: boolean;
  /** ADR 0432: viewport lengths (`50vw`): a canvas size change restyles the tree. */
  readonly useViewport: boolean;
  /** ADR 0432: how the sheets use `:has()` (null: they don't), so changes inside the tree restyle the elements it may match. */
  readonly has: UIHasUse | null;
  /** ADR 0432: the pseudo-elements the sheets style (`::before`, `::placeholder`, form parts…). */
  readonly pseudoElements: ReadonlySet<UIPseudoElement>;
}

const sheetSets = new WeakMap<UISheetSource, UISheetSet>();

/** The sheet set of `source`'s current version (made once per version, shared by every tree styled from it). */
function sheetSetOf(source: UISheetSource): UISheetSet {
  const known = sheetSets.get(source);
  if (known && known.version === source.version) return known;
  let order = 0;
  const sheets: UIStylesheet[] = [];
  for (const [file, css] of source.files) {
    const sheet = { ...css, file, rules: css.rules.map((r, i) => ({ ...r, order: order + i })) };
    order += sheet.rules.length;
    for (const p of sheet.problems) warnOnce(p.message);
    sheets.push(sheet);
  }
  const set: UISheetSet = {
    version: source.version,
    sheets,
    usePseudo: usesPseudo(sheets),
    useLang: usesLang(sheets),
    useStructure: usesStructure(sheets),
    useMedia: usesMedia(sheets),
    useViewport: usesViewportUnits(sheets),
    has: hasUse(sheets),
    pseudoElements: pseudoElementsUsed(sheets),
  };
  sheetSets.set(source, set);
  return set;
}

// --- Selectors --------------------------------------------------------------------------------------

const selectorLists = new Map<string, readonly Selector[]>();

function selectorList(selector: string, cache: Map<string, readonly Selector[]>, anyTag: boolean): readonly Selector[] {
  let list = cache.get(selector);
  if (!list) {
    try {
      list = parseSelectorQuery(selector, anyTag ? { anyTag: true } : undefined);
    } catch (err) {
      throw new Error(`Bad selector "${selector}": ${(err as Error).message}.`);
    }
    cache.set(selector, list);
  }
  return list;
}

/**
 * Whether `target` matches a selector list in the cascade's grammar (ADR 0422 wave 5), any tag allowed, as `UIView.query`
 * reads it: what a renderer's own nodes answer `querySelector`, `matches` and `closest` with. Throws for a selector
 * outside that grammar.
 */
export function matchesSelector(selector: string, target: StyleTarget): boolean {
  return selectorList(selector, selectorLists, true).some((s) => matchSelector(s, target));
}

// --- Elements ---------------------------------------------------------------------------------------

/** What the styled tree reads of a hosted element: the UI host's elements are these. */
export interface UIStyledNode<E extends UIStyledNode<E>> {
  /** The tag as written (`div`), which selectors match. */
  readonly tag: string;
  readonly uiTag: UITag;
  /** Made by the renderer (a text's label) or the styled tree (a generated element), not written. */
  readonly synthetic: boolean;
  /** Where it was written: relative asset paths in its attributes resolve against `source.file`. */
  readonly source: { readonly file: string } | null;
  readonly node: GameObject;
  readonly component: UIComponentType;
  readonly parent: E | null;
  /** Its child elements, in order (a generated box's: its label). */
  readonly children: readonly E[];
  /** Its attributes as last set (for node references). */
  readonly attributes: ReadonlyMap<string, string>;
  readonly _alive: boolean;
  /** Its style state: set by the styled tree (`attach`, or when it makes a generated element), read by the host. */
  _style: UIElementStyle<E>;
}

interface MutableTarget extends StyleTarget {
  id: string | null;
  classes: string[];
  state: UIPseudoState;
  parent: MutableTarget | null;
  lang: string;
  media: UIMediaEnvironment | null;
  viewport: UIMediaEnvironment | null;
}

/**
 * One element's style state, kept by the styled tree. The host reads its target (id, classes, pseudo-state), the
 * resolved style and its generated elements, and offers the target and the resolved style to callers outside the UI
 * module (`UIHostElement.styleTarget` and `resolvedStyle`: a renderer's selector matching, the editor's field sources);
 * everything else is the styled tree's.
 */
export class UIElementStyle<E extends UIStyledNode<E>> {
  /** What selectors match: its attributes, child elements and text are read when a selector asks (ADR 0422 wave 5). */
  readonly target: MutableTarget;
  /** @internal What the cascade reads attributes from (ADR 0077 §2: attributes beat rules; an inline style beats attributes). */ markup: MarkupElement;
  /** Its resolved style by field (variables, `UNITS_KEY` and other keys included). */
  resolved: ReadonlyMap<string, ResolvedValue> = new Map();
  /** @internal The fields the cascade set last. */ applied: ReadonlySet<string> = new Set();
  /** @internal Styled at least once (a first style starts no transitions, ADR 0422 wave 4). */ styled = false;
  /** @internal The attributes as written, which attribute selectors match (ADR 0422 wave 5). */ written: ReadonlyMap<string, string> = new Map();
  /** @internal Its child elements' targets, until its children change. */ childTargets: MutableTarget[] | null = null;
  /** ADR 0432: the pseudo-element this generated element is, or null. */
  readonly pseudo: "before" | "after" | null;
  /** ADR 0432: its generated `::before` and `::after`: nodes under its node (first and last), not among its children. */
  before: E | null = null;
  after: E | null = null;
  /** @internal ADR 0432: the part styles its form part pseudo-elements gave it last (null: none). */ parts: Partial<Record<UIPseudoElement, UIPartStyle>> | null = null;

  constructor(target: MutableTarget, markup: MarkupElement, pseudo: "before" | "after" | null = null) {
    this.target = target;
    this.markup = markup;
    this.pseudo = pseudo;
  }
}

/** An element's style target, whose attributes, children and content are always the element's current ones. */
function targetOf<E extends UIStyledNode<E>>(el: E, tag: string, parent: MutableTarget | null): MutableTarget {
  return {
    tag,
    id: null,
    classes: [],
    state: { hover: false, pressed: false, focus: false, disabled: false },
    parent,
    lang: Locale.language,
    media: null,
    viewport: null,
    get attributes() {
      return el._style.written;
    },
    get children() {
      return (el._style.childTargets ??= el.children.filter((c) => !c.synthetic && c._alive).map((c) => c._style.target));
    },
    get content() {
      // It has text: a text element's own, or text beside its children (a label made from it).
      if (el.component instanceof UIText && el.component.text !== "") return true;
      return el.children.some((c) => c.synthetic && c._alive);
    },
  };
}

/** ADR 0432: a pseudo-element's style target: matched through its originating element (`parent`). */
function pseudoTarget(origin: MutableTarget, which: UIPseudoElement): MutableTarget {
  return {
    tag: `::${which}`,
    id: null,
    classes: [],
    state: { hover: false, pressed: false, focus: false, disabled: false },
    parent: origin,
    lang: origin.lang,
    media: null,
    viewport: null,
    pseudoElement: which,
    children: [],
  } as MutableTarget;
}

/** An attribute as written (`attr()` in `content`, ADR 0432), by name in any case. */
function writtenAttribute(written: ReadonlyMap<string, string>, name: string): string | undefined {
  const v = written.get(name);
  if (v !== undefined) return v;
  for (const [k, w] of written) if (k.toLowerCase() === name) return w;
  return undefined;
}

const ZERO = { start: 0, end: 0 };

/** What the cascade reads attributes from (ADR 0077 §2: attributes beat rules; an inline style beats attributes). */
function markupOf(uiTag: UITag, attributes: ReadonlyMap<string, string>, file: string): MarkupElement {
  const attrs: MarkupAttribute[] = [];
  const content = uiContentAttributes(uiTag);
  for (const [name, value] of attributes) {
    if (name === "style" || content.includes(name)) continue;
    attrs.push({ name, value, span: ZERO, valueSpan: ZERO });
  }
  const style = attributes.get("style");
  if (style) {
    for (const decl of splitDeclarations(style)) attrs.push({ name: decl.name, value: decl.value, span: ZERO, valueSpan: ZERO });
  }
  return { tag: uiTag, attributes: attrs, file };
}

/** Whether attributes name another element by id (`nav-up`, `first-selected`…, ADR 0340): a cheap name test first, as attributes change often. */
function hasReferenceAttribute(attributes: ReadonlyMap<string, string>): boolean {
  for (const name of attributes.keys()) {
    const n = name.charCodeAt(0);
    if ((n === 110 || n === 102) && referenceField({ name } as MarkupAttribute) !== null) return true; // "n…", "f…"
  }
  return false;
}

// --- Values -----------------------------------------------------------------------------------------

/**
 * A component class's default value of `field` (a copy for colours and vectors): what a field the cascade stops setting,
 * or a content attribute that went (ADR 0428), goes back to.
 */
const defaults = new Map<ComponentClass, UIComponentType>();
export function defaultFieldValue(type: ComponentClass, field: string): unknown {
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

/** ADR 0432: whether two resolved maps pass the same on to children: variables, inherited fields and relative-length units. */
function passesOnSame(a: ReadonlyMap<string, ResolvedValue>, b: ReadonlyMap<string, ResolvedValue>): boolean {
  const passed = (k: string) => k.startsWith("--") || INHERITED_FIELDS.has(k) || k === UNITS_KEY;
  let count = 0;
  for (const [k, v] of a) {
    if (!passed(k)) continue;
    count++;
    const w = b.get(k);
    if (!w) return false;
    if (k === UNITS_KEY) {
      const x = v.value as UIElementUnits, y = w.value as UIElementUnits;
      if (x.em !== y.em || x.rem !== y.rem || x.parentEm !== y.parentEm || x.viewport?.width !== y.viewport?.width || x.viewport?.height !== y.viewport?.height) return false;
    } else if (!sameValue(v.value, w.value)) return false;
  }
  for (const k of b.keys()) if (passed(k)) count--;
  return count === 0;
}

const animatedFields = new Map<ComponentClass, { readonly fields: ReadonlyMap<string, FieldInfo>; readonly virtual: ReadonlySet<string> }>();
/** ADR 0432: a component's fields with the inherited ones it only passes on, which the animator animates for its children. */
function animatedFieldsOf(type: ComponentClass, fields: ReadonlyMap<string, FieldInfo>, passed: ReadonlyMap<string, FieldInfo>) {
  let a = animatedFields.get(type);
  if (!a) animatedFields.set(type, (a = { fields: new Map([...fields, ...passed]), virtual: new Set(passed.keys()) }));
  return a;
}

const NO_STATES: readonly UIPaintState[] = [];
const PAINT_STATES: ReadonlySet<string> = new Set<UIPaintState>(["hover", "pressed", "focus"]);

/**
 * ADR 0437: the paint states its rule for `field` states the look for (named by a selector of it that matches it now,
 * `statesNamed`); null when neither rule names any.
 */
function styledStatesOf(target: StyleTarget, resolved: ReadonlyMap<string, ResolvedValue>): UIStyledStates | null {
  const named = (field: string): readonly UIPaintState[] => {
    const source = resolved.get(field)?.source;
    if (source?.kind !== "rule") return NO_STATES;
    const out = new Set<UIPaintState>();
    for (const s of source.rule.selectors) {
      const states = s.pseudoElement ? NO_STATES : paintStatesOf(s);
      if (states.length && matchSelector(s, target)) for (const n of states) out.add(n);
    }
    return out.size ? [...out] : NO_STATES;
  };
  const background = named("backgroundColor"), border = named("borderColor");
  return background.length || border.length ? { background, border } : null;
}

const selectorStates = new WeakMap<Selector, readonly UIPaintState[]>();
/** The paint states `s` names as holding (`statesNamed`), worked out once per selector (rule data doesn't change). */
function paintStatesOf(s: Selector): readonly UIPaintState[] {
  let states = selectorStates.get(s);
  if (!states) {
    const out = new Set<UIPaintState>();
    statesNamed(s, true, out);
    selectorStates.set(s, (states = out.size ? [...out] : NO_STATES));
  }
  return states;
}

/**
 * The paint states a selector names as states that hold (`positive`), in any of its compounds: its subject's
 * (`button:hover`), an ancestor's or sibling's (`.row:hover button`), inside `:is()`, `:where()`, `:has()` and
 * `:nth-child(... of S)`. Under `:not()` a state is named as not holding (`button:not(:hover)` is the look while not
 * hovered), so it counts only under an even number of them. A rule that matches while its state holds states the look
 * for that state; the Unity-style colour would hide it (ADR 0437 follow-up).
 */
function statesNamed(s: Selector, positive: boolean, out: Set<UIPaintState>): void {
  for (const { selector: c } of s.parts) {
    if (positive) for (const p of c.pseudo) if (PAINT_STATES.has(p)) out.add(p as UIPaintState);
    for (const is of c.is ?? []) for (const inner of is.selectors) statesNamed(inner, positive, out);
    for (const list of c.has ?? []) for (const inner of list) statesNamed(inner, positive, out);
    for (const nth of c.nth ?? []) for (const inner of nth.of ?? []) statesNamed(inner, positive, out);
    for (const list of c.not ?? []) for (const inner of list) statesNamed(inner, !positive, out);
  }
}

/** ADR 0432: a canvas's reference resolution, what viewport lengths resolve against before its first layout. */
function referenceSize(canvas: UIComponentType): UIMediaEnvironment {
  const r = (canvas as UICanvas).referenceResolution;
  return { width: r.x, height: r.y };
}

function walk<E extends UIStyledNode<E>>(el: E, fn: (el: E) => void): void {
  fn(el);
  for (const c of el.children) walk(c, fn);
}

/** `walk`, with the generated `::before`/`::after` elements (ADR 0432) too. */
function walkAll<E extends UIStyledNode<E>>(el: E, fn: (el: E) => void): void {
  fn(el);
  const s = el._style;
  if (s.before) walkAll(s.before, fn);
  for (const c of el.children) walkAll(c, fn);
  if (s.after) walkAll(s.after, fn);
}

/** How deep an element is in its tree (the canvas is 0). */
function depthOf<E extends UIStyledNode<E>>(el: E): number {
  let d = 0;
  for (let p = el.parent; p; p = p.parent) d++;
  return d;
}

// --- The tree ---------------------------------------------------------------------------------------

/** What the styled tree asks of its host: the World, the sheets, and making and destroying the elements it generates. */
export interface UIStyledTreeHost<E extends UIStyledNode<E>> {
  readonly world: World;
  /** What relative asset paths in attributes resolve against when an element has no source file. */
  readonly file: string;
  readonly sheets: UISheetSource;
  /**
   * Make `origin`'s generated `::before` or `::after` (ADR 0432) as a `uiTag` element: a node under `origin`'s node (first
   * or last), not among its children. The styled tree sets its style state.
   */
  makeGenerated(origin: E, which: "before" | "after", uiTag: UITag): E;
  /** Make the text label a generated box holds: a text written as `tag`, its only child. The styled tree sets its style state. */
  makeLabel(box: E, tag: string): E;
  /** Destroy a generated element or label (and what it holds) now. */
  destroyGenerated(g: E): void;
  /** Styles were written (`shape` false), or a generated element was made or destroyed (`shape` true). */
  changed(shape: boolean): void;
}

/**
 * The styled tree of one hosted UI tree (ADR 0438): see the module comment. `root` is the tree's canvas, made by the host
 * (node and component) before the styled tree; it takes no style of its own, but `:root` variables and inherited
 * properties start there.
 */
export class UIStyledTree<E extends UIStyledNode<E>> {
  private sheets: UISheetSet;
  private styledVersion: number;
  private localeEpoch = Locale.epoch;
  /** ADR 0431: the `UIPreferences` the styles last matched `@media` against. */
  private prefsVersion = uiPreferencesVersion();
  private readonly dirty = new Set<E>();
  /**
   * ADR 0432: elements whose `:has()` may match differently since the last restyle (something inside or after them
   * changed): each restyles alone, and its subtree only when what it passes on changed.
   */
  private readonly hasDirty = new Set<E>();
  /**
   * Elements made since styles were last resolved (a late sync, or a pending restyle before geometry is read) when the
   * sheets use structural selectors or `:has()`: restyling them for the siblings made after them starts no transitions
   * (they're new). Once styles are resolved they're settled, as an element's are in the DOM once its style has been read.
   */
  private readonly fresh = new Set<E>();
  /** The next late sync restyles for the canvas's first known size: nothing transitions (ADR 0422 wave 5). */
  private firstMedia = false;
  /** ADR 0432: an element's attributes (an inline style) have a viewport length: a canvas resize restyles the tree. */
  private attrsUseViewport = false;
  /**
   * Elements with node reference attributes (`nav-up="play"`, ADR 0340), with the fields they set: resolved by element id
   * in this tree once the tree or an attribute changed (`refsDirty`), before a restyle is done.
   */
  private readonly referencing = new Map<E, Set<string>>();
  private refsDirty = false;
  private readonly selectorCache = new Map<string, readonly Selector[]>();
  private readonly world: World;

  constructor(
    private readonly host: UIStyledTreeHost<E>,
    private readonly root: E,
  ) {
    this.world = host.world;
    const target = targetOf(root, root.tag, null);
    target.media = this.canvasSize();
    target.viewport = target.media ?? referenceSize(root.component);
    root._style = new UIElementStyle(target, markupOf(root.uiTag, new Map(), host.file));
    this.sheets = sheetSetOf(host.sheets);
    this.resolve(root); // `:root` variables, which its children inherit
    this.styledVersion = this.sheets.version;
  }

  // --- Calls in ---------------------------------------------------------------------------------------

  /** A new element (its node, component and parent set): give it its style state and its first attributes. Not styled yet. */
  attach(el: E, attributes: ReadonlyMap<string, string>, written?: ReadonlyMap<string, string>): void {
    el._style = new UIElementStyle(targetOf(el, el.tag, el.parent?._style.target ?? null), markupOf(el.uiTag, new Map(), this.fileOf(el)));
    this.writeAttributes(el, attributes, written);
  }

  /** `el`, new or moved, was put among its parent's children. */
  inserted(el: E, made: boolean): void {
    if (made && (this.sheets.useStructure || this.sheets.has)) this.fresh.add(el);
    this.childrenChanged(el.parent!);
    this.hasChanged(el);
  }

  /** `el` was taken out of `from`'s children to move (its parent now the new one, where it isn't inserted yet). */
  detached(el: E, from: E): void {
    const parent = el.parent!;
    if (from !== parent) {
      el._style.target.parent = parent._style.target;
      this.dirty.add(el); // descendant selectors may match differently
      this.childrenChanged(from);
    }
    this.hasChanged(el, from); // where it was
  }

  /** `el` and its subtree were removed from `parent` (the host marked them dead). */
  removed(el: E, parent: E | null): void {
    walkAll(el, (e) => {
      this.dirty.delete(e);
      this.hasDirty.delete(e);
      this.fresh.delete(e);
      this.referencing.delete(e);
    });
    if (this.referencing.size) this.refsDirty = true; // an id it named may be gone
    if (parent) {
      this.childrenChanged(parent);
      this.hasChanged(el, parent);
    }
  }

  /** `el`'s attributes are now `attributes` (and `written`, every attribute as the author wrote it): it restyles at the next sync. */
  attributesChanged(el: E, attributes: ReadonlyMap<string, string>, written?: ReadonlyMap<string, string>): void {
    this.writeAttributes(el, attributes, written);
    this.dirty.add(this.sheets.useStructure && el.parent ? el.parent : el);
    this.hasChanged(el);
  }

  /** A text element's text became empty or stopped being (`:empty`). */
  emptinessChanged(el: E): void {
    if (this.sheets.useStructure) this.dirty.add(el); // `:empty`
    this.hasChanged(el); // `:has(:empty)`
  }

  /** Resolve an element's style (and its subtree's) now: a new subtree shows styled before the next frame. */
  restyle(el: E): void {
    this.sheets = sheetSetOf(this.host.sheets);
    this.resolve(el);
    this.resolveReferences();
  }

  /** Restyle what changed since the last restyle (before geometry is read). */
  restylePending(): void {
    this.sheets = sheetSetOf(this.host.sheets);
    this.resolveDirty();
  }

  /** The frame's late sync: the stylesheets, language, UI preferences, canvas size and pseudo-states are checked, and what changed restyles. */
  sync(): void {
    this.sheets = sheetSetOf(this.host.sheets);
    const sheets = this.sheets;
    const root = this.root._style.target;
    if (this.styledVersion !== sheets.version) {
      this.styledVersion = sheets.version;
      this.dirty.add(this.root);
    }
    if (this.localeEpoch !== Locale.epoch) {
      this.localeEpoch = Locale.epoch;
      const language = Locale.language;
      walk(this.root, (el) => {
        el._style.target.lang = language;
      });
      if (sheets.useLang) this.dirty.add(this.root);
    }
    // ADR 0431: and when the player's UI preferences (reduced motion, colour scheme) change.
    if (this.prefsVersion !== uiPreferencesVersion()) {
      this.prefsVersion = uiPreferencesVersion();
      if (sheets.useMedia) this.dirty.add(this.root);
    }
    // ADR 0422 wave 5: `@media` rules match again when the canvas (last frame's layout) changes size.
    const size = this.canvasSize();
    const was = root.media;
    if (size && (!was || was.width !== size.width || was.height !== size.height)) {
      root.media = size;
      if (sheets.useMedia) {
        this.dirty.add(this.root);
        if (!was) this.firstMedia = true; // the view's first size isn't a change to animate
      }
    }
    // ADR 0432: viewport lengths follow the canvas (its reference resolution until the first layout).
    const viewport = size ?? referenceSize(this.root.component);
    const vp = root.viewport;
    if (!vp || vp.width !== viewport.width || vp.height !== viewport.height) {
      root.viewport = viewport;
      if (sheets.useViewport || this.attrsUseViewport) {
        this.dirty.add(this.root);
        if (!was) this.firstMedia = true; // nor is a size before or at the first layout
      }
    }
    walk(this.root, (el) => {
      const state = uiPseudoState(el.component);
      const t = el._style.target;
      if (!samePseudoState(state, t.state)) {
        t.state = state;
        if (sheets.usePseudo) this.dirty.add(el);
        this.hasChanged(el); // `:has(:hover)`
      }
    });
    this.resolveDirty();
    this.resolveReferences();
    this.firstMedia = false;
  }

  /** The first element inside `within` a selector matches (`first`), or every one in tree order. */
  query(selector: string, within: E, first: boolean): E[] {
    const selectors = selectorList(selector, this.selectorCache, false);
    const out: E[] = [];
    const visit = (el: E): boolean => {
      if (!el._alive) return false;
      if (selectors.some((s) => matchSelector(s, el._style.target))) {
        out.push(el);
        if (first) return true;
      }
      for (const c of el.children) if (visit(c)) return true;
      return false;
    };
    for (const c of within.children) if (visit(c)) break;
    return out;
  }

  /**
   * Play keyframes on `el` (ADR 0423: a Svelte transition's or `animate:`'s) on the UI animator: each keyframe is CSS
   * declarations by property (camel or kebab case), evenly spaced over `duration` seconds, converted as a stylesheet's are
   * (its variables and relative lengths included); a declaration it can't animate is warned about once and left out.
   */
  play(el: E, keyframes: readonly Readonly<Record<string, string>>[], duration: number, hooks: UIPlayHooks): UIPlayback {
    const type = el.component.constructor as ComponentClass;
    const fields = fieldsOf(type);
    const resolved = el._style.resolved;
    const vars = new Map<string, string>();
    for (const [k, v] of resolved) if (k.startsWith("--")) vars.set(k, String(v.value));
    const units = unitsOf(resolved);
    const file = this.fileOf(el);
    const tracks = new Map<string, UIAnimationStop[]>();
    const n = keyframes.length;
    keyframes.forEach((frame, i) => {
      const offset = n === 1 ? 1 : i / (n - 1);
      for (const [property, value] of Object.entries(frame)) {
        if (value === undefined || value === null || String(value).trim() === "") continue;
        const name = property === "cssFloat" ? "float" : property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
        const field = propertyField(name);
        const substituted = substituteVars(String(value), vars);
        // ADR 0432: relative lengths as the element's own declarations take them.
        const raw = substituted === undefined ? undefined : withElementUnits(substituted, field, units);
        const values = substituted === undefined ? "uses a variable that isn't defined." : raw === undefined ? "uses a viewport length before the canvas size is known." : keyframeValues(field, raw, fields, file);
        if (typeof values === "string") {
          const later = /^stroke|^fill/.test(name) ? " SVG paint applies to shapes inside an <svg> (ADR 0430); the rest of the animation runs." : "";
          // Once per tag, property and reason (a transition's keyframes hold a new value each frame).
          const key = `${el.tag}|${name}|${values}`;
          if (!animateWarned.has(key)) {
            animateWarned.add(key);
            warn(`<${el.tag}> can't animate ${name}: "${raw ?? value}" ${values}${later}`);
          }
          continue;
        }
        for (const [field, v] of values) {
          let list = tracks.get(field);
          if (!list) tracks.set(field, (list = []));
          const stop = { offset, value: cloneValue(v), timing: null };
          if (list.length && list[list.length - 1].offset === offset) list[list.length - 1] = stop;
          else list.push(stop);
        }
      }
    });
    return uiAnimator(this.world).play(
      { owner: this, element: el, comp: el.component, fields, animate: el._alive && !this.world.inEditMode(el.node.entity) },
      "transition",
      tracks,
      duration,
      hooks,
    );
  }

  /** Last frame's transition and animation events on this tree's elements (ADR 0422 wave 4), taken. */
  takeEvents(): { element: E; event: UIAnimationEvent }[] {
    return takeUIAnimationEvents(this.world, this) as { element: E; event: UIAnimationEvent }[];
  }

  /** The tree is gone: nothing more restyles, and its elements stop animating. */
  dispose(): void {
    uiAnimationOwnerGone(this.world, this);
    this.dirty.clear();
    this.hasDirty.clear();
  }

  /**
   * @internal ADR 0432 (the animator's owner hook): an animation wrote `value` to `field` of `element`. When the field
   * inherits, the element's children that inherit it show that value this frame, as computed values pass through
   * children while a parent's property transitions; a child animating the field itself keeps its own.
   */
  _animatedWrite(element: object, field: string, value: unknown): void {
    if (!INHERITED_FIELDS.has(field)) return;
    const el = element as E;
    if (!el._alive) return;
    for (const c of el.children) this.passInherited(c, field, value);
  }

  // --- Inside -----------------------------------------------------------------------------------------

  private fileOf(el: E): string {
    return el.source?.file ?? this.host.file;
  }

  private passInherited(el: E, field: string, value: unknown): void {
    if (!el._alive) return;
    const s = el._style;
    const rv = s.resolved.get(field);
    if (!rv || rv.source.kind !== "inherited") return; // set here: its children inherit its own value
    if (uiAnimatedField(this.world, el.component, field)) return;
    if (s.applied.has(field)) {
      const comp = el.component as unknown as Record<string, unknown>;
      if (!sameValue(comp[field], value)) comp[field] = cloneValue(value);
    }
    for (const c of el.children) this.passInherited(c, field, value);
  }

  private writeAttributes(el: E, attributes: ReadonlyMap<string, string>, written?: ReadonlyMap<string, string>): void {
    const s = el._style;
    if (!this.attrsUseViewport) for (const v of attributes.values()) if (hasViewportUnits(v)) this.attrsUseViewport = true;
    s.written = written ?? attributes;
    const id = attributes.get("id") || null;
    if (this.referencing.has(el) || hasReferenceAttribute(attributes)) {
      if (!this.referencing.has(el)) this.referencing.set(el, new Set());
      this.refsDirty = true;
    } else if (this.referencing.size && id !== s.target.id) this.refsDirty = true; // an id others name
    s.target.id = id;
    s.target.classes = (attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
    s.markup = markupOf(el.uiTag, attributes, this.fileOf(el));
  }

  /** `parent`'s children were added, removed or reordered: with structural selectors, it restyles with them (ADR 0422 wave 5). */
  private childrenChanged(parent: E): void {
    parent._style.childTargets = null;
    if (this.sheets.useStructure && parent._alive) this.dirty.add(parent);
  }

  /** The canvas's size in UI pixels at the World's last layout, which `@media` matches (null before one). */
  private canvasSize(): UIMediaEnvironment | null {
    const canvas = this.root.component;
    const c = uiInteractions(this.world).layout?.canvases().find((l) => l.comp === canvas);
    return c ? { width: c.width, height: c.height } : null;
  }

  /** Restyle the elements changed since the last restyle (a subtree once, from its top); new elements are settled after. */
  private resolveDirty(): void {
    if (!this.dirty.size && !this.hasDirty.size) {
      this.fresh.clear();
      return;
    }
    const dirty = [...this.dirty].filter((e) => e._alive);
    this.dirty.clear();
    const set = new Set(dirty);
    for (const el of dirty) {
      let covered = false;
      for (let p = el.parent; p && !covered; p = p.parent) covered = set.has(p);
      if (!covered) this.resolve(el);
    }
    // ADR 0432: `:has()` anchors not restyled with a subtree above: alone, top first (each passes its changes down).
    if (this.hasDirty.size) {
      const anchors = [...this.hasDirty].filter((e) => {
        if (!e._alive) return false;
        for (let p: E | null = e; p; p = p.parent) if (set.has(p)) return false;
        return true;
      });
      this.hasDirty.clear();
      anchors.sort((a, b) => depthOf(a) - depthOf(b));
      for (const el of anchors) this.resolve(el, false);
    }
    this.fresh.clear();
    this.host.changed(false);
  }

  /**
   * ADR 0432: something about `el` changed (it was made, moved or removed, or its attributes, text or state changed):
   * the elements whose `:has()` may now match differently restyle (`hasDirty`, or with their parent's subtree when a
   * `:has()` isn't its selector's subject). They're its ancestors from `parent` up (its old parent for a move or removal)
   * that could be an anchor, and with `+`/`~` relative selectors, the earlier siblings of it and of each ancestor.
   */
  private hasChanged(el: E, parent: E | null = el.parent): void {
    const use = this.sheets.has;
    if (!use) return;
    const mark = (a: E) => {
      const t = a._style.target;
      if (!a._alive || a.synthetic || !couldAnchorHas(use, a.tag, t.id, t.classes)) return;
      if (use.deep) this.dirty.add(a.parent ?? a);
      else this.hasDirty.add(a);
    };
    for (let a = parent; a; a = a.parent) mark(a);
    if (!use.siblings) return;
    for (let n: E | null = el, p = parent; n && p; n = p, p = p.parent) {
      for (const sib of p.children) {
        if (sib === n) break;
        mark(sib);
      }
    }
  }

  /**
   * Node references written by element id (ADR 0340): `nav-up`, `nav-down`, `nav-left`, `nav-right` and `first-selected`
   * set their field to the node of the element in this tree with that id (`"play"` or `"#play"`), or null.
   */
  private resolveReferences(): void {
    if (!this.refsDirty) return;
    this.refsDirty = false;
    if (!this.referencing.size) return;
    const byId = new Map<string, E>();
    walk(this.root, (e) => {
      const id = e._style.target.id;
      if (e._alive && id && !byId.has(id)) byId.set(id, e);
    });
    for (const [el, set] of [...this.referencing]) {
      if (!el._alive) {
        this.referencing.delete(el);
        continue;
      }
      const comp = el.component as unknown as Record<string, unknown>;
      const fields = fieldsOf(el.component.constructor as ComponentClass);
      const now = new Set<string>();
      for (const [name, value] of el.attributes) {
        const field = referenceField({ name } as MarkupAttribute);
        if (!field) continue;
        if (!fields.has(field)) {
          warnOnce(`<${el.tag} ${name}>: <${el.tag}> has no field "${name}".`);
          continue;
        }
        const id = value.trim().replace(/^#/, "");
        const target = id ? byId.get(id) : undefined;
        if (id && !target) warnOnce(`<${el.tag} ${name}="${value}">: there's no element with id "${id}".`);
        comp[field] = target?.node ?? null;
        now.add(field);
      }
      for (const field of set) if (!now.has(field)) comp[field] = null; // the attribute went
      if (now.size) this.referencing.set(el, now);
      else this.referencing.delete(el);
    }
  }

  /** Restyle an element and (`deep`, or when what it passes on changed, ADR 0432) its subtree. */
  private resolve(el: E, deep = true): void {
    const s = el._style;
    if (s.pseudo) {
      // ADR 0432: a generated `::before`/`::after` restyles with its originating element.
      if (el.parent?._alive) this.resolve(el.parent, false);
      return;
    }
    const type = el.component.constructor as ComponentClass;
    const { sheets, pseudoElements } = this.sheets;
    const parentResolved = el.parent?._style.resolved ?? null;
    const resolved = el === this.root ? new Map<string, ResolvedValue>() : resolveStyle(s.target, s.markup, type, sheets, parentResolved, warn);
    if (el === this.root) {
      // The canvas takes no style (its fields are its owner's), but `:root` variables start here for its children.
      // ADR 0432: and what it inherits from `:root` rules (text properties, the font size `rem` is relative to).
      for (const [k, v] of resolveStyle(s.target, s.markup, type, sheets, null, () => {})) if (k.startsWith("--") || k === UNITS_KEY || INHERITED_FIELDS.has(k)) resolved.set(k, v);
    } else if (pseudoElements.size || s.parts) this.pseudoFields(el, resolved);
    const passOn = this.apply(el, resolved) || deep;
    if (el !== this.root && !el.synthetic && (s.before || s.after || pseudoElements.has("before") || pseudoElements.has("after"))) this.generate(el);
    if (passOn) for (const child of el.children) this.resolve(child);
  }

  /**
   * Write a resolved style to an element's component (transitions and keyframe animations through the animator); returns
   * whether what it passes on to children changed (ADR 0432).
   */
  private apply(el: E, resolved: Map<string, ResolvedValue>): boolean {
    const s = el._style;
    const type = el.component.constructor as ComponentClass;
    const sheets = this.sheets.sheets;
    const comp = el.component as unknown as Record<string, unknown>;
    const fields = fieldsOf(type);
    const content = new Set(uiContentAttributes(el.uiTag));
    const next = new Set<string>();
    const writes: UIStyleWrite[] = [];
    const write = (name: string, value: unknown) => {
      writes.push({ field: name, before: comp[name], after: value });
      comp[name] = value;
    };
    for (const [name, rv] of resolved) {
      if (name.startsWith("--") || content.has(name) || !fields.has(name)) continue;
      next.add(name);
      const prev = s.resolved.get(name);
      if (prev && s.applied.has(name) && prev.source === rv.source && sameValue(prev.value, rv.value)) continue;
      write(name, cloneValue(rv.value));
    }
    for (const name of s.applied) if (!next.has(name)) write(name, defaultFieldValue(type, name));
    // Transitions and keyframe animations (ADR 0422 wave 4): the animator takes what changed from here.
    const transitions = resolved.get(TRANSITION_KEY)?.value as readonly UITransitionSpec[] | undefined;
    const animations = resolved.get(ANIMATION_KEY)?.value as readonly UIAnimationSpec[] | undefined;
    const first = !s.styled || this.fresh.has(el) || this.firstMedia;
    s.styled = true;
    if (transitions?.length || animations?.length || uiAnimating(this.world, el.component)) {
      // ADR 0432: inherited fields it only passes on (a panel's `color`) animate too, for its children.
      const passed = passedOnFields(fields);
      const animated = passed.size ? animatedFieldsOf(type, fields, passed) : null;
      for (const [f, info] of passed) {
        const now = resolved.get(f), was = s.resolved.get(f);
        if (!now || !was) continue;
        const after = passedOnValue(now.value, info, s.markup.file), before = passedOnValue(was.value, info, s.markup.file);
        if (after !== undefined && before !== undefined && !sameValue(after, before)) writes.push({ field: f, before, after });
      }
      const all = animated?.fields ?? fields;
      uiAnimator(this.world).styled(
        { owner: this, element: el, comp: el.component, fields: all, animate: !this.world.inEditMode(el.node.entity), virtual: animated?.virtual },
        writes,
        first,
        transitions?.map((spec): UIResolvedTransition => ({ spec, fields: transitionFields(spec.property, all) })) ?? null,
        animations?.map((spec): UIResolvedAnimation => ({ spec, tracks: () => keyframeTracks(sheets, spec.name, type, resolved, s.markup.file, warn, passed) })) ?? null,
      );
    }
    // ADR 0437: the states of its own its rules give its fill and border colour: its resolved paint draws those from its
    // style (`sync` restyles it as its state changes), not from the Unity-style state colours.
    if (el.component instanceof UIPanel) el.component._styledStates = this.sheets.usePseudo ? styledStatesOf(s.target, resolved) : null;
    const changed = !passesOnSame(s.resolved, resolved);
    s.resolved = resolved;
    s.applied = next;
    return changed;
  }

  /**
   * ADR 0432: what `::placeholder`, `::selection` and form part pseudo-elements style on the element itself. The first
   * two become entries of its resolved style (`placeholderColor`, `placeholderFontStyle`, `selectionColor`,
   * `selectionBackgroundColor`), applied, transitioned and reset as its own fields are; only what a pseudo-element rule
   * declares counts (not what it inherits), so the fields' own values stay the defaults. Parts go to the control's parts
   * (`setUIPartStyles`).
   */
  private pseudoFields(el: E, resolved: Map<string, ResolvedValue>): void {
    const c = el.component;
    const s = el._style;
    const used = this.sheets.pseudoElements;
    const style = (which: UIPseudoElement, type: ComponentClass) => resolveStyle(pseudoTarget(s.target, which), { tag: el.uiTag, attributes: [], file: s.markup.file }, type, this.sheets.sheets, resolved, warn);
    const set = (field: string, value: unknown, source: ResolvedValue["source"]) => resolved.set(field, { field, value, source });
    if ((c instanceof UIInputField || c instanceof UIText) && used.has("selection")) {
      const r = style("selection", UIText);
      const color = own(r, "color"), background = own(r, "backgroundColor");
      if (color) set("selectionColor", color.value, color.source);
      if (background) set("selectionBackgroundColor", background.value, background.source);
    }
    if (c instanceof UIInputField && used.has("placeholder")) {
      const r = style("placeholder", UIText);
      const color = own(r, "color"), opacity = own(r, "opacity"), fontStyle = own(r, "fontStyle");
      if (color || opacity) {
        // `opacity` fades the placeholder's colour (as Firefox's user-agent sheet does), over its own or the default.
        const base = (color?.value ?? resolved.get("placeholderColor")?.value ?? defaultFieldValue(c.constructor as ComponentClass, "placeholderColor")) as Color;
        const a = typeof opacity?.value === "number" ? Math.min(1, Math.max(0, opacity.value)) : 1;
        set("placeholderColor", new Color(base.r, base.g, base.b, base.a * a), (color ?? opacity)!.source);
      }
      if (fontStyle) set("placeholderFontStyle", fontStyle.value, fontStyle.source);
    }
    const parts = uiPartElements(el.uiTag);
    if (parts.length) {
      let styles: Partial<Record<UIPseudoElement, UIPartStyle>> | null = null;
      for (const name of parts) {
        if (!used.has(name)) continue;
        const part = partStyleOf(style(name, UIPanel));
        if (part) (styles ??= {})[name] = part;
      }
      if (styles || s.parts) {
        s.parts = styles;
        setUIPartStyles(c, styles);
      }
    }
  }

  /** ADR 0432: make, restyle or remove an element's `::before` and `::after` by their `content`. */
  private generate(el: E): void {
    const s = el._style;
    const inText = el.component instanceof UIText;
    for (const which of ["before", "after"] as const) {
      let g = which === "before" ? s.before : s.after;
      let resolved: Map<string, ResolvedValue> | null = null;
      let text: string | null = null;
      if (this.sheets.pseudoElements.has(which) && generatesPseudoElements(el.uiTag)) {
        // Inside a text element it's an inline run (a text); elsewhere a box (a panel) holding its text as a label.
        resolved = resolveStyle(g?._style.target ?? pseudoTarget(s.target, which), { tag: inText ? "Text" : "Panel", attributes: [], file: s.markup.file }, inText ? UIText : UIPanel, this.sheets.sheets, s.resolved, warn);
        const pieces = resolved.get(CONTENT_KEY)?.value as readonly UIContentPiece[] | null | undefined;
        if (pieces) text = contentText(pieces, (name) => writtenAttribute(s.written, name));
      }
      if (text === null || !resolved) {
        if (g) this.removeGenerated(el, which);
        continue;
      }
      g ??= this.makeGenerated(el, which, inText ? "Text" : "Panel");
      if (g.component instanceof UIText) g.component.text = text;
      this.apply(g, resolved);
      if (!inText) this.generatedLabel(g, text);
    }
  }

  private makeGenerated(el: E, which: "before" | "after", uiTag: UITag): E {
    const g = this.host.makeGenerated(el, which, uiTag);
    g._style = new UIElementStyle(pseudoTarget(el._style.target, which), { tag: uiTag, attributes: [], file: el._style.markup.file }, which);
    if (which === "before") el._style.before = g;
    else el._style.after = g;
    this.host.changed(true);
    return g;
  }

  /** ADR 0432: a generated box's text, as a label it holds (none for `""`), which inherits its text properties. */
  private generatedLabel(g: E, text: string): void {
    let label: E | null = g.children[0] ?? null;
    if (text === "") {
      if (label) this.destroyGenerated(label);
      return;
    }
    if (!label) {
      label = this.host.makeLabel(g, TEXT_PIECE_TAG);
      label._style = new UIElementStyle(targetOf(label, TEXT_PIECE_TAG, g._style.target), { tag: "Text", attributes: [], file: g._style.markup.file });
      this.host.changed(true);
    }
    (label.component as UIText).text = text;
    this.resolve(label);
  }

  private removeGenerated(el: E, which: "before" | "after"): void {
    const g = which === "before" ? el._style.before : el._style.after;
    if (!g) return;
    if (which === "before") el._style.before = null;
    else el._style.after = null;
    this.destroyGenerated(g);
  }

  private destroyGenerated(g: E): void {
    walkAll(g, (e) => this.dirty.delete(e));
    this.host.destroyGenerated(g);
    this.host.changed(true);
  }
}

/** What `UIElement.animate` warned about, by tag, property and reason. */
const animateWarned = new Set<string>();

/** Only what a pseudo-element rule declares (not what it inherits or defaults to). */
function own(map: ReadonlyMap<string, ResolvedValue>, field: string): ResolvedValue | undefined {
  const v = map.get(field);
  return v && v.source.kind !== "inherited" && v.source.kind !== "default" ? v : undefined;
}

/** ADR 0432: a form part's style from its pseudo-element's resolved style (as a panel), or null when it declares nothing. */
function partStyleOf(r: ReadonlyMap<string, ResolvedValue>): UIPartStyle | null {
  const out: { -readonly [K in keyof UIPartStyle]: UIPartStyle[K] } = {};
  const num = (field: string) => {
    const v = own(r, field)?.value;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const px = (field: string) => {
    const v = own(r, field)?.value;
    return typeof v === "string" && /^-?(\d+\.?\d*|\.\d+)(px)?$/.test(v.trim()) ? parseFloat(v) : undefined;
  };
  const color = (field: string) => {
    const v = own(r, field);
    if (!v) return undefined;
    if (v.value instanceof Color || v.value === null) return v.value;
    return typeof v.value === "string" ? (parseColor(v.value) ?? undefined) : undefined;
  };
  const background = color("backgroundColor");
  if (background !== undefined) out.background = background;
  const fg = color("color");
  if (fg) out.color = fg;
  const radius = num("borderRadius") ?? num("borderTopLeftRadius");
  if (radius !== undefined && radius >= 0) out.radius = radius;
  const bw = num("borderWidth") ?? num("borderTopWidth");
  if (bw !== undefined) out.borderWidth = bw;
  const bc = color("borderColor");
  if (bc) out.borderColor = bc;
  const w = px("width"), h = px("height");
  if (w !== undefined) out.width = w;
  if (h !== undefined) out.height = h;
  const sc = color("boxShadowColor");
  if (sc !== undefined) out.shadow = sc ? { color: sc, x: num("boxShadowOffsetX") ?? 0, y: num("boxShadowOffsetY") ?? 0, blur: num("boxShadowBlur") ?? 0 } : null;
  const opacity = num("opacity");
  if (opacity !== undefined) out.opacity = opacity;
  return Object.keys(out).length ? out : null;
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
