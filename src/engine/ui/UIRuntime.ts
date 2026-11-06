/**
 * The UI runtime (ADR 0069): mirrors a World's UI components into pmndrs uikit objects, lays them
 * out (Yoga), draws screen canvases in the UI pass, and routes the pointer to UI before game
 * scripts run. The render backend imports this module the first time its World has a `UICanvas`,
 * so games without UI never load uikit or Yoga. Nothing here is public API (ADR 0010).
 *
 * It needs no WebGL until `render`: layout and routing work in Node, which is how the tests run it.
 */
import { Container, Image as UikitImage, Input as UikitInput, Text as UikitText, reversePainterSortStable, type Component as UikitComponent } from "@pmndrs/uikit";
import { Matrix4, Object3D, OrthographicCamera, Ray, Raycaster, Scene, Vector2 as ThreeVector2, Vector3 as ThreeVector3, type Camera as ThreeCamera, type Texture, type WebGLRenderer } from "three";
import type { Color } from "../core/math";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { Input } from "../input/Input";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType, type UILength } from "./components";
import type { UICorners, UIPickRay } from "./uiCoreTypes";

/** What the render backend gives the runtime. */
export interface UIHost {
  /** The three.js scene world canvases join (null: world canvases aren't drawn). */
  readonly scene?: Object3D | null;
  /** The camera that draws the view, for world canvases' pointer rays. */
  camera?(): ThreeCamera | null;
  /** Load a texture asset (`asset:images/logo.png`). */
  texture?(ref: string): Promise<Texture>;
}

export interface UIRuntimeOptions {
  /** Route the pointer and keyboard to UI (false in the editor's own World: clicks select there). */
  interactive?: boolean;
  host?: UIHost;
}

/** A rectangle in canvas CSS pixels, origin top-left. */
export interface UIRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Kind = "canvas" | "panel" | "text" | "image" | "button" | "input";

interface Entry {
  readonly comp: UIComponentType;
  readonly kind: Kind;
  readonly obj: UikitComponent;
  /** The JSON of the properties last given to uikit. */
  sig: string;
  /** Its canvas (itself for a canvas); null while it has none (not drawn). */
  canvas: CanvasEntry | null;
  /** Children in node order, as last added to `obj`. */
  children: Entry[];
  /** Image: the texture asset requested, and the texture once loaded. */
  texturePath?: string;
  texture?: Texture | null;
  /** An element above it (in the UI tree) has `visible` false. */
  hiddenByAncestor?: boolean;
  /** Input field: Enter was pressed since the last routing. */
  pendingSubmit?: boolean;
  /** Input field: the DOM listener to remove. */
  detach?: () => void;
}

interface CanvasEntry extends Entry {
  readonly comp: UICanvas;
  /** Screen mode: its own scene and orthographic camera, one UI pixel per unit. */
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  /** Canvas CSS pixels per UI pixel (screen mode). */
  scale: number;
  /** The interactive elements in draw order (later is on top), from the last sync. */
  interactive: Entry[];
  /** Every element in draw order (later is on top), from the last sync: the editor's picking. */
  elements: Entry[];
}

const LEAF_KINDS: ReadonlySet<Kind> = new Set(["text", "image", "input"]);

/**
 * Canvas CSS pixels per UI pixel for a screen canvas, like Unity's Canvas Scaler in "scale with
 * screen size" mode: the width and height ratios blended in log space by `matchHeight` (0: width).
 */
export function canvasScale(canvasWidth: number, canvasHeight: number, refWidth: number, refHeight: number, matchHeight: number): number {
  if (!(canvasWidth > 0 && canvasHeight > 0 && refWidth > 0 && refHeight > 0)) return 1;
  const m = Math.min(Math.max(matchHeight, 0), 1);
  const lw = Math.log2(canvasWidth / refWidth), lh = Math.log2(canvasHeight / refHeight);
  return 2 ** (lw + (lh - lw) * m);
}

/** A length field as uikit takes it: pixels, a percentage, `"auto"`, or undefined when empty or unreadable. */
export function uiLength(v: UILength | null | undefined): number | string | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (s === "auto") return "auto";
  if (/^-?\d+(\.\d+)?%$/.test(s)) return s;
  const px = s.replace(/px$/, "");
  const n = Number(px);
  return px !== "" && Number.isFinite(n) ? n : undefined;
}

/** `#rrggbbaa`: uikit reads hex as sRGB (like three.js colours) and takes the alpha from it. */
function hex8(c: Color): string {
  const a = Math.round(Math.min(Math.max(c.a, 0), 1) * 255).toString(16).padStart(2, "0");
  return c.toHex() + a;
}

function kindOf(c: UIComponentType): Kind {
  if (c instanceof UICanvas) return "canvas";
  if (c instanceof UIButton) return "button";
  if (c instanceof UIInputField) return "input";
  if (c instanceof UIText) return "text";
  if (c instanceof UIImage) return "image";
  return "panel";
}

const scratch = { m: new Matrix4(), inv: new Matrix4(), v: new ThreeVector3(), ray: new Ray(), raycaster: new Raycaster(), ndc: new ThreeVector2() };

export class UIRuntime {
  private readonly entries = new Map<UIComponentType, Entry>();
  private readonly canvases = new Map<UICanvas, CanvasEntry>();
  private readonly interactiveMode: boolean;
  private readonly host: UIHost;
  private readonly removeHook: () => void;
  private readonly warned = new Set<string>();
  private world: World | null = null;
  private width = 0;
  private height = 0;
  /** The button a pointer press began on, until it's released. */
  private pressed: Entry | null = null;
  private disposed = false;

  constructor(options: UIRuntimeOptions = {}) {
    this.interactiveMode = options.interactive ?? true;
    this.host = options.host ?? {};
    this.removeHook = Input._addFrameHook(() => this.route());
  }

  /** Set what uikit needs from the renderer: its transparent sort (it falls back to three's for other objects) and local clipping. */
  static prepare(renderer: WebGLRenderer): void {
    renderer.setTransparentSort(reversePainterSortStable);
    renderer.localClippingEnabled = true;
  }

  /** Step 8: mirror the World's UI components, lay them out for a canvas of `width`×`height` CSS pixels. */
  sync(world: World, width: number, height: number, deltaSeconds = 0): void {
    if (this.disposed) return;
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
        if (first && first !== c) this.warnOnce(`two|${e}`, `node "${c.owner.name}" has two UI components; only its ${first.constructor.name} is drawn.`);
        else byNode.set(e, c);
      }
    }
    for (const c of [...this.entries.keys()]) if (!live.has(c) || byNode.get(c.owner.entity) !== c) this.release(c);
    for (const c of byNode.values()) this.ensure(c);

    // The tree: each canvas's descendants in node order; elements outside a canvas aren't drawn.
    const placed = new Set<Entry>();
    for (const canvas of this.canvases.values()) {
      canvas.canvas = canvas;
      canvas.interactive = [];
      canvas.elements = [];
      placed.add(canvas);
      this.collect(canvas.comp.owner, canvas, canvas, byNode, placed);
    }
    for (const entry of this.entries.values()) {
      if (placed.has(entry)) continue;
      entry.canvas = null;
      entry.obj.parent?.remove(entry.obj);
      if (entry.comp.isActiveAndEnabled) this.warnOnce(`orphan|${entry.comp.owner.entity}`, `UI element "${entry.comp.owner.name}" has no UICanvas above it, so it isn't drawn.`);
    }

    for (const entry of this.entries.values()) {
      if (entry.canvas) this.applyProperties(entry);
      if (entry.obj instanceof UikitInput) this.syncFocus(entry.comp as UIInputField, entry.obj as UikitInput);
    }
    for (const canvas of this.canvases.values()) this.placeCanvas(world, canvas);
    for (const canvas of this.canvases.values()) {
      if (canvas.comp.isActiveAndEnabled) canvas.obj.update(deltaSeconds * 1000);
    }
  }

  /** Step 9: draw the screen canvases over what's drawn, in ascending `sortOrder`, each over the last. */
  render(renderer: WebGLRenderer): void {
    for (const canvas of this.screenCanvases()) {
      renderer.clearDepth();
      renderer.render(canvas.scene, canvas.camera);
    }
  }

  /** True when there's a screen canvas to draw. */
  get hasScreenUI(): boolean {
    return this.screenCanvases().length > 0;
  }

  /** @internal Tests and the editor: an element's rectangle on the canvas (screen canvases only; null otherwise or before layout). */
  rectOf(c: UIComponentType): UIRect | null {
    const entry = this.entries.get(c);
    const canvas = entry?.canvas;
    if (!entry || !canvas || canvas.comp.mode !== "screen" || !entry.obj.size.value) return null;
    const m = this.panelWorld(entry, scratch.m);
    if (!m) return null;
    const s = canvas.scale;
    const a = scratch.v.set(-0.5, 0.5, 0).applyMatrix4(m);
    const [x0, y0] = [a.x * s, -a.y * s];
    const b = scratch.v.set(0.5, -0.5, 0).applyMatrix4(m);
    const [x1, y1] = [b.x * s, -b.y * s];
    return { x: Math.min(x0, x1) + 0, y: Math.min(y0, y1) + 0, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }

  /** @internal Tests: the topmost interactive element under a canvas point, or null. */
  hitTest(x: number, y: number): UIComponentType | null {
    return this.hit(x, y)?.comp ?? null;
  }

  /**
   * Editor (ADR 0077 wave B): every drawn element under a canvas CSS point, topmost first: screen
   * canvases from the highest `sortOrder` (each canvas's elements from the last drawn), then world
   * canvases nearest first, hit with `ray` (the editor's scene camera's) or else the host's camera.
   * Canvases themselves aren't listed. The same contract as the UI core's `pickAll`.
   */
  pickAll(x: number, y: number, ray?: UIPickRay | null): UIComponentType[] {
    const out: UIComponentType[] = [];
    for (const canvas of this.screenCanvases().reverse()) {
      const px = x / canvas.scale, py = -y / canvas.scale;
      for (let i = canvas.elements.length - 1; i >= 0; i--) {
        const e = canvas.elements[i];
        if (!this.hittable(e)) continue;
        const m = this.panelWorld(e, scratch.m);
        if (!m) continue;
        const p = scratch.v.set(px, py, 0).applyMatrix4(scratch.inv.copy(m).invert());
        if (Math.abs(p.x) <= 0.5 && Math.abs(p.y) <= 0.5) out.push(e.comp);
      }
    }
    const worldRay = this.pickRay(x, y, ray);
    if (!worldRay) return out;
    const hits: { comps: UIComponentType[]; t: number }[] = [];
    const local = new Ray();
    for (const canvas of this.canvases.values()) {
      if (canvas.comp.mode !== "world" || !canvas.comp.isActiveAndEnabled || !canvas.obj.parent) continue;
      const comps: UIComponentType[] = [];
      let nearest = Infinity;
      for (let i = canvas.elements.length - 1; i >= 0; i--) {
        const e = canvas.elements[i];
        if (!this.hittable(e)) continue;
        const m = this.panelWorld(e, scratch.m);
        if (!m) continue;
        local.copy(worldRay).applyMatrix4(scratch.inv.copy(m).invert());
        if (Math.abs(local.direction.z) < 1e-9) continue;
        const t = -local.origin.z / local.direction.z;
        if (t < 0) continue;
        const p = local.at(t, scratch.v);
        if (Math.abs(p.x) > 0.5 || Math.abs(p.y) > 0.5) continue;
        comps.push(e.comp);
        nearest = Math.min(nearest, p.applyMatrix4(m).distanceTo(worldRay.origin));
      }
      if (comps.length) hits.push({ comps, t: nearest });
    }
    hits.sort((a, b) => a.t - b.t);
    for (const h of hits) out.push(...h.comps);
    return out;
  }

  /**
   * Editor (ADR 0077 wave B): an element's box corners (top-left, top-right, bottom-right,
   * bottom-left) from the last layout, canvas CSS pixels on a screen canvas, world points on a world
   * canvas, with its size in UI pixels. Null when it isn't laid out. As the UI core's `cornersOf`.
   */
  cornersOf(c: UIComponentType): UICorners | null {
    const entry = this.entries.get(c);
    const canvas = entry?.canvas;
    const size = entry?.obj.size.value;
    if (!entry || !canvas || !size) return null;
    const m = this.panelWorld(entry, new Matrix4());
    if (!m) return null;
    const local = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
    const points = local.map(([lx, ly]) => {
      const p = new ThreeVector3(lx, ly, 0).applyMatrix4(m);
      return canvas.comp.mode === "world" ? [p.x, p.y, p.z] : [p.x * canvas.scale, -p.y * canvas.scale];
    });
    return { space: canvas.comp.mode === "world" ? "world" : "screen", points, size: [size[0], size[1]] };
  }

  /** A world ray under a canvas point: the given one, else the host camera's; null without either. */
  private pickRay(x: number, y: number, ray?: UIPickRay | null): Ray | null {
    if (ray) return new Ray(new ThreeVector3(...ray.origin), new ThreeVector3(...ray.direction).normalize());
    const camera = this.host.camera?.();
    if (!camera || !(this.width > 0 && this.height > 0)) return null;
    scratch.ndc.set((x / this.width) * 2 - 1, 1 - (y / this.height) * 2);
    scratch.raycaster.setFromCamera(scratch.ndc, camera);
    return scratch.raycaster.ray.clone();
  }

  /** Release the uikit object of a removed component. */
  release(c: UIComponentType): void {
    const entry = this.entries.get(c);
    if (!entry) return;
    this.entries.delete(c);
    if (c instanceof UICanvas) this.canvases.delete(c);
    if (this.pressed === entry) this.pressed = null;
    entry.detach?.();
    entry.obj.parent?.remove(entry.obj);
    entry.obj.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.removeHook();
    for (const c of [...this.entries.keys()]) this.release(c);
    this.disposed = true;
  }

  // --- Building -------------------------------------------------------------------------------

  private ensure(c: UIComponentType): Entry {
    const existing = this.entries.get(c);
    if (existing) return existing;
    const kind = kindOf(c);
    let entry: Entry;
    if (kind === "canvas") {
      const scene = new Scene();
      const camera = new OrthographicCamera(0, 1, 0, -1, -1000, 1000);
      const canvas: CanvasEntry = { comp: c as UICanvas, kind, obj: new Container(), sig: "", canvas: null, children: [], scene, camera, scale: 1, interactive: [], elements: [] };
      this.canvases.set(c as UICanvas, canvas);
      entry = canvas;
    } else if (kind === "text") {
      entry = { comp: c, kind, obj: new UikitText(), sig: "", canvas: null, children: [] };
    } else if (kind === "image") {
      entry = { comp: c, kind, obj: new UikitImage(), sig: "", canvas: null, children: [] };
    } else if (kind === "input") {
      entry = this.createInput(c as UIInputField);
    } else {
      entry = { comp: c, kind, obj: new Container(), sig: "", canvas: null, children: [] };
    }
    this.entries.set(c, entry);
    return entry;
  }

  /**
   * An input field: uikit's Input, whose hidden DOM `<input>` takes typing (IME and paste work). Without
   * a DOM (a Node test), a Text showing the value stands in; focus and routing still work.
   */
  private createInput(c: UIInputField): Entry {
    if (typeof document === "undefined") return { comp: c, kind: "input", obj: new UikitText(), sig: "", canvas: null, children: [] };
    const input = new UikitInput();
    const entry: Entry = { comp: c, kind: "input", obj: input, sig: "", canvas: null, children: [] };
    const onKey = (e: Event) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter") entry.pendingSubmit = true;
      else if (key === "Escape") c._focused = false;
    };
    input.element.addEventListener("keydown", onKey);
    entry.detach = () => input.element.removeEventListener("keydown", onKey);
    return entry;
  }

  /** Walk `node`'s descendants in order, placing UI elements under `parent` (skipping nodes without one). */
  private collect(node: GameObject, parent: Entry, canvas: CanvasEntry, byNode: Map<number, UIComponentType>, placed: Set<Entry>): void {
    const children: Entry[] = [];
    // `hidden`: a UI element above (a leaf's parent included, for nodes under a leaf) has `visible` false.
    const walk = (n: GameObject, into: Entry, list: Entry[], hidden: boolean) => {
      for (const child of n.children) {
        if (child.isComponentNode) continue; // its component counts as its owner's (ADR 0009)
        const c = byNode.get(child.entity);
        if (!c) {
          walk(child, into, list, hidden);
          continue;
        }
        if (c instanceof UICanvas) continue; // a nested canvas is a root of its own
        const entry = this.entries.get(c)!;
        entry.canvas = canvas;
        entry.hiddenByAncestor = hidden;
        const hiddenBelow = hidden || !c.visible;
        placed.add(entry);
        if (entry.kind === "button" || entry.kind === "input") canvas.interactive.push(entry);
        canvas.elements.push(entry);
        if (LEAF_KINDS.has(into.kind)) {
          this.warnOnce(`leaf|${child.entity}`, `UI element "${child.name}" is under a ${into.comp.constructor.name}, which can't have children; it lays out beside it instead.`);
        }
        list.push(entry);
        if (LEAF_KINDS.has(entry.kind)) walk(child, into, list, hiddenBelow); // children of a leaf join its parent
        else {
          const own: Entry[] = [];
          walk(child, entry, own, hiddenBelow);
          this.setChildren(entry, own);
        }
      }
    };
    walk(node, parent, children, false);
    this.setChildren(parent, children);
  }

  /** Make `entry.obj`'s uikit children `children`, in order, re-adding only when they changed. */
  private setChildren(entry: Entry, children: Entry[]): void {
    const same = entry.children.length === children.length && entry.children.every((c, i) => c === children[i] && c.obj.parent === entry.obj);
    if (same) return;
    for (const c of entry.children) if (c.obj.parent === entry.obj) entry.obj.remove(c.obj);
    for (const c of children) entry.obj.add(c.obj);
    entry.children = children;
  }

  // --- Properties -----------------------------------------------------------------------------

  private applyProperties(entry: Entry): void {
    const props = this.properties(entry);
    const sig = JSON.stringify(props) + (entry.kind === "image" ? `|${entry.texturePath}|${entry.texture ? entry.texture.uuid : ""}` : "");
    if (sig === entry.sig) return;
    entry.sig = sig;
    if (entry.kind === "image" && entry.texture) props.src = entry.texture;
    if (entry.kind === "input" && entry.obj instanceof UikitInput) {
      const c = entry.comp as UIInputField;
      props.onValueChange = (v: string) => (c.value = c.maxLength > 0 ? v.slice(0, c.maxLength) : v);
      props.onFocusChange = (focused: boolean) => (c._focused = focused);
    }
    try {
      (entry.obj as UikitComponent).resetProperties(props as never);
    } catch (err) {
      this.warnOnce(`props|${entry.comp.owner.entity}`, `UI element "${entry.comp.owner.name}" has a value uikit can't use: ${(err as Error).message}`);
    }
  }

  /** The uikit properties of an element, from its component's fields. */
  private properties(entry: Entry): Record<string, unknown> {
    const c = entry.comp;
    const display = c.isActiveAndEnabled && (c instanceof UICanvas || c.display !== "none") ? "flex" : "none";
    if (c instanceof UICanvas) {
      const canvas = entry as CanvasEntry;
      if (c.mode === "world") {
        return { width: c.referenceResolution.x, height: c.referenceResolution.y, pixelSize: c.pixelSize, anchorX: "center", anchorY: "center", display };
      }
      const s = canvasScale(this.width, this.height, c.referenceResolution.x, c.referenceResolution.y, c.matchHeight);
      canvas.scale = s;
      return { width: this.width / s, height: this.height / s, pixelSize: 1, anchorX: "left", anchorY: "top", display };
    }
    const props: Record<string, unknown> = {
      display,
      flexDirection: c.flexDirection,
      justifyContent: c.justifyContent,
      alignItems: c.alignItems,
      gap: c.gap,
      padding: c.padding,
      margin: c.margin,
      width: uiLength(c.width),
      height: uiLength(c.height),
      positionType: c.positionType,
      positionTop: uiLength(c.top),
      positionRight: uiLength(c.right),
      positionBottom: uiLength(c.bottom),
      positionLeft: uiLength(c.left),
      flexGrow: c.flexGrow,
      opacity: c.opacity,
      // uikit's visibility doesn't reach children: an element under a hidden one is hidden too, as on Babylon.
      visibility: c.visible && !entry.hiddenByAncestor ? "visible" : "hidden",
    };
    if (c instanceof UIPanel) {
      let background = c.backgroundColor;
      if (c instanceof UIButton && c.interactable) {
        if (c.pressed && c.hovered) background = c.pressedColor;
        else if (c.hovered) background = c.hoverColor;
      }
      if (background) props.backgroundColor = hex8(background);
      props.borderRadius = c.borderRadius;
      props.borderWidth = c.borderWidth;
      props.borderColor = hex8(c.borderColor);
    }
    if (c instanceof UIText) {
      Object.assign(props, { text: c.text, fontSize: c.fontSize, color: hex8(c.color), fontWeight: c.fontWeight, textAlign: c.textAlign, wordBreak: c.wordBreak });
    } else if (c instanceof UIImage) {
      this.requestTexture(entry, c.image);
      Object.assign(props, { objectFit: c.fit === "cover" ? "cover" : "fill", keepAspectRatio: c.fit !== "fill" });
    } else if (c instanceof UIInputField) {
      const text = { fontSize: c.fontSize, color: hex8(c.color) };
      if (entry.obj instanceof UikitInput) {
        Object.assign(props, text, { value: c.value, placeholder: c.placeholder, placeholderStyle: { color: hex8(c.placeholderColor) } });
        const el = entry.obj.element;
        if (c.maxLength > 0) el.maxLength = c.maxLength;
        else el.removeAttribute("maxlength");
      } else {
        Object.assign(props, text, { text: c.value || c.placeholder, color: hex8(c.value ? c.color : c.placeholderColor) });
      }
    }
    for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
    return props;
  }

  /** Move DOM focus to or from the field's hidden input when a click or a script changed `focused`. */
  private syncFocus(c: UIInputField, input: UikitInput): void {
    const want = c.focused && input.parent !== null;
    const has = input.hasFocus.peek();
    if (want && !has) input.focus();
    else if (!want && has) input.blur();
  }

  private requestTexture(entry: Entry, ref: string): void {
    if (entry.texturePath === ref) return;
    entry.texturePath = ref;
    entry.texture = null;
    if (!ref || !this.host.texture) return;
    this.host
      .texture(ref)
      .then((tex) => {
        if (entry.texturePath === ref) entry.texture = tex;
      })
      .catch((err) => this.warnOnce(`tex|${ref}`, `failed to load UI image "${ref}": ${(err as Error).message}`));
  }

  /** Put a canvas's root where it draws: its own scene and camera (screen), or the World's scene at its node (world). */
  private placeCanvas(world: World, canvas: CanvasEntry): void {
    const root = canvas.obj;
    const c = canvas.comp;
    if (c.mode === "world") {
      const scene = this.host.scene ?? null;
      if (root.parent !== scene) {
        root.parent?.remove(root);
        scene?.add(root);
      }
      const e = c.owner.entity;
      scratch.m.fromArray(world.worldMatrix(e), e * 16);
      scratch.m.decompose(root.position, root.quaternion, root.scale);
    } else {
      if (root.parent !== canvas.scene) {
        root.parent?.remove(root);
        canvas.scene.add(root);
      }
      root.position.set(0, 0, 0);
      root.quaternion.identity();
      root.scale.set(1, 1, 1);
      const cam = canvas.camera;
      const w = this.width / canvas.scale, h = this.height / canvas.scale;
      if (cam.right !== w || cam.bottom !== -h) {
        cam.left = 0;
        cam.right = w;
        cam.top = 0;
        cam.bottom = -h;
        cam.updateProjectionMatrix();
      }
    }
    root.updateMatrix();
    root.parent?.updateMatrixWorld();
  }

  private screenCanvases(): CanvasEntry[] {
    return [...this.canvases.values()].filter((c) => c.comp.mode === "screen" && c.comp.isActiveAndEnabled && c.obj.parent === c.scene).sort((a, b) => a.comp.sortOrder - b.comp.sortOrder);
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

  /** The topmost interactive element under a canvas point: screen canvases from the highest `sortOrder`, then the nearest in world canvases. */
  private hit(x: number, y: number): Entry | null {
    const screens = this.screenCanvases().reverse();
    for (const canvas of screens) {
      const px = x / canvas.scale, py = -y / canvas.scale;
      for (let i = canvas.interactive.length - 1; i >= 0; i--) {
        const e = canvas.interactive[i];
        if (!this.hittable(e)) continue;
        const m = this.panelWorld(e, scratch.m);
        if (!m) continue;
        const p = scratch.v.set(px, py, 0).applyMatrix4(scratch.inv.copy(m).invert());
        if (Math.abs(p.x) <= 0.5 && Math.abs(p.y) <= 0.5) return e;
      }
    }
    const camera = this.host.camera?.();
    if (!camera || !(this.width > 0 && this.height > 0)) return null;
    let best: Entry | null = null, bestDistance = Infinity;
    const { raycaster, ndc, ray } = scratch;
    ndc.set((x / this.width) * 2 - 1, 1 - (y / this.height) * 2);
    raycaster.setFromCamera(ndc, camera);
    for (const canvas of this.canvases.values()) {
      if (canvas.comp.mode !== "world" || !canvas.comp.isActiveAndEnabled || !canvas.obj.parent) continue;
      for (const e of canvas.interactive) {
        if (!this.hittable(e)) continue;
        const m = this.panelWorld(e, scratch.m);
        if (!m) continue;
        ray.copy(raycaster.ray).applyMatrix4(scratch.inv.copy(m).invert());
        if (Math.abs(ray.direction.z) < 1e-9) continue;
        const t = -ray.origin.z / ray.direction.z;
        if (t < 0) continue;
        const p = ray.at(t, scratch.v);
        if (Math.abs(p.x) > 0.5 || Math.abs(p.y) > 0.5) continue;
        const d = p.applyMatrix4(m).distanceTo(raycaster.ray.origin);
        if (d < bestDistance) [best, bestDistance] = [e, d];
      }
    }
    return best;
  }

  private hittable(e: Entry): boolean {
    return e.comp.isActiveAndEnabled && e.obj.isVisible.value && !!e.obj.size.value;
  }

  /** The matrix taking an element's unit panel square (±0.5) to world space: its root's transform times uikit's panel matrix. */
  private panelWorld(e: Entry, out: Matrix4): Matrix4 | null {
    const panel = e.obj.globalPanelMatrix.value;
    const root = e.canvas?.obj;
    if (!panel || !root) return null;
    root.updateMatrix();
    out.copy(root.matrix);
    if (root.parent) out.premultiply(root.parent.matrixWorld);
    return out.multiply(panel);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}
