// Internal (ADR 0076, 0075 stage 9): draws the UI core's laid-out canvases and elements with Babylon GUI.
// Layout and routing are the core's (`ui/UICore.ts`); this module
// makes no layout decisions: every element becomes a control at its box (absolute, top-left aligned,
// in pixels) inside a plain `Container` per canvas, and Babylon's own pointer handling is switched
// off, so the engine decides who gets the pointer. Loaded on demand by the renderer, so games without
// UI never load `@babylonjs/gui`. Babylon types stay inside this folder (ADR 0010).
//
// Units and scaling:
// - The screen texture is created standalone at the drawing-buffer size (the engine's render size),
//   so one texture pixel is one drawing-buffer pixel. Each screen canvas's root container is
//   `width x height` UI pixels, scaled about its top-left corner by `scale * pixelRatio`: a UI pixel
//   is `scale` CSS pixels is `scale * pixelRatio` buffer pixels. Controls are therefore positioned
//   in UI pixels, and canvas text is rasterised at the device's resolution (crisp on a 2x display),
//   not scaled up from a CSS-pixel texture. Babylon's own adaptive scaling (`idealWidth`,
//   `renderScale`) is left alone, because it would also resize the texture.
// - A world canvas is a plane with its own texture at `WORLD_RESOLUTION` times the reference
//   resolution, its root container scaled by that factor.
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { CreatePlane, CreatePlaneVertexData } from "@babylonjs/core/Meshes/Builders/planeBuilder.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import "@babylonjs/core/Materials/standardMaterial.js"; // the GUI's mesh material
import "@babylonjs/core/Layers/layerSceneComponent.js"; // the fullscreen texture's layer
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture.js";
import { Container } from "@babylonjs/gui/2D/controls/container.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";
import { Image } from "@babylonjs/gui/2D/controls/image.js";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle.js";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import type { BaseGradient } from "@babylonjs/gui/2D/controls/gradient/BaseGradient.js";
import { LinearGradient } from "@babylonjs/gui/2D/controls/gradient/LinearGradient.js";
import { RadialGradient } from "@babylonjs/gui/2D/controls/gradient/RadialGradient.js";
import type { Measure } from "@babylonjs/gui/2D/measure.js";
import type { Component } from "../../core/Component";
import type { Color } from "../../core/math";
import type { World } from "../../core/World";
import { splitSpriteRef } from "../../scene/importSettings";
import type { WarmContent } from "../../scene/warmUp";
import { WARM_PREFIX, type WarmItem } from "./warmUp";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType } from "../../ui/components";
import type { ICanvasRenderingContext } from "@babylonjs/core/Engines/ICanvas.js";
import { fontEpoch, onFontLoaded } from "../../ui/fonts";
import { uiInteractions } from "../../ui/interactions";
import { wrapLine, wrapText, type LineBreakMode } from "../../ui/text/lineBreak";
import type { TextMeasureRequest, UICoreLike, UILaidOutCanvas, UILaidOutElement, UITextRun, UITextWrap } from "../../ui/uiCoreTypes";
import { flipRows, redrawnPixels, type PixelRect } from "../pixelRegions";
import { linearGradientLine, parseBackgroundImage, radialGradientCircle, type PaintBox, type UIBackgroundImage } from "../../ui/document/paintValues";

/** World canvases' texture pixels per UI pixel. */
const WORLD_RESOLUTION = 2;

// TextWrapping is a const enum in Babylon's declarations: use its values.
const WRAP_CLIP = 0;
const WRAP_WORD = 1;

export interface BabylonUIOptions {
  /** Loads a texture asset (`asset:images/logo.png`). Its URL is what the GUI image loads. */
  texture(ref: string): Promise<Texture>;
  /**
   * Draw screen canvases only, skipping world canvases (which the main drawing
   * layer already puts in the scene). The editor's camera preview inset draws its UI with one.
   */
  screenOnly?: boolean;
}

/** Where `sync` puts the screen UI: a rectangle of the drawing canvas, in CSS pixels. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Last values given to a control, so unchanged properties cost one comparison per frame. */
type Last = Record<string, unknown>;

interface CanvasEntry {
  comp: UICanvas;
  root: Container;
  /** The texture this canvas draws on: the shared screen one, or its own. */
  adt: AdvancedDynamicTexture;
  mesh: Mesh | null;
  last: Last;
  stamp: number;
}

interface ElementEntry {
  comp: UIComponentType;
  canvas: CanvasEntry;
  control: Control;
  /** Input fields: the text inside and the caret. Images: nothing. */
  label: TextBlock | null;
  /** Panels whose `backgroundImage` is a `url()` (ADR 0418 wave 2): the image filling the box, under any children. */
  backdrop: Image | null;
  caret: Rectangle | null;
  last: Last;
  stamp: number;
  dead: boolean;
}

/**
 * A text block in the language's direction, wrapping lines by the engine's line breaking (ADR 0356 §5): the context's
 * base direction is the language's, and lines break where `lineBreak.ts` allows (spaces, between CJK characters with
 * the kinsoku rules, Thai words), measured as `textSize` measures them for layout.
 */
class LocalisedTextBlock extends TextBlock {
  /** The base direction (ADR 0356 §5): the canvas context's `direction`, so the browser orders mixed runs within a line. */
  direction: "ltr" | "rtl" = "ltr";
  /** Where lines may break: `ui/text/lineBreak.ts`'s rules, the same ones `textSize` measured with. */
  breakMode: LineBreakMode = "normal";
  /**
   * Texture pixels the redrawn rectangle grows by on every side (Babylon's own hook; Rectangle widens it for its border
   * the same way). A text block doesn't clip (descenders and outlines reach past its box), but when it changes Babylon
   * GUI clears and redraws only its old and new boxes, grown by one padding to the left and top: an outline reaching
   * past the box was left on the texture when the text was cleared or shortened (the flappy sample's start message
   * left the outlined "p"s of "Space" and "flap" on screen). On WebGPU, `uploadRedrawnPart` uploads that same rectangle.
   */
  overflow = 0;
  /** How far its shadow reaches past its box now, and the most of that and the last one (see `PaintedRectangle`). */
  shadowReach = 0;
  shadowOverflow = 0;

  protected override _applyStates(context: ICanvasRenderingContext): void {
    super._applyStates(context);
    const c = context as unknown as { direction?: string; textAlign?: string };
    c.direction = this.direction;
    c.textAlign = "left"; // the block places each line itself, from its left edge
  }

  protected override _parseLineWordWrap(line: string | undefined, width: number, context: ICanvasRenderingContext): object[] {
    const metrics = this as unknown as { _getTextMetricsWidth(m: unknown): number };
    return wrapLine(line ?? "", width, (s) => metrics._getTextMetricsWidth(context.measureText(s)), this.breakMode);
  }

  protected override _computeAdditionalOffsetX(): number {
    return this.overflow;
  }

  protected override _computeAdditionalOffsetY(): number {
    return this.overflow;
  }
}

/**
 * A panel's rectangle with the paint of ADR 0418 wave 2. A Babylon gradient is placed in the texture's pixels, not the
 * control's, so the rectangle rebuilds its gradient for the box it's drawn in, the moment it draws (assigned to the
 * protected field, as a setter would mark it dirty again mid-draw).
 */
class PaintedRectangle extends Rectangle {
  /** The gradient `backgroundImage` names, or null. */
  paint: GradientPaint | null = null;
  /** Texture pixels the redrawn rectangle grows by on every side, for a shadow that moved or shrank (see `LocalisedTextBlock`). */
  overflow = 0;
  /** How far its shadow reaches past its box, in texture pixels. */
  shadowReach = 0;
  private paintedBox = "";

  override set backgroundGradient(value: BaseGradient | null) {
    this.paintedBox = "";
    super.backgroundGradient = value;
  }

  override get backgroundGradient(): BaseGradient | null {
    return super.backgroundGradient;
  }

  protected override _getRectangleFill(context: ICanvasRenderingContext): string | CanvasGradient {
    if (this.paint) {
      const m: Measure = this._currentMeasure;
      const key = `${m.left}|${m.top}|${m.width}|${m.height}`;
      if (key !== this.paintedBox) {
        this.paintedBox = key;
        this._backgroundGradient = babylonGradient(this.paint, m);
      }
    }
    return super._getRectangleFill(context);
  }

  protected override _computeAdditionalOffsetX(): number {
    return super._computeAdditionalOffsetX() + this.overflow;
  }

  protected override _computeAdditionalOffsetY(): number {
    return super._computeAdditionalOffsetY() + this.overflow;
  }
}

/** Draws UI with Babylon GUI. */
export class BabylonUI {
  /** The fullscreen texture for screen canvases (standalone: a frame graph task draws it). */
  readonly screen: AdvancedDynamicTexture;
  private readonly canvases = new Map<UICanvas, CanvasEntry>();
  private readonly elements = new Map<UIComponentType, ElementEntry>();
  private readonly warned = new Set<string>();
  private stamp = 0;
  private disposed = false;
  private readonly offFont: () => void;

  constructor(private readonly scene: Scene, private readonly options: BabylonUIOptions) {
    // A font arrived: the GUI's cached font heights and our line spacings were measured with the fallback.
    this.offFont = onFontLoaded(() => this.fontsChanged());
    this.screen = readableCanvas(scene.getEngine(), () => AdvancedDynamicTexture.CreateFullscreenUI("myco.ui", true, { width: 0, height: 0, scene, useStandalone: true } as never));
    quiet(this.screen);
    uploadRedrawnPart(this.screen);
  }

  /**
   * Each frame after the core's sync: mirror its canvases and elements into GUI controls. The core laid
   * the screen UI out for `cssWidth × cssHeight`; `origin` (CSS pixels, default the canvas's top-left)
   * is where that rectangle is on the drawing canvas.
   */
  sync(_world: World, core: UICoreLike, extra: { caretOf?(c: UIInputField): number | null }, cssWidth: number, cssHeight: number, pixelRatio: number, origin: { x: number; y: number } = { x: 0, y: 0 }): void {
    if (this.disposed) return;
    const stamp = ++this.stamp;
    this.origin = { x: origin.x * pixelRatio, y: origin.y * pixelRatio };

    for (const c of core.canvases()) {
      if (c.mode === "world" && this.options.screenOnly) continue;
      this.syncCanvas(c, pixelRatio, stamp);
    }
    for (const el of core.elements()) {
      const canvas = this.canvases.get(el.canvas);
      if (!canvas) continue;
      this.syncElement(el, canvas, extra, stamp);
    }
    for (const [c, e] of this.elements) {
      if (e.stamp !== stamp) this.removeElement(c, e);
    }
    for (const [c, e] of this.canvases) {
      if (e.stamp !== stamp) this.removeCanvas(c, e);
      // A mesh's GUI texture otherwise redraws only as a camera renders, but the frame graph won't render
      // until every material is ready, and the texture isn't ready until it has drawn once: draw it here.
      else if (e.mesh) e.adt._checkUpdate(null);
    }
  }

  /** Forget a removed component's control. */
  release(c: Component): void {
    if (c instanceof UICanvas) {
      const e = this.canvases.get(c);
      if (e) this.removeCanvas(c, e);
      return;
    }
    const e = this.elements.get(c as UIComponentType);
    if (e) this.removeElement(c as UIComponentType, e);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offFont();
    for (const [c, e] of [...this.canvases]) this.removeCanvas(c, e);
    this.elements.clear();
    this.screen.dispose();
  }

  // --- canvases ---

  private syncCanvas(c: UILaidOutCanvas, pixelRatio: number, stamp: number): void {
    let e = this.canvases.get(c.comp);
    if (!e) {
      e = c.mode === "world" ? this.createWorldCanvas(c) : this.createScreenCanvas(c);
      this.canvases.set(c.comp, e);
    } else if ((c.mode === "world") !== (e.mesh !== null)) {
      // The canvas changed mode: rebuild it (its elements are re-created below, as their entries go with it).
      this.removeCanvas(c.comp, e);
      e = c.mode === "world" ? this.createWorldCanvas(c) : this.createScreenCanvas(c);
      this.canvases.set(c.comp, e);
    }
    e.stamp = stamp;
    const root = e.root;
    root.isVisible = c.visible;
    if (put(root, "size", `${c.width}x${c.height}`)) {
      root.widthInPixels = c.width;
      root.heightInPixels = c.height;
    }
    if (e.mesh) {
      const mesh = e.mesh;
      const k = `${c.width}x${c.height}x${c.pixelSize}`;
      if (e.last.plane !== k) {
        e.last.plane = k;
        CreatePlaneVertexData({ width: c.width * c.pixelSize, height: c.height * c.pixelSize }).applyToMesh(mesh);
        e.adt.scaleTo(Math.max(1, Math.round(c.width * WORLD_RESOLUTION)), Math.max(1, Math.round(c.height * WORLD_RESOLUTION)));
      }
      root.scaleX = root.scaleY = WORLD_RESOLUTION;
      mesh.setEnabled(c.visible);
      if (c.worldMatrix) this.placeMesh(e, mesh, c.worldMatrix);
    } else {
      root.zIndex = c.sortOrder;
      root.scaleX = root.scaleY = c.scale * pixelRatio;
      if (put(root, "x", this.origin.x)) root.leftInPixels = this.origin.x;
      if (put(root, "y", this.origin.y)) root.topInPixels = this.origin.y;
    }
  }

  /** Where screen canvases start on the texture, in its pixels (see `sync`'s `origin`). */
  private origin = { x: 0, y: 0 };

  /**
   * What it drew now (ADR 0276): each visible world canvas's plane.
   */
  *drawn(): Iterable<{ canvas: UICanvas; mesh: Mesh }> {
    for (const [canvas, e] of this.canvases) if (e.mesh?.isEnabled()) yield { canvas, mesh: e.mesh };
  }

  /** A font finished loading: forget font metrics measured without it, and redraw every text. */
  private fontsChanged(): void {
    if (this.disposed) return;
    const sizes = (Control as unknown as { _FontHeightSizes?: Record<string, unknown> })._FontHeightSizes;
    if (sizes) for (const k of Object.keys(sizes)) delete sizes[k];
    this.spacings.clear();
    this.screen.rootContainer._markAllAsDirty();
    for (const e of this.canvases.values()) if (e.mesh) e.adt.rootContainer._markAllAsDirty();
  }

  private createScreenCanvas(c: UILaidOutCanvas): CanvasEntry {
    const root = new Container(`${CANVAS_PREFIX}${c.comp.owner.name}`);
    placeBox(root);
    this.screen.addControl(root);
    return { comp: c.comp, root, adt: this.screen, mesh: null, last: {}, stamp: 0 };
  }

  private createWorldCanvas(c: UILaidOutCanvas): CanvasEntry {
    const name = `${CANVAS_PREFIX}${c.comp.owner.name}`;
    const { mesh, adt } = worldCanvasPlane(this.scene, name, c.width * c.pixelSize, c.height * c.pixelSize, Math.round(c.width * WORLD_RESOLUTION), Math.round(c.height * WORLD_RESOLUTION));
    const root = new Container(name);
    placeBox(root);
    adt.addControl(root);
    return { comp: c.comp, root, adt, mesh, last: {}, stamp: 0 };
  }

  private placeMesh(e: CanvasEntry, mesh: Mesh, m: Float32Array): void {
    const prev = e.last.matrix as Float32Array | undefined;
    let same = prev !== undefined;
    if (prev) for (let i = 0; i < 16; i++) if (prev[i] !== m[i]) { same = false; break; }
    if (same) return;
    e.last.matrix = Float32Array.from(m);
    mesh.unfreezeWorldMatrix();
    mesh.freezeWorldMatrix(Matrix.FromArray(m));
  }

  private removeCanvas(c: UICanvas, e: CanvasEntry): void {
    for (const [comp, el] of this.elements) if (el.canvas === e) this.removeElement(comp, el, true);
    this.canvases.delete(c);
    if (e.mesh) {
      e.adt.dispose();
      e.mesh.dispose(false, true);
    } else {
      this.screen.removeControl(e.root);
      e.root.dispose();
    }
  }

  // --- elements ---

  private syncElement(el: UILaidOutElement, canvas: CanvasEntry, extra: { caretOf?(c: UIInputField): number | null }, stamp: number): void {
    let e = this.elements.get(el.comp);
    if (!e) {
      e = this.createElement(el, canvas);
      this.elements.set(el.comp, e);
    }
    e.stamp = stamp;
    const ctl = e.control;
    ctl.isVisible = el.visible;
    if (!el.visible) return;
    if (put(ctl, "x", el.x)) ctl.leftInPixels = el.x;
    if (put(ctl, "y", el.y)) ctl.topInPixels = el.y;
    if (put(ctl, "w", el.width)) ctl.widthInPixels = el.width;
    if (put(ctl, "h", el.height)) ctl.heightInPixels = el.height;
    if (put(ctl, "z", el.order)) ctl.zIndex = el.order;
    if (put(ctl, "alpha", el.opacity)) ctl.alpha = el.opacity;

    const c = el.comp;
    switch (el.kind) {
      case "panel":
      case "button":
        this.syncPanel(e, c as UIPanel, el, canvas.root.scaleX);
        break;
      case "text":
        this.syncUIText(e, c as UIText, el.text!, canvas.root.scaleX);
        break;
      case "image":
        this.syncImage(e, c as UIImage, el);
        break;
      case "input":
        this.syncInput(e, c as UIInputField, el, extra);
        break;
    }
  }

  private createElement(el: UILaidOutElement, canvas: CanvasEntry): ElementEntry {
    const name = el.comp.owner.name;
    let control: Control;
    let label: TextBlock | null = null;
    let caret: Rectangle | null = null;
    if (el.kind === "text") {
      const t = new LocalisedTextBlock(name);
      t.resizeToFit = false;
      t.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      // Layout gives each line 1.2 em, but a font's ascent plus descent can be a little taller (Inter's is),
      // and a text block clips to its box: the last line's descenders were cut off. Text overflows its line
      // box on the web too.
      t.clipContent = false;
      control = t;
    } else if (el.kind === "image") {
      const image = new Image(name);
      image.autoScale = false;
      control = image;
    } else {
      const r = new PaintedRectangle(name);
      if (el.kind === "input") {
        label = new LocalisedTextBlock(`${name}.text`);
        label.resizeToFit = false;
        label.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        label.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        label.textWrapping = WRAP_CLIP;
        placeBox(label);
        label.isHitTestVisible = false;
        r.addControl(label);
        caret = new Rectangle(`${name}.caret`);
        caret.thickness = 0;
        caret.widthInPixels = 1;
        caret.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        caret.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        caret.isHitTestVisible = false;
        caret.isVisible = false;
        r.addControl(caret);
      }
      control = r;
    }
    placeBox(control);
    control.isHitTestVisible = false;
    canvas.root.addControl(control);
    return { comp: el.comp, canvas, control, label, caret, backdrop: null, last: {}, stamp: 0, dead: false };
  }

  private removeElement(c: UIComponentType, e: ElementEntry, canvasGone = false): void {
    e.dead = true;
    this.elements.delete(c);
    if (!canvasGone) e.canvas.root.removeControl(e.control);
    e.control.dispose();
  }

  /** A panel, button or input field's box. `scale` is its canvas's texture pixels per UI pixel. */
  private syncPanel(e: ElementEntry, c: UIPanel, el: UILaidOutElement, scale: number): void {
    const r = e.control as PaintedRectangle;
    let background = c.backgroundColor;
    let border = c.borderColor;
    // Focus colours (ADR 0340) show while the last UI input was navigation: a button's fill, a field's border.
    const showsFocus = (c instanceof UIButton || c instanceof UIInputField) && uiInteractions(c._world).showsFocus(c);
    if (c instanceof UIButton && c.interactable) {
      // Pressed needs hovered too (a press dragged off the button shows it unpressed).
      if (c.pressed && c.hovered) background = c.pressedColor;
      else if (c.hovered) background = c.hoverColor;
      else if (showsFocus) background = c.focusColor;
    } else if (c instanceof UIInputField && showsFocus) border = c.focusColor;
    const bk = background ? colorKey(background) : -1;
    if (put(r, "bg", bk)) r.background = background ? background.toCss() : "";
    // ADR 0418 wave 2: a corner's own radius, or (at -1) borderRadius. Babylon's corners, by how Rectangle draws them:
    // X top-left, Y top-right, Z bottom-right, W bottom-left (its declarations' comments swap Z and W).
    const corner = (v: number) => (v >= 0 ? v : c.borderRadius);
    const tl = corner(c.borderTopLeftRadius);
    const tr = corner(c.borderTopRightRadius);
    const br = corner(c.borderBottomRightRadius);
    const bl = corner(c.borderBottomLeftRadius);
    if (put(r, "radius", `${tl}|${tr}|${br}|${bl}`)) {
      r.cornerRadiusX = tl;
      r.cornerRadiusY = tr;
      r.cornerRadiusZ = br;
      r.cornerRadiusW = bl;
    }
    if (put(r, "border", c.borderWidth)) r.thickness = c.borderWidth;
    const ck = colorKey(border);
    if (put(r, "color", ck)) r.color = border.toCss();
    // The shadow is the background's (Babylon's Rectangle casts it from its fill). Canvas2D shadows ignore the
    // context's transform, so they're scaled here, as the canvas's scale scales everything else.
    const shadow = c.boxShadowColor;
    if (put(r, "shadow", shadow ? `${colorKey(shadow)}|${c.boxShadowOffsetX}|${c.boxShadowOffsetY}|${c.boxShadowBlur}|${scale}` : "none")) {
      const reach = applyShadow(r, shadow, c.boxShadowOffsetX, c.boxShadowOffsetY, c.boxShadowBlur, scale);
      r.overflow = Math.max(r.shadowReach, reach); // clears the old shadow too when it shrinks or moves
      r.shadowReach = reach;
    }
    if (put(r, "image", c.backgroundImage)) this.setBackgroundImage(e, r, c.backgroundImage, el);
    if (e.backdrop) {
      const inset = c.borderWidth; // the Rectangle insets its children by its thickness
      const w = Math.max(0, el.width - 2 * inset);
      const h = Math.max(0, el.height - 2 * inset);
      if (put(e.backdrop, "w", w)) e.backdrop.widthInPixels = w;
      if (put(e.backdrop, "h", h)) e.backdrop.heightInPixels = h;
    }
  }

  /** A panel's `backgroundImage` (ADR 0418 wave 2): a gradient fill, a texture under its children, or neither. */
  private setBackgroundImage(e: ElementEntry, r: PaintedRectangle, value: string, el: UILaidOutElement): void {
    const parsed = parseBackgroundImage(value);
    if (!parsed.ok) this.warnOnce(`bgimg|${value}`, `UI backgroundImage "${value}" ${parsed.problem}`);
    const image = parsed.ok ? parsed.value : ({ kind: "none" } as const);
    r.paint = image.kind === "linear-gradient" || image.kind === "radial-gradient" ? image : null;
    // In the element's box for now; drawing puts it in the box it's drawn in.
    r.backgroundGradient = r.paint ? babylonGradient(r.paint, { left: el.x, top: el.y, width: el.width, height: el.height }) : null;
    if (image.kind !== "url") {
      if (e.backdrop) {
        r.removeControl(e.backdrop);
        e.backdrop.dispose();
        e.backdrop = null;
      }
      return;
    }
    let img = e.backdrop;
    if (!img) {
      img = new Image(`${r.name}.background`);
      img.autoScale = false;
      img.stretch = Image.STRETCH_FILL;
      img.isHitTestVisible = false;
      img.zIndex = -1; // under an input field's text and caret
      placeBox(img);
      r.addControl(img);
      e.backdrop = img;
    }
    img.source = null;
    const ref = splitSpriteRef(image.path.startsWith("asset:") ? image.path : `asset:${image.path}`).path;
    const backdrop = img;
    this.options
      .texture(ref)
      .then((tex) => {
        if (e.dead || e.backdrop !== backdrop || lasts.get(r)?.image !== value) return; // removed, or another image by now
        if (tex.url) backdrop.source = tex.url;
        else this.warnOnce(`img|${ref}`, `UI background image "${ref}" has no URL to draw`);
      })
      .catch((err) => this.warnOnce(`img|${ref}`, `failed to load UI background image "${ref}": ${(err as Error).message}`));
  }

  /**
   * A UIText: the core's text run (exactly what it measured), with the component's colour, outline and alignment.
   * `scale` is its canvas's texture pixels per UI pixel.
   */
  private syncUIText(e: ElementEntry, c: UIText, run: UITextRun, scale: number): void {
    const t = e.control as LocalisedTextBlock;
    if (put(t, "text", run.text)) t.text = run.text;
    this.setFont(t, run);
    const ck = colorKey(c.color);
    if (put(t, "color", ck)) t.color = c.color.toCss();
    // ADR 0417: in UI pixels like the font size, so the canvas's scale scales it too. Stroked twice as wide, centred on
    // the glyph edge: `textOutlineWidth` shows outside it.
    const outline = c.textOutlineColor && c.textOutlineWidth > 0 ? c.textOutlineWidth : 0;
    if (put(t, "outline", `${outline}|${outline ? colorKey(c.textOutlineColor!) : -1}`)) {
      t.outlineWidth = outline * 2;
      if (outline) t.outlineColor = c.textOutlineColor!.toCss();
    }
    // ADR 0418 wave 2: one shadow under the glyphs, scaled by the canvas like a panel's.
    const shadow = c.textShadowColor;
    if (put(t, "shadow", shadow ? `${colorKey(shadow)}|${c.textShadowOffsetX}|${c.textShadowOffsetY}|${c.textShadowBlur}|${scale}` : "none")) {
      const reach = applyShadow(t, shadow, c.textShadowOffsetX, c.textShadowOffsetY, c.textShadowBlur, scale);
      t.shadowOverflow = Math.max(t.shadowReach, reach); // clears the old shadow too when it shrinks or moves
      t.shadowReach = reach;
    }
    // Kept while the text changes or empties, so the redraw that clears it covers the outline too (see `overflow`).
    t.overflow = Math.max(outline ? Math.ceil(outline * scale) + 1 : 0, t.shadowOverflow);
    // `start`/`end` already resolved for the language's direction (ADR 0356 §5); justify draws from the left, as before.
    const align = run.align === "center" ? Control.HORIZONTAL_ALIGNMENT_CENTER : run.align === "right" ? Control.HORIZONTAL_ALIGNMENT_RIGHT : Control.HORIZONTAL_ALIGNMENT_LEFT;
    if (put(t, "align", align)) t.textHorizontalAlignment = align;
    if (put(t, "dir", run.direction)) t.direction = run.direction;
    if (put(t, "wrap", run.wrap)) {
      t.textWrapping = run.wrap === "none" ? WRAP_CLIP : WRAP_WORD;
      // The block wraps with `lineBreak.ts`, as `textSize` measured: anywhere, or at spaces and between CJK characters.
      t.breakMode = run.wrap === "anywhere" ? "anywhere" : "normal";
    }
  }

  private syncImage(e: ElementEntry, c: UIImage, el: UILaidOutElement): void {
    const img = e.control as Image;
    const ref = c.image ? splitSpriteRef(c.image).path : "";
    if (put(img, "image", ref)) {
      img.source = null;
      if (ref) {
        this.options
          .texture(ref)
          .then((tex) => {
            if (e.dead || lasts.get(img)?.image !== ref) return; // removed, or showing another image by now
            const url = tex.url;
            if (url) img.source = url;
            else this.warnOnce(`img|${ref}`, `UI image "${ref}" has no URL to draw`);
          })
          .catch((err) => this.warnOnce(`img|${ref}`, `failed to load UI image "${ref}": ${(err as Error).message}`));
      }
    }
    if (put(img, "fit", c.fit)) {
      img.stretch = c.fit === "contain" ? Image.STRETCH_UNIFORM : Image.STRETCH_FILL;
    }
    // cover: fill the box and crop the source to its aspect ratio.
    const iw = img.imageWidth;
    const ih = img.imageHeight;
    const crop = c.fit === "cover" && iw > 0 && ih > 0 && el.width > 0 && el.height > 0 ? `${iw}x${ih}|${el.width}x${el.height}` : c.fit === "cover" ? "pending" : "none";
    if (put(img, "cropKey", crop)) {
      if (crop === "none" || crop === "pending") {
        if (img.sourceWidth !== 0 || img.sourceLeft !== 0) {
          img.sourceLeft = img.sourceTop = img.sourceWidth = img.sourceHeight = 0;
        }
      } else {
        const boxAspect = el.width / el.height;
        const srcAspect = iw / ih;
        const sw = srcAspect > boxAspect ? ih * boxAspect : iw;
        const sh = srcAspect > boxAspect ? ih : iw / boxAspect;
        img.sourceLeft = (iw - sw) / 2;
        img.sourceTop = (ih - sh) / 2;
        img.sourceWidth = sw;
        img.sourceHeight = sh;
      }
    }
  }

  private syncInput(e: ElementEntry, c: UIInputField, el: UILaidOutElement, extra: { caretOf?(c: UIInputField): number | null }): void {
    this.syncPanel(e, c, el, e.canvas.root.scaleX);
    const label = e.label!;
    const caret = e.caret!;
    const inset = c.borderWidth; // the Rectangle already insets its children by its thickness
    const run = el.text!; // the value, or the placeholder while it's empty, as the core measured it
    if (put(label, "text", run.text)) label.text = run.text;
    this.setFont(label, run);
    // From the language's start edge, in its direction (ADR 0356 §5).
    const rtl = run.direction === "rtl";
    if (put(label, "dir", run.direction)) {
      (label as LocalisedTextBlock).direction = run.direction;
      label.textHorizontalAlignment = rtl ? Control.HORIZONTAL_ALIGNMENT_RIGHT : Control.HORIZONTAL_ALIGNMENT_LEFT;
    }
    const color = c.value ? c.color : c.placeholderColor;
    if (put(label, "color", colorKey(color))) label.color = color.toCss();
    if (put(label, "left", c.padding)) label.leftInPixels = c.padding;
    const lw = Math.max(0, el.width - 2 * (inset + c.padding));
    if (put(label, "w", lw)) label.widthInPixels = lw;
    const lh = Math.max(0, el.height - 2 * inset);
    if (put(label, "h", lh)) label.heightInPixels = lh;

    const index = c.typing ? (extra.caretOf?.(c) ?? null) : null;
    if (index === null) {
      caret.isVisible = false;
      return;
    }
    const prefix = c.value ? run.text.slice(0, Math.max(0, index)) : "";
    const pw = prefix ? textSize(prefix, run.fontSize, run.fontWeight, run.fontFamily, run.lineHeight).width : 0; // exact, unlike layout's roomier measure
    caret.isVisible = true;
    const ch = run.fontSize * run.lineHeight;
    // Right to left: the text ends at the right edge, so the caret sits that far in from it. Approximate for text that
    // mixes directions (a known limit, ADR 0356 §5).
    const full = rtl && c.value ? textSize(run.text, run.fontSize, run.fontWeight, run.fontFamily, run.lineHeight).width : 0;
    const x = rtl ? c.padding + Math.max(lw, full) - pw : c.padding + pw;
    if (put(caret, "left", x)) caret.leftInPixels = x;
    if (put(caret, "h", ch)) caret.heightInPixels = ch;
    if (put(caret, "color", colorKey(c.color))) caret.background = c.color.toCss();
  }

  /** Font properties of a TextBlock; line spacing makes the line height `lineHeight` times the size. */
  private setFont(t: TextBlock, run: { readonly fontSize: number; readonly fontWeight: string; readonly fontFamily: string; readonly lineHeight: number }): void {
    const { fontSize: size, fontWeight: weight, fontFamily: family, lineHeight } = run;
    if (put(t, "size", size)) t.fontSize = size;
    if (put(t, "weight", weight)) t.fontWeight = weight;
    if (put(t, "family", family)) t.fontFamily = family;
    const key = `${weight}|${size}|${family}|${lineHeight}|${fontEpoch()}`;
    if (put(t, "spacing", key)) t.lineSpacing = this.lineSpacing(`${weight} ${size}px ${family}`, size, lineHeight);
  }

  private readonly spacings = new Map<string, number>();

  /** Pixels between lines that turn the GUI's font height into `lineHeight * size`. */
  private lineSpacing(font: string, size: number, lineHeight: number): number {
    const key = `${font}|${lineHeight}`;
    let s = this.spacings.get(key);
    if (s === undefined) {
      try {
        s = lineHeight * size - Control._GetFontOffset(font, this.scene.getEngine()).height;
      } catch {
        s = 0; // no DOM to measure the font in (Node)
      }
      this.spacings.set(key, s);
    }
    return s;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}

// --- helpers ---

type GradientPaint = Extract<UIBackgroundImage, { kind: "linear-gradient" | "radial-gradient" }>;

/** A Babylon GUI gradient filling `box` (in the pixels it's drawn in) as CSS draws the parsed one. */
function babylonGradient(paint: GradientPaint, box: PaintBox): BaseGradient {
  let g: BaseGradient;
  if (paint.kind === "linear-gradient") {
    const l = linearGradientLine(paint.angle, box);
    g = new LinearGradient(l.x0, l.y0, l.x1, l.y1);
  } else {
    const c = radialGradientCircle(box);
    g = new RadialGradient(c.cx, c.cy, 0, c.cx, c.cy, c.r);
  }
  for (const s of paint.stops) g.addColorStop(s.offset, s.color.toCss());
  return g;
}

/**
 * A control's shadow (ADR 0418 wave 2) from UI-pixel values, in texture pixels (`scale` per UI pixel: Canvas2D draws
 * shadows untransformed). Returns how far it reaches past the box, in texture pixels. Null: none.
 */
function applyShadow(ctl: Control, color: Color | null, offsetX: number, offsetY: number, blur: number, scale: number): number {
  if (!color) {
    ctl.shadowOffsetX = ctl.shadowOffsetY = ctl.shadowBlur = 0;
    return 0;
  }
  ctl.shadowColor = color.toCss();
  ctl.shadowOffsetX = offsetX * scale;
  ctl.shadowOffsetY = offsetY * scale;
  ctl.shadowBlur = Math.max(0, blur) * scale;
  return Math.ceil((Math.max(Math.abs(offsetX), Math.abs(offsetY)) + 2 * Math.max(0, blur)) * scale) + 1;
}

/** Controls sit at absolute pixel boxes from the top-left; the core did the layout. */
function placeBox(c: Control): void {
  c.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  c.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  if (c instanceof Container) {
    c.transformCenterX = 0;
    c.transformCenterY = 0;
  }
}

/**
 * A world canvas's plane (`width` x `height` metres) and its GUI texture (`w` x `h` pixels).
 * Facing: the plane's UVs run +x right and +y up, so seen from the node's +Z the texture reads upright.
 * The material doesn't cull, so the winding doesn't matter (the back reads mirrored, as a sign does).
 */
function worldCanvasPlane(scene: Scene, name: string, width: number, height: number, w: number, h: number): { mesh: Mesh; adt: AdvancedDynamicTexture } {
  const mesh = CreatePlane(name, { width: Math.max(1e-6, width), height: Math.max(1e-6, height) }, scene);
  mesh.isPickable = false;
  mesh.doNotSyncBoundingInfo = false;
  const adt = AdvancedDynamicTexture.CreateForMesh(mesh, Math.max(1, w), Math.max(1, h), false);
  quiet(adt);
  const material = mesh.material as StandardMaterial | null;
  if (material) {
    material.disableLighting = true;
    material.backFaceCulling = false;
  }
  return { mesh, adt };
}

/** @internal A UI canvas's GUI container (and a world canvas's plane) is named this, then its node's name. */
export const CANVAS_PREFIX = "myco.canvas.";

/**
 * @internal ADR 0080: the warm items for `content`'s world-space UI: one world canvas plane (the UI
 * feature's, and before it loads the UI plugin's light warm factory, ADR 0154).
 */
export function worldCanvasWarm(scene: Scene, content: WarmContent): WarmItem[] {
  if (!content.worldUI) return [];
  return [{ key: "worldUI", build: (at) => warmWorldCanvas(scene, `${WARM_PREFIX}canvas`, at) }];
}

/**
 * ADR 0080: a world canvas's plane for the warm-up, made as `createWorldCanvas` makes one
 * (the GUI's material: emissive and opacity from its texture, unlit, not culled) and placed at `at`,
 * so drawing it once makes the pipelines world-space UI draws with.
 */
function warmWorldCanvas(scene: Scene, name: string, at: Matrix): { meshes: Mesh[]; ready(): boolean; dispose(): void } {
  const { mesh, adt } = worldCanvasPlane(scene, name, 1, 1, 2, 2);
  mesh.freezeWorldMatrix(at);
  return {
    meshes: [mesh],
    ready: () => mesh.isReady(true),
    dispose: () => {
      adt.dispose();
      mesh.dispose(false, true);
    },
  };
}

/** The engine owns the pointer and the keyboard: Babylon's handling is off. */
function quiet(adt: AdvancedDynamicTexture): void {
  adt.disablePicking = true;
  adt.disableTabNavigation = true; // Tab would otherwise be swallowed by the GUI's focus walk
}

const lasts = new WeakMap<object, Last>();

/** Store a control's last-given value; true when it changed. (Entries keep their own `last` for components; this is for bare controls.) */
function put(control: object, key: string, value: unknown): boolean {
  let last = lasts.get(control);
  if (!last) lasts.set(control, (last = {}));
  if (last[key] === value) return false;
  last[key] = value;
  return true;
}

/** A number that changes when a colour does (premultiplied rounding like `toCss`). */
function colorKey(c: Color): number {
  const q = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255);
  return (((q(c.r) * 256 + q(c.g)) * 256 + q(c.b)) * 256 + q(c.a));
}

// --- uploading only what was redrawn ---

/**
 * On WebGPU, a GUI texture's update writes only the part its redraw touched (ADR 0075 notes). Babylon
 * GUI redraws only its invalidated rectangle, but its update copied the whole canvas with
 * `copyExternalImageToTexture`, which cost about 5–15 ms of GPU queue time per copy whatever its
 * size, and the pirates HUD's moving ship markers redraw it every other frame. Reading the redrawn
 * pixels back and writing them with `writeTexture` costs in proportion to their area. Anything the
 * shortcut can't do exactly (the first upload, a resize, a full redraw, mipmaps, premultiplied alpha,
 * WebGL2) goes through Babylon's own update.
 */
/** The bit of WebGPU's queue this uses (the project builds without WebGPU's type declarations). */
interface GPUQueueLike {
  writeTexture(destination: { texture: unknown; origin: { x: number; y: number } }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number }): void;
}

/**
 * Make `create`'s GUI texture on a canvas whose 2D context reads back cheaply
 * (`willReadFrequently`) on WebGPU, where `uploadRedrawnPart` reads the redrawn pixels each redraw.
 * Chrome draws a canvas on the GPU until a few readbacks, then moves it to the CPU: that move took
 * about 440 ms of one frame when a pirates match's HUD first drew (ADR 0120). Created on the CPU,
 * readbacks are a copy from the start. Babylon makes the canvas in `DynamicTexture` with
 * `engine.createCanvas` and takes its context with a plain `getContext("2d")`, which returns the
 * context already made with this setting.
 */
function readableCanvas<T>(engine: AbstractEngine, create: () => T): T {
  if (!engine.isWebGPU) return create();
  const original = engine.createCanvas;
  engine.createCanvas = ((width: number, height: number) => {
    const canvas = original.call(engine, width, height);
    try {
      (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true });
    } catch {
      /* a canvas without 2D (none in browsers): Babylon gets its own context */
    }
    return canvas;
  }) as AbstractEngine["createCanvas"];
  try {
    return create();
  } finally {
    engine.createCanvas = original;
  }
}

function uploadRedrawnPart(adt: AdvancedDynamicTexture): void {
  const engine = adt.getScene()?.getEngine() as (AbstractEngine & { _device?: { queue: GPUQueueLike } }) | undefined;
  if (!engine?.isWebGPU || !engine._device) return;
  const device = engine._device;
  let pending: PixelRect | null = null;
  let flipped = new Uint8Array(0);
  // Called after layout, as the redraw starts: the invalidated rectangle is final then.
  adt.onBeginRenderObservable.add(() => {
    const r = (adt as unknown as { _invalidatedRectangle: { left: number; top: number; width: number; height: number } | null })._invalidatedRectangle;
    const size = adt.getSize();
    pending = r ? redrawnPixels(r, size.width, size.height) : null;
  });
  const full = adt.update.bind(adt);
  adt.update = (invertY?: boolean, premulAlpha?: boolean, allowGPUOptimization?: boolean) => {
    const rect = pending;
    pending = null;
    const internal = adt.getInternalTexture();
    const gpu = (internal as unknown as { _hardwareTexture?: { underlyingResource?: unknown } } | null)?._hardwareTexture?.underlyingResource;
    const size = adt.getSize();
    if (!rect || !internal || !gpu || !internal.isReady || internal.generateMipMaps || premulAlpha || internal.width !== size.width || internal.height !== size.height) {
      full(invertY, premulAlpha, allowGPUOptimization);
      return;
    }
    const rowBytes = rect.width * 4;
    let pixels: Uint8ClampedArray | Uint8Array = adt.getContext().getImageData(rect.x, rect.y, rect.width, rect.height).data;
    let y = rect.y;
    if (invertY) {
      pixels = flipped = flipRows(pixels, rowBytes, rect.height, flipped);
      y = size.height - rect.y - rect.height;
    }
    device.queue.writeTexture({ texture: gpu, origin: { x: rect.x, y } }, pixels, { bytesPerRow: rowBytes, rowsPerImage: rect.height }, { width: rect.width, height: rect.height });
  };
}

// --- text measuring ---

interface MeasureContext {
  font: string;
  measureText(text: string): { width: number };
}

let measureContext: MeasureContext | null | undefined;

function context(): MeasureContext | null {
  if (measureContext !== undefined) return measureContext;
  try {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : typeof document !== "undefined" ? document.createElement("canvas") : null;
    measureContext = (canvas?.getContext("2d") as MeasureContext | null | undefined) ?? null;
  } catch {
    measureContext = null;
  }
  return measureContext;
}

/**
 * Text's lines (wrapped to `maxWidth` by `lineBreak.ts`: at spaces and between CJK characters, or at any character for
 * `wrap: "anywhere"`, as the drawing's text blocks wrap) and the widest one.
 */
function textSize(text: string, fontSize: number, weight: string, family: string, lineHeight: number, maxWidth = Infinity, wrap: UITextWrap = "word"): { width: number; height: number; lines: number } {
  const ctx = context();
  const width = (s: string) => {
    if (!ctx) return s.length * fontSize * 0.55; // no canvas (Node): a per-character estimate
    return ctx.measureText(s).width;
  };
  if (ctx) ctx.font = `${weight} ${fontSize}px ${family}`;
  const wrapped = wrapText(text, maxWidth, width, wrap === "anywhere" ? "anywhere" : "normal");
  const lines = Math.max(1, wrapped.length);
  const widest = wrapped.reduce((w, l) => Math.max(w, l.width), 0);
  return { width: widest, height: lines * lineHeight * fontSize, lines };
}

/**
 * Measure a text run in UI pixels for the core's layout (`UICoreHost.measureText`): a 2D canvas's
 * `measureText` with the font string the GUI text blocks use, wrapped to `maxWidth` as the run's `wrap`
 * says. Empty text is one line tall and zero wide. Without a canvas (Node) it estimates.
 */
export function measureText(req: TextMeasureRequest): { width: number; height: number } {
  // The GUI measures text at the size it's drawn: a canvas's scale × the pixel ratio. Font hinting doesn't
  // scale linearly, so at small drawn sizes text comes out a little wider than measured here at full size,
  // and the GUI wrapped a one-line title onto a second, clipped line. So wrap against a narrower width
  // (never fewer lines than the GUI draws) and report a slightly wider box.
  const maxWidth = req.wrap === "none" ? Infinity : req.maxWidth;
  const { width, height } = textSize(req.text, req.fontSize, req.fontWeight, req.fontFamily, req.lineHeight, maxWidth / TEXT_SLACK, req.wrap);
  if (width <= 0) return { width: 0, height };
  const roomy = width * TEXT_SLACK + 1;
  return { width: width <= maxWidth ? Math.min(maxWidth, roomy) : roomy, height }; // a word wider than maxWidth overflows, as before
}

/** Room measured text gets over its full-size measurement (see `measureText`). */
const TEXT_SLACK = 1.05;
