/**
 * The renderer-neutral UI core (ADR 0076): mirrors a World's UI components into a Yoga tree, lays it
 * out, routes the pointer and keyboard to UI before game scripts run, and takes input fields' typing
 * through a hidden DOM `<input>`. A backend's drawing layer draws what `canvases()` and `elements()`
 * report. It replaces the layout, tree and routing parts of `UIRuntime.ts` (ADR 0069), which stays
 * for the three.js backend until it is removed. Nothing here is public API (ADR 0010).
 *
 * Yoga loads asynchronously (WebAssembly): the constructor starts the load and `sync` lays nothing
 * out until it's ready (`await core.ready` to wait). Without a `document` (Node) there is no typing
 * element; routing and layout work all the same.
 */
import type { Node as YogaNode, Yoga } from "yoga-layout/load";
import { Mat4, Vector2 } from "../core/math";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { Input } from "../input/Input";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType } from "./components";
import { UI_FONT_FAMILY, UI_LINE_HEIGHT, canvasScale, cssFontWeight, estimateText, loadYogaOnce, uiLength } from "./layout";
import type { TextMeasureRequest, UICoreHost, UICoreLike, UICoreOptions, UIKind, UILaidOutCanvas, UILaidOutElement, UIPickRay } from "./uiCoreTypes";

export { canvasScale, uiLength } from "./layout";

type ElementKind = Exclude<UIKind, "canvas">;

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
  /** What last made a measured node dirty. */
  measureSig: string;
  /** Last laid-out result, in its canvas's UI pixels. */
  box: { x: number; y: number; width: number; height: number; visible: boolean; opacity: number };
  /** Input field: Enter was pressed since the last routing. */
  pendingSubmit?: boolean;
}

interface CanvasEntry extends Entry {
  readonly comp: UICanvas;
  scale: number;
  width: number;
  height: number;
  /** Elements in draw order, from the last sync. */
  elements: Entry[];
  /** The interactive elements in draw order (later is on top). */
  interactive: Entry[];
}

const LEAF_KINDS: ReadonlySet<UIKind> = new Set(["text", "image", "input"]);

function kindOf(c: UIComponentType): UIKind {
  if (c instanceof UICanvas) return "canvas";
  if (c instanceof UIButton) return "button";
  if (c instanceof UIInputField) return "input";
  if (c instanceof UIText) return "text";
  if (c instanceof UIImage) return "image";
  return "panel";
}

const scratchInv = new Float32Array(16);

export class UICore implements UICoreLike {
  /** Resolves when Yoga has loaded. */
  readonly ready: Promise<void>;
  layoutVersion = 0;

  private yoga: Yoga | null = null;
  private config: ReturnType<Yoga["Config"]["create"]> | null = null;
  private readonly entries = new Map<UIComponentType, Entry>();
  private readonly canvasEntries = new Map<UICanvas, CanvasEntry>();
  private readonly interactiveMode: boolean;
  private readonly host: UICoreHost;
  private readonly removeHook: () => void;
  private readonly warned = new Set<string>();
  private world: World | null = null;
  private width = 0;
  private height = 0;
  /** The button a pointer press began on, until it's released. */
  private pressed: Entry | null = null;
  private disposed = false;
  private canvasList: UILaidOutCanvas[] = [];
  private elementList: UILaidOutElement[] = [];
  private screenList: CanvasEntry[] = [];

  // Typing: one hidden DOM <input>, shared by whichever field is focused.
  private dom: HTMLInputElement | null = null;
  private active: UIInputField | null = null;
  private activeEntry: Entry | null = null;
  private programmatic = false;
  private detachDom: (() => void) | null = null;

  constructor(options: UICoreOptions = {}) {
    this.interactiveMode = options.interactive ?? true;
    this.host = options.host ?? {};
    this.removeHook = Input._addFrameHook(() => this.route());
    this.ready = loadYogaOnce().then((yoga) => {
      if (this.disposed) return;
      this.yoga = yoga;
      this.config = yoga.Config.create();
      this.config.setPointScaleFactor(0); // no rounding: boxes are exact in UI pixels
    });
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
    return this.hit(x, y)?.comp ?? null;
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
    for (const type of [UICanvas, UIPanel, UIText, UIImage] as (abstract new () => UIComponentType)[]) {
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
    const kind = kindOf(c);
    const node = yoga.Node.create(this.config ?? undefined);
    const entry: Entry = { comp: c, kind, node, parent: null, children: [], canvas: null, measureSig: "", box: { x: 0, y: 0, width: 0, height: 0, visible: false, opacity: 1 } };
    if (kind === "canvas") {
      const canvas = entry as CanvasEntry;
      canvas.scale = 1;
      canvas.width = canvas.height = 0;
      canvas.elements = [];
      canvas.interactive = [];
      this.canvasEntries.set(c as UICanvas, canvas);
    } else if (kind === "text") {
      node.setMeasureFunc((w, wm) => this.measure(entry, wm === yoga.MEASURE_MODE_UNDEFINED ? Infinity : w));
    } else if (kind === "input") {
      node.setMeasureFunc(() => this.measure(entry, Infinity));
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
        if (LEAF_KINDS.has(entry.kind)) {
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
    const flexDirections = { row: yoga.FLEX_DIRECTION_ROW, column: yoga.FLEX_DIRECTION_COLUMN, "row-reverse": yoga.FLEX_DIRECTION_ROW_REVERSE, "column-reverse": yoga.FLEX_DIRECTION_COLUMN_REVERSE };
    const justify = { "flex-start": yoga.JUSTIFY_FLEX_START, center: yoga.JUSTIFY_CENTER, "flex-end": yoga.JUSTIFY_FLEX_END, "space-between": yoga.JUSTIFY_SPACE_BETWEEN, "space-around": yoga.JUSTIFY_SPACE_AROUND, "space-evenly": yoga.JUSTIFY_SPACE_EVENLY };
    const align = { "flex-start": yoga.ALIGN_FLEX_START, center: yoga.ALIGN_CENTER, "flex-end": yoga.ALIGN_FLEX_END, stretch: yoga.ALIGN_STRETCH, baseline: yoga.ALIGN_BASELINE };
    n.setDisplay(c.isActiveAndEnabled && c.display !== "none" ? yoga.DISPLAY_FLEX : yoga.DISPLAY_NONE);
    n.setFlexDirection(flexDirections[c.flexDirection] ?? yoga.FLEX_DIRECTION_ROW);
    n.setJustifyContent(justify[c.justifyContent] ?? yoga.JUSTIFY_FLEX_START);
    n.setAlignItems(align[c.alignItems] ?? yoga.ALIGN_STRETCH);
    n.setGap(yoga.GUTTER_ALL, finite(c.gap));
    n.setPadding(yoga.EDGE_ALL, finite(c.padding));
    n.setMargin(yoga.EDGE_ALL, finite(c.margin));
    n.setWidth(uiLength(c.width));
    n.setHeight(uiLength(c.height));
    n.setPositionType(c.positionType === "absolute" ? yoga.POSITION_TYPE_ABSOLUTE : yoga.POSITION_TYPE_RELATIVE);
    n.setPosition(yoga.EDGE_TOP, autoToUndefined(uiLength(c.top)));
    n.setPosition(yoga.EDGE_RIGHT, autoToUndefined(uiLength(c.right)));
    n.setPosition(yoga.EDGE_BOTTOM, autoToUndefined(uiLength(c.bottom)));
    n.setPosition(yoga.EDGE_LEFT, autoToUndefined(uiLength(c.left)));
    n.setFlexGrow(finite(c.flexGrow));
    n.setFlexShrink(entry.kind === "text" ? 1 : 0); // text wraps to what's left; other boxes keep their size
    n.setBorder(yoga.EDGE_ALL, c instanceof UIPanel ? finite(c.borderWidth) : 0);

    let sig: string | null = null;
    if (c instanceof UIText) sig = `${c.text}|${c.fontSize}|${c.fontWeight}`;
    else if (c instanceof UIInputField) sig = `${c.value || c.placeholder}|${c.fontSize}`;
    if (sig !== null && sig !== entry.measureSig) {
      entry.measureSig = sig;
      n.markDirty();
    }
  }

  private measure(entry: Entry, maxWidth: number): { width: number; height: number } {
    const c = entry.comp;
    if (c instanceof UIText) {
      const request: TextMeasureRequest = { text: c.text, fontSize: c.fontSize, fontWeight: cssFontWeight(c.fontWeight), fontFamily: UI_FONT_FAMILY, lineHeight: UI_LINE_HEIGHT, maxWidth };
      return this.host.measureText?.(request) ?? estimateText(request);
    }
    if (c instanceof UIInputField) {
      // One line at the field's size, whatever it holds.
      const request: TextMeasureRequest = { text: c.value || c.placeholder, fontSize: c.fontSize, fontWeight: "400", fontFamily: UI_FONT_FAMILY, lineHeight: UI_LINE_HEIGHT, maxWidth: Infinity };
      const m = this.host.measureText?.(request) ?? estimateText(request);
      return { width: m.width, height: c.fontSize * UI_LINE_HEIGHT };
    }
    return { width: 0, height: 0 };
  }

  /** Read Yoga's boxes into the entries' absolute (canvas UI pixel) boxes, visibility and opacity, in draw order. */
  private readLayout(canvas: CanvasEntry): void {
    canvas.elements = [];
    canvas.interactive = [];
    const cv = canvas.comp.isActiveAndEnabled;
    canvas.box = { x: 0, y: 0, width: canvas.width, height: canvas.height, visible: cv, opacity: 1 };
    const walk = (parent: Entry, ox: number, oy: number, visible: boolean, opacity: number) => {
      for (const e of parent.children) {
        const c = e.comp as Exclude<UIComponentType, UICanvas>;
        const x = ox + e.node.getComputedLeft(), y = oy + e.node.getComputedTop();
        const v = visible && c.isActiveAndEnabled && c.visible && c.display !== "none";
        const o = opacity * c.opacity;
        e.box = { x, y, width: e.node.getComputedWidth(), height: e.node.getComputedHeight(), visible: v, opacity: o };
        canvas.elements.push(e);
        if (e.kind === "button" || e.kind === "input") canvas.interactive.push(e);
        walk(e, x, y, v, o);
      }
    };
    walk(canvas, 0, 0, cv, 1);
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
      canvas.elements.forEach((e, order) => {
        const b = e.box;
        elementList.push({ comp: e.comp, kind: e.kind as ElementKind, canvas: c, x: b.x, y: b.y, width: b.width, height: b.height, order, visible: b.visible, opacity: b.opacity });
      });
    }
    const changed = !sameCanvases(this.canvasList, canvasList) || !sameElements(this.elementList, elementList);
    this.screenList = canvases.filter((c) => c.comp.mode === "screen" && c.comp.isActiveAndEnabled);
    if (!changed) return;
    this.canvasList = canvasList;
    this.elementList = elementList;
    this.layoutVersion++;
  }

  // --- Typing ---------------------------------------------------------------------------------

  /** The input field that should have the keyboard now: focused, laid out and visible. */
  private wantedField(): Entry | null {
    for (const e of this.entries.values()) {
      if (e.kind !== "input" || !e.canvas) continue;
      const c = e.comp as UIInputField;
      if (c.focused && e.box.visible) return e;
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
    const onInput = () => {
      const c = this.active;
      if (!c) return;
      let v = el.value;
      if (c.maxLength > 0 && v.length > c.maxLength) {
        v = v.slice(0, c.maxLength);
        el.value = v;
      }
      c.value = v;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && this.activeEntry) this.activeEntry.pendingSubmit = true;
      else if (e.key === "Escape" && this.active) this.active._focused = false;
    };
    const onBlur = () => {
      if (this.programmatic || !this.active) return;
      // A press on the canvas takes DOM focus first; routing re-focuses the field that press hit.
      const raw = Input._raw();
      if (raw.down(0) || raw.held(0)) return;
      this.active._focused = false;
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
    if (typeof document === "undefined") return;
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
      this.activeEntry = want;
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
    if (el.value !== wantComp.value) el.value = wantComp.value; // a script changed it
  }

  private unfocusDom(): void {
    const el = this.dom;
    this.active = null;
    this.activeEntry = null;
    if (el && typeof document !== "undefined" && document.activeElement === el) {
      this.programmatic = true;
      el.blur();
      this.programmatic = false;
    }
  }

  // --- Pointer routing ------------------------------------------------------------------------

  /**
   * The frame hook (ADR 0069), run in `Input.beginFrame` before any World steps: hit-test the
   * pointer against last frame's layout, claim it for UI, update buttons and focus.
   */
  private route(): void {
    const world = this.world;
    if (this.disposed || !world) return;
    const buttons = [...this.entries.values()].filter((e) => e.kind === "button");
    const fields = [...this.entries.values()].filter((e) => e.kind === "input");
    if (!this.interactiveMode || !world._takesInput) {
      for (const b of buttons) (b.comp as UIButton)._hovered = (b.comp as UIButton)._pressed = false;
      this.pressed = null;
      return;
    }
    const raw = Input._raw();
    const hit = this.hit(raw.pointer.x, raw.pointer.y);
    if (hit) Input._claimPointer();
    // Scripts in the World's next frame see what happened now.
    const frame = world.time.frameCount + 1;
    const usable = (e: Entry | null) => !!e && e.kind === "button" && (e.comp as UIButton).interactable && e.comp.isActiveAndEnabled;

    for (const b of buttons) (b.comp as UIButton)._hovered = b === hit && usable(b);
    if (raw.down(0)) {
      this.pressed = usable(hit) ? hit : null;
      for (const f of fields) (f.comp as UIInputField)._focused = f === hit;
    }
    if (this.pressed && !this.entries.has(this.pressed.comp)) this.pressed = null;
    if (raw.up(0)) {
      if (this.pressed && this.pressed === hit) (this.pressed.comp as UIButton)._clickFrame = frame;
      this.pressed = null;
    } else if (this.pressed && !raw.held(0) && !raw.down(0)) this.pressed = null; // released without an up (focus lost)
    for (const b of buttons) (b.comp as UIButton)._pressed = b === this.pressed;

    let focused = false;
    for (const f of fields) {
      const c = f.comp as UIInputField;
      if (f.pendingSubmit) {
        f.pendingSubmit = false;
        if (c.focused) c._submitFrame = frame;
      }
      focused ||= c.focused;
    }
    if (focused) Input._claimKeyboard();
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
      for (let i = canvas.elements.length - 1; i >= 0; i--) {
        const e = canvas.elements[i];
        if (!this.hittable(e)) continue;
        const b = e.box;
        if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) out.push(e.comp);
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
      for (let i = canvas.elements.length - 1; i >= 0; i--) {
        const e = canvas.elements[i];
        if (!this.hittable(e)) continue;
        const b = e.box;
        if (at.ux >= b.x && at.ux <= b.x + b.width && at.uy >= b.y && at.uy <= b.y + b.height) comps.push(e.comp);
      }
      if (comps.length) hits.push({ comps, t: at.t });
    }
    hits.sort((a, b) => a.t - b.t);
    for (const h of hits) out.push(...h.comps);
    return out;
  }

  /**
   * Editor (ADR 0077 wave B): an element's box corners (top-left, top-right, bottom-right,
   * bottom-left) from the last layout: canvas CSS pixels `[x, y]` on a screen canvas, world points
   * `[x, y, z]` on a world canvas. Null when it isn't laid out.
   */
  cornersOf(c: UIComponentType): { space: "screen" | "world"; points: number[][] } | null {
    const entry = this.entries.get(c);
    const canvas = entry?.canvas;
    if (!entry || !canvas || !this.yoga) return null;
    const b = entry.box;
    const xs = [b.x, b.x + b.width, b.x + b.width, b.x], ys = [b.y, b.y, b.y + b.height, b.y + b.height];
    if (canvas.comp.mode !== "world") return { space: "screen", points: xs.map((x, i) => [x * canvas.scale, ys[i] * canvas.scale]) };
    const laid = this.canvasList.find((l) => l.comp === canvas.comp);
    if (!laid?.worldMatrix) return null;
    const m = laid.worldMatrix;
    const points = xs.map((x, i) => {
      const lx = (x - laid.width / 2) * laid.pixelSize, ly = (laid.height / 2 - ys[i]) * laid.pixelSize;
      return [m[0] * lx + m[4] * ly + m[12], m[1] * lx + m[5] * ly + m[13], m[2] * lx + m[6] * ly + m[14]];
    });
    return { space: "world", points };
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

  /** The topmost interactive element under a canvas point: screen canvases from the highest `sortOrder`, then the nearest in world canvases. */
  private hit(x: number, y: number): Entry | null {
    for (let k = this.screenList.length - 1; k >= 0; k--) {
      const canvas = this.screenList[k];
      const px = x / canvas.scale, py = y / canvas.scale;
      for (let i = canvas.interactive.length - 1; i >= 0; i--) {
        const e = canvas.interactive[i];
        if (!this.hittable(e)) continue;
        const b = e.box;
        if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) return e;
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
      for (let i = canvas.interactive.length - 1; i >= 0; i--) {
        const e = canvas.interactive[i];
        if (!this.hittable(e)) continue;
        const b = e.box;
        if (ux < b.x || ux > b.x + b.width || uy < b.y || uy > b.y + b.height) continue;
        if (t < bestDistance) [best, bestDistance] = [e, t];
        break; // the topmost of this canvas
      }
    }
    return best;
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
    return x.comp === y.comp && x.canvas === y.canvas && x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height && x.order === y.order && x.visible === y.visible && x.opacity === y.opacity;
  });
}
