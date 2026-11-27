/**
 * The renderer-neutral UI core (ADR 0076): mirrors a World's UI components into a Yoga tree, lays it
 * out, routes the pointer and keyboard to UI before game scripts run, and takes input fields' typing
 * through a hidden DOM `<input>`. A backend's drawing layer draws what `canvases()` and `elements()`
 * report, including each text element's resolved text run (ADR 0271), which is what it measured.
 * What each element kind is comes from `elementKinds.ts`. Nothing here is public API (ADR 0010).
 *
 * Yoga loads asynchronously (WebAssembly): the constructor starts the load and `sync` lays nothing
 * out until it's ready (`await core.ready` to wait). Without a `document` (Node) there is no typing
 * element; routing and layout work all the same.
 */
import type { Node as YogaNode, Yoga } from "yoga-layout/load";
import { Mat4, Vector2 } from "../core/math";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { devices, type InputClaim, type PointerFrame } from "../input/devices";
import { UIButton, UICanvas, UIImage, UIInputField, UIOption, UISelect, UISlider, UIText, UITextArea, isFocusableUI, type UIComponentType, type UIFocusableElement } from "./components";
import { controlState, dragSlider, formOf, pageSlider, playerTyped, selectLabels, setSelectOpen, settleSelect, sliderToEnd, stepNumberField, submitForm, uiClickRecord } from "./formModel";
import { formPartsOf, partsKey } from "./formParts";
import { paintOf } from "./paint";
import { UI_KIND_TYPES, clipsChildren, flexShrinkOf, isInlineAtom, isInteractiveKind, isLeafKind, isRaycastTarget, isUserScroller, overflowAxes, sameTextMeasure, sameTextRun, textRunOf, uiKindOf, userScrollsAxis, type UIInlineAtomSizes } from "./elementKinds";
import { fontEpoch } from "./fonts";
import { uiInteractions } from "./interactions";
import { pointerFocus } from "./navigation";
import { canvasScale, estimateText, inRect, intersectRect, isMixedLength, loadYogaOnce, loadedYoga, uiBorderEdges, uiEdges, uiLength, uiLimit, type UIRect } from "./layout";
import type { UIInlineAtomSize, UIInlineEditing, UIInlineRun, TextMeasureRequest, UITextRun, UICoreHost, UICoreLike, UICoreOptions, UICorners, UIKind, UILaidOutCanvas, UILaidOutElement, UIPaint, UIPart, UIPickRay, UIScrollbar, UIScrollInfo, UIScrollSnap, UIScrollSnapArea } from "./uiCoreTypes";
import { fireUIEvent, uiDomCode, uiDomKey, uiEventRecord, UIDataTransfer, type UIEventData, type UIEventRecord } from "./events";
import { advanceUIScrolling, canMove, uiEndScrollGesture, uiResnap, uiScrollBy, uiScrollMoving, uiScrollTo, uiStopScrolling, uiWheelScroll, type UIScrollable } from "./scrolling";
import { applyAffine, boundsOf, compose, invert, localTransform, multiply, transformRect, type UIAffine, type UITransformFields } from "./transform2d";
import { backdropFilterFields, filterStepsOf, transformFilterSteps, type UIFilterFields, type UIFilterStep } from "./filters";
import { INLINE_ASCENT, INLINE_DESCENT, caretAt, indexAt, inlineFont, layoutInline, selectionRects, type RunMeasure, type UIInlineLayout } from "./text/inlineLayout";
import { applyInlineEdit } from "./text/inlineEdit";

export { canvasScale, uiLength } from "./layout";

type ElementKind = Exclude<UIKind, "canvas">;

/** Where an element sits among `overflow: hidden` clips and in the draw order (ADR 0422), from the last layout. */
interface Placement {
  /** The overlap of its `overflow: hidden` ancestors' padding boxes; null when unclipped. */
  clip: UIRect | null;
  /** Its nearest `overflow: hidden` ancestor. */
  clipper: Entry | null;
  /** With `overflow: hidden`: its own padding box. */
  childClip: UIRect | null;
  /** Its place in its canvas's draw order. */
  order: number;
  /**
   * ADR 0422 wave 3: the clips a point must fall in to reach it, as each clipper's padding box in layout space with the
   * inverse of that clipper's transform (null: untransformed). Clips in one frame are merged into one rectangle.
   */
  clips: readonly ClipStep[];
  /** Its whole transform (its ancestors' and its own; null: none) and that inverted (null: none, or a scale of 0 flattens it). */
  transform: UIAffine | null;
  inverse: UIAffine | null;
  /** The axis-aligned bounds of what's drawn of it, in canvas UI pixels: transformed, then clipped. */
  bounds: UIRect;
  /** ADR 0427: the clips that don't scroll (navigation reaches elements scrolled out of view), and `bounds` cut by those only. */
  reachClips: readonly ClipStep[];
  reach: UIRect;
  /** ADR 0427: a clipping element's scroll state; null otherwise. */
  scroll: UIScrollInfo | null;
  /** ADR 0430: the filter drawn over it: its own steps, then its ancestors' (lengths in canvas UI pixels); null: none. */
  filter: readonly UIFilterStep[] | null;
  /** ADR 0432: its `backdrop-filter` (its own steps only, lengths through its transform); null: none. */
  backdrop?: readonly UIFilterStep[] | null;
}

/** One clip (ADR 0422): a rectangle in layout space, tested after mapping the point through `inverse`. `empty`: hides everything (a clipper scaled to 0). */
interface ClipStep {
  readonly rect: UIRect;
  readonly transform: UIAffine | null;
  readonly inverse: UIAffine | null;
  readonly empty: boolean;
}

/** True when a canvas point lies in every clip. */
function inClips(x: number, y: number, clips: readonly ClipStep[]): boolean {
  for (const c of clips) {
    if (c.empty) return false;
    const [lx, ly] = c.inverse ? applyAffine(c.inverse, x, y) : [x, y];
    if (!inRect(lx, ly, c.rect)) return false;
  }
  return true;
}

/** True when a canvas point lies on the element's box as drawn (its transform inverted), and in its clips. */
function onDrawnBox(e: Entry, x: number, y: number): boolean {
  const p = e.place;
  if (p.transform && !p.inverse) return false; // flattened to nothing
  const [lx, ly] = p.inverse ? applyAffine(p.inverse, x, y) : [x, y];
  const b = e.box;
  return lx >= b.x && lx <= b.x + b.width && ly >= b.y && ly <= b.y + b.height && inClips(x, y, p.clips);
}

interface Entry {
  readonly comp: UIComponentType;
  readonly kind: UIKind;
  readonly node: YogaNode;
  /** Its Yoga parent (null for a canvas root, or while it has none). */
  parent: Entry | null;
  /** Yoga children as last attached, in order. */
  children: Entry[];
  /** Its canvas (itself for a canvas); null while it has none (not laid out). */
  canvas: CanvasEntry | null;
  /** Text and input field elements: the text run last measured (its dirty signature, with `measuredEpoch`). */
  run: UITextRun | null;
  /** The font epoch `run` was measured in (a font arriving changes every text's size). */
  measuredEpoch: number;
  /** The values last given to its Yoga node, by `applyProperties` slot, so unchanged ones aren't set again. */
  applied: unknown[];
  /** Last laid-out result, in its canvas's UI pixels. */
  box: { x: number; y: number; width: number; height: number; visible: boolean; opacity: number };
  /** Clip and draw order from the last layout (ADR 0422). */
  place: Placement;
  /**
   * ADR 0422 wave 5: the parent's content size its lengths mixing % and px (`calc()`) were last resolved against, or
   * absent when it has none. Layout runs again once when the parent's size turns out different.
   */
  calcBasis?: { width: number; height: number };
  /**
   * ADR 0428: a select's list: a Yoga root of its own that its options lay out in (the select's node is measured, for
   * its label, and has no children), placed below the select when it's read.
   */
  popup?: YogaNode;
  /** ADR 0428: a form element's parts at the last layout, and their key (`formParts.ts`). */
  parts?: UIPart[] | null;
  partsKey?: string;
  /** ADR 0437: its last resolved paint, the same object while it draws the same. */
  paint?: UIPaint | null;
  /** ADR 0428: what else a measured element's size depends on (a select's option labels, a text area's rows). */
  measureKey?: string;
  /**
   * ADR 0429: an inline run (a text's inline child): the element it's inside (its text, or an inline element), which events
   * travel up through. It has no Yoga node in the tree; its box is its fragments' bounds, from its text's layout.
   */
  inlineIn?: Entry | null;
  /** ADR 0429: a text with runs: its inline layout at its content width (null otherwise), and what it was laid out for. */
  inline?: UIInlineLayout | null;
  inlineFor?: { run: UITextRun; width: number; inset: string };
  /** ADR 0429: its runs' fragments in canvas UI pixels (layout space): what hit-testing resolves a point on the text to. */
  inlineHits?: { x: number; y: number; width: number; height: number; owner: Entry | null }[];
  /** ADR 0432: an atomic inline box: the text whose lines it's on (null otherwise), and its margin box's size and baseline at its last layout. */
  atomOf?: Entry | null;
  atomSize?: UIInlineAtomSize | null;
  /** ADR 0432: a text's atomic inline boxes (inside its runs too), from the last sync. */
  atoms?: Entry[];
  /** ADR 0429: a text's inline runs (every inline descendant), from the last sync. */
  inlineRuns?: Entry[];
}

/** ADR 0429: an editable text being edited: its selection (`anchor` to `focus`, offsets in its text), the hidden text area's text, what's shown. */
interface EditState {
  readonly entry: Entry;
  anchor: number;
  focus: number;
  text: string;
  /** A press is selecting by dragging. */
  dragging: boolean;
  /** The selection changed here, to be put into the hidden text area. */
  selectionChanged: boolean;
  shown: UIInlineEditing | null;
  shownFor: UIInlineLayout | null;
  shownAnchor: number;
  shownFocus: number;
}

/** What a sync's walk of a canvas's nodes carries (`UICore.collect`). */
interface CollectWalk {
  readonly canvas: CanvasEntry;
  readonly byNode: Map<number, UIComponentType>;
  readonly placed: Set<Entry>;
  readonly desired: Map<Entry, Entry[]>;
}

/** ADR 0429: the element events go up to from `e`: an inline run's text or inline element, else its Yoga parent. */
function up(e: Entry): Entry | null {
  return e.inlineIn ?? e.parent;
}

interface CanvasEntry extends Entry {
  readonly comp: UICanvas;
  scale: number;
  width: number;
  height: number;
  /** Elements in tree order (parents first), from the last sync. */
  elements: Entry[];
  /** The same elements in draw order (ADR 0422: `zIndex`, then document order): picking walks it from the end. */
  painted: Entry[];
  /** ADR 0427: `painted` with each scroller's scrollbars after its last descendant, as they're drawn: hit-testing walks it from the end. */
  hitOrder: HitItem[];
}

/** An element, or one of a scroller's scrollbars (ADR 0427), in hit-testing order. */
type HitItem = Entry | { readonly bar: "x" | "y"; readonly scroller: Entry };

/** True for an element that draws its descendants together, ordered among themselves (ADR 0422): a non-zero `zIndex` or an `overflow` that clips. */
function stacks(e: Entry): boolean {
  if (e.kind === "canvas") return true;
  return zOf(e) !== 0 || clipsChildren(e.comp);
}

function zOf(e: Entry): number {
  const z = (e.comp as { zIndex?: number }).zIndex;
  return typeof z === "number" && Number.isFinite(z) ? z : 0;
}

/** The length fields that may hold a `calc()` mixing % and px (ADR 0422 wave 5). */
const MIXED_FIELDS = ["width", "height", "top", "right", "bottom", "left", "minWidth", "maxWidth", "minHeight", "maxHeight", "flexBasis"] as const;

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width - b.width) < 1e-4 && Math.abs(a.height - b.height) < 1e-4;
}

/**
 * A canvas's elements in draw order, as CSS paints stacking contexts (ADR 0422): within each group (the canvas, or an
 * element that `stacks`), its members are its descendants down to (and including) nested groups, stably sorted by
 * `zIndex`, so equal ones keep document order and parents stay before their children; each nested group is followed
 * by its own members.
 */
function paintOrder(root: Entry): Entry[] {
  const out: Entry[] = [];
  const group = (g: Entry) => {
    const members: Entry[] = [];
    const gather = (p: Entry) => {
      for (const c of p.atoms?.length ? [...p.children, ...p.atoms] : p.children) {
        members.push(c);
        if (!stacks(c)) gather(c);
      }
    };
    gather(g);
    const sorted = members.some((m) => zOf(m) !== 0) ? members.map((m, i) => ({ m, i, z: zOf(m) })).sort((a, b) => a.z - b.z || a.i - b.i).map((x) => x.m) : members;
    for (const m of sorted) {
      out.push(m);
      if (stacks(m)) group(m);
    }
  };
  group(root);
  return out;
}

const NO_PLACE: Placement = { clip: null, clipper: null, childClip: null, order: 0, clips: [], transform: null, inverse: null, bounds: { x: 0, y: 0, width: 0, height: 0 }, reachClips: [], reach: { x: 0, y: 0, width: 0, height: 0 }, scroll: null, filter: null };

/** ADR 0427: scrollbar thickness in UI pixels by `scrollbarWidth`, and a thumb's shortest length. */
const SCROLLBAR_WIDTH = { auto: 10, thin: 6, none: 0 } as const;
const MIN_THUMB = 18;
/** ADR 0426/0427: how far (CSS pixels) a press moves before it's a drag: a mouse drag of a draggable element, a touch or pen drag scroll. */
const DRAG_THRESHOLD = 4;
const TOUCH_SCROLL_THRESHOLD = 10;
/** Two clicks this close (seconds, CSS pixels) on the same element make a `dblclick`. */
const DBLCLICK_SECONDS = 0.5;
const DBLCLICK_DISTANCE = 5;
/** Keyboard scrolling: an arrow key's step (UI pixels), and a page key's share of the scroller's height. */
const ARROW_STEP = 40;
const PAGE_SHARE = 0.875;

/** True when a point lies within `edge` pixels inside the border of the `width` x `height` frame at the origin. */
function onFrameEdge(x: number, y: number, width: number, height: number, edge: number): boolean {
  if (x < 0 || y < 0 || x > width || y > height) return false;
  return x < edge || y < edge || x > width - edge || y > height - edge;
}

const scratchInv = new Float32Array(16);

/** What the pointer meets: the topmost raycast target, and the button or input field that takes it (null: it only blocks). */
interface Hit {
  readonly target: Entry;
  readonly handler: Entry | null;
  /** Where, in the target canvas's UI pixels. */
  readonly ux: number;
  readonly uy: number;
  /** ADR 0427: the press is on the target's scrollbar (the target is the scroller). */
  readonly bar: "x" | "y" | null;
}

/** ADR 0426/0427: what a held press is doing: maybe a drag, scrolling by touch, a UI drag, or dragging a scrollbar. */
interface Gesture {
  kind: "pending" | "scroll" | "drag" | "thumb" | "slider" | "none";
  readonly pointerType: "mouse" | "touch" | "pen";
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  /** The pointerdown wasn't prevented (a prevented press neither drag-scrolls nor drags). */
  armed: boolean;
  /** The element pressed (the raycast target). */
  readonly target: Entry | null;
  /** The nearest draggable element at or above it. */
  readonly source: Entry | null;
  /** The scrollers at or above it, innermost first. */
  readonly chain: Entry[];
  /** A touch drag: the scroller it moves; a thumb drag: the scroller and axis; ADR 0428, a slider drag: the slider (and `startScroll` its value at the press). */
  scroller: Entry | null;
  axis: "x" | "y" | null;
  startScroll: number;
  /** ADR 0432: a touch drag's or thumb drag's scroller's offsets when it took the gesture (where a snap measures `scroll-snap-stop` from). */
  scrollFrom: { x: number; y: number } | null;
  /** Recent positions (seconds, CSS pixels) for momentum. */
  samples: { t: number; x: number; y: number }[];
  /** A UI drag's data, the element under the pointer, and whether its last `dragover` was prevented (a drop allowed). */
  data: UIDataTransfer | null;
  dropTarget: Entry | null;
  accepts: boolean;
}

/** The Yoga node an entry's children are in: its own, or (ADR 0428) a select's list. */
function holder(e: Entry): YogaNode {
  return e.popup ?? e.node;
}

/** ADR 0428: the open select whose list `e` is in (at or below one of its options), or null. */
function openSelectAbove(e: Entry): Entry | null {
  for (let at = e.parent; at && at.kind !== "canvas"; at = at.parent) if (at.kind === "select") return (at.comp as UISelect).open ? at : null;
  return null;
}

/** ADR 0426: an element and its ancestors below its canvas, the element first. */
function pathOf(e: Entry): Entry[] {
  const out: Entry[] = [];
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = up(at)) out.push(at);
  return out;
}

/** ADR 0432: the text elements and inline runs at or above `e` (what `:hover` and `:active` apply to). */
function textsOn(e: Entry | null): ReadonlySet<UIComponentType> | undefined {
  let out: Set<UIComponentType> | undefined;
  for (let at = e; at && at.kind !== "canvas"; at = up(at)) if (at.kind === "text") (out ??= new Set()).add(at.comp);
  return out;
}

/** ADR 0426: the nearest element both are in (themselves included), below their canvas; null when they share none. */
function commonAncestor(a: Entry, b: Entry): Entry | null {
  const path = pathOf(a);
  for (let at: Entry | null = b; at && at.kind !== "canvas"; at = up(at)) if (path.includes(at)) return at;
  return null;
}

/** HTML's `inert`: the element or one it's in is inert (the pointer passes through it). */
function inertEntry(e: Entry): boolean {
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = up(at)) if ((at.comp as { inert?: boolean }).inert) return true;
  return false;
}

/** ADR 0426: a press in a button (ADR 0428: any control) that isn't interactable doesn't click (the DOM's disabled controls). */
function disabledPath(e: Entry): boolean {
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = up(at)) if (isFocusableUI(at.comp) && !at.comp.interactable) return true;
  return false;
}

/** ADR 0427: the elements at or above `e` the player scrolls (`overflow` `auto` or `scroll`), innermost first. */
function scrollChain(e: Entry): Entry[] {
  const out: Entry[] = [];
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = up(at)) {
    const s = at.place.scroll;
    if (s && (s.userX || s.userY) && at.box.visible) out.push(at);
  }
  return out;
}

/**
 * ADR 0427: the scroller in `chain` (innermost first) that takes a scroll of `dx`, `dy`: the first that scrolls that
 * way and can still move, chaining outward, unless a scroller that can't move has `overscroll-behavior` `contain` or
 * `none`, which ends the chain there.
 */
function pickScroller(chain: readonly Entry[], dx: number, dy: number): Entry | null {
  if (dx === 0 && dy === 0) return null;
  for (const e of chain) {
    const s = e.place.scroll!;
    const okX = dx === 0 || (s.userX && canMove(s.x, s.minX, s.maxX, dx));
    const okY = dy === 0 || (s.userY && canMove(s.y, s.minY, s.maxY, dy));
    if (okX && okY) return e;
    if ((e.comp as UIScrollable).overscrollBehavior !== "auto") return null;
  }
  return null;
}

/** The interactive element a pointer on `e` goes to: `e` itself or its nearest interactive ancestor, below its canvas. */
function handlerOf(e: Entry): Entry | null {
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = up(at)) if (isInteractiveKind(at.kind)) return at;
  return null;
}

export class UICore implements UICoreLike {
  /** Resolves when Yoga has loaded. */
  readonly ready: Promise<void>;
  layoutVersion = 0;

  private yoga: Yoga | null = null;
  private config: ReturnType<Yoga["Config"]["create"]> | null = null;
  private readonly entries = new Map<UIComponentType, Entry>();
  private readonly canvasEntries = new Map<UICanvas, CanvasEntry>();
  private interactiveMode: boolean;
  private readonly host: UICoreHost;
  private readonly removeHook: () => void;
  private readonly passive: boolean;
  /** In `relayout` (a mid-frame layout read): layout only. */
  private relayingOut = false;
  private readonly warned = new Set<string>();
  private world: World | null = null;
  private width = 0;
  private height = 0;
  /** The button a pointer press began on, until it's released. */
  private pressed: Entry | null = null;
  /** The left button was down or held at the last routing (a press on the canvas takes DOM focus first). */
  private pointerHeld = false;
  private disposed = false;
  private canvasList: UILaidOutCanvas[] = [];
  private elementList: UILaidOutElement[] = [];
  private screenList: CanvasEntry[] = [];

  // Typing: one hidden DOM <input>, shared by whichever field is focused.
  private dom: HTMLInputElement | null = null;
  /** ADR 0428: the hidden elements made so far: a one-line `<input>` and a `<textarea>`. */
  private readonly doms: { line?: HTMLInputElement; area?: HTMLInputElement } = {};
  private active: UIInputField | null = null;
  /** ADR 0429: the editable text being edited, and the one the hidden text area holds. */
  private editing: EditState | null = null;
  private editActive: UIText | null = null;
  private programmatic = false;
  private detachDom: (() => void) | null = null;
  /** Keys the hidden input took since the last routing (Tab, Escape leaving a field), claimed from the game until released. */
  private swallowed: string[] = [];
  /** The pointer's position at the last routing: moving it ends navigation's focus colours (ADR 0340). */
  private lastPointer: { x: number; y: number } | null = null;
  /** ADR 0426: the raycast target under the pointer at the last routing (pointerover/out/enter/leave follow it). */
  private hoverTarget: Entry | null = null;
  /** ADR 0426: the raycast target a left press began on (a click goes to what it and the release share). */
  private pressTarget: Entry | null = null;
  /** ADR 0426: the last click, for `dblclick`. */
  private lastClick: { comp: UIComponentType; time: number; x: number; y: number; count: number } | null = null;
  /** ADR 0426/0427: what the held press is doing. */
  private gesture: Gesture | null = null;
  /** ADR 0427: the scroller the last press landed in: with nothing focused, keys scroll it. */
  private activeScroller: Entry | null = null;
  /** ADR 0427: each scroller's offsets at the last layout, and whether it was moving (for `scroll` and `scrollend`). */
  private readonly lastScroll = new Map<Entry, { x: number; y: number; moving: boolean }>();

  /** Whether clicks press buttons and focus fields (false: the editor's scene view, where they select; ADR 0129). */
  setInteractive(on: boolean): void {
    this.interactiveMode = on;
  }

  constructor(options: UICoreOptions = {}) {
    this.interactiveMode = options.interactive ?? true;
    this.host = options.host ?? {};
    this.passive = options.passive ?? false;
    this.removeHook = this.passive ? () => undefined : devices.addRouter((pointer) => this.route(pointer));
    // With Yoga loaded already (another core loaded it), lay out from the first sync: a World that
    // syncs only when something changes (the editor's) may not sync again for a while.
    const yoga = loadedYoga();
    if (yoga) this.useYoga(yoga);
    this.ready = yoga ? Promise.resolve() : loadYogaOnce().then((y) => this.useYoga(y));
  }

  /** Yoga's enum values by the components' names, made once. */
  private tables: ReturnType<typeof yogaTables> | null = null;

  private useYoga(yoga: Yoga): void {
    if (this.disposed) return;
    this.yoga = yoga;
    this.config = yoga.Config.create();
    this.config.setPointScaleFactor(0); // no rounding: boxes are exact in UI pixels
  }

  get hasScreenUI(): boolean {
    return this.screenList.length > 0;
  }

  canvases(): readonly UILaidOutCanvas[] {
    return this.canvasList;
  }

  /** The drawing canvas's size in CSS pixels at the last `sync`. */
  get viewport(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  elements(): readonly UILaidOutElement[] {
    return this.elementList;
  }

  /** Lay the last synced World's UI out again now, at the last size (the UI host reading geometry mid-frame, ADR 0423). */
  relayout(): void {
    if (!this.world || this.disposed) return;
    // Layout only: scrolling moves on, and `scroll`/`scrollend` are noted, once a frame, in the frame's own sync (ADR 0427).
    this.relayingOut = true;
    try {
      this.sync(this.world, this.width, this.height);
    } finally {
      this.relayingOut = false;
    }
  }

  /** The caret index in a focused input field's text, or null when it isn't the one being typed in. */
  caretOf(c: UIInputField): number | null {
    if (!this.dom || this.active !== c) return null;
    return this.dom.selectionStart ?? this.dom.value.length;
  }

  /** ADR 0432: the selection (`[start, end)`) in the input field being typed in, or null when it isn't the one or nothing is selected. */
  selectionOf(c: UIInputField): readonly [number, number] | null {
    if (!this.dom || this.active !== c) return null;
    const s = this.dom.selectionStart, e = this.dom.selectionEnd;
    return s !== null && e !== null && e > s ? [s, e] : null;
  }

  rectOf(c: UIComponentType): { x: number; y: number; width: number; height: number } | null {
    const entry = this.entries.get(c);
    const canvas = entry?.canvas;
    if (!entry || !canvas || canvas.comp.mode !== "screen" || !this.yoga) return null;
    const s = canvas.scale;
    const b = entry.box;
    return { x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s };
  }

  hitTest(x: number, y: number): UIComponentType | null {
    const hit = this.hit(x, y);
    return hit ? (hit.handler ?? hit.target).comp : null;
  }

  // --- Sync -----------------------------------------------------------------------------------

  sync(world: World, width: number, height: number, deltaSeconds = 0): void {
    if (this.disposed || !this.yoga) return;
    const yoga = this.yoga;
    this.world = world;
    // ADR 0427: smooth scrolls and momentum move on before layout reads the offsets (the routing core only).
    if (!this.passive && !this.relayingOut) advanceUIScrolling(world, deltaSeconds);
    // The layout scripts' scrolling reads (ADR 0427) and navigation search: the routing core's, from its first layout.
    if (!this.passive && this.interactiveMode && world._takesInput) uiInteractions(world).layout = this;
    this.width = width;
    this.height = height;

    // The World's UI components, one per node (the first wins), by owner node.
    const live = new Set<UIComponentType>();
    const byNode = new Map<number, UIComponentType>();
    for (const type of UI_KIND_TYPES) {
      for (const c of world._componentsOfType(type)) {
        if (live.has(c) || c._destroyed) continue;
        live.add(c);
        const e = c.owner.entity;
        const first = byNode.get(e);
        if (first && first !== c) this.warnOnce(`two|${e}`, `node "${c.owner.name}" has two UI components; only its ${first.constructor.name} is laid out.`);
        else byNode.set(e, c);
      }
    }
    for (const c of [...this.entries.keys()]) if (!live.has(c) || byNode.get(c.owner.entity) !== c) this.release(c);
    for (const c of byNode.values()) this.ensure(c);
    // ADR 0436: a select's fields a script wrote are settled (HTML's selectedness) before layout reads its label, so
    // measuring it stays a pure read. The routing core only: a passive core never changes what it lays out.
    if (!this.passive) for (const c of byNode.values()) if (c instanceof UISelect) settleSelect(c);

    // The tree: each canvas's descendants in node order; elements outside a canvas aren't laid out.
    const desired = new Map<Entry, Entry[]>();
    const placed = new Set<Entry>();
    for (const canvas of this.canvasEntries.values()) {
      canvas.canvas = canvas;
      placed.add(canvas);
      this.collect(canvas.comp.owner, canvas, canvas, byNode, placed, desired);
    }
    for (const entry of this.entries.values()) {
      if (placed.has(entry)) continue;
      entry.canvas = null;
      if (entry.comp.isActiveAndEnabled) this.warnOnce(`orphan|${entry.comp.owner.entity}`, `UI element "${entry.comp.owner.name}" has no UICanvas above it, so it isn't laid out.`);
    }
    this.attach(desired);

    // Properties and layout.
    // ADR 0432: an atomic inline box is laid out (it's a run of its text only by its size).
    for (const entry of this.entries.values()) if (entry.canvas && (!entry.inlineIn || entry.atomOf)) this.applyProperties(yoga, entry);
    this.layoutAtoms(yoga);
    const canvases = [...this.canvasEntries.values()].sort((a, b) => a.comp.sortOrder - b.comp.sortOrder);
    for (const canvas of canvases) {
      this.applyCanvas(canvas);
      canvas.node.calculateLayout(canvas.width, canvas.height, yoga.DIRECTION_LTR);
      this.readLayout(canvas);
      // `calc()` mixing % and px (ADR 0422 wave 5) resolved against last frame's parent sizes: once more where they changed.
      const stale = canvas.elements.filter((e) => e.calcBasis && e.parent && !sameSize(e.calcBasis, this.contentSize(e.parent)));
      if (stale.length) {
        for (const e of stale) this.applyProperties(yoga, e);
        canvas.node.calculateLayout(canvas.width, canvas.height, yoga.DIRECTION_LTR);
        this.readLayout(canvas);
      }
    }
    this.collectResults(world, canvases);
    if (!this.passive && !this.relayingOut) this.noteScrolls(world);
    this.syncDom();
  }

  /**
   * ADR 0427: a scroller whose offsets changed since the last layout gets a `scroll` event, and one that stopped (no
   * change, no gesture holding it, no smooth scroll or momentum) a `scrollend`, published with the next routing, so
   * they're dispatched the frame after (as the DOM fires them before the next frame's rendering).
   */
  private noteScrolls(world: World): void {
    const log = uiInteractions(world);
    const seen = new Set<Entry>();
    for (const canvas of this.canvasEntries.values()) {
      for (const e of canvas.elements) {
        const s = e.place.scroll;
        if (!s) continue;
        seen.add(e);
        const last = this.lastScroll.get(e);
        if (!last) {
          this.lastScroll.set(e, { x: s.x, y: s.y, moving: false });
          continue;
        }
        if (last.x !== s.x || last.y !== s.y) {
          last.x = s.x;
          last.y = s.y;
          last.moving = true;
          log.queue(uiEventRecord("scroll", e.comp));
        } else if (last.moving && !uiScrollMoving(world, e.comp as UIScrollable) && this.gesture?.scroller !== e) {
          last.moving = false;
          log.queue(uiEventRecord("scrollend", e.comp));
        }
      }
    }
    for (const e of [...this.lastScroll.keys()]) if (!seen.has(e)) this.lastScroll.delete(e);
  }

  /** Forget a removed component. */
  release(c: UIComponentType): void {
    const entry = this.entries.get(c);
    if (!entry) return;
    this.entries.delete(c);
    if (c instanceof UICanvas) this.canvasEntries.delete(c);
    if (this.pressed === entry) this.pressed = null;
    if (this.hoverTarget === entry) this.hoverTarget = null;
    if (this.pressTarget === entry) this.pressTarget = null;
    if (this.activeScroller === entry) this.activeScroller = null;
    if (this.gesture && (this.gesture.target === entry || this.gesture.source === entry || this.gesture.scroller === entry || this.gesture.dropTarget === entry)) this.gesture = null;
    this.lastScroll.delete(entry);
    if (this.active === c) this.unfocusDom();
    if (this.editing?.entry === entry) this.endEditing();
    if (entry.parent) {
      holder(entry.parent).removeChild(entry.node);
      entry.parent.children = entry.parent.children.filter((e) => e !== entry);
      entry.parent = null;
    }
    for (const child of entry.children) {
      if (child.parent === entry) {
        holder(entry).removeChild(child.node);
        child.parent = null;
      }
    }
    entry.children = [];
    entry.node.free();
    entry.popup?.free();
  }

  dispose(): void {
    if (this.disposed) return;
    this.removeHook();
    if (this.world && uiInteractions(this.world).layout === this) uiInteractions(this.world).layout = null;
    for (const c of [...this.entries.keys()]) this.release(c);
    this.unfocusDom();
    this.editing = null;
    this.editActive = null;
    this.detachDom?.();
    this.detachDom = null;
    this.doms.line = this.doms.area = undefined;
    this.dom = null;
    this.config?.free();
    this.config = null;
    this.disposed = true;
    this.canvasList = [];
    this.elementList = [];
    this.screenList = [];
  }

  // --- Building -------------------------------------------------------------------------------

  private ensure(c: UIComponentType): Entry {
    const existing = this.entries.get(c);
    if (existing) return existing;
    const yoga = this.yoga!;
    const kind = uiKindOf(c);
    const node = yoga.Node.create(this.config ?? undefined);
    const run = textRunOf(c);
    const entry: Entry = { comp: c, kind, node, parent: null, children: [], canvas: null, run, measuredEpoch: fontEpoch(), applied: [], box: { x: 0, y: 0, width: 0, height: 0, visible: false, opacity: 1 }, place: NO_PLACE };
    if (kind === "canvas") {
      const canvas = entry as CanvasEntry;
      canvas.scale = 1;
      canvas.width = canvas.height = 0;
      canvas.elements = [];
      canvas.painted = [];
      canvas.hitOrder = [];
      this.canvasEntries.set(c as UICanvas, canvas);
    } else if (run) {
      node.setMeasureFunc((w, wm) => this.measure(entry, wm === yoga.MEASURE_MODE_UNDEFINED ? Infinity : w));
    }
    // ADR 0428: a select's options lay out in a list of their own; a control's state as built is what a form resets to
    // (ADR 0436: unless its front end handed the form-control model one).
    if (kind === "select") {
      entry.popup = yoga.Node.create(this.config ?? undefined);
      entry.popup.setFlexDirection(yoga.FLEX_DIRECTION_COLUMN);
    }
    if (!this.passive) controlState(c);
    this.entries.set(c, entry);
    return entry;
  }

  /** Walk `node`'s descendants in order, listing each entry's wanted Yoga children (skipping nodes without a UI component). */
  private collect(node: GameObject, parent: Entry, canvas: CanvasEntry, byNode: Map<number, UIComponentType>, placed: Set<Entry>, desired: Map<Entry, Entry[]>): void {
    const root: Entry[] = [];
    desired.set(parent, root);
    this.walkUI({ canvas, byNode, placed, desired }, node, root);
  }

  /**
   * Walk `n`'s descendants in order into `list` (their Yoga parent's children), skipping nodes without a UI component;
   * `leaf` is the leaf element they're under (its children join its parent's list), if any.
   */
  private walkUI(w: CollectWalk, n: GameObject, list: Entry[], leaf?: Entry): void {
    for (const child of n.children) {
      if (child.isComponentNode) continue; // its component counts as its owner's (ADR 0009)
      const c = w.byNode.get(child.entity);
      if (!c) {
        this.walkUI(w, child, list, leaf);
        continue;
      }
      if (c instanceof UICanvas) continue; // a nested canvas is a root of its own
      const entry = this.entries.get(c)!;
      entry.canvas = w.canvas;
      w.placed.add(entry);
      entry.inlineIn = null;
      entry.atomOf = null;
      if (leaf?.kind === "text") {
        // ADR 0432: an inline block, a control, an SVG or media element in a text is an atomic inline box of it.
        if (isInlineAtom(c)) {
          this.collectAtom(w, child, entry, leaf, leaf);
          continue;
        }
        // ADR 0429: a text's inline children (texts and images, nested ones too) are its runs: no boxes of their own.
        if (c instanceof UIText || c instanceof UIImage) {
          this.collectInline(w, child, entry, leaf, leaf);
          continue;
        }
      }
      if (leaf) {
        this.warnOnce(`leaf|${child.entity}`, `UI element "${child.name}" is under a ${leaf.comp.constructor.name}, which can't have children; it lays out beside it instead.`);
      }
      list.push(entry);
      this.collectChildren(w, child, entry, list);
    }
  }

  /** An element's own children: a leaf's join `list` (its parent's), a container's are its own. */
  private collectChildren(w: CollectWalk, node: GameObject, entry: Entry, list: Entry[]): void {
    if (isLeafKind(entry.kind)) {
      w.desired.set(entry, []);
      entry.inlineRuns = [];
      entry.atoms = [];
      this.walkUI(w, node, list, entry); // children of a leaf join its parent
    } else {
      const own: Entry[] = [];
      w.desired.set(entry, own);
      this.walkUI(w, node, own);
    }
  }

  /**
   * ADR 0432: an atomic inline box `entry` (on `node`) inside `within` (its text or an inline element) on `text`'s lines:
   * events go up through `within`; its Yoga node is a root of its own, its subtree laid out in it, and its size a run of the text.
   */
  private collectAtom(w: CollectWalk, node: GameObject, entry: Entry, within: Entry, text: Entry): void {
    entry.inlineIn = within;
    entry.atomOf = text;
    (text.atoms ??= []).push(entry);
    this.collectChildren(w, node, entry, []);
  }

  /** ADR 0429: an inline run `entry` (on `node`) inside `within` (its text or an inline element), and its own inline descendants. */
  private collectInline(w: CollectWalk, node: GameObject, entry: Entry, within: Entry, text: Entry): void {
    entry.inlineIn = within;
    (text.inlineRuns ??= []).push(entry);
    w.desired.set(entry, []);
    const walk = (n: GameObject) => {
      for (const child of n.children) {
        if (child.isComponentNode) continue;
        const c = w.byNode.get(child.entity);
        if (!c) {
          walk(child);
          continue;
        }
        if (c instanceof UICanvas) continue;
        const e = this.entries.get(c)!;
        e.canvas = w.canvas;
        w.placed.add(e);
        e.atomOf = null;
        if (isInlineAtom(c)) this.collectAtom(w, child, e, entry, text);
        else this.collectInline(w, child, e, entry, text);
      }
    };
    walk(node);
  }

  /** Make every Yoga node's children what `desired` says (and detach elements that have no place). */
  private attach(desired: Map<Entry, Entry[]>): void {
    const wanted = (e: Entry) => desired.get(e) ?? [];
    // Detach first, so a node moving between parents is free before its new parent takes it.
    for (const entry of this.entries.values()) {
      const want = wanted(entry);
      for (const c of entry.children) {
        if (c.parent === entry && !want.includes(c)) {
          holder(entry).removeChild(c.node);
          c.parent = null;
        }
      }
      entry.children = entry.children.filter((c) => c.parent === entry);
    }
    for (const entry of this.entries.values()) {
      const want = wanted(entry);
      const same = entry.children.length === want.length && entry.children.every((c, i) => c === want[i]);
      if (same) continue;
      for (const c of entry.children) {
        holder(entry).removeChild(c.node);
        c.parent = null;
      }
      want.forEach((c, i) => {
        holder(entry).insertChild(c.node, i);
        c.parent = entry;
      });
      entry.children = [...want];
    }
  }

  // --- Properties and layout ------------------------------------------------------------------

  private applyCanvas(canvas: CanvasEntry): void {
    const c = canvas.comp;
    const yoga = this.yoga!;
    if (c.mode === "world") {
      canvas.scale = 1;
      canvas.width = c.referenceResolution.x;
      canvas.height = c.referenceResolution.y;
    } else {
      const s = canvasScale(this.width, this.height, c.referenceResolution.x, c.referenceResolution.y, c.matchHeight);
      canvas.scale = s;
      canvas.width = this.width / s;
      canvas.height = this.height / s;
    }
    const n = canvas.node;
    n.setFlexDirection(yoga.FLEX_DIRECTION_ROW);
    n.setWidth(canvas.width);
    n.setHeight(canvas.height);
    n.setDisplay(c.isActiveAndEnabled ? yoga.DISPLAY_FLEX : yoga.DISPLAY_NONE);
  }

  private applyProperties(yoga: Yoga, entry: Entry): void {
    if (entry.kind === "canvas") return;
    const c = entry.comp as Exclude<UIComponentType, UICanvas>;
    const n = entry.node;
    const t = (this.tables ??= yogaTables(yoga));
    // Each value goes to Yoga only when it differs from what the node was last given: a Yoga setter is
    // a call into WebAssembly, and about twenty per element every frame added up (ADR 0075 notes).
    const last = entry.applied;
    const put = (slot: number, value: unknown): boolean => {
      if (last[slot] === value) return false;
      last[slot] = value;
      return true;
    };
    let v: unknown;
    if (put(0, (v = c.isActiveAndEnabled && c.display !== "none" ? yoga.DISPLAY_FLEX : yoga.DISPLAY_NONE))) n.setDisplay(v as never);
    if (put(1, (v = t.flexDirections[c.flexDirection] ?? yoga.FLEX_DIRECTION_ROW))) n.setFlexDirection(v as never);
    if (put(2, (v = t.justify[c.justifyContent] ?? yoga.JUSTIFY_FLEX_START))) n.setJustifyContent(v as never);
    if (put(3, (v = t.align[c.alignItems] ?? yoga.ALIGN_STRETCH))) n.setAlignItems(v as never);
    if (put(4, (v = finite(c.gap)))) n.setGap(yoga.GUTTER_ALL, v as number);
    // ADR 0422 wave 1: each side its own value, else the all-sides one (slots 5, 6 and 16 are the top edges).
    const pad = uiEdges(c.padding, c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft);
    const mar = uiEdges(c.margin, c.marginTop, c.marginRight, c.marginBottom, c.marginLeft);
    let bor = uiBorderEdges(c);
    // ADR 0432: `scrollbar-gutter: stable` reserves the vertical scrollbar's space between the border and the padding:
    // to Yoga, a wider border on that side (the padding box, `clientWidth`, shrinks; the drawn border doesn't change).
    const gutter = gutterOf(c, directionOf(entry) === "rtl");
    if (gutter.right || gutter.left) bor = [bor[0], bor[1] + gutter.right, bor[2], bor[3] + gutter.left];
    for (let i = 0; i < 4; i++) {
      const edge = t.edges[i];
      if (put(i === 0 ? 5 : 16 + i, pad[i])) n.setPadding(edge, pad[i]);
      if (put(i === 0 ? 6 : 19 + i, mar[i])) n.setMargin(edge, mar[i]);
      if (put(i === 0 ? 16 : 22 + i, bor[i])) n.setBorder(edge, bor[i]);
    }
    // ADR 0422 wave 5: lengths mixing % and px resolve in pixels against the parent's content size (last layout's).
    const basis = MIXED_FIELDS.some((f) => isMixedLength(c[f])) && entry.parent ? this.contentSize(entry.parent) : undefined;
    entry.calcBasis = basis;
    const bw = basis?.width, bh = basis?.height;
    if (put(7, (v = uiLength(c.width, bw)))) n.setWidth(v as never);
    if (put(8, (v = uiLength(c.height, bh)))) n.setHeight(v as never);
    if (put(9, (v = c.positionType === "absolute" ? yoga.POSITION_TYPE_ABSOLUTE : yoga.POSITION_TYPE_RELATIVE))) n.setPositionType(v as never);
    if (put(10, (v = autoToUndefined(uiLength(c.top, bh))))) n.setPosition(yoga.EDGE_TOP, v as never);
    if (put(11, (v = autoToUndefined(uiLength(c.right, bw))))) n.setPosition(yoga.EDGE_RIGHT, v as never);
    if (put(12, (v = autoToUndefined(uiLength(c.bottom, bh))))) n.setPosition(yoga.EDGE_BOTTOM, v as never);
    if (put(13, (v = autoToUndefined(uiLength(c.left, bw))))) n.setPosition(yoga.EDGE_LEFT, v as never);
    if (put(14, (v = finite(c.flexGrow)))) n.setFlexGrow(v as number);
    // Null: the kind's (text wraps to what's left; other boxes keep their size).
    // ADR 0427: in a parent the player scrolls along its main axis, content lays out unconstrained: a kind's default shrink is 0 there.
    if (put(15, (v = c.flexShrink === null || c.flexShrink === undefined ? (scrollsMainAxis(entry.parent) ? 0 : flexShrinkOf(entry.kind)) : finite(c.flexShrink)))) n.setFlexShrink(v as number);
    if (put(26, (v = uiLimit(c.minWidth, bw)))) n.setMinWidth(v as never);
    if (put(27, (v = uiLimit(c.maxWidth, bw)))) n.setMaxWidth(v as never);
    if (put(28, (v = uiLimit(c.minHeight, bh)))) n.setMinHeight(v as never);
    if (put(29, (v = uiLimit(c.maxHeight, bh)))) n.setMaxHeight(v as never);
    if (put(30, (v = t.wrap[c.flexWrap] ?? yoga.WRAP_NO_WRAP))) n.setFlexWrap(v as never);
    if (put(31, (v = t.alignSelf[c.alignSelf] ?? yoga.ALIGN_AUTO))) n.setAlignSelf(v as never);
    if (put(32, (v = t.alignContent[c.alignContent] ?? yoga.ALIGN_STRETCH))) n.setAlignContent(v as never);
    const rowParent = entry.parent?.kind === "canvas" || /^row/.test((entry.parent?.comp as { flexDirection?: string } | undefined)?.flexDirection ?? "");
    if (put(33, (v = uiLength(c.flexBasis, rowParent ? bw : bh) ?? "auto"))) n.setFlexBasis(v as never);
    if (put(34, (v = Number.isFinite(c.aspectRatio) && c.aspectRatio > 0 ? c.aspectRatio : undefined))) n.setAspectRatio(v as never);
    if (put(35, (v = isUserScroller(c) ? yoga.OVERFLOW_SCROLL : clipsChildren(c) ? yoga.OVERFLOW_HIDDEN : yoga.OVERFLOW_VISIBLE))) n.setOverflow(v as never);
    // ADR 0432: `direction` (null inherits, Yoga's own inheritance from the canvas's LTR).
    if (put(36, (v = c.direction === "rtl" ? yoga.DIRECTION_RTL : c.direction === "ltr" ? yoga.DIRECTION_LTR : yoga.DIRECTION_INHERIT))) n.setDirection(v as never);

    if (entry.run) this.updateRun(entry);
  }

  /**
   * The text run is the measure's dirty signature: a changed run, or a font arriving (which changes every text's size),
   * measures again. An unchanged run keeps its object, so `elements()` compare it by identity.
   */
  private updateRun(entry: Entry): void {
    const c = entry.comp;
    const run = textRunOf(c, this.atomSizes)!;
    const epoch = fontEpoch();
    // ADR 0428: a select's size follows every option's label, a text area's its rows.
    const key = entry.kind === "select" ? selectLabels(c as UISelect).join("\u0000") : entry.kind === "textarea" ? String((c as UITextArea).rows) : undefined;
    if (!sameTextRun(run, entry.run) || epoch !== entry.measuredEpoch || key !== entry.measureKey) {
      // ADR 0429: runs that changed only colour, decoration or background (a link's hover) are drawn again, not measured.
      const remeasure = !sameTextMeasure(run, entry.run) || epoch !== entry.measuredEpoch || key !== entry.measureKey;
      entry.run = run;
      entry.measuredEpoch = epoch;
      entry.measureKey = key;
      if (remeasure) entry.node.markDirty();
    }
  }

  /** ADR 0432: atomic inline boxes' sizes, from their own layouts, for their texts' runs. */
  private readonly atomSizes: UIInlineAtomSizes = (c) => this.entries.get(c)?.atomSize ?? null;

  /**
   * ADR 0432: lay every atomic inline box out in its own Yoga tree at its content's size (CSS's shrink-to-fit with room to
   * spare), innermost first, each text holding atoms taking their sizes into its runs before the box it's in is laid out.
   */
  private layoutAtoms(yoga: Yoga): void {
    const items: { e: Entry; depth: number }[] = [];
    const depthOf = (e: Entry) => {
      let d = 0;
      for (let at: Entry | null = e; at && at.kind !== "canvas"; at = up(at)) d++;
      return d;
    };
    for (const e of this.entries.values()) {
      if (!e.canvas) continue;
      if (e.atomOf) items.push({ e, depth: depthOf(e) });
      else if (e.kind === "text" && e.atoms?.length && e.run) items.push({ e, depth: depthOf(e) });
    }
    if (!items.length) return;
    items.sort((a, b) => b.depth - a.depth);
    for (const { e } of items) {
      if (!e.atomOf) {
        this.updateRun(e);
        continue;
      }
      const n = e.node;
      n.calculateLayout(undefined, undefined, yoga.DIRECTION_LTR);
      const margin = (edge: number) => (Number.isFinite(n.getComputedMargin(edge)) ? n.getComputedMargin(edge) : 0);
      const ml = margin(yoga.EDGE_LEFT), mr = margin(yoga.EDGE_RIGHT), mt = margin(yoga.EDGE_TOP), mb = margin(yoga.EDGE_BOTTOM);
      const w = n.getComputedWidth(), h = n.getComputedHeight();
      const shown = e.comp.isActiveAndEnabled && (e.comp as { display?: string }).display !== "none";
      const size = shown ? { width: w + ml + mr, height: h + mt + mb, baseline: mt + this.atomBaseline(e, h, mb) } : { width: 0, height: 0, baseline: 0 };
      const was = e.atomSize;
      if (!was || was.width !== size.width || was.height !== size.height || was.baseline !== size.baseline) e.atomSize = size;
    }
  }

  /**
   * ADR 0432: an atomic inline box's baseline, down from its border box's top: its last line of text's (a text, a
   * button's label, a field's value: the last such element in it), or its bottom margin edge when it has none or doesn't
   * show its overflow (as CSS's inline blocks; an image, an SVG, a video, a checkbox).
   */
  private atomBaseline(atom: Entry, height: number, marginBottom: number): number {
    const yoga = this.yoga!;
    const bottom = height + marginBottom;
    if (clipsChildren(atom.comp)) return bottom;
    const find = (e: Entry, oy: number): number | null => {
      for (let i = e.children.length - 1; i >= 0; i--) {
        const ch = e.children[i];
        if (!ch.comp.isActiveAndEnabled || (ch.comp as { display?: string }).display === "none") continue;
        const found = find(ch, oy + ch.node.getComputedTop());
        if (found !== null) return found;
      }
      const run = e.run;
      if (!run) return null;
      const n = e.node;
      const side = (edge: number) => (Number.isFinite(n.getComputedPadding(edge)) ? n.getComputedPadding(edge) : 0) + (Number.isFinite(n.getComputedBorder(edge)) ? n.getComputedBorder(edge) : 0);
      const fs = run.fontSize, lh = fs * run.lineHeight;
      const contentBottom = n.getComputedHeight() - side(yoga.EDGE_BOTTOM);
      return oy + contentBottom - (lh - (INLINE_ASCENT + INLINE_DESCENT) * fs) / 2 - INLINE_DESCENT * fs;
    };
    return find(atom, 0) ?? bottom;
  }

  /** ADR 0429: a string's width in a run's font: the host's exact measure, else an estimate (Node). */
  private readonly runWidth: RunMeasure = (text, run) => {
    const exact = this.host.measureRunWidth?.(text, inlineFont(run));
    if (exact !== undefined) return exact;
    let n = 0;
    for (const _ of text) n++;
    return n * 0.55 * run.fontSize;
  };

  /** ADR 0429: a text run with inline runs laid out at `maxWidth` (and aligned in `alignWidth`). */
  private layoutRuns(run: UITextRun, maxWidth: number, alignWidth?: number): UIInlineLayout {
    return layoutInline(run.runs!, { maxWidth: run.wrap === "none" ? Infinity : maxWidth, alignWidth, wrap: run.wrap, lineHeight: run.lineHeight, align: run.align, direction: run.direction, fontSize: run.fontSize, keepTrailingBreak: !!run.editable, boxes: run.boxes }, this.runWidth);
  }

  /** An entry's content box size at its last layout (a canvas's own size): what its children's percentages are of. */
  private contentSize(e: Entry): { width: number; height: number } {
    if (e.kind === "canvas") return { width: (e as CanvasEntry).width, height: (e as CanvasEntry).height };
    const n = e.node;
    const y = this.yoga!;
    const fin = (v: number) => (Number.isFinite(v) ? v : 0);
    const across = (a: number, b: number) => fin(n.getComputedPadding(a)) + fin(n.getComputedPadding(b)) + fin(n.getComputedBorder(a)) + fin(n.getComputedBorder(b));
    return {
      width: Math.max(0, fin(n.getComputedWidth()) - across(y.EDGE_LEFT, y.EDGE_RIGHT)),
      height: Math.max(0, fin(n.getComputedHeight()) - across(y.EDGE_TOP, y.EDGE_BOTTOM)),
    };
  }

  /** Measure the entry's text run, wrapped to `maxWidth` unless it doesn't wrap. */
  private measure(entry: Entry, maxWidth: number): { width: number; height: number } {
    const run = entry.run;
    if (!run) return { width: 0, height: 0 };
    const measure = (r: TextMeasureRequest) => this.host.measureText?.(r) ?? estimateText(r);
    const lineHeight = run.fontSize * run.lineHeight;
    // ADR 0428: a select fits its widest option's label; a text area is `rows` lines tall whatever its text (which scrolls).
    if (entry.kind === "select") {
      let width = 0;
      for (const text of selectLabels(entry.comp as UISelect)) width = Math.max(width, measure({ ...run, text, maxWidth: Infinity }).width);
      return { width, height: lineHeight };
    }
    if (entry.kind === "textarea") {
      const rows = Math.max(1, Math.round((entry.comp as UITextArea).rows) || 1);
      return { width: Number.isFinite(maxWidth) ? maxWidth : 20 * run.fontSize * 0.55, height: rows * lineHeight };
    }
    // ADR 0429: inline runs measure together, as they're laid out and drawn.
    if (run.runs) {
      const laid = this.layoutRuns(run, maxWidth);
      return { width: laid.width, height: laid.height };
    }
    const request: TextMeasureRequest = { ...run, maxWidth: run.wrap === "none" ? Infinity : maxWidth };
    return measure(request);
  }

  /**
   * Read Yoga's boxes into the entries' absolute (canvas UI pixel) boxes, visibility and opacity, in tree order; then
   * their clips (`overflow: hidden` ancestors' padding boxes) and draw order (ADR 0422).
   */
  private readLayout(canvas: CanvasEntry): void {
    canvas.elements = [];
    const cv = canvas.comp.isActiveAndEnabled;
    canvas.box = { x: 0, y: 0, width: canvas.width, height: canvas.height, visible: cv, opacity: 1 };
    const yoga = this.yoga!;
    type Walk = (visible: boolean, opacity: number, clip: UIRect | null, clipper: Entry | null, clips: readonly ClipStep[], reachClips: readonly ClipStep[], parentTransform: UIAffine | null, parentFilter: readonly UIFilterStep[] | null) => void;
    const walk = (parent: Entry, ox: number, oy: number, ...rest: Parameters<Walk>) => {
      for (const e of parent.children) visit(e, ox + e.node.getComputedLeft(), oy + e.node.getComputedTop(), ...rest);
    };
    /** One element, its border box at `x`, `y` (canvas UI pixels, layout space), then its children. */
    const visit = (e: Entry, x: number, y: number, ...[visible, opacity, clip, clipper, clips, reachClips, parentTransform, parentFilter]: Parameters<Walk>): void => {
      {
        const c = e.comp as Exclude<UIComponentType, UICanvas>;
        const n = e.node;
        const v = visible && c.isActiveAndEnabled && c.visible && c.display !== "none";
        const o = opacity * c.opacity;
        const width = n.getComputedWidth(), height = n.getComputedHeight();
        e.box = { x, y, width, height, visible: v, opacity: o };
        let childClip: UIRect | null = null;
        let scroll: UIScrollInfo | null = null;
        if (clipsChildren(c)) {
          const bl = n.getComputedBorder(yoga.EDGE_LEFT), bt = n.getComputedBorder(yoga.EDGE_TOP);
          const br = n.getComputedBorder(yoga.EDGE_RIGHT), bb = n.getComputedBorder(yoga.EDGE_BOTTOM);
          childClip = { x: x + bl, y: y + bt, width: Math.max(0, width - bl - br), height: Math.max(0, height - bt - bb) };
          scroll = this.scrollOf(e, childClip, bl, bt);
        }
        // ADR 0422 wave 3: its transform composes its parent's with its own; layout above ignored both.
        const transform = compose(parentTransform, localTransform(c as unknown as UITransformFields, e.box));
        const inverse = transform ? invert(transform) : null;
        // ADR 0430: its own filter (lengths through its transform) applies to it and its descendants, before its ancestors'.
        const own = filterStepsOf(c as unknown as UIFilterFields);
        const filter = own.length ? [...transformFilterSteps(own, transform), ...(parentFilter ?? [])] : parentFilter;
        // ADR 0432: its backdrop filter, its own only (what's behind it, not its subtree).
        const backdropOwn = filterStepsOf(backdropFilterFields(c));
        const backdrop = backdropOwn.length ? transformFilterSteps(backdropOwn, transform) : null;
        e.place = { clip, clipper, childClip, order: 0, clips, transform, inverse, bounds: drawnBounds(e.box, transform, clips), reachClips, reach: drawnBounds(e.box, transform, reachClips), scroll, filter, backdrop };
        canvas.elements.push(e);
        // ADR 0429: a text with inline runs is laid out at its content width; its runs get their fragments' bounds.
        if (e.kind === "text") this.placeInline(e);
        if (e.popup) {
          // ADR 0428: a select's list lays out at least as wide as the select, below it (above it where it wouldn't fit),
          // outside every clip; shown only while the select is open.
          const list = e.popup;
          list.setMinWidth(width);
          list.calculateLayout(undefined, undefined, yoga.DIRECTION_LTR);
          const lh = list.getComputedHeight();
          const below = y + height;
          const top = below + lh > canvas.height && y - lh >= 0 ? y - lh : below;
          walk(e, x - list.getComputedLeft(), top - list.getComputedTop(), v && (c as UISelect).open, o, null, null, [], [], transform, filter);
          return;
        }
        // ADR 0427: its children are drawn moved by its scroll; only a clip that doesn't scroll keeps navigation out.
        const sx = scroll?.x ?? 0, sy = scroll?.y ?? 0;
        const nextClips = childClip ? withClip(clips, childClip, transform, inverse) : clips;
        const nextReach = childClip && !isUserScroller(c) ? withClip(reachClips, childClip, transform, inverse) : reachClips;
        const inner: Parameters<Walk> = [v, o, childClip ? intersectRect(childClip, clip) : clip, childClip ? e : clipper, nextClips, nextReach, transform, filter];
        // ADR 0432: a text's atomic inline boxes, where its lines put them (each its own laid-out subtree), as its children.
        for (const atom of e.kind === "text" ? (e.atoms ?? []) : []) {
          const at = this.atomPlace(e, atom);
          if (at) visit(atom, at.x, at.y, ...inner);
        }
        walk(e, x - sx, y - sy, ...inner);
      }
    };
    walk(canvas, 0, 0, cv, 1, null, null, [], [], null, null);
    canvas.painted = paintOrder(canvas);
    // ADR 0428: open selects' lists draw (and take the pointer) above everything else in their canvas.
    const lists = canvas.painted.filter((e) => openSelectAbove(e));
    if (lists.length) canvas.painted = [...canvas.painted.filter((e) => !lists.includes(e)), ...lists];
    canvas.painted.forEach((e, i) => (e.place.order = i));
    canvas.hitOrder = hitOrderOf(canvas.painted);
  }

  /** ADR 0432: where an atomic inline box's border box goes on its text's lines (canvas UI pixels), or null when it's on none. */
  private atomPlace(text: Entry, atom: Entry): { x: number; y: number } | null {
    const laid = text.inline, runs = text.run?.runs;
    if (!laid || !runs) return null;
    const yoga = this.yoga!;
    const inset = laid.inset ?? { x: 0, y: 0 };
    for (const line of laid.lines) {
      for (const f of line.fragments) {
        if (runs[f.run].owner !== atom.comp || !runs[f.run].atom) continue;
        const n = atom.node;
        const margin = (edge: number) => (Number.isFinite(n.getComputedMargin(edge)) ? n.getComputedMargin(edge) : 0);
        return { x: text.box.x + inset.x + f.x + margin(yoga.EDGE_LEFT), y: text.box.y + inset.y + f.top + margin(yoga.EDGE_TOP) };
      }
    }
    return null;
  }

  /**
   * ADR 0429: lay a text's runs out at its content width (again only when its run, width or insets changed), and give each
   * of its inline runs a box (its fragments' bounds; at the text's content corner with no size when it has none) and the
   * text's placement, so events, `getBoundingClientRect` and hit-testing reach the run.
   */
  private placeInline(e: Entry): void {
    const run = e.run;
    if (!run?.runs) {
      e.inline = null;
      e.inlineFor = undefined;
      e.inlineHits = undefined;
      return;
    }
    const yoga = this.yoga!;
    const n = e.node;
    const side = (edge: number) => (Number.isFinite(n.getComputedPadding(edge)) ? n.getComputedPadding(edge) : 0) + (Number.isFinite(n.getComputedBorder(edge)) ? n.getComputedBorder(edge) : 0);
    const pl = side(yoga.EDGE_LEFT), pt = side(yoga.EDGE_TOP);
    const inner = Math.max(0, e.box.width - pl - side(yoga.EDGE_RIGHT));
    const insetKey = `${pl}|${pt}`;
    const f = e.inlineFor;
    let laid = e.inline;
    if (!laid || !f || f.run !== run || Math.abs(f.width - inner) > 1e-6 || f.inset !== insetKey) {
      laid = { ...this.layoutRuns(run, inner + 1e-6, inner), inset: { x: pl, y: pt } };
      e.inline = laid;
      e.inlineFor = { run, width: inner, inset: insetKey };
    }
    const ox = e.box.x + pl, oy = e.box.y + pt;
    const hits: NonNullable<Entry["inlineHits"]> = [];
    const boxes = new Map<Entry, UIRect>();
    for (const line of laid.lines) {
      for (const fr of line.fragments) {
        const r = run.runs[fr.run];
        const owner = r.owner && r.owner !== e.comp ? (this.entries.get(r.owner) ?? null) : null;
        const rect = { x: ox + fr.x, y: oy + line.top, width: fr.width, height: line.height };
        hits.push({ ...rect, owner });
        for (let at = owner; at && at !== e; at = at.inlineIn ?? null) {
          const b = boxes.get(at);
          boxes.set(at, b ? unionRect(b, rect) : rect);
        }
      }
    }
    // ADR 0432: an inline box's parts (its padding and border, past its glyphs) are its element's too, hit after the
    // fragments inside them (inner boxes before the boxes they're in).
    const boxHits: (typeof hits)[number][] = [];
    for (const line of laid.lines) {
      for (const part of line.boxes ?? []) {
        const owner = this.entries.get(run.boxes![part.box].owner) ?? null;
        if (!owner) continue;
        const rect = { x: ox + part.x, y: oy + part.top, width: part.width, height: part.height };
        boxHits.push({ ...rect, owner });
        for (let at: Entry | null = owner; at && at !== e; at = at.inlineIn ?? null) {
          const b = boxes.get(at);
          boxes.set(at, b ? unionRect(b, rect) : rect);
        }
      }
    }
    for (let i = boxHits.length - 1; i >= 0; i--) hits.push(boxHits[i]);
    e.inlineHits = hits;
    for (const re of e.inlineRuns ?? []) {
      const rect = boxes.get(re) ?? { x: ox, y: oy, width: 0, height: 0 };
      re.box = { ...rect, visible: e.box.visible && re.comp.isActiveAndEnabled && (re.comp as UIText).visible !== false, opacity: e.box.opacity * ((re.comp as UIText).opacity ?? 1) };
      re.place = { ...e.place, childClip: null, scroll: null, bounds: drawnBounds(rect, e.place.transform, e.place.clips), reach: drawnBounds(rect, e.place.transform, e.place.reachClips) };
    }
  }

  /**
   * ADR 0427: a clipping element's scroll state. Its content's extent is the union of its children's margin boxes (from
   * its padding box's corner) plus its end padding, at least the padding box; its offsets are clamped to that, and the
   * routing core writes the clamped values back. Scrollbars show on an axis the player scrolls: always for `scroll`,
   * for `auto` when the content overflows, never with `scrollbar-width: none`.
   *
   * ADR 0432: an axis whose content starts at its far end (`row-reverse`, `column-reverse`, `direction: rtl`) reaches
   * past its start edge instead, with offsets from a negative `min` to 0 (CSSOM's); the vertical bar is on the left in
   * `rtl`, and in a reserved gutter (`scrollbar-gutter: stable`) outside the padding box. A snapping scroller's snap
   * areas are measured here, and (the routing core, nothing holding it) it snaps again to what the layout moved.
   */
  private scrollOf(e: Entry, client: UIRect, bl: number, bt: number): UIScrollInfo {
    const yoga = this.yoga!;
    const c = e.comp as UIScrollable;
    const n = e.node;
    const pl = n.getComputedPadding(yoga.EDGE_LEFT), pt = n.getComputedPadding(yoga.EDGE_TOP);
    const pr = n.getComputedPadding(yoga.EDGE_RIGHT), pb = n.getComputedPadding(yoga.EDGE_BOTTOM);
    const origin = e.kind === "textarea" ? { x: false, y: false } : endOrigin(e);
    // The content's edges from the padding box's corner (the start ones from the content box, so none reach nothing).
    let left = pl, top = pt, right = 0, bottom = 0;
    if (e.kind === "textarea" && e.run) {
      // ADR 0428: a text area's content is its text, wrapped at its content width (inside its padding).
      const inner = Math.max(0, client.width - pl - pr);
      const text = this.host.measureText?.({ ...e.run, maxWidth: e.run.wrap === "none" ? Infinity : inner }) ?? estimateText({ ...e.run, maxWidth: e.run.wrap === "none" ? Infinity : inner });
      right = pl + text.width;
      bottom = pt + text.height;
    }
    for (const ch of e.popup ? [] : e.children) {
      const cc = ch.comp as UIScrollable;
      if (!cc.isActiveAndEnabled || cc.display === "none") continue;
      const cn = ch.node;
      left = Math.min(left, cn.getComputedLeft() - bl - cn.getComputedMargin(yoga.EDGE_LEFT));
      top = Math.min(top, cn.getComputedTop() - bt - cn.getComputedMargin(yoga.EDGE_TOP));
      right = Math.max(right, cn.getComputedLeft() - bl + cn.getComputedWidth() + cn.getComputedMargin(yoga.EDGE_RIGHT));
      bottom = Math.max(bottom, cn.getComputedTop() - bt + cn.getComputedHeight() + cn.getComputedMargin(yoga.EDGE_BOTTOM));
    }
    const minX = origin.x ? Math.min(0, left - pl) : 0, minY = origin.y ? Math.min(0, top - pt) : 0;
    const maxX = origin.x ? 0 : Math.max(0, right + pr - client.width), maxY = origin.y ? 0 : Math.max(0, bottom + pb - client.height);
    const scrollWidth = client.width + maxX - minX, scrollHeight = client.height + maxY - minY;
    const at = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(min, v), max) : 0);
    let x = at(c.scrollX, minX, maxX), y = at(c.scrollY, minY, maxY);
    const axes = overflowAxes(c);
    const userX = userScrollsAxis(axes.x), userY = userScrollsAxis(axes.y);
    const base: UIScrollInfo = { x, y, minX, minY, maxX, maxY, clientWidth: client.width, clientHeight: client.height, scrollWidth, scrollHeight, userX, userY, client, barX: null, barY: null, snap: this.snapOf(e, client, bl, bt) };
    if (!this.passive) {
      // ADR 0432: snapping again after a layout change, unless a drag or thumb holds it.
      const held = this.gesture?.scroller === e && (this.gesture.kind === "scroll" || this.gesture.kind === "thumb");
      if (this.world && !held) ({ x, y } = uiResnap(this.world, c, base, x, y));
      if (c.scrollX !== x) c.scrollX = x;
      if (c.scrollY !== y) c.scrollY = y;
    }
    const rtl = directionOf(e) === "rtl";
    const gutter = gutterOf(c, rtl);
    const t = SCROLLBAR_WIDTH[c.scrollbarWidth] ?? SCROLLBAR_WIDTH.auto;
    const showX = t > 0 && userX && (axes.x === "scroll" || maxX - minX > 0.5);
    const showY = t > 0 && userY && (axes.y === "scroll" || maxY - minY > 0.5);
    // The vertical bar in its gutter (outside the padding box), else over the content's edge.
    const inGutter = rtl ? gutter.left > 0 : gutter.right > 0;
    const overlayY = showY && !inGutter;
    const bar = (along: "x" | "y"): UIScrollbar => {
      if (along === "y") {
        const tx = inGutter ? (rtl ? client.x - t : client.x + client.width) : rtl ? client.x : client.x + client.width - t;
        const track = { x: tx, y: client.y, width: t, height: Math.max(0, client.height - (showX && !inGutter ? t : 0)) };
        const len = Math.min(track.height, Math.max(MIN_THUMB, (track.height * client.height) / scrollHeight));
        return { track, thumb: { x: track.x, y: track.y + (maxY > minY ? ((track.height - len) * (y - minY)) / (maxY - minY) : 0), width: t, height: len } };
      }
      const track = { x: client.x + (rtl && overlayY ? t : 0), y: client.y + client.height - t, width: Math.max(0, client.width - (overlayY ? t : 0)), height: t };
      const len = Math.min(track.width, Math.max(MIN_THUMB, (track.width * client.width) / scrollWidth));
      return { track, thumb: { x: track.x + (maxX > minX ? ((track.width - len) * (x - minX)) / (maxX - minX) : 0), y: track.y, width: len, height: t } };
    };
    return { ...base, x, y, barX: showX ? bar("x") : null, barY: showY ? bar("y") : null };
  }

  /**
   * ADR 0432: a scroller's snapping (`scroll-snap-type`): its snapport (the padding box inset by `scroll-padding`) and
   * the snap areas of the descendants it's the nearest clipping ancestor of (border box plus `scroll-margin`, transforms
   * aside), each with its snap positions per `scroll-snap-align`. Null when it doesn't snap.
   */
  private snapOf(e: Entry, client: UIRect, bl: number, bt: number): UIScrollSnap | null {
    const c = e.comp as UIScrollable;
    const axis = c.scrollSnapAxis;
    if (!axis || axis === "none") return null;
    const sx = axis === "x" || axis === "inline" || axis === "both";
    const sy = axis === "y" || axis === "block" || axis === "both";
    const f = finite;
    const port = { x: f(c.scrollPaddingLeft), y: f(c.scrollPaddingTop), width: Math.max(0, client.width - f(c.scrollPaddingLeft) - f(c.scrollPaddingRight)), height: Math.max(0, client.height - f(c.scrollPaddingTop) - f(c.scrollPaddingBottom)) };
    const position = (align: string, start: number, size: number, portStart: number, portSize: number): number | null =>
      align === "start" ? start - portStart : align === "end" ? start + size - (portStart + portSize) : align === "center" ? start + size / 2 - (portStart + portSize / 2) : null;
    const areas: UIScrollSnapArea[] = [];
    const visit = (parent: Entry, ox: number, oy: number) => {
      for (const ch of parent.popup ? [] : parent.children) {
        const cc = ch.comp as UIScrollable;
        if (ch.inlineIn || !cc.isActiveAndEnabled || cc.display === "none") continue;
        const cn = ch.node;
        const x = ox + cn.getComputedLeft(), y = oy + cn.getComputedTop();
        const ab = cc.scrollSnapAlignBlock ?? "none", ai = cc.scrollSnapAlignInline ?? "none";
        if (ab !== "none" || ai !== "none") {
          const ml = f(cc.scrollMarginLeft), mt = f(cc.scrollMarginTop);
          const area = { x: x - ml, y: y - mt, width: cn.getComputedWidth() + ml + f(cc.scrollMarginRight), height: cn.getComputedHeight() + mt + f(cc.scrollMarginBottom) };
          const px = sx ? position(ai, area.x, area.width, port.x, port.width) : null;
          const py = sy ? position(ab, area.y, area.height, port.y, port.height) : null;
          if (px !== null || py !== null) areas.push({ comp: cc, x: px, y: py, stop: cc.scrollSnapStop === "always", area });
        }
        // A clipping descendant is its own scroll container: its descendants snap in it.
        if (!clipsChildren(cc)) visit(ch, x, y);
      }
    };
    visit(e, -bl, -bt);
    return { x: sx, y: sy, mandatory: c.scrollSnapStrictness === "mandatory", port, areas };
  }

  /** Publish the results for the drawing layer, bumping `layoutVersion` only if something changed. */
  private collectResults(world: World, canvases: CanvasEntry[]): void {
    const canvasList: UILaidOutCanvas[] = [];
    const elementList: UILaidOutElement[] = [];
    for (const canvas of canvases) {
      const c = canvas.comp;
      let worldMatrix: Float32Array | null = null;
      if (c.mode === "world") {
        const e = c.owner.entity;
        worldMatrix = new Float32Array(16);
        Mat4.copy(worldMatrix, 0, world.worldMatrix(e), e * 16);
      }
      canvasList.push({ comp: c, mode: c.mode, sortOrder: c.sortOrder, width: canvas.width, height: canvas.height, scale: canvas.scale, pixelSize: c.mode === "world" ? c.pixelSize : 1, worldMatrix, visible: c.isActiveAndEnabled });
      for (const e of canvas.elements) {
        const b = e.box, p = e.place;
        // ADR 0428: a form element's parts, the same array while they don't change (the drawing layer compares by identity).
        const parts = b.visible ? formPartsOf(e.comp, b.width, b.height, world.time.realtimeSinceStartup) : null;
        const key = partsKey(parts);
        if (key !== e.partsKey) {
          e.partsKey = key;
          e.parts = parts;
        }
        // ADR 0437: its paint, its state colours resolved (the same object, nothing allocated, while unchanged, as parts are).
        e.paint = paintOf(e.comp, e.paint);
        elementList.push({ comp: e.comp, kind: e.kind as ElementKind, canvas: c, x: b.x, y: b.y, width: b.width, height: b.height, order: p.order, visible: b.visible, opacity: b.opacity, text: e.run, clip: p.clip, clipper: p.clipper?.comp ?? null, childClip: p.childClip, transform: p.transform, bounds: p.bounds, reach: p.reach, scroll: p.scroll, parts: e.parts ?? null, paint: e.paint ?? null, filter: p.filter, backdrop: p.backdrop ?? null, inline: e.kind === "text" ? (e.inline ?? null) : null, editing: this.editingOf(e) });
      }
    }
    const changed = !sameCanvases(this.canvasList, canvasList) || !sameElements(this.elementList, elementList);
    this.screenList = canvases.filter((c) => c.comp.mode === "screen" && c.comp.isActiveAndEnabled);
    if (!changed) return;
    this.canvasList = canvasList;
    this.elementList = elementList;
    this.layoutVersion++;
  }

  // --- Typing ---------------------------------------------------------------------------------

  /** The input field that should have the keyboard now: typing, laid out and visible. */
  private wantedField(): Entry | null {
    for (const e of this.entries.values()) {
      if ((e.kind !== "input" && e.kind !== "textarea") || !e.canvas) continue;
      const c = e.comp as UIInputField;
      if (c.typing && e.box.visible) return e;
    }
    return null;
  }

  /** The hidden element a field types in: an `<input>`, or (ADR 0428) a `<textarea>` for a text area, where Enter starts a line. */
  private ensureDom(multiline = false): HTMLInputElement | null {
    const have = multiline ? this.doms.area : this.doms.line;
    if (have) return have;
    if (typeof document === "undefined" || !document.body) return null;
    const el = document.createElement(multiline ? "textarea" : "input") as HTMLInputElement;
    if (!multiline) el.type = "text";
    el.autocomplete = "off";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    // The player's typing: the value now, the change event for the World's next frame (ADR 0309).
    const onInput = () => {
      // ADR 0429: an editable text's edit goes into its runs' components; `input` follows in the next frame.
      if (this.editing && this.editActive && this.dom === el) return this.editInput(el);
      const c = this.active;
      if (!c) return;
      let v = el.value;
      if (c.maxLength > 0 && v.length > c.maxLength) {
        v = v.slice(0, c.maxLength);
        el.value = v;
      }
      if (v === c.value) return;
      playerTyped(c, v);
      uiInteractions(c._world).record("change", c);
    };
    // Enter submits; Tab, Shift+Tab and Escape leave the field through navigation (ADR 0340), and their
    // presses stay the UI's until released, so the game (and the `ui` context) never sees them as new ones.
    const onKey = (e: KeyboardEvent) => {
      // ADR 0429: Escape leaves an editable text (Enter starts a line in it); Tab leaves it for navigation.
      if (this.editing && this.editActive && this.dom === el && !e.isComposing && e.keyCode !== 229) {
        if (e.key === "Escape" || e.key === "Tab") {
          if (e.key === "Tab") e.preventDefault?.();
          this.swallowed.push(e.key === "Tab" ? "tab" : "escape");
          this.endEditing();
          if (e.key === "Tab" && this.world) uiInteractions(this.world).request(e.shiftKey ? "previous" : "next");
        }
        return;
      }
      const c = this.active;
      if (!c) return;
      // While an IME composes (CJK, ADR 0356), Enter picks its candidate and Escape drops the composition.
      if (e.isComposing || e.keyCode === 229) return;
      const log = uiInteractions(c._world);
      if (e.key === "Enter") {
        if (!multiline) log.record("submit", c);
      } else if (e.key === "Escape") {
        this.swallowed.push("escape");
        log.request("cancel");
      } else if (e.key === "Tab") {
        e.preventDefault?.(); // not the browser's focus change
        this.swallowed.push("tab");
        if (e.shiftKey) this.swallowed.push("shift");
        log.request(e.shiftKey ? "previous" : "next");
      }
    };
    const onBlur = () => {
      if (!this.programmatic && this.editing && this.editActive && !this.pointerHeld) return this.endEditing();
      if (this.programmatic || !this.active) return;
      // A press on the canvas takes DOM focus first; routing re-focuses the field that press hit.
      if (this.pointerHeld) return;
      uiInteractions(this.active._world).blur(this.active, "script");
    };
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
    const before = this.detachDom;
    this.detachDom = () => {
      before?.();
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
      el.remove();
    };
    document.body.appendChild(el);
    if (multiline) this.doms.area = el;
    else this.doms.line = el;
    return el;
  }

  /** Move DOM focus to or from the wanted field's hidden input, and mirror `value` and `maxLength` into it. */
  private syncDom(): void {
    if (this.passive || typeof document === "undefined") return;
    // ADR 0429: an editable text being edited holds the hidden text area (its runs' text, images as U+FFFC).
    const ed = this.editing;
    if (ed && (!this.entries.has(ed.entry.comp) || !ed.entry.canvas || !ed.entry.box.visible || !ed.entry.run?.runs || !(ed.entry.comp as UIText).contentEditable)) this.endEditing();
    if (this.editing) return this.syncEditDom(this.editing);
    if (this.editActive) {
      this.editActive = null;
      this.unfocusDom();
    }
    const want = this.wantedField();
    const wantComp = want ? (want.comp as UIInputField) : null;
    if (!wantComp) {
      if (this.active) this.unfocusDom();
      return;
    }
    const el = this.ensureDom(want!.kind === "textarea");
    if (!el) return;
    if (this.dom !== el) {
      this.dom = el;
      this.active = null; // the other hidden element: take the value and focus over
    }
    if (this.active !== wantComp) {
      this.active = wantComp;
      el.value = wantComp.value;
      this.programmatic = true;
      el.focus();
      this.programmatic = false;
      el.setSelectionRange(el.value.length, el.value.length);
    } else if (document.activeElement !== el) {
      this.programmatic = true;
      el.focus();
      this.programmatic = false;
    }
    if (wantComp.maxLength > 0) el.maxLength = wantComp.maxLength;
    else el.removeAttribute("maxlength");
    const dir = want!.run?.direction ?? "ltr"; // the language's direction (ADR 0356 §5): the IME and selection follow it
    if (el.dir !== dir) el.dir = dir;
    if (el.value !== wantComp.value) el.value = wantComp.value; // a script changed it
  }

  // --- Editable text (ADR 0429) ----------------------------------------------------------------

  /** The text area an editable text types in: its text mirrored, focused, and the selection either way between them. */
  private syncEditDom(ed: EditState): void {
    const el = this.ensureDom(true);
    if (!el) return;
    this.dom = el;
    this.active = null;
    const run = ed.entry.run!;
    const comp = ed.entry.comp as UIText;
    if (this.editActive !== comp) {
      this.editActive = comp;
      el.value = ed.text = run.text;
      el.removeAttribute("maxlength");
      this.programmatic = true;
      el.focus();
      this.programmatic = false;
      ed.selectionChanged = true;
    } else if (document.activeElement !== el) {
      this.programmatic = true;
      el.focus();
      this.programmatic = false;
    }
    if (run.text !== ed.text && el.value === ed.text) {
      // A script changed the text (or an edit couldn't go in whole: an image stays): take it as it is now.
      el.value = ed.text = run.text;
      ed.anchor = Math.min(ed.anchor, run.text.length);
      ed.focus = Math.min(ed.focus, run.text.length);
      ed.selectionChanged = true;
    }
    if (el.dir !== run.direction) el.dir = run.direction;
    if (ed.selectionChanged) {
      ed.selectionChanged = false;
      const a = Math.min(ed.anchor, ed.focus), b = Math.max(ed.anchor, ed.focus);
      el.setSelectionRange(a, b, ed.anchor > ed.focus ? "backward" : "forward");
    } else {
      // The player moved the caret or the selection with the keys (or the IME did).
      const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
      const backward = el.selectionDirection === "backward";
      ed.anchor = backward ? e : s;
      ed.focus = backward ? s : e;
    }
  }

  /** The player typed in an editable text: the edit goes into its runs' components; `input` is sent in the next routing. */
  private editInput(el: HTMLInputElement): void {
    const ed = this.editing!;
    const next = el.value;
    if (next === ed.text || !ed.entry.run?.runs) return;
    applyInlineEdit(ed.entry.comp as UIText, ed.entry.run.runs, ed.text, next);
    ed.text = next;
    const s = el.selectionStart ?? next.length, e = el.selectionEnd ?? s;
    ed.anchor = s;
    ed.focus = e;
    uiInteractions(ed.entry.comp._world).queue(uiEventRecord("input", ed.entry.comp));
  }

  /** The editable text a press on `e` edits: the text it is or is a run of, when that text is editable. */
  private editableOf(e: Entry | null): Entry | null {
    let at = e;
    while (at?.inlineIn) at = at.inlineIn;
    return at && at.kind === "text" && (at.comp as UIText).contentEditable && at.run?.runs ? at : null;
  }

  /** The offset in an editable text nearest a canvas UI pixel point. */
  private editIndexAt(e: Entry, ux: number, uy: number): number {
    const laid = e.inline;
    const run = e.run;
    if (!laid || !run?.runs) return 0;
    const [lx, ly] = e.place.inverse ? applyAffine(e.place.inverse, ux, uy) : [ux, uy];
    const inset = laid.inset ?? { x: 0, y: 0 };
    return indexAt(laid, run.runs, lx - e.box.x - inset.x, ly - e.box.y - inset.y, this.runWidth, run.direction);
  }

  /** A press on an editable text: it starts (or goes on) being edited, the caret where the press was (Shift extends the selection). */
  private beginEditing(world: World, e: Entry, ux: number, uy: number, extend: boolean): void {
    const index = this.editIndexAt(e, ux, uy);
    if (this.editing && this.editing.entry !== e) this.endEditing();
    if (this.editing) {
      if (!extend) this.editing.anchor = index;
      this.editing.focus = index;
      this.editing.dragging = true;
      this.editing.selectionChanged = true;
      return;
    }
    this.editing = { entry: e, anchor: index, focus: index, text: e.run!.text, dragging: true, selectionChanged: true, shown: null, shownFor: null, shownAnchor: -1, shownFocus: -1 };
    uiInteractions(world).emit(uiEventRecord("focus", e.comp));
  }

  /** The editable text stops being edited: `blur` (and `focusout`) on it, and the hidden text area lets go. */
  private endEditing(): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    if (this.entries.has(ed.entry.comp)) uiInteractions(ed.entry.comp._world).queue(uiEventRecord("blur", ed.entry.comp));
    if (this.editActive) {
      this.editActive = null;
      this.unfocusDom();
    }
  }

  /** What an editable text being edited shows (the same object while nothing changes), or null for any other element. */
  private editingOf(e: Entry): UIInlineEditing | null {
    const ed = this.editing;
    if (!ed || ed.entry !== e || !e.inline || !e.run?.runs) return null;
    if (ed.shown && ed.shownFor === e.inline && ed.shownAnchor === ed.anchor && ed.shownFocus === ed.focus) return ed.shown;
    const runs = e.run.runs, laid = e.inline, dir = e.run.direction;
    const a = Math.min(ed.anchor, ed.focus, laid.text.length), b = Math.min(Math.max(ed.anchor, ed.focus), laid.text.length);
    ed.shown = a === b ? { caret: caretAt(laid, runs, a, this.runWidth, dir), selection: [] } : { caret: null, selection: selectionRects(laid, runs, a, b, this.runWidth, dir) };
    ed.shownFor = laid;
    ed.shownAnchor = ed.anchor;
    ed.shownFocus = ed.focus;
    return ed.shown;
  }

  private unfocusDom(): void {
    const el = this.dom;
    this.active = null;
    if (el && typeof document !== "undefined" && document.activeElement === el) {
      this.programmatic = true;
      el.blur();
      this.programmatic = false;
    }
  }

  // --- Pointer routing ------------------------------------------------------------------------

  /**
   * The routing step (ADR 0069, 0310), run in the device snapshot before any World steps: hit-test
   * the pointer against last frame's layout, claim it for UI, and hand the World's interaction log
   * (ADR 0309) what the pointer did; the log publishes the frame's events.
   *
   * ADR 0426: it also records the frame's UI events in order, each on the raycast target it happened on (the element
   * that claims the pointer, 0385): `pointerover`/`pointerout`/`pointerenter`/`pointerleave` as the target changes,
   * `pointermove`, `pointerdown`/`pointerup` for each button, `click` on what the left press and release share (and
   * `dblclick`), `contextmenu`, `wheel`, `keydown`/`keyup` on the focused element (else the scroller last pressed in),
   * `pointercancel` when a touch drag starts scrolling, and UI drags. Default actions ride on them, run after their
   * dispatch unless a handler prevents them: focus on press, scrolling (ADR 0427), a drag starting, submit on Enter.
   */
  private route(raw: PointerFrame): InputClaim | void {
    this.pointerHeld = raw.down(0) || raw.held(0);
    const world = this.world;
    const keys = this.swallowed;
    this.swallowed = [];
    if (this.disposed || !world) return;
    const log = uiInteractions(world);
    if (!this.interactiveMode || !world._takesInput) {
      if (log.layout === this) log.layout = null;
      log.idle();
      this.pressed = null;
      this.hoverTarget = this.pressTarget = this.activeScroller = null;
      this.gesture = null;
      return;
    }
    log.layout = this; // navigation searches this core's layout (ADR 0340)
    // A raycast target claims the pointer (ADR 0385); the button or input field it's in, if any, takes it.
    const blocked = this.hit(raw.x, raw.y);
    const hit = blocked?.handler ?? null;
    const usable = (e: Entry | null): e is Entry => !!e && e.comp instanceof UIButton && e.comp.interactable && e.comp.isActiveAndEnabled;
    // The pointer moving or pressing makes it the last UI input: focus colours hide.
    const last = this.lastPointer;
    const moved = !last || last.x !== raw.x || last.y !== raw.y;
    if (last && moved) log.navigating = false;
    this.lastPointer = { x: raw.x, y: raw.y };
    const now = world.time.realtimeSinceStartup;

    // ADR 0426: the frame's records, with what each needs.
    const records: UIEventRecord[] = [];
    const mods = { shiftKey: raw.keyHeld("shift"), ctrlKey: raw.keyHeld("control"), altKey: raw.keyHeld("alt"), metaKey: raw.keyHeld("meta") };
    const buttons = (raw.held(0) ? 1 : 0) | (raw.held(2) ? 2 : 0) | (raw.held(1) ? 4 : 0);
    const live = (e: Entry | null): Entry | null => (e && this.entries.has(e.comp) && e.canvas ? e : null);
    const pdata = (e: Entry | null, extra: UIEventData = {}): UIEventData => ({ canvasX: raw.x, canvasY: raw.y, ...this.pointAt(e, blocked, raw.x, raw.y), button: -1, buttons, pointerType: raw.pointerType, pointerId: raw.pointerType === "mouse" ? 1 : 2, isPrimary: true, ...mods, ...extra });
    const over = blocked?.target ?? null;
    const g = this.gesture;

    // Hover: out and leave from what it left, over and enter on what it's on (DOM order: leave innermost first, enter outermost first).
    const old = live(this.hoverTarget);
    if (over !== old) {
      const oldPath = old ? pathOf(old) : [];
      const newPath = over ? pathOf(over) : [];
      const related = (e: Entry | null) => ({ related: e?.comp ?? null });
      if (old) records.push(uiEventRecord("pointerout", old.comp, pdata(old, related(over))));
      for (const e of oldPath) if (!newPath.includes(e)) records.push(uiEventRecord("pointerleave", e.comp, pdata(e, related(over))));
      if (over) records.push(uiEventRecord("pointerover", over.comp, pdata(over, related(old))));
      for (let i = newPath.length - 1; i >= 0; i--) if (!oldPath.includes(newPath[i])) records.push(uiEventRecord("pointerenter", newPath[i].comp, pdata(newPath[i], related(old))));
    }
    this.hoverTarget = over;
    if (moved && over && g?.kind !== "scroll") records.push(uiEventRecord("pointermove", over.comp, pdata(over)));

    // Presses.
    if (raw.down(0)) {
      log.navigating = false;
      this.pressed = usable(hit) ? hit : null;
      // A press focuses what it hit (an input field starts typing); elsewhere it unfocuses, unless a modal canvas keeps focus.
      // ADR 0426: that's the pointerdown's default action, after its dispatch.
      // ADR 0428: every control takes focus this way, but an option (in a select's list) leaves it on its select.
      const target = hit && isFocusableUI(hit.comp) && hit.kind !== "option" ? (hit.comp as UIFocusableElement) : null;
      const press = pointerFocus(this, target);
      const typing = hit?.kind === "input" || hit?.kind === "textarea";
      this.pressTarget = over;
      const chain = over ? scrollChain(over) : [];
      for (const s of chain) uiStopScrolling(world, s.comp as UIScrollable); // a press stops a fling
      this.activeScroller = chain[0] ?? null;
      let source: Entry | null = null;
      for (let at = over; at && at.kind !== "canvas" && !source; at = up(at)) if ((at.comp as UIScrollable).draggable) source = at;
      const gesture: Gesture = { kind: "pending", pointerType: raw.pointerType, startX: raw.x, startY: raw.y, lastX: raw.x, lastY: raw.y, armed: true, target: over, source, chain, scroller: null, axis: null, startScroll: 0, scrollFrom: null, samples: [{ t: now, x: raw.x, y: raw.y }], data: null, dropTarget: null, accepts: false };
      let barAction: (() => void) | null = null;
      if (blocked?.bar && over) barAction = this.pressBar(world, gesture, over, blocked.bar, blocked.ux, blocked.uy);
      // ADR 0428: a press on a slider drags its thumb (not a scroll or a UI drag).
      const slider = !blocked?.bar && hit?.kind === "slider" && (hit.comp as UISlider).interactable ? hit : null;
      if (slider) {
        gesture.kind = "slider";
        gesture.scroller = slider;
        gesture.startScroll = (slider.comp as UISlider).value;
      }
      this.gesture = gesture;
      const ux = blocked?.ux ?? 0, uy = blocked?.uy ?? 0;
      records.push(
        uiEventRecord("pointerdown", over?.comp ?? null, pdata(over, { button: 0, buttons: buttons | 1 }), (prevented) => {
          if (prevented) {
            if (gesture.kind === "pending") gesture.armed = false;
            if (gesture.kind === "slider") gesture.kind = "none";
            return;
          }
          barAction?.();
          if (press.focus) log.focus(target, "press", typing);
          else if (!press.trapped) log.focus(null, "press");
          // ADR 0428: a press outside an open select's list closes it; on a slider, the thumb jumps there.
          const path = over ? pathOf(over) : [];
          for (const e of this.entries.values()) if (e.kind === "select" && (e.comp as UISelect).open && !path.includes(e)) setSelectOpen(e.comp as UISelect, false);
          if (slider && gesture.kind === "slider") this.slideTo(world, slider, ux, uy, null);
          // ADR 0429: a press on an editable text puts its caret there (and edits it); a press elsewhere ends editing.
          const editable = this.editableOf(over);
          if (editable && !press.trapped) this.beginEditing(world, editable, ux, uy, mods.shiftKey);
          else if (this.editing) this.endEditing();
        }),
      );
    }
    // ADR 0429: dragging from a press in an editable text selects.
    const ed = this.editing;
    if (ed?.dragging) {
      if (raw.held(0) && !raw.down(0) && moved) {
        const at = this.canvasPoint(ed.entry, raw.x, raw.y);
        if (at) {
          ed.focus = this.editIndexAt(ed.entry, at.x, at.y);
          ed.selectionChanged = true;
        }
      }
      if (!raw.held(0) && !raw.down(0)) ed.dragging = false;
    }
    for (const b of [1, 2]) {
      if (raw.down(b) && over) records.push(uiEventRecord("pointerdown", over.comp, pdata(over, { button: b, buttons: buttons | (b === 2 ? 2 : 4) })));
      if (raw.down(b) && over && b === 2) records.push(uiEventRecord("contextmenu", over.comp, pdata(over, { button: 2, buttons: buttons | 2 })));
      if (raw.up(b) && over) records.push(uiEventRecord("pointerup", over.comp, pdata(over, { button: b })));
    }

    // A held press moving: a touch or pen drag scrolls, a draggable element drags, a scrollbar thumb follows.
    if (g && g === this.gesture && raw.held(0) && !raw.down(0)) this.moveGesture(world, g, raw, records, pdata);
    const dragging = this.gesture?.kind === "drag" ? this.gesture : null;
    if (dragging && (raw.held(0) || raw.up(0))) {
      const source = live(dragging.source);
      const under = over;
      if (source) records.push(uiEventRecord("drag", source.comp, pdata(source, { dataTransfer: dragging.data! })));
      if (under !== dragging.dropTarget) {
        const before = live(dragging.dropTarget);
        if (before) records.push(uiEventRecord("dragleave", before.comp, pdata(before, { related: under?.comp ?? null, dataTransfer: dragging.data! })));
        if (under) records.push(uiEventRecord("dragenter", under.comp, pdata(under, { related: before?.comp ?? null, dataTransfer: dragging.data! })));
        dragging.dropTarget = under;
        dragging.accepts = false;
      }
      if (under && raw.held(0)) records.push(uiEventRecord("dragover", under.comp, pdata(under, { dataTransfer: dragging.data! }), (prevented) => (dragging.accepts = prevented)));
    }

    if (this.pressed && !this.entries.has(this.pressed.comp)) this.pressed = null;
    let clicked: UIButton | null = null;
    if (raw.up(0)) {
      const done = this.gesture;
      // ADR 0428: a slider let go after its value moved: `change` (its `input`s were sent as it moved).
      const slid = done?.kind === "slider" ? live(done.scroller) : null;
      if (slid && (slid.comp as UISlider).value !== done!.startScroll) log.record("change", slid.comp as UISlider);
      // ADR 0432: a scrollbar thumb let go snaps (as a gesture's end).
      if (done?.kind === "thumb" && done.scroller && done.scrollFrom && this.entries.has(done.scroller.comp)) uiEndScrollGesture(world, done.scroller.comp as UIScrollable, 0, 0, done.scrollFrom.x, done.scrollFrom.y);
      if (done?.kind === "scroll" && done.scroller) this.fling(world, done);
      else if (done?.kind === "drag") {
        const target = live(done.dropTarget);
        const source = live(done.source);
        if (target && done.accepts) records.push(uiEventRecord("drop", target.comp, pdata(target, { button: 0, dataTransfer: done.data! })));
        if (source) records.push(uiEventRecord("dragend", source.comp, pdata(source, { button: 0, dataTransfer: done.data! })));
      } else if (done?.kind !== "thumb" || over) {
        if (over) records.push(uiEventRecord("pointerup", over.comp, pdata(over, { button: 0 })));
        if (this.pressed && this.pressed === hit) clicked = this.pressed.comp as UIButton;
        // ADR 0426: `click` on the element the press and the release share, unless a disabled button holds it.
        const pressedOn = live(this.pressTarget);
        const target = pressedOn && over ? commonAncestor(pressedOn, over) : null;
        if (target && !disabledPath(target)) {
          const prev = this.lastClick;
          const again = prev && prev.comp === target.comp && now - prev.time <= DBLCLICK_SECONDS && Math.hypot(raw.x - prev.x, raw.y - prev.y) <= DBLCLICK_DISTANCE;
          const count = again ? prev.count + 1 : 1;
          this.lastClick = { comp: target.comp, time: now, x: raw.x, y: raw.y, count };
          // ADR 0428: its default action activates the control it's on (a checkbox toggles, an option is chosen…).
          const clickData = pdata(target, { button: 0, detail: count });
          const on = target.comp;
          records.push(uiClickRecord(world, on, clickData));
          if (count === 2) records.push(uiEventRecord("dblclick", target.comp, pdata(target, { button: 0, detail: 2 })));
        }
      }
      this.pressed = null;
      this.pressTarget = null;
      this.gesture = null;
    } else if (this.pressed && !raw.held(0) && !raw.down(0)) this.pressed = null; // released without an up (focus lost)
    if (this.gesture && !raw.held(0) && !raw.down(0) && !raw.up(0)) this.gesture = null;

    // The wheel (ADR 0427): the innermost scroller under the pointer that can still move that way takes it, as its default action.
    let wheelTaken = false;
    if ((raw.wheelX !== 0 || raw.wheelY !== 0) && over) {
      const scale = over.canvas?.comp.mode === "screen" ? over.canvas.scale : 1;
      let dx = raw.wheelX / scale, dy = raw.wheelY / scale;
      if (mods.shiftKey && dx === 0) [dx, dy] = [dy, 0]; // Shift turns the wheel sideways, as browsers do
      const chain = scrollChain(over);
      const sx = dx !== 0 ? pickScroller(chain, dx, 0) : null;
      const sy = dy !== 0 ? pickScroller(chain, 0, dy) : null;
      wheelTaken = !!(sx || sy);
      records.push(
        uiEventRecord("wheel", over.comp, pdata(over, { button: 0, deltaX: raw.wheelX, deltaY: raw.wheelY, deltaMode: 0 }), (prevented) => {
          if (prevented) return;
          if (sx) uiWheelScroll(world, sx.comp as UIScrollable, dx, 0);
          if (sy) uiWheelScroll(world, sy.comp as UIScrollable, 0, dy);
        }),
      );
    }

    // Keys (ADR 0426): to the focused element, else (ADR 0427) the scroller the last press landed in.
    const focusedEntry = live(log.focused ? (this.entries.get(log.focused) ?? null) : null);
    // ADR 0429: an editable text being edited has the keys, as a focused contenteditable does.
    const editingEntry = this.editing ? live(this.editing.entry) : null;
    const keyTarget = editingEntry ?? focusedEntry ?? live(this.activeScroller);
    if (keyTarget) {
      for (const k of raw.keys) {
        const data: UIEventData = { key: uiDomKey(k.key), code: uiDomCode(k.key), repeat: false, ...mods };
        if (!k.down) {
          records.push(uiEventRecord("keyup", keyTarget.comp, data));
          continue;
        }
        records.push(
          uiEventRecord("keydown", keyTarget.comp, data, (prevented) => {
            const field = keyTarget.comp instanceof UIInputField ? keyTarget.comp : null;
            if (prevented) {
              if (k.key === "enter" && field) log.retract("submit", field); // Enter's default: the submit
              return;
            }
            // ADR 0428: Page Up/Down and Home/End move a focused slider; a typing number field's arrows step it; Enter in a
            // one-line field submits its form.
            const c = keyTarget.comp;
            if (focusedEntry && c instanceof UISlider && this.keySlider(world, c, k.key)) return;
            if (field?.typing && field.type === "number" && (k.key === "arrowup" || k.key === "arrowdown")) {
              stepNumberField(world, field, k.key === "arrowup" ? 1 : -1);
              return;
            }
            if (k.key === "enter" && field?.typing && !(field instanceof UITextArea)) {
              const form = formOf(field);
              if (form) submitForm(world, form, true);
            }
            this.keyScroll(world, keyTarget, k.key, !focusedEntry && !editingEntry, !!field?.typing || !!editingEntry);
          }),
        );
      }
    }

    // ADR 0432: text elements and runs on the hovered path are `:hover`; on the pressed path while held, `:active`.
    const heldOn = raw.held(0) ? live(this.pressTarget) : null;
    log.route({ hovered: usable(hit) ? (hit.comp as UIButton) : null, pressed: (this.pressed?.comp as UIButton | undefined) ?? null, clicked, hoveredText: textsOn(live(this.hoverTarget)), pressedText: textsOn(heldOn) }, records);

    const focused = log.focused;
    const typing = focused instanceof UIInputField && focused.typing;
    return { pointer: !!blocked, keyboard: typing || !!this.editing, keys, wheel: wheelTaken };
  }

  /** ADR 0426: a point's position for an event on `e`: the target canvas's UI pixels, and `e`'s own (through its transform). */
  private pointAt(e: Entry | null, hit: Hit | null, x: number, y: number): UIEventData {
    let ux = hit?.ux ?? x, uy = hit?.uy ?? y;
    if (e?.canvas && hit && e.canvas !== hit.target.canvas && e.canvas.comp.mode === "screen") [ux, uy] = [x / e.canvas.scale, y / e.canvas.scale];
    else if (e?.canvas && !hit && e.canvas.comp.mode === "screen") [ux, uy] = [x / e.canvas.scale, y / e.canvas.scale];
    if (!e) return { clientX: ux, clientY: uy, offsetX: 0, offsetY: 0 };
    const [lx, ly] = e.place.inverse ? applyAffine(e.place.inverse, ux, uy) : [ux, uy];
    const offsetOf = (comp: UIComponentType) => {
      const o = this.entries.get(comp);
      if (!o) return null;
      const [ox, oy] = o.place.inverse ? applyAffine(o.place.inverse, ux, uy) : [ux, uy];
      return { x: ox - o.box.x, y: oy - o.box.y };
    };
    return { clientX: ux, clientY: uy, offsetX: lx - e.box.x, offsetY: ly - e.box.y, offsetOf };
  }

  /**
   * ADR 0427: a press on a scrollbar. On the thumb it starts dragging it; on the track it pages toward the press (the
   * pointerdown's default action, returned to run after its dispatch).
   */
  private pressBar(world: World, g: Gesture, scroller: Entry, axis: "x" | "y", ux: number, uy: number): (() => void) | null {
    const s = scroller.place.scroll;
    const bar = axis === "x" ? s?.barX : s?.barY;
    if (!s || !bar) return null;
    const [lx, ly] = scroller.place.inverse ? applyAffine(scroller.place.inverse, ux, uy) : [ux, uy];
    if (inRect(lx, ly, bar.thumb)) {
      g.kind = "thumb";
      g.scroller = scroller;
      g.axis = axis;
      g.startScroll = axis === "x" ? s.x : s.y;
      g.scrollFrom = { x: s.x, y: s.y };
      return null;
    }
    g.kind = "none";
    const before = axis === "x" ? lx < bar.thumb.x : ly < bar.thumb.y;
    const page = (axis === "x" ? s.clientWidth : s.clientHeight) * PAGE_SHARE * (before ? -1 : 1);
    return () => uiScrollBy(world, scroller.comp as UIScrollable, axis === "x" ? page : 0, axis === "y" ? page : 0);
  }

  /** ADR 0426/0427: a held press moved (the frames after it went down). */
  private moveGesture(world: World, g: Gesture, raw: PointerFrame, records: UIEventRecord[], pdata: (e: Entry | null, extra?: UIEventData) => UIEventData): void {
    const now = world.time.realtimeSinceStartup;
    g.samples.push({ t: now, x: raw.x, y: raw.y });
    while (g.samples.length > 2 && now - g.samples[0].t > 0.1) g.samples.shift();
    const scaleOf = (e: Entry | null) => (e?.canvas?.comp.mode === "screen" ? e.canvas.scale : 1);
    if (g.kind === "pending" && g.armed) {
      const fx = raw.x - g.startX, fy = raw.y - g.startY;
      const distance = Math.hypot(fx, fy);
      // A touch or pen drag past the threshold scrolls the innermost scroller that can move its main way; the press is cancelled.
      if (g.pointerType !== "mouse" && distance > TOUCH_SCROLL_THRESHOLD) {
        const along = Math.abs(fx) > Math.abs(fy) ? { dx: -fx, dy: 0 } : { dx: 0, dy: -fy };
        const scroller = pickScroller(g.chain, along.dx, along.dy);
        if (scroller) {
          g.kind = "scroll";
          g.scroller = scroller;
          g.scrollFrom = { x: (scroller.comp as UIScrollable).scrollX, y: (scroller.comp as UIScrollable).scrollY };
          const target = g.target && this.entries.has(g.target.comp) ? g.target : null;
          if (target) records.push(uiEventRecord("pointercancel", target.comp, pdata(target, { button: 0 })));
          this.pressed = null;
          this.pressTarget = null;
          const scale = scaleOf(scroller);
          uiScrollBy(world, scroller.comp as UIScrollable, -fx / scale, -fy / scale, "instant", "none");
        }
      }
      // A draggable element dragged past the threshold starts a UI drag, unless `dragstart` is prevented.
      if (g.kind === "pending" && g.source && distance > DRAG_THRESHOLD && this.entries.has(g.source.comp)) {
        g.kind = "none";
        g.data = new UIDataTransfer();
        records.push(
          uiEventRecord("dragstart", g.source.comp, pdata(g.source, { button: 0, dataTransfer: g.data }), (prevented) => {
            if (prevented || this.gesture !== g) return;
            g.kind = "drag";
            this.pressed = null; // a drag isn't a click
            this.pressTarget = null;
          }),
        );
      }
    } else if (g.kind === "slider" && g.scroller && this.entries.has(g.scroller.comp)) {
      // ADR 0428: the thumb follows the pointer; each new value sends `input`.
      const at = this.canvasPoint(g.scroller, raw.x, raw.y);
      if (at) this.slideTo(world, g.scroller, at.x, at.y, records);
    } else if (g.kind === "scroll" && g.scroller) {
      const scale = scaleOf(g.scroller);
      uiScrollBy(world, g.scroller.comp as UIScrollable, -(raw.x - g.lastX) / scale, -(raw.y - g.lastY) / scale, "instant", "none");
    } else if (g.kind === "thumb" && g.scroller && g.axis) {
      const s = g.scroller.place.scroll;
      const bar = g.axis === "x" ? s?.barX : s?.barY;
      if (s && bar) {
        const room = g.axis === "x" ? bar.track.width - bar.thumb.width : bar.track.height - bar.thumb.height;
        const moved = (g.axis === "x" ? raw.x - g.startX : raw.y - g.startY) / scaleOf(g.scroller);
        const range = g.axis === "x" ? s.maxX - s.minX : s.maxY - s.minY;
        const to = g.startScroll + (room > 0 ? (moved * range) / room : 0);
        uiScrollTo(world, g.scroller.comp as UIScrollable, g.axis === "x" ? to : null, g.axis === "y" ? to : null, "instant", { snap: "none" });
      }
    }
    g.lastX = raw.x;
    g.lastY = raw.y;
  }

  /** A canvas CSS point in `e`'s canvas's UI pixels (a world canvas through the view's ray); null when it misses the canvas. */
  private canvasPoint(e: Entry, x: number, y: number): { x: number; y: number } | null {
    const canvas = e.canvas;
    if (!canvas) return null;
    if (canvas.comp.mode === "screen") return { x: x / canvas.scale, y: y / canvas.scale };
    const laid = this.canvasList.find((l) => l.comp === canvas.comp);
    const ray = this.viewRay(x, y);
    const at = laid && ray ? this.onWorldCanvas(laid, ray) : null;
    return at ? { x: at.ux, y: at.uy } : null;
  }

  /**
   * ADR 0428: move a slider's thumb to a point (its canvas's UI pixels): the value there, snapped to its steps. A new
   * value sends `input`: into `records` from the routing, else now (a press's default action).
   */
  private slideTo(world: World, e: Entry, ux: number, uy: number, records: UIEventRecord[] | null): void {
    const s = e.comp as UISlider;
    const [lx] = e.place.inverse ? applyAffine(e.place.inverse, ux, uy) : [ux, uy];
    const thumb = e.box.height;
    const room = e.box.width - thumb;
    const f = room > 0 ? (lx - e.box.x - thumb / 2) / room : 0;
    if (!dragSlider(s, s.min + Math.min(1, Math.max(0, f)) * (s.max - s.min))) return;
    if (records) records.push(uiEventRecord("input", s));
    else fireUIEvent(world, uiEventRecord("input", s));
  }

  /** ADR 0428, 0436: a key's default action on a focused slider (Page Up/Down a page, Home/End its ends), as the form-control model's inputs. Returns whether it was one. */
  private keySlider(world: World, s: UISlider, key: string): boolean {
    if (key === "pageup" || key === "pagedown") pageSlider(world, s, key === "pageup" ? 1 : -1);
    else if (key === "home" || key === "end") sliderToEnd(world, s, key === "home" ? "min" : "max");
    else return false;
    return true;
  }

  /**
   * ADR 0427: a touch or pen drag scroll let go: it keeps moving at the speed of its last tenth of a second (ADR 0432:
   * or, snapping, eases to the snap position nearest where that would end).
   */
  private fling(world: World, g: Gesture): void {
    const a = g.samples[0], b = g.samples[g.samples.length - 1];
    const dt = b.t - a.t;
    if (!g.scroller || !this.entries.has(g.scroller.comp)) return;
    const scale = g.scroller.canvas?.comp.mode === "screen" ? g.scroller.canvas.scale : 1;
    const s = g.scroller.place.scroll;
    const vx = s?.userX && dt > 0 ? -(b.x - a.x) / dt / scale : 0;
    const vy = s?.userY && dt > 0 ? -(b.y - a.y) / dt / scale : 0;
    const comp = g.scroller.comp as UIScrollable;
    const from = g.scrollFrom ?? { x: comp.scrollX, y: comp.scrollY };
    uiEndScrollGesture(world, comp, vx, vy, from.x, from.y);
  }

  /**
   * ADR 0427: keyboard scrolling, a keydown's default action. Page Up/Down and Home/End scroll the scroller the target is
   * in (not while an input field types, for Home/End); with nothing focused (the target is the scroller last pressed
   * in), the arrow keys scroll too (with something focused they're navigation's, ADR 0340).
   */
  private keyScroll(world: World, target: Entry, key: string, nothingFocused: boolean, typing: boolean): void {
    const page = key === "pageup" || key === "pagedown";
    const edge = key === "home" || key === "end";
    const arrow = key === "arrowup" || key === "arrowdown" || key === "arrowleft" || key === "arrowright";
    if (!page && !(edge && !typing) && !(arrow && nothingFocused)) return;
    const horizontal = key === "arrowleft" || key === "arrowright";
    const sign = key === "pageup" || key === "home" || key === "arrowup" || key === "arrowleft" ? -1 : 1;
    const scroller = pickScroller(scrollChain(target), horizontal ? sign : 0, horizontal ? 0 : sign);
    const s = scroller?.place.scroll;
    if (!scroller || !s) return;
    const comp = scroller.comp as UIScrollable;
    if (edge) uiScrollTo(world, comp, null, sign < 0 ? s.minY : s.maxY);
    else if (page) uiScrollBy(world, comp, 0, sign * s.clientHeight * PAGE_SHARE);
    else uiScrollBy(world, comp, horizontal ? sign * ARROW_STEP : 0, horizontal ? 0 : sign * ARROW_STEP);
  }

  /**
   * Editor (ADR 0077 wave B): every drawn element under a canvas CSS point, not only interactive ones,
   * topmost first: screen canvases from the highest `sortOrder` (each canvas's elements from the last
   * drawn), then world canvases nearest first. Canvases themselves aren't listed. `ray` is the view's
   * ray under the point for world canvases (the editor passes its scene camera's); without it the
   * host's view camera makes one.
   */
  pickAll(x: number, y: number, ray?: UIPickRay | null): UIComponentType[] {
    const out: UIComponentType[] = [];
    for (let k = this.screenList.length - 1; k >= 0; k--) {
      const canvas = this.screenList[k];
      const px = x / canvas.scale, py = y / canvas.scale;
      for (let i = canvas.painted.length - 1; i >= 0; i--) {
        const e = canvas.painted[i];
        if (!this.hittable(e)) continue;
        if (!onDrawnBox(e, px, py)) continue;
        const run = this.runAt(e, px, py); // ADR 0429: the run under the point first, then its text
        if (run) out.push(run.comp);
        out.push(e.comp);
      }
    }
    const r = ray ?? this.viewRay(x, y);
    if (!r) return out;
    const hits: { comps: UIComponentType[]; t: number }[] = [];
    for (const laid of this.canvasList) {
      const canvas = laid.mode === "world" ? this.canvasEntries.get(laid.comp) : undefined;
      const at = canvas ? this.onWorldCanvas(laid, r) : null;
      if (!canvas || !at) continue;
      const comps: UIComponentType[] = [];
      for (let i = canvas.painted.length - 1; i >= 0; i--) {
        const e = canvas.painted[i];
        if (!this.hittable(e)) continue;
        if (!onDrawnBox(e, at.ux, at.uy)) continue;
        const run = this.runAt(e, at.ux, at.uy);
        if (run) comps.push(run.comp);
        comps.push(e.comp);
      }
      if (comps.length) hits.push({ comps, t: at.t });
    }
    hits.sort((a, b) => a.t - b.t);
    for (const h of hits) out.push(...h.comps);
    return out;
  }

  /**
   * Editor (ADR 0117): the canvases a click selects, topmost first. A world canvas is a plane in the
   * scene: its whole rectangle counts (nearest first). A screen canvas covers the view, so only a strip
   * `edge` CSS pixels wide along the inside of its frame counts; a click on its bare interior never
   * selects it (that click deselects). Screen canvases come before world ones, highest `sortOrder` first.
   */
  pickCanvases(x: number, y: number, ray?: UIPickRay | null, edge = 8): UICanvas[] {
    const out: UICanvas[] = [];
    for (let k = this.screenList.length - 1; k >= 0; k--) {
      const c = this.screenList[k];
      if (c.comp.node.activeInHierarchy && onFrameEdge(x, y, c.width * c.scale, c.height * c.scale, edge)) out.push(c.comp);
    }
    const r = ray ?? this.viewRay(x, y);
    if (!r) return out;
    const hits: { comp: UICanvas; t: number }[] = [];
    for (const laid of this.canvasList) {
      if (laid.mode !== "world") continue;
      const at = this.onWorldCanvas(laid, r);
      if (at && at.ux >= 0 && at.ux <= laid.width && at.uy >= 0 && at.uy <= laid.height) hits.push({ comp: laid.comp, t: at.t });
    }
    hits.sort((a, b) => a.t - b.t);
    for (const h of hits) out.push(h.comp);
    return out;
  }

  /**
   * Editor (ADR 0077 wave B): an element's box corners (top-left, top-right, bottom-right,
   * bottom-left) from the last layout: canvas CSS pixels `[x, y]` on a screen canvas, world points
   * `[x, y, z]` on a world canvas, with the box's size in UI pixels. Null when it isn't laid out. `clip` has the
   * corners of the part that's drawn when an `overflow: hidden` ancestor clips it (ADR 0422).
   */
  cornersOf(c: UIComponentType): UICorners | null {
    const entry = this.entries.get(c);
    const canvas = entry?.canvas;
    if (!entry || !canvas || !this.yoga) return null;
    const b = entry.box;
    const p = entry.place;
    // ADR 0422 wave 3: the corners as drawn (its transform), and as laid out in its parent's frame (its ancestors' only).
    const clipRect = p.clips.length ? localClip(b, p) : null;
    const drawn = transformRect(p.transform, b);
    const laid = transformRect(entry.parent?.place.transform ?? null, b);
    const clipped = clipRect ? transformRect(p.transform, clipRect) : null;
    const size: [number, number] = [b.width, b.height];
    if (canvas.comp.mode !== "world") {
      const toCanvas = (pts: [number, number][]) => pts.map(([x, y]) => [x * canvas.scale, y * canvas.scale]);
      return { space: "screen", points: toCanvas(drawn), size, clip: clipped ? toCanvas(clipped) : null, layoutPoints: toCanvas(laid) };
    }
    const plane = this.canvasList.find((l) => l.comp === canvas.comp);
    if (!plane?.worldMatrix) return null;
    const m = plane.worldMatrix;
    const toWorld = (pts: [number, number][]) =>
      pts.map(([x, y]) => {
        const lx = (x - plane.width / 2) * plane.pixelSize, ly = (plane.height / 2 - y) * plane.pixelSize;
        return [m[0] * lx + m[4] * ly + m[12], m[1] * lx + m[5] * ly + m[13], m[2] * lx + m[6] * ly + m[14]];
      });
    return { space: "world", points: toWorld(drawn), size, clip: clipped ? toWorld(clipped) : null, layoutPoints: toWorld(laid) };
  }

  private viewRay(x: number, y: number): UIPickRay | null {
    const camera = this.host.viewCamera?.();
    if (!camera) return null;
    const ray = camera.screenPointToRay(new Vector2(x, y));
    return { origin: [ray.origin.x, ray.origin.y, ray.origin.z], direction: [ray.direction.x, ray.direction.y, ray.direction.z] };
  }

  /** Where a ray meets a world canvas, in its UI pixels, with the ray parameter (a world distance); null if it misses the plane. */
  private onWorldCanvas(laid: UILaidOutCanvas, ray: UIPickRay): { ux: number; uy: number; t: number } | null {
    if (!laid.visible || !laid.worldMatrix) return null;
    // The ray in the canvas's local space (an affine map keeps the ray parameter, so t is a world distance).
    Mat4.invert(scratchInv, 0, laid.worldMatrix, 0);
    const m = scratchInv;
    const [oX, oY, oZ] = ray.origin, [dX, dY, dZ] = ray.direction;
    const ox = m[0] * oX + m[4] * oY + m[8] * oZ + m[12], oy = m[1] * oX + m[5] * oY + m[9] * oZ + m[13], oz = m[2] * oX + m[6] * oY + m[10] * oZ + m[14];
    const dx = m[0] * dX + m[4] * dY + m[8] * dZ, dy = m[1] * dX + m[5] * dY + m[9] * dZ, dz = m[2] * dX + m[6] * dY + m[10] * dZ;
    if (Math.abs(dz) < 1e-9) return null;
    const t = -oz / dz;
    if (t < 0) return null;
    return { ux: (ox + dx * t) / laid.pixelSize + laid.width / 2, uy: laid.height / 2 - (oy + dy * t) / laid.pixelSize, t };
  }

  /**
   * What the pointer meets at a canvas point (ADR 0385): the topmost raycast target (`target`, an element whose
   * `raycastTarget` is on and that is a graphic), screen canvases from the highest `sortOrder`, then the nearest in
   * world canvases; and the button or input field that takes it (`handler`: the target or its nearest such ancestor,
   * as Unity's events bubble to their handler), null when the target only blocks. Null when no target is there.
   * ADR 0427: a scroller's scrollbars, drawn over its content, are met before it (the target is the scroller, `bar` the axis).
   */
  private hit(x: number, y: number): Hit | null {
    for (let k = this.screenList.length - 1; k >= 0; k--) {
      const canvas = this.screenList[k];
      const found = this.hitIn(canvas, x / canvas.scale, y / canvas.scale);
      if (found) return found;
    }
    const ray = this.viewRay(x, y);
    if (!ray) return null;
    let best: Hit | null = null, bestDistance = Infinity;
    for (const laid of this.canvasList) {
      const canvas = laid.mode === "world" ? this.canvasEntries.get(laid.comp) : undefined;
      const at = canvas ? this.onWorldCanvas(laid, ray) : null;
      if (!canvas || !at) continue;
      const found = this.hitIn(canvas, at.ux, at.uy); // the topmost of this canvas
      if (found && at.t < bestDistance) [best, bestDistance] = [found, at.t];
    }
    return best;
  }

  /** The topmost raycast target (or scrollbar) of a canvas at a point in its UI pixels. */
  private hitIn(canvas: CanvasEntry, ux: number, uy: number): Hit | null {
    const order = canvas.hitOrder;
    for (let i = order.length - 1; i >= 0; i--) {
      const item = order[i];
      if ("bar" in item) {
        const e = item.scroller;
        const s = e.place.scroll;
        const bar = item.bar === "x" ? s?.barX : s?.barY;
        if (!bar || !this.hittable(e) || (e.place.transform && !e.place.inverse)) continue;
        const [lx, ly] = e.place.inverse ? applyAffine(e.place.inverse, ux, uy) : [ux, uy];
        if (inRect(lx, ly, bar.track) && inClips(ux, uy, e.place.clips)) return { target: e, handler: handlerOf(e), ux, uy, bar: item.bar };
        continue;
      }
      if (!this.hittable(item) || !isRaycastTarget(item.comp)) continue;
      if (onDrawnBox(item, ux, uy)) {
        // ADR 0429: on a text with runs, the run under the point (its element) is the target.
        const run = this.runAt(item, ux, uy);
        const target = run && this.hittable(run) && isRaycastTarget(run.comp) ? run : item;
        return { target, handler: handlerOf(target), ux, uy, bar: null };
      }
    }
    return null;
  }

  /** ADR 0429: the inline run (its element) under a canvas point on a text with runs, or null (between runs, or plain text). */
  private runAt(e: Entry, ux: number, uy: number): Entry | null {
    const hits = e.inlineHits;
    if (!hits?.length) return null;
    const [lx, ly] = e.place.inverse ? applyAffine(e.place.inverse, ux, uy) : [ux, uy];
    for (const h of hits) if (h.owner && lx >= h.x && lx <= h.x + h.width && ly >= h.y && ly <= h.y + h.height) return this.entries.has(h.owner.comp) ? h.owner : null;
    return null;
  }

  private hittable(e: Entry): boolean {
    return e.comp.isActiveAndEnabled && e.box.visible && e.canvas !== null && !inertEntry(e);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}

/** Yoga's enum values by the components' property values. */
function yogaTables(yoga: Yoga) {
  return {
    flexDirections: { row: yoga.FLEX_DIRECTION_ROW, column: yoga.FLEX_DIRECTION_COLUMN, "row-reverse": yoga.FLEX_DIRECTION_ROW_REVERSE, "column-reverse": yoga.FLEX_DIRECTION_COLUMN_REVERSE } as Record<string, number>,
    justify: { "flex-start": yoga.JUSTIFY_FLEX_START, center: yoga.JUSTIFY_CENTER, "flex-end": yoga.JUSTIFY_FLEX_END, "space-between": yoga.JUSTIFY_SPACE_BETWEEN, "space-around": yoga.JUSTIFY_SPACE_AROUND, "space-evenly": yoga.JUSTIFY_SPACE_EVENLY } as Record<string, number>,
    align: { "flex-start": yoga.ALIGN_FLEX_START, center: yoga.ALIGN_CENTER, "flex-end": yoga.ALIGN_FLEX_END, stretch: yoga.ALIGN_STRETCH, baseline: yoga.ALIGN_BASELINE } as Record<string, number>,
    // ADR 0422 wave 1.
    edges: [yoga.EDGE_TOP, yoga.EDGE_RIGHT, yoga.EDGE_BOTTOM, yoga.EDGE_LEFT] as const,
    wrap: { nowrap: yoga.WRAP_NO_WRAP, wrap: yoga.WRAP_WRAP, "wrap-reverse": yoga.WRAP_WRAP_REVERSE } as Record<string, number>,
    alignSelf: { auto: yoga.ALIGN_AUTO, "flex-start": yoga.ALIGN_FLEX_START, center: yoga.ALIGN_CENTER, "flex-end": yoga.ALIGN_FLEX_END, stretch: yoga.ALIGN_STRETCH, baseline: yoga.ALIGN_BASELINE } as Record<string, number>,
    alignContent: { "flex-start": yoga.ALIGN_FLEX_START, center: yoga.ALIGN_CENTER, "flex-end": yoga.ALIGN_FLEX_END, stretch: yoga.ALIGN_STRETCH, "space-between": yoga.ALIGN_SPACE_BETWEEN, "space-around": yoga.ALIGN_SPACE_AROUND, "space-evenly": yoga.ALIGN_SPACE_EVENLY } as Record<string, number>,
  };
}

/** ADR 0427: true when the player scrolls `parent` along its flex direction (its children then keep their size along it). */
function scrollsMainAxis(parent: Entry | null): boolean {
  if (!parent || parent.kind === "canvas") return false;
  const c = parent.comp as UIScrollable;
  const axes = overflowAxes(c);
  const row = c.flexDirection === "row" || c.flexDirection === "row-reverse";
  return userScrollsAxis(row ? axes.x : axes.y);
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** Yoga reads `undefined` as unset; `"auto"` for a position edge means the same. */
function autoToUndefined(v: number | `${number}%` | "auto" | undefined): number | `${number}%` | undefined {
  return v === "auto" ? undefined : v;
}

function sameCanvases(a: readonly UILaidOutCanvas[], b: readonly UILaidOutCanvas[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x.comp !== y.comp || x.mode !== y.mode || x.sortOrder !== y.sortOrder || x.width !== y.width || x.height !== y.height || x.scale !== y.scale || x.pixelSize !== y.pixelSize || x.visible !== y.visible) return false;
    if (!x.worldMatrix || !y.worldMatrix) return x.worldMatrix === y.worldMatrix;
    return x.worldMatrix.every((v, k) => v === y.worldMatrix![k]);
  });
}

function sameElements(a: readonly UILaidOutElement[], b: readonly UILaidOutElement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.comp === y.comp && x.canvas === y.canvas && x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height && x.order === y.order && x.visible === y.visible && x.opacity === y.opacity && x.text === y.text && x.clipper === y.clipper && sameRect(x.clip, y.clip) && sameRect(x.childClip, y.childClip) && sameAffine(x.transform, y.transform) && sameRect(x.bounds, y.bounds) && sameRect(x.reach, y.reach) && sameScroll(x.scroll, y.scroll) && x.parts === y.parts && x.paint === y.paint && sameFilter(x.filter, y.filter) && sameFilter(x.backdrop, y.backdrop) && (x.inline ?? null) === (y.inline ?? null) && (x.editing ?? null) === (y.editing ?? null);
  });
}

/** ADR 0430, 0432: true when two filter step lists (a filter or a backdrop) draw the same. Each sync builds new lists. */
function sameFilter(a: readonly UIFilterStep[] | null | undefined, b: readonly UIFilterStep[] | null | undefined): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    if (p.kind !== q.kind) return false;
    switch (p.kind) {
      case "blur":
        return p.radius === (q as typeof p).radius;
      case "hue-rotate":
        return p.degrees === (q as typeof p).degrees;
      case "drop-shadow": {
        const d = q as typeof p;
        return p.x === d.x && p.y === d.y && p.blur === d.blur && p.color.r === d.color.r && p.color.g === d.color.g && p.color.b === d.color.b && p.color.a === d.color.a;
      }
      default:
        return p.amount === (q as typeof p).amount;
    }
  });
}

function sameScroll(a: UIScrollInfo | null, b: UIScrollInfo | null): boolean {
  if (!a || !b) return a === b;
  const bar = (p: UIScrollbar | null, q: UIScrollbar | null) => (!p || !q ? p === q : sameRect(p.track, q.track) && sameRect(p.thumb, q.thumb));
  return a.x === b.x && a.y === b.y && a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY && a.userX === b.userX && a.userY === b.userY && sameRect(a.client, b.client) && bar(a.barX, b.barX) && bar(a.barY, b.barY) && sameSnap(a.snap, b.snap);
}

/** ADR 0432: true when two scrollers' snapping is the same. */
function sameSnap(a: UIScrollSnap | null, b: UIScrollSnap | null): boolean {
  if (!a || !b) return a === b;
  if (a.x !== b.x || a.y !== b.y || a.mandatory !== b.mandatory || !sameRect(a.port, b.port) || a.areas.length !== b.areas.length) return false;
  return a.areas.every((p, i) => {
    const q = b.areas[i];
    return p.comp === q.comp && p.x === q.x && p.y === q.y && p.stop === q.stop && sameRect(p.area, q.area);
  });
}

/** ADR 0432: an element's direction: its own `direction`, else its nearest ancestor's, else `ltr` (the canvas's). */
function directionOf(e: Entry | null): "ltr" | "rtl" {
  for (let at = e; at && at.kind !== "canvas"; at = at.parent) {
    const d = (at.comp as UIScrollable).direction;
    if (d === "ltr" || d === "rtl") return d;
  }
  return "ltr";
}

/**
 * ADR 0432: the axes of a scroller whose content starts at the far end, so it scrolls from there (CSS's scroll origin):
 * horizontally in `rtl` (unless `row-reverse` turns it back) or `row-reverse`, vertically in `column-reverse`.
 */
function endOrigin(e: Entry): { x: boolean; y: boolean } {
  const c = e.comp as UIScrollable;
  return { x: (directionOf(e) === "rtl") !== (c.flexDirection === "row-reverse"), y: c.flexDirection === "column-reverse" };
}

/** ADR 0432: the scrollbar gutter `scrollbar-gutter: stable` reserves on each side (UI pixels): the bar's side (left in `rtl`), or both. */
function gutterOf(c: UIScrollable, rtl: boolean): { left: number; right: number } {
  const g = c.scrollbarGutter;
  if ((g !== "stable" && g !== "stable both-edges") || !clipsChildren(c)) return { left: 0, right: 0 };
  const t = SCROLLBAR_WIDTH[c.scrollbarWidth] ?? SCROLLBAR_WIDTH.auto;
  if (g === "stable both-edges") return { left: t, right: t };
  return rtl ? { left: t, right: 0 } : { left: 0, right: t };
}

/**
 * ADR 0427: hit-testing order: the draw order with each scroller's scrollbars right after its last descendant (they're
 * drawn over its content, under whatever is drawn after it). A scroller's descendants follow it in `painted`.
 */
function hitOrderOf(painted: readonly Entry[]): HitItem[] {
  const index = new Map<Entry, number>();
  painted.forEach((e, i) => index.set(e, i));
  const lastOf = (e: Entry): number => {
    let last = index.get(e) ?? -1;
    for (const c of e.children) last = Math.max(last, lastOf(c));
    return last;
  };
  const after = new Map<number, HitItem[]>();
  for (let i = painted.length - 1; i >= 0; i--) {
    const e = painted[i];
    const s = e.place.scroll;
    if (!s || (!s.barX && !s.barY)) continue;
    const at = lastOf(e);
    const list = after.get(at) ?? [];
    // An outer scroller's bars go after an inner one's ending at the same place (visited later, pushed last).
    if (s.barX) list.push({ bar: "x", scroller: e });
    if (s.barY) list.push({ bar: "y", scroller: e });
    after.set(at, list);
  }
  if (!after.size) return painted as HitItem[];
  const out: HitItem[] = [];
  painted.forEach((e, i) => {
    out.push(e);
    const bars = after.get(i);
    if (bars) out.push(...bars);
  });
  return out;
}

function sameAffine(a: UIAffine | null, b: UIAffine | null): boolean {
  if (!a || !b) return a === b;
  return a.every((v, i) => v === b[i]);
}

/** A clipper's clip added to the chain (ADR 0422): merged into the last one when both are in the same (untransformed) frame. */
function withClip(clips: readonly ClipStep[], rect: UIRect, transform: UIAffine | null, inverse: UIAffine | null): readonly ClipStep[] {
  const last = clips[clips.length - 1];
  if (!transform && last && !last.transform && !last.empty) return [...clips.slice(0, -1), { ...last, rect: intersectRect(rect, last.rect) }];
  return [...clips, { rect, transform, inverse, empty: !!transform && !inverse }];
}

/** The axis-aligned bounds of a box as drawn: its transformed corners, cut down by each clip's transformed bounds. */
function drawnBounds(box: UIRect, transform: UIAffine | null, clips: readonly ClipStep[]): UIRect {
  let r = transform ? boundsOf(transformRect(transform, box)) : box;
  for (const c of clips) r = c.empty ? { x: r.x, y: r.y, width: 0, height: 0 } : intersectRect(r, c.transform ? boundsOf(transformRect(c.transform, c.rect)) : c.rect);
  return r;
}

/**
 * The part of an element's box its clips leave, in its own layout frame (the editor's outline of a clipped element). A
 * clip turned against the element (a rotated clipper with an unrotated child, or the reverse) isn't a rectangle in its
 * frame and is left out, so the outline is the box there.
 */
function localClip(box: UIRect, p: Placement): UIRect | null {
  let r: UIRect = box;
  let any = false;
  for (const c of p.clips) {
    if (c.empty) return { x: box.x, y: box.y, width: 0, height: 0 };
    // The clipper's frame to the element's: inverse(element) · clipper.
    const rel = p.inverse ? (c.transform ? multiply(p.inverse, c.transform) : p.inverse) : c.transform;
    if (rel && (Math.abs(rel[1]) > 1e-9 || Math.abs(rel[2]) > 1e-9 || rel[0] <= 0 || rel[3] <= 0)) continue;
    r = intersectRect(r, rel ? boundsOf(transformRect(rel, c.rect)) : c.rect);
    any = true;
  }
  return any ? r : null;
}

/** The smallest rectangle holding both. */
function unionRect(a: UIRect, b: UIRect): UIRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function sameRect(a: UIRect | null, b: UIRect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
