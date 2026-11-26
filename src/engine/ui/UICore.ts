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
import { UIButton, UICanvas, UIInputField, type UIComponentType, type UIFocusableElement } from "./components";
import { UI_KIND_TYPES, clipsChildren, flexShrinkOf, isInteractiveKind, isLeafKind, isRaycastTarget, isUserScroller, overflowAxes, sameTextRun, textRunOf, uiKindOf, userScrollsAxis } from "./elementKinds";
import { fontEpoch } from "./fonts";
import { uiInteractions } from "./interactions";
import { pointerFocus } from "./navigation";
import { canvasScale, estimateText, inRect, intersectRect, isMixedLength, loadYogaOnce, loadedYoga, uiBorderEdges, uiEdges, uiLength, uiLimit, type UIRect } from "./layout";
import type { TextMeasureRequest, UITextRun, UICoreHost, UICoreLike, UICoreOptions, UICorners, UIKind, UILaidOutCanvas, UILaidOutElement, UIPickRay, UIScrollbar, UIScrollInfo } from "./uiCoreTypes";
import { uiDomCode, uiDomKey, uiEventRecord, UIDataTransfer, type UIEventData, type UIEventRecord } from "./events";
import { advanceUIScrolling, canMove, uiScrollBy, uiScrollMoving, uiScrollTo, uiStartMomentum, uiStopScrolling, type UIScrollable } from "./scrolling";
import { applyAffine, boundsOf, compose, invert, localTransform, multiply, transformRect, type UIAffine, type UITransformFields } from "./transform2d";

export { canvasScale, uiLength } from "./layout";

type ElementKind = Exclude<UIKind, "canvas">;

/** Where an element sits among `overflow: hidden` clips and in the draw order (ADR 0418), from the last layout. */
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
   * ADR 0418 wave 3: the clips a point must fall in to reach it, as each clipper's padding box in layout space with the
   * inverse of that clipper's transform (null: untransformed). Clips in one frame are merged into one rectangle.
   */
  clips: readonly ClipStep[];
  /** Its whole transform (its ancestors' and its own; null: none) and that inverted (null: none, or a scale of 0 flattens it). */
  transform: UIAffine | null;
  inverse: UIAffine | null;
  /** The axis-aligned bounds of what's drawn of it, in canvas UI pixels: transformed, then clipped. */
  bounds: UIRect;
  /** ADR 0423: the clips that don't scroll (navigation reaches elements scrolled out of view), and `bounds` cut by those only. */
  reachClips: readonly ClipStep[];
  reach: UIRect;
  /** ADR 0423: a clipping element's scroll state; null otherwise. */
  scroll: UIScrollInfo | null;
}

/** One clip (ADR 0418): a rectangle in layout space, tested after mapping the point through `inverse`. `empty`: hides everything (a clipper scaled to 0). */
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
  /** Clip and draw order from the last layout (ADR 0418). */
  place: Placement;
  /**
   * ADR 0418 wave 5: the parent's content size its lengths mixing % and px (`calc()`) were last resolved against, or
   * absent when it has none. Layout runs again once when the parent's size turns out different.
   */
  calcBasis?: { width: number; height: number };
}

interface CanvasEntry extends Entry {
  readonly comp: UICanvas;
  scale: number;
  width: number;
  height: number;
  /** Elements in tree order (parents first), from the last sync. */
  elements: Entry[];
  /** The same elements in draw order (ADR 0418: `zIndex`, then document order): picking walks it from the end. */
  painted: Entry[];
  /** ADR 0423: `painted` with each scroller's scrollbars after its last descendant, as they're drawn: hit-testing walks it from the end. */
  hitOrder: HitItem[];
}

/** An element, or one of a scroller's scrollbars (ADR 0423), in hit-testing order. */
type HitItem = Entry | { readonly bar: "x" | "y"; readonly scroller: Entry };

/** True for an element that draws its descendants together, ordered among themselves (ADR 0418): a non-zero `zIndex` or an `overflow` that clips. */
function stacks(e: Entry): boolean {
  if (e.kind === "canvas") return true;
  return zOf(e) !== 0 || clipsChildren(e.comp);
}

function zOf(e: Entry): number {
  const z = (e.comp as { zIndex?: number }).zIndex;
  return typeof z === "number" && Number.isFinite(z) ? z : 0;
}

/** The length fields that may hold a `calc()` mixing % and px (ADR 0418 wave 5). */
const MIXED_FIELDS = ["width", "height", "top", "right", "bottom", "left", "minWidth", "maxWidth", "minHeight", "maxHeight", "flexBasis"] as const;

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width - b.width) < 1e-4 && Math.abs(a.height - b.height) < 1e-4;
}

/**
 * A canvas's elements in draw order, as CSS paints stacking contexts (ADR 0418): within each group (the canvas, or an
 * element that `stacks`), its members are its descendants down to (and including) nested groups, stably sorted by
 * `zIndex`, so equal ones keep document order and parents stay before their children; each nested group is followed
 * by its own members.
 */
function paintOrder(root: Entry): Entry[] {
  const out: Entry[] = [];
  const group = (g: Entry) => {
    const members: Entry[] = [];
    const gather = (p: Entry) => {
      for (const c of p.children) {
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

const NO_PLACE: Placement = { clip: null, clipper: null, childClip: null, order: 0, clips: [], transform: null, inverse: null, bounds: { x: 0, y: 0, width: 0, height: 0 }, reachClips: [], reach: { x: 0, y: 0, width: 0, height: 0 }, scroll: null };

/** ADR 0423: scrollbar thickness in UI pixels by `scrollbarWidth`, and a thumb's shortest length. */
const SCROLLBAR_WIDTH = { auto: 10, thin: 6, none: 0 } as const;
const MIN_THUMB = 18;
/** ADR 0422/0423: how far (CSS pixels) a press moves before it's a drag: a mouse drag of a draggable element, a touch or pen drag scroll. */
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
  /** ADR 0423: the press is on the target's scrollbar (the target is the scroller). */
  readonly bar: "x" | "y" | null;
}

/** ADR 0422/0423: what a held press is doing: maybe a drag, scrolling by touch, a UI drag, or dragging a scrollbar. */
interface Gesture {
  kind: "pending" | "scroll" | "drag" | "thumb" | "none";
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
  /** A touch drag: the scroller it moves; a thumb drag: the scroller and axis. */
  scroller: Entry | null;
  axis: "x" | "y" | null;
  startScroll: number;
  /** Recent positions (seconds, CSS pixels) for momentum. */
  samples: { t: number; x: number; y: number }[];
  /** A UI drag's data, the element under the pointer, and whether its last `dragover` was prevented (a drop allowed). */
  data: UIDataTransfer | null;
  dropTarget: Entry | null;
  accepts: boolean;
}

/** ADR 0422: an element and its ancestors below its canvas, the element first. */
function pathOf(e: Entry): Entry[] {
  const out: Entry[] = [];
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = at.parent) out.push(at);
  return out;
}

/** ADR 0422: the nearest element both are in (themselves included), below their canvas; null when they share none. */
function commonAncestor(a: Entry, b: Entry): Entry | null {
  const up = pathOf(a);
  for (let at: Entry | null = b; at && at.kind !== "canvas"; at = at.parent) if (up.includes(at)) return at;
  return null;
}

/** ADR 0422: a press in a button that isn't interactable doesn't click (the DOM's disabled controls). */
function disabledPath(e: Entry): boolean {
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = at.parent) if (at.kind === "button" && !(at.comp as UIButton).interactable) return true;
  return false;
}

/** ADR 0423: the elements at or above `e` the player scrolls (`overflow` `auto` or `scroll`), innermost first. */
function scrollChain(e: Entry): Entry[] {
  const out: Entry[] = [];
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = at.parent) {
    const s = at.place.scroll;
    if (s && (s.userX || s.userY) && at.box.visible) out.push(at);
  }
  return out;
}

/**
 * ADR 0423: the scroller in `chain` (innermost first) that takes a scroll of `dx`, `dy`: the first that scrolls that
 * way and can still move, chaining outward, unless a scroller that can't move has `overscroll-behavior` `contain` or
 * `none`, which ends the chain there.
 */
function pickScroller(chain: readonly Entry[], dx: number, dy: number): Entry | null {
  if (dx === 0 && dy === 0) return null;
  for (const e of chain) {
    const s = e.place.scroll!;
    const okX = dx === 0 || (s.userX && canMove(s.x, s.maxX, dx));
    const okY = dy === 0 || (s.userY && canMove(s.y, s.maxY, dy));
    if (okX && okY) return e;
    if ((e.comp as UIScrollable).overscrollBehavior !== "auto") return null;
  }
  return null;
}

/** The interactive element a pointer on `e` goes to: `e` itself or its nearest interactive ancestor, below its canvas. */
function handlerOf(e: Entry): Entry | null {
  for (let at: Entry | null = e; at && at.kind !== "canvas"; at = at.parent) if (isInteractiveKind(at.kind)) return at;
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
  private active: UIInputField | null = null;
  private programmatic = false;
  private detachDom: (() => void) | null = null;
  /** Keys the hidden input took since the last routing (Tab, Escape leaving a field), claimed from the game until released. */
  private swallowed: string[] = [];
  /** The pointer's position at the last routing: moving it ends navigation's focus colours (ADR 0340). */
  private lastPointer: { x: number; y: number } | null = null;
  /** ADR 0422: the raycast target under the pointer at the last routing (pointerover/out/enter/leave follow it). */
  private hoverTarget: Entry | null = null;
  /** ADR 0422: the raycast target a left press began on (a click goes to what it and the release share). */
  private pressTarget: Entry | null = null;
  /** ADR 0422: the last click, for `dblclick`. */
  private lastClick: { comp: UIComponentType; time: number; x: number; y: number; count: number } | null = null;
  /** ADR 0422/0423: what the held press is doing. */
  private gesture: Gesture | null = null;
  /** ADR 0423: the scroller the last press landed in: with nothing focused, keys scroll it. */
  private activeScroller: Entry | null = null;
  /** ADR 0423: each scroller's offsets at the last layout, and whether it was moving (for `scroll` and `scrollend`). */
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

  /** Lay the last synced World's UI out again now, at the last size (the UI host reading geometry mid-frame, ADR 0419). */
  relayout(): void {
    if (!this.world || this.disposed) return;
    // Layout only: scrolling moves on, and `scroll`/`scrollend` are noted, once a frame, in the frame's own sync (ADR 0423).
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
    // ADR 0423: smooth scrolls and momentum move on before layout reads the offsets (the routing core only).
    if (!this.passive && !this.relayingOut) advanceUIScrolling(world, deltaSeconds);
    // The layout scripts' scrolling reads (ADR 0423) and navigation search: the routing core's, from its first layout.
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
    for (const entry of this.entries.values()) if (entry.canvas) this.applyProperties(yoga, entry);
    const canvases = [...this.canvasEntries.values()].sort((a, b) => a.comp.sortOrder - b.comp.sortOrder);
    for (const canvas of canvases) {
      this.applyCanvas(canvas);
      canvas.node.calculateLayout(canvas.width, canvas.height, yoga.DIRECTION_LTR);
      this.readLayout(canvas);
      // `calc()` mixing % and px (ADR 0418 wave 5) resolved against last frame's parent sizes: once more where they changed.
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
   * ADR 0423: a scroller whose offsets changed since the last layout gets a `scroll` event, and one that stopped (no
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
    if (entry.parent) {
      entry.parent.node.removeChild(entry.node);
      entry.parent.children = entry.parent.children.filter((e) => e !== entry);
      entry.parent = null;
    }
    for (const child of entry.children) {
      if (child.parent === entry) {
        entry.node.removeChild(child.node);
        child.parent = null;
      }
    }
    entry.children = [];
    entry.node.free();
  }

  dispose(): void {
    if (this.disposed) return;
    this.removeHook();
    if (this.world && uiInteractions(this.world).layout === this) uiInteractions(this.world).layout = null;
    for (const c of [...this.entries.keys()]) this.release(c);
    this.unfocusDom();
    this.detachDom?.();
    this.detachDom = null;
    this.dom?.remove();
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
    this.entries.set(c, entry);
    return entry;
  }

  /** Walk `node`'s descendants in order, listing each entry's wanted Yoga children (skipping nodes without a UI component). */
  private collect(node: GameObject, parent: Entry, canvas: CanvasEntry, byNode: Map<number, UIComponentType>, placed: Set<Entry>, desired: Map<Entry, Entry[]>): void {
    const root: Entry[] = [];
    desired.set(parent, root);
    const walk = (n: GameObject, into: Entry, list: Entry[], leaf?: Entry) => {
      for (const child of n.children) {
        if (child.isComponentNode) continue; // its component counts as its owner's (ADR 0009)
        const c = byNode.get(child.entity);
        if (!c) {
          walk(child, into, list, leaf);
          continue;
        }
        if (c instanceof UICanvas) continue; // a nested canvas is a root of its own
        const entry = this.entries.get(c)!;
        entry.canvas = canvas;
        placed.add(entry);
        if (leaf) {
          this.warnOnce(`leaf|${child.entity}`, `UI element "${child.name}" is under a ${leaf.comp.constructor.name}, which can't have children; it lays out beside it instead.`);
        }
        list.push(entry);
        if (isLeafKind(entry.kind)) {
          desired.set(entry, []);
          walk(child, into, list, entry); // children of a leaf join its parent
        } else {
          const own: Entry[] = [];
          desired.set(entry, own);
          walk(child, entry, own);
        }
      }
    };
    walk(node, parent, root);
  }

  /** Make every Yoga node's children what `desired` says (and detach elements that have no place). */
  private attach(desired: Map<Entry, Entry[]>): void {
    const wanted = (e: Entry) => desired.get(e) ?? [];
    // Detach first, so a node moving between parents is free before its new parent takes it.
    for (const entry of this.entries.values()) {
      const want = wanted(entry);
      for (const c of entry.children) {
        if (c.parent === entry && !want.includes(c)) {
          entry.node.removeChild(c.node);
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
        entry.node.removeChild(c.node);
        c.parent = null;
      }
      want.forEach((c, i) => {
        entry.node.insertChild(c.node, i);
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
    // ADR 0418 wave 1: each side its own value, else the all-sides one (slots 5, 6 and 16 are the top edges).
    const pad = uiEdges(c.padding, c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft);
    const mar = uiEdges(c.margin, c.marginTop, c.marginRight, c.marginBottom, c.marginLeft);
    const bor = uiBorderEdges(c);
    for (let i = 0; i < 4; i++) {
      const edge = t.edges[i];
      if (put(i === 0 ? 5 : 16 + i, pad[i])) n.setPadding(edge, pad[i]);
      if (put(i === 0 ? 6 : 19 + i, mar[i])) n.setMargin(edge, mar[i]);
      if (put(i === 0 ? 16 : 22 + i, bor[i])) n.setBorder(edge, bor[i]);
    }
    // ADR 0418 wave 5: lengths mixing % and px resolve in pixels against the parent's content size (last layout's).
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
    // ADR 0423: in a parent the player scrolls along its main axis, content lays out unconstrained: a kind's default shrink is 0 there.
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

    // The text run is the measure's dirty signature: a changed run, or a font arriving (which changes
    // every text's size), measures again. An unchanged run keeps its object, so `elements()` compare it by identity.
    if (entry.run) {
      const run = textRunOf(c)!;
      const epoch = fontEpoch();
      if (!sameTextRun(run, entry.run) || epoch !== entry.measuredEpoch) {
        entry.run = run;
        entry.measuredEpoch = epoch;
        n.markDirty();
      }
    }
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
    const request: TextMeasureRequest = { ...run, maxWidth: run.wrap === "none" ? Infinity : maxWidth };
    return this.host.measureText?.(request) ?? estimateText(request);
  }

  /**
   * Read Yoga's boxes into the entries' absolute (canvas UI pixel) boxes, visibility and opacity, in tree order; then
   * their clips (`overflow: hidden` ancestors' padding boxes) and draw order (ADR 0418).
   */
  private readLayout(canvas: CanvasEntry): void {
    canvas.elements = [];
    const cv = canvas.comp.isActiveAndEnabled;
    canvas.box = { x: 0, y: 0, width: canvas.width, height: canvas.height, visible: cv, opacity: 1 };
    const yoga = this.yoga!;
    const walk = (parent: Entry, ox: number, oy: number, visible: boolean, opacity: number, clip: UIRect | null, clipper: Entry | null, clips: readonly ClipStep[], reachClips: readonly ClipStep[], parentTransform: UIAffine | null) => {
      for (const e of parent.children) {
        const c = e.comp as Exclude<UIComponentType, UICanvas>;
        const n = e.node;
        const x = ox + n.getComputedLeft(), y = oy + n.getComputedTop();
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
        // ADR 0418 wave 3: its transform composes its parent's with its own; layout above ignored both.
        const transform = compose(parentTransform, localTransform(c as unknown as UITransformFields, e.box));
        const inverse = transform ? invert(transform) : null;
        e.place = { clip, clipper, childClip, order: 0, clips, transform, inverse, bounds: drawnBounds(e.box, transform, clips), reachClips, reach: drawnBounds(e.box, transform, reachClips), scroll };
        canvas.elements.push(e);
        // ADR 0423: its children are drawn moved by its scroll; only a clip that doesn't scroll keeps navigation out.
        const sx = scroll?.x ?? 0, sy = scroll?.y ?? 0;
        const nextClips = childClip ? withClip(clips, childClip, transform, inverse) : clips;
        const nextReach = childClip && !isUserScroller(c) ? withClip(reachClips, childClip, transform, inverse) : reachClips;
        walk(e, x - sx, y - sy, v, o, childClip ? intersectRect(childClip, clip) : clip, childClip ? e : clipper, nextClips, nextReach, transform);
      }
    };
    walk(canvas, 0, 0, cv, 1, null, null, [], [], null);
    canvas.painted = paintOrder(canvas);
    canvas.painted.forEach((e, i) => (e.place.order = i));
    canvas.hitOrder = hitOrderOf(canvas.painted);
  }

  /**
   * ADR 0423: a clipping element's scroll state. Its content's extent is the union of its children's margin boxes (from
   * its padding box's corner) plus its end padding, at least the padding box; its offsets are clamped to that, and the
   * routing core writes the clamped values back. Scrollbars show on an axis the player scrolls: always for `scroll`,
   * for `auto` when the content overflows, never with `scrollbar-width: none`.
   */
  private scrollOf(e: Entry, client: UIRect, bl: number, bt: number): UIScrollInfo {
    const yoga = this.yoga!;
    const c = e.comp as UIScrollable;
    const n = e.node;
    let right = 0, bottom = 0;
    for (const ch of e.children) {
      const cc = ch.comp as UIScrollable;
      if (!cc.isActiveAndEnabled || cc.display === "none") continue;
      const cn = ch.node;
      right = Math.max(right, cn.getComputedLeft() - bl + cn.getComputedWidth() + cn.getComputedMargin(yoga.EDGE_RIGHT));
      bottom = Math.max(bottom, cn.getComputedTop() - bt + cn.getComputedHeight() + cn.getComputedMargin(yoga.EDGE_BOTTOM));
    }
    const scrollWidth = Math.max(client.width, right + n.getComputedPadding(yoga.EDGE_RIGHT));
    const scrollHeight = Math.max(client.height, bottom + n.getComputedPadding(yoga.EDGE_BOTTOM));
    const maxX = scrollWidth - client.width, maxY = scrollHeight - client.height;
    const at = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(0, v), max) : 0);
    const x = at(c.scrollX, maxX), y = at(c.scrollY, maxY);
    if (!this.passive) {
      if (c.scrollX !== x) c.scrollX = x;
      if (c.scrollY !== y) c.scrollY = y;
    }
    const axes = overflowAxes(c);
    const userX = userScrollsAxis(axes.x), userY = userScrollsAxis(axes.y);
    const t = SCROLLBAR_WIDTH[c.scrollbarWidth] ?? SCROLLBAR_WIDTH.auto;
    const showX = t > 0 && userX && (axes.x === "scroll" || maxX > 0.5);
    const showY = t > 0 && userY && (axes.y === "scroll" || maxY > 0.5);
    const bar = (along: "x" | "y"): UIScrollbar => {
      if (along === "y") {
        const track = { x: client.x + client.width - t, y: client.y, width: t, height: Math.max(0, client.height - (showX ? t : 0)) };
        const len = Math.min(track.height, Math.max(MIN_THUMB, (track.height * client.height) / scrollHeight));
        return { track, thumb: { x: track.x, y: track.y + (maxY > 0 ? ((track.height - len) * y) / maxY : 0), width: t, height: len } };
      }
      const track = { x: client.x, y: client.y + client.height - t, width: Math.max(0, client.width - (showY ? t : 0)), height: t };
      const len = Math.min(track.width, Math.max(MIN_THUMB, (track.width * client.width) / scrollWidth));
      return { track, thumb: { x: track.x + (maxX > 0 ? ((track.width - len) * x) / maxX : 0), y: track.y, width: len, height: t } };
    };
    return { x, y, maxX, maxY, clientWidth: client.width, clientHeight: client.height, scrollWidth, scrollHeight, userX, userY, client, barX: showX ? bar("x") : null, barY: showY ? bar("y") : null };
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
        elementList.push({ comp: e.comp, kind: e.kind as ElementKind, canvas: c, x: b.x, y: b.y, width: b.width, height: b.height, order: p.order, visible: b.visible, opacity: b.opacity, text: e.run, clip: p.clip, clipper: p.clipper?.comp ?? null, childClip: p.childClip, transform: p.transform, bounds: p.bounds, reach: p.reach, scroll: p.scroll });
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
      if (e.kind !== "input" || !e.canvas) continue;
      const c = e.comp as UIInputField;
      if (c.typing && e.box.visible) return e;
    }
    return null;
  }

  private ensureDom(): HTMLInputElement | null {
    if (this.dom) return this.dom;
    if (typeof document === "undefined" || !document.body) return null;
    const el = document.createElement("input");
    el.type = "text";
    el.autocomplete = "off";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    // The player's typing: the value now, the change event for the World's next frame (ADR 0309).
    const onInput = () => {
      const c = this.active;
      if (!c) return;
      let v = el.value;
      if (c.maxLength > 0 && v.length > c.maxLength) {
        v = v.slice(0, c.maxLength);
        el.value = v;
      }
      if (v === c.value) return;
      c.value = v;
      uiInteractions(c._world).record("change", c);
    };
    // Enter submits; Tab, Shift+Tab and Escape leave the field through navigation (ADR 0340), and their
    // presses stay the UI's until released, so the game (and the `ui` context) never sees them as new ones.
    const onKey = (e: KeyboardEvent) => {
      const c = this.active;
      if (!c) return;
      // While an IME composes (CJK, ADR 0356), Enter picks its candidate and Escape drops the composition.
      if (e.isComposing || e.keyCode === 229) return;
      const log = uiInteractions(c._world);
      if (e.key === "Enter") log.record("submit", c);
      else if (e.key === "Escape") {
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
      if (this.programmatic || !this.active) return;
      // A press on the canvas takes DOM focus first; routing re-focuses the field that press hit.
      if (this.pointerHeld) return;
      uiInteractions(this.active._world).blur(this.active, "script");
    };
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
    this.detachDom = () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
    };
    document.body.appendChild(el);
    this.dom = el;
    return el;
  }

  /** Move DOM focus to or from the wanted field's hidden input, and mirror `value` and `maxLength` into it. */
  private syncDom(): void {
    if (this.passive || typeof document === "undefined") return;
    const want = this.wantedField();
    const wantComp = want ? (want.comp as UIInputField) : null;
    if (!wantComp) {
      if (this.active) this.unfocusDom();
      return;
    }
    const el = this.ensureDom();
    if (!el) return;
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
   * ADR 0422: it also records the frame's UI events in order, each on the raycast target it happened on (the element
   * that claims the pointer, 0385): `pointerover`/`pointerout`/`pointerenter`/`pointerleave` as the target changes,
   * `pointermove`, `pointerdown`/`pointerup` for each button, `click` on what the left press and release share (and
   * `dblclick`), `contextmenu`, `wheel`, `keydown`/`keyup` on the focused element (else the scroller last pressed in),
   * `pointercancel` when a touch drag starts scrolling, and UI drags. Default actions ride on them, run after their
   * dispatch unless a handler prevents them: focus on press, scrolling (ADR 0423), a drag starting, submit on Enter.
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
    const usable = (e: Entry | null): e is Entry => !!e && e.kind === "button" && (e.comp as UIButton).interactable && e.comp.isActiveAndEnabled;
    // The pointer moving or pressing makes it the last UI input: focus colours hide.
    const last = this.lastPointer;
    const moved = !last || last.x !== raw.x || last.y !== raw.y;
    if (last && moved) log.navigating = false;
    this.lastPointer = { x: raw.x, y: raw.y };
    const now = world.time.realtimeSinceStartup;

    // ADR 0422: the frame's records, with what each needs.
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
      // ADR 0422: that's the pointerdown's default action, after its dispatch.
      const target = hit && (hit.kind === "button" || hit.kind === "input") ? (hit.comp as UIFocusableElement) : null;
      const press = pointerFocus(this, target);
      const typing = hit?.kind === "input";
      this.pressTarget = over;
      const chain = over ? scrollChain(over) : [];
      for (const s of chain) uiStopScrolling(world, s.comp as UIScrollable); // a press stops a fling
      this.activeScroller = chain[0] ?? null;
      let source: Entry | null = null;
      for (let at = over; at && at.kind !== "canvas" && !source; at = at.parent) if ((at.comp as UIScrollable).draggable) source = at;
      const gesture: Gesture = { kind: "pending", pointerType: raw.pointerType, startX: raw.x, startY: raw.y, lastX: raw.x, lastY: raw.y, armed: true, target: over, source, chain, scroller: null, axis: null, startScroll: 0, samples: [{ t: now, x: raw.x, y: raw.y }], data: null, dropTarget: null, accepts: false };
      let barAction: (() => void) | null = null;
      if (blocked?.bar && over) barAction = this.pressBar(world, gesture, over, blocked.bar, blocked.ux, blocked.uy);
      this.gesture = gesture;
      records.push(
        uiEventRecord("pointerdown", over?.comp ?? null, pdata(over, { button: 0, buttons: buttons | 1 }), (prevented) => {
          if (prevented) {
            if (gesture.kind === "pending") gesture.armed = false;
            return;
          }
          barAction?.();
          if (press.focus) log.focus(target, "press", typing);
          else if (!press.trapped) log.focus(null, "press");
        }),
      );
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
      if (done?.kind === "scroll" && done.scroller) this.fling(world, done);
      else if (done?.kind === "drag") {
        const target = live(done.dropTarget);
        const source = live(done.source);
        if (target && done.accepts) records.push(uiEventRecord("drop", target.comp, pdata(target, { button: 0, dataTransfer: done.data! })));
        if (source) records.push(uiEventRecord("dragend", source.comp, pdata(source, { button: 0, dataTransfer: done.data! })));
      } else if (done?.kind !== "thumb" || over) {
        if (over) records.push(uiEventRecord("pointerup", over.comp, pdata(over, { button: 0 })));
        if (this.pressed && this.pressed === hit) clicked = this.pressed.comp as UIButton;
        // ADR 0422: `click` on the element the press and the release share, unless a disabled button holds it.
        const pressedOn = live(this.pressTarget);
        const target = pressedOn && over ? commonAncestor(pressedOn, over) : null;
        if (target && !disabledPath(target)) {
          const prev = this.lastClick;
          const again = prev && prev.comp === target.comp && now - prev.time <= DBLCLICK_SECONDS && Math.hypot(raw.x - prev.x, raw.y - prev.y) <= DBLCLICK_DISTANCE;
          const count = again ? prev.count + 1 : 1;
          this.lastClick = { comp: target.comp, time: now, x: raw.x, y: raw.y, count };
          records.push(uiEventRecord("click", target.comp, pdata(target, { button: 0, detail: count })));
          if (count === 2) records.push(uiEventRecord("dblclick", target.comp, pdata(target, { button: 0, detail: 2 })));
        }
      }
      this.pressed = null;
      this.pressTarget = null;
      this.gesture = null;
    } else if (this.pressed && !raw.held(0) && !raw.down(0)) this.pressed = null; // released without an up (focus lost)
    if (this.gesture && !raw.held(0) && !raw.down(0) && !raw.up(0)) this.gesture = null;

    // The wheel (ADR 0423): the innermost scroller under the pointer that can still move that way takes it, as its default action.
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
          if (sx) uiScrollBy(world, sx.comp as UIScrollable, dx, 0, "instant");
          if (sy) uiScrollBy(world, sy.comp as UIScrollable, 0, dy, "instant");
        }),
      );
    }

    // Keys (ADR 0422): to the focused element, else (ADR 0423) the scroller the last press landed in.
    const focusedEntry = live(log.focused ? (this.entries.get(log.focused) ?? null) : null);
    const keyTarget = focusedEntry ?? live(this.activeScroller);
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
            this.keyScroll(world, keyTarget, k.key, !focusedEntry, !!field?.typing);
          }),
        );
      }
    }

    log.route({ hovered: usable(hit) ? (hit.comp as UIButton) : null, pressed: (this.pressed?.comp as UIButton | undefined) ?? null, clicked }, records);

    const focused = log.focused;
    const typing = focused instanceof UIInputField && focused.typing;
    return { pointer: !!blocked, keyboard: typing, keys, wheel: wheelTaken };
  }

  /** ADR 0422: a point's position for an event on `e`: the target canvas's UI pixels, and `e`'s own (through its transform). */
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
   * ADR 0423: a press on a scrollbar. On the thumb it starts dragging it; on the track it pages toward the press (the
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
      return null;
    }
    g.kind = "none";
    const before = axis === "x" ? lx < bar.thumb.x : ly < bar.thumb.y;
    const page = (axis === "x" ? s.clientWidth : s.clientHeight) * PAGE_SHARE * (before ? -1 : 1);
    return () => uiScrollBy(world, scroller.comp as UIScrollable, axis === "x" ? page : 0, axis === "y" ? page : 0);
  }

  /** ADR 0422/0423: a held press moved (the frames after it went down). */
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
          const target = g.target && this.entries.has(g.target.comp) ? g.target : null;
          if (target) records.push(uiEventRecord("pointercancel", target.comp, pdata(target, { button: 0 })));
          this.pressed = null;
          this.pressTarget = null;
          const scale = scaleOf(scroller);
          uiScrollBy(world, scroller.comp as UIScrollable, -fx / scale, -fy / scale, "instant");
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
    } else if (g.kind === "scroll" && g.scroller) {
      const scale = scaleOf(g.scroller);
      uiScrollBy(world, g.scroller.comp as UIScrollable, -(raw.x - g.lastX) / scale, -(raw.y - g.lastY) / scale, "instant");
    } else if (g.kind === "thumb" && g.scroller && g.axis) {
      const s = g.scroller.place.scroll;
      const bar = g.axis === "x" ? s?.barX : s?.barY;
      if (s && bar) {
        const room = g.axis === "x" ? bar.track.width - bar.thumb.width : bar.track.height - bar.thumb.height;
        const moved = (g.axis === "x" ? raw.x - g.startX : raw.y - g.startY) / scaleOf(g.scroller);
        const max = g.axis === "x" ? s.maxX : s.maxY;
        const to = g.startScroll + (room > 0 ? (moved * max) / room : 0);
        uiScrollTo(world, g.scroller.comp as UIScrollable, g.axis === "x" ? to : null, g.axis === "y" ? to : null, "instant");
      }
    }
    g.lastX = raw.x;
    g.lastY = raw.y;
  }

  /** ADR 0423: a touch or pen drag scroll let go: it keeps moving at the speed of its last tenth of a second. */
  private fling(world: World, g: Gesture): void {
    const a = g.samples[0], b = g.samples[g.samples.length - 1];
    const dt = b.t - a.t;
    if (!g.scroller || dt <= 0) return;
    const scale = g.scroller.canvas?.comp.mode === "screen" ? g.scroller.canvas.scale : 1;
    const s = g.scroller.place.scroll;
    const vx = s?.userX ? -(b.x - a.x) / dt / scale : 0;
    const vy = s?.userY ? -(b.y - a.y) / dt / scale : 0;
    uiStartMomentum(world, g.scroller.comp as UIScrollable, vx, vy);
  }

  /**
   * ADR 0423: keyboard scrolling, a keydown's default action. Page Up/Down and Home/End scroll the scroller the target is
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
    if (edge) uiScrollTo(world, comp, null, sign < 0 ? 0 : s.maxY);
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
        if (onDrawnBox(e, px, py)) out.push(e.comp);
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
        if (onDrawnBox(e, at.ux, at.uy)) comps.push(e.comp);
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
   * corners of the part that's drawn when an `overflow: hidden` ancestor clips it (ADR 0418).
   */
  cornersOf(c: UIComponentType): UICorners | null {
    const entry = this.entries.get(c);
    const canvas = entry?.canvas;
    if (!entry || !canvas || !this.yoga) return null;
    const b = entry.box;
    const p = entry.place;
    // ADR 0418 wave 3: the corners as drawn (its transform), and as laid out in its parent's frame (its ancestors' only).
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
   * ADR 0423: a scroller's scrollbars, drawn over its content, are met before it (the target is the scroller, `bar` the axis).
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
      if (onDrawnBox(item, ux, uy)) return { target: item, handler: handlerOf(item), ux, uy, bar: null };
    }
    return null;
  }

  private hittable(e: Entry): boolean {
    return e.comp.isActiveAndEnabled && e.box.visible && e.canvas !== null;
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
    // ADR 0418 wave 1.
    edges: [yoga.EDGE_TOP, yoga.EDGE_RIGHT, yoga.EDGE_BOTTOM, yoga.EDGE_LEFT] as const,
    wrap: { nowrap: yoga.WRAP_NO_WRAP, wrap: yoga.WRAP_WRAP, "wrap-reverse": yoga.WRAP_WRAP_REVERSE } as Record<string, number>,
    alignSelf: { auto: yoga.ALIGN_AUTO, "flex-start": yoga.ALIGN_FLEX_START, center: yoga.ALIGN_CENTER, "flex-end": yoga.ALIGN_FLEX_END, stretch: yoga.ALIGN_STRETCH, baseline: yoga.ALIGN_BASELINE } as Record<string, number>,
    alignContent: { "flex-start": yoga.ALIGN_FLEX_START, center: yoga.ALIGN_CENTER, "flex-end": yoga.ALIGN_FLEX_END, stretch: yoga.ALIGN_STRETCH, "space-between": yoga.ALIGN_SPACE_BETWEEN, "space-around": yoga.ALIGN_SPACE_AROUND, "space-evenly": yoga.ALIGN_SPACE_EVENLY } as Record<string, number>,
  };
}

/** ADR 0423: true when the player scrolls `parent` along its flex direction (its children then keep their size along it). */
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
    return x.comp === y.comp && x.canvas === y.canvas && x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height && x.order === y.order && x.visible === y.visible && x.opacity === y.opacity && x.text === y.text && x.clipper === y.clipper && sameRect(x.clip, y.clip) && sameRect(x.childClip, y.childClip) && sameAffine(x.transform, y.transform) && sameRect(x.bounds, y.bounds) && sameRect(x.reach, y.reach) && sameScroll(x.scroll, y.scroll);
  });
}

function sameScroll(a: UIScrollInfo | null, b: UIScrollInfo | null): boolean {
  if (!a || !b) return a === b;
  const bar = (p: UIScrollbar | null, q: UIScrollbar | null) => (!p || !q ? p === q : sameRect(p.track, q.track) && sameRect(p.thumb, q.thumb));
  return a.x === b.x && a.y === b.y && a.maxX === b.maxX && a.maxY === b.maxY && a.userX === b.userX && a.userY === b.userY && sameRect(a.client, b.client) && bar(a.barX, b.barX) && bar(a.barY, b.barY);
}

/**
 * ADR 0423: hit-testing order: the draw order with each scroller's scrollbars right after its last descendant (they're
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

/** A clipper's clip added to the chain (ADR 0418): merged into the last one when both are in the same (untransformed) frame. */
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

function sameRect(a: UIRect | null, b: UIRect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
