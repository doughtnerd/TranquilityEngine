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
import { UI_KIND_TYPES, flexShrinkOf, isInteractiveKind, isLeafKind, isRaycastTarget, sameTextRun, textRunOf, uiKindOf } from "./elementKinds";
import { fontEpoch } from "./fonts";
import { uiInteractions } from "./interactions";
import { pointerFocus } from "./navigation";
import { canvasScale, estimateText, inRect, intersectRect, loadYogaOnce, loadedYoga, uiBorderEdges, uiEdges, uiLength, uiLimit, type UIRect } from "./layout";
import type { TextMeasureRequest, UITextRun, UICoreHost, UICoreLike, UICoreOptions, UICorners, UIKind, UILaidOutCanvas, UILaidOutElement, UIPickRay } from "./uiCoreTypes";

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
}

interface CanvasEntry extends Entry {
  readonly comp: UICanvas;
  scale: number;
  width: number;
  height: number;
  /** Elements in tree order (parents first), from the last sync. */
  elements: Entry[];
  /** The same elements in draw order (ADR 0418: `zIndex`, then document order): hit-testing walks it from the end. */
  painted: Entry[];
}

/** True for an element that draws its descendants together, ordered among themselves (ADR 0418): a non-zero `zIndex` or `overflow: hidden`. */
function stacks(e: Entry): boolean {
  if (e.kind === "canvas") return true;
  const c = e.comp as Exclude<UIComponentType, UICanvas>;
  return zOf(e) !== 0 || c.overflow === "hidden";
}

function zOf(e: Entry): number {
  const z = (e.comp as { zIndex?: number }).zIndex;
  return typeof z === "number" && Number.isFinite(z) ? z : 0;
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

const NO_PLACE: Placement = { clip: null, clipper: null, childClip: null, order: 0 };

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

  elements(): readonly UILaidOutElement[] {
    return this.elementList;
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

  sync(world: World, width: number, height: number, _deltaSeconds = 0): void {
    if (this.disposed || !this.yoga) return;
    const yoga = this.yoga;
    this.world = world;
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
    }
    this.collectResults(world, canvases);
    this.syncDom();
  }

  /** Forget a removed component. */
  release(c: UIComponentType): void {
    const entry = this.entries.get(c);
    if (!entry) return;
    this.entries.delete(c);
    if (c instanceof UICanvas) this.canvasEntries.delete(c);
    if (this.pressed === entry) this.pressed = null;
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
    if (put(7, (v = uiLength(c.width)))) n.setWidth(v as never);
    if (put(8, (v = uiLength(c.height)))) n.setHeight(v as never);
    if (put(9, (v = c.positionType === "absolute" ? yoga.POSITION_TYPE_ABSOLUTE : yoga.POSITION_TYPE_RELATIVE))) n.setPositionType(v as never);
    if (put(10, (v = autoToUndefined(uiLength(c.top))))) n.setPosition(yoga.EDGE_TOP, v as never);
    if (put(11, (v = autoToUndefined(uiLength(c.right))))) n.setPosition(yoga.EDGE_RIGHT, v as never);
    if (put(12, (v = autoToUndefined(uiLength(c.bottom))))) n.setPosition(yoga.EDGE_BOTTOM, v as never);
    if (put(13, (v = autoToUndefined(uiLength(c.left))))) n.setPosition(yoga.EDGE_LEFT, v as never);
    if (put(14, (v = finite(c.flexGrow)))) n.setFlexGrow(v as number);
    // Null: the kind's (text wraps to what's left; other boxes keep their size).
    if (put(15, (v = c.flexShrink === null || c.flexShrink === undefined ? flexShrinkOf(entry.kind) : finite(c.flexShrink)))) n.setFlexShrink(v as number);
    if (put(26, (v = uiLimit(c.minWidth)))) n.setMinWidth(v as never);
    if (put(27, (v = uiLimit(c.maxWidth)))) n.setMaxWidth(v as never);
    if (put(28, (v = uiLimit(c.minHeight)))) n.setMinHeight(v as never);
    if (put(29, (v = uiLimit(c.maxHeight)))) n.setMaxHeight(v as never);
    if (put(30, (v = t.wrap[c.flexWrap] ?? yoga.WRAP_NO_WRAP))) n.setFlexWrap(v as never);
    if (put(31, (v = t.alignSelf[c.alignSelf] ?? yoga.ALIGN_AUTO))) n.setAlignSelf(v as never);
    if (put(32, (v = t.alignContent[c.alignContent] ?? yoga.ALIGN_STRETCH))) n.setAlignContent(v as never);
    if (put(33, (v = uiLength(c.flexBasis) ?? "auto"))) n.setFlexBasis(v as never);
    if (put(34, (v = Number.isFinite(c.aspectRatio) && c.aspectRatio > 0 ? c.aspectRatio : undefined))) n.setAspectRatio(v as never);
    if (put(35, (v = c.overflow === "hidden" ? yoga.OVERFLOW_HIDDEN : yoga.OVERFLOW_VISIBLE))) n.setOverflow(v as never);

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
    const walk = (parent: Entry, ox: number, oy: number, visible: boolean, opacity: number, clip: UIRect | null, clipper: Entry | null) => {
      for (const e of parent.children) {
        const c = e.comp as Exclude<UIComponentType, UICanvas>;
        const n = e.node;
        const x = ox + n.getComputedLeft(), y = oy + n.getComputedTop();
        const v = visible && c.isActiveAndEnabled && c.visible && c.display !== "none";
        const o = opacity * c.opacity;
        const width = n.getComputedWidth(), height = n.getComputedHeight();
        e.box = { x, y, width, height, visible: v, opacity: o };
        let childClip: UIRect | null = null;
        if (c.overflow === "hidden") {
          const bl = n.getComputedBorder(yoga.EDGE_LEFT), bt = n.getComputedBorder(yoga.EDGE_TOP);
          const br = n.getComputedBorder(yoga.EDGE_RIGHT), bb = n.getComputedBorder(yoga.EDGE_BOTTOM);
          childClip = { x: x + bl, y: y + bt, width: Math.max(0, width - bl - br), height: Math.max(0, height - bt - bb) };
        }
        e.place = { clip, clipper, childClip, order: 0 };
        canvas.elements.push(e);
        walk(e, x, y, v, o, childClip ? intersectRect(childClip, clip) : clip, childClip ? e : clipper);
      }
    };
    walk(canvas, 0, 0, cv, 1, null, null);
    canvas.painted = paintOrder(canvas);
    canvas.painted.forEach((e, i) => (e.place.order = i));
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
        elementList.push({ comp: e.comp, kind: e.kind as ElementKind, canvas: c, x: b.x, y: b.y, width: b.width, height: b.height, order: p.order, visible: b.visible, opacity: b.opacity, text: e.run, clip: p.clip, clipper: p.clipper?.comp ?? null, childClip: p.childClip });
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
   * (ADR 0309) what the pointer did, with focus moved by a press; the log publishes the frame's events.
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
      return;
    }
    log.layout = this; // navigation searches this core's layout (ADR 0340)
    // A raycast target claims the pointer (ADR 0385); the button or input field it's in, if any, takes it.
    const blocked = this.hit(raw.x, raw.y);
    const hit = blocked?.handler ?? null;
    const usable = (e: Entry | null): e is Entry => !!e && e.kind === "button" && (e.comp as UIButton).interactable && e.comp.isActiveAndEnabled;
    // The pointer moving or pressing makes it the last UI input: focus colours hide.
    const last = this.lastPointer;
    if (last && (last.x !== raw.x || last.y !== raw.y)) log.navigating = false;
    this.lastPointer = { x: raw.x, y: raw.y };

    if (raw.down(0)) {
      log.navigating = false;
      this.pressed = usable(hit) ? hit : null;
      // A press focuses what it hit (an input field starts typing); elsewhere it unfocuses, unless a modal canvas keeps focus.
      const target = hit && (hit.kind === "button" || hit.kind === "input") ? (hit.comp as UIFocusableElement) : null;
      const press = pointerFocus(this, target);
      if (press.focus) log.focus(target, "pointer", hit!.kind === "input");
      else if (!press.trapped) log.focus(null, "pointer");
    }
    if (this.pressed && !this.entries.has(this.pressed.comp)) this.pressed = null;
    let clicked: UIButton | null = null;
    if (raw.up(0)) {
      if (this.pressed && this.pressed === hit) clicked = this.pressed.comp as UIButton;
      this.pressed = null;
    } else if (this.pressed && !raw.held(0) && !raw.down(0)) this.pressed = null; // released without an up (focus lost)
    log.route({ hovered: usable(hit) ? (hit.comp as UIButton) : null, pressed: (this.pressed?.comp as UIButton | undefined) ?? null, clicked });

    const focused = log.focused;
    const typing = focused instanceof UIInputField && focused.typing;
    return { pointer: !!blocked, keyboard: typing, keys };
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
        const b = e.box;
        if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height && inRect(px, py, e.place.clip)) out.push(e.comp);
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
        const b = e.box;
        if (at.ux >= b.x && at.ux <= b.x + b.width && at.uy >= b.y && at.uy <= b.y + b.height && inRect(at.ux, at.uy, e.place.clip)) comps.push(e.comp);
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
    const clipRect = entry.place.clip ? intersectRect(b, entry.place.clip) : null;
    const corners = (r: UIRect) => {
      const xs = [r.x, r.x + r.width, r.x + r.width, r.x], ys = [r.y, r.y, r.y + r.height, r.y + r.height];
      return xs.map((x, i) => [x, ys[i]]);
    };
    const size: [number, number] = [b.width, b.height];
    if (canvas.comp.mode !== "world") {
      const toCanvas = (r: UIRect) => corners(r).map(([x, y]) => [x * canvas.scale, y * canvas.scale]);
      return { space: "screen", points: toCanvas(b), size, clip: clipRect ? toCanvas(clipRect) : null };
    }
    const laid = this.canvasList.find((l) => l.comp === canvas.comp);
    if (!laid?.worldMatrix) return null;
    const m = laid.worldMatrix;
    const toWorld = (r: UIRect) =>
      corners(r).map(([x, y]) => {
        const lx = (x - laid.width / 2) * laid.pixelSize, ly = (laid.height / 2 - y) * laid.pixelSize;
        return [m[0] * lx + m[4] * ly + m[12], m[1] * lx + m[5] * ly + m[13], m[2] * lx + m[6] * ly + m[14]];
      });
    return { space: "world", points: toWorld(b), size, clip: clipRect ? toWorld(clipRect) : null };
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
   */
  private hit(x: number, y: number): Hit | null {
    for (let k = this.screenList.length - 1; k >= 0; k--) {
      const canvas = this.screenList[k];
      const px = x / canvas.scale, py = y / canvas.scale;
      for (let i = canvas.painted.length - 1; i >= 0; i--) {
        const e = canvas.painted[i];
        if (!this.hittable(e) || !isRaycastTarget(e.comp)) continue;
        const b = e.box;
        if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height && inRect(px, py, e.place.clip)) return { target: e, handler: handlerOf(e) };
      }
    }
    const ray = this.viewRay(x, y);
    if (!ray) return null;
    let best: Entry | null = null, bestDistance = Infinity;
    for (const laid of this.canvasList) {
      const canvas = laid.mode === "world" ? this.canvasEntries.get(laid.comp) : undefined;
      const at = canvas ? this.onWorldCanvas(laid, ray) : null;
      if (!canvas || !at) continue;
      const { ux, uy, t } = at;
      for (let i = canvas.painted.length - 1; i >= 0; i--) {
        const e = canvas.painted[i];
        if (!this.hittable(e) || !isRaycastTarget(e.comp)) continue;
        const b = e.box;
        if (ux < b.x || ux > b.x + b.width || uy < b.y || uy > b.y + b.height || !inRect(ux, uy, e.place.clip)) continue;
        if (t < bestDistance) [best, bestDistance] = [e, t];
        break; // the topmost of this canvas
      }
    }
    return best ? { target: best, handler: handlerOf(best) } : null;
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
    return x.comp === y.comp && x.canvas === y.canvas && x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height && x.order === y.order && x.visible === y.visible && x.opacity === y.opacity && x.text === y.text && x.clipper === y.clipper && sameRect(x.clip, y.clip) && sameRect(x.childClip, y.childClip);
  });
}

function sameRect(a: UIRect | null, b: UIRect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
