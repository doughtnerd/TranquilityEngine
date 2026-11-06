// Internal (ADR 0076, 0075 stage 9): draws the UI core's laid-out canvases and elements with Babylon GUI,
// and the interim `Text` component. Layout and routing are the core's (`ui/UICore.ts`); this module
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
// - The interim `Text` components sit in a container scaled by `pixelRatio` alone, so they're placed
//   in CSS pixels like the three.js backend does.
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
import type { Component } from "../../core/Component";
import type { Color } from "../../core/math";
import type { World } from "../../core/World";
import { splitSpriteRef } from "../../scene/importSettings";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType } from "../../ui/components";
import { fontEpoch, fontFamilyOf, onFontLoaded } from "../../ui/fonts";
import { UI_FONT_FAMILY, UI_LINE_HEIGHT } from "../../ui/layout";
import type { TextMeasureRequest, UICoreLike, UILaidOutCanvas, UILaidOutElement } from "../../ui/uiCoreTypes";
import { Text, type Anchor } from "../components";

/** World canvases' texture pixels per UI pixel. */
export const WORLD_RESOLUTION = 2;
export { UI_FONT_FAMILY, UI_LINE_HEIGHT };

// TextWrapping is a const enum in Babylon's declarations: use its values.
const WRAP_CLIP = 0;
const WRAP_WORD = 1;

export interface BabylonUIOptions {
  /** Loads a texture asset (`asset:images/logo.png`). Its URL is what the GUI image loads. */
  texture(ref: string): Promise<Texture>;
  /**
   * Draw screen canvases and the interim Text only, skipping world canvases (which the main drawing
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
  caret: Rectangle | null;
  last: Last;
  stamp: number;
  dead: boolean;
}

interface TextEntry {
  control: TextBlock;
  last: Last;
  stamp: number;
}

/** Draws UI with Babylon GUI. */
export class BabylonUI {
  /** The fullscreen texture for screen canvases and the interim Text (standalone: a frame graph task draws it). */
  readonly screen: AdvancedDynamicTexture;
  private readonly canvases = new Map<UICanvas, CanvasEntry>();
  private readonly elements = new Map<UIComponentType, ElementEntry>();
  private readonly texts = new Map<Text, TextEntry>();
  /** Holds the interim Text controls, scaled by the pixel ratio, below every canvas. */
  private readonly textRoot: Container;
  private readonly warned = new Set<string>();
  private stamp = 0;
  private disposed = false;
  private readonly offFont: () => void;

  constructor(private readonly scene: Scene, private readonly options: BabylonUIOptions) {
    // A font arrived: the GUI's cached font heights and our line spacings were measured with the fallback.
    this.offFont = onFontLoaded(() => this.fontsChanged());
    this.screen = AdvancedDynamicTexture.CreateFullscreenUI("myco.ui", true, { width: 0, height: 0, scene, useStandalone: true } as never);
    quiet(this.screen);
    uploadRedrawnPart(this.screen);
    this.textRoot = new Container("myco.texts");
    placeBox(this.textRoot);
    this.textRoot.zIndex = -1e9;
    this.screen.addControl(this.textRoot);
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
    this.textRoot.scaleX = this.textRoot.scaleY = pixelRatio;
    if (put(this.textRoot, "size", `${cssWidth}x${cssHeight}`)) {
      this.textRoot.widthInPixels = cssWidth;
      this.textRoot.heightInPixels = cssHeight;
    }
    if (put(this.textRoot, "x", this.origin.x)) this.textRoot.leftInPixels = this.origin.x;
    if (put(this.textRoot, "y", this.origin.y)) this.textRoot.topInPixels = this.origin.y;

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

  /** The interim Text components, on the screen texture (CSS pixels). */
  syncTexts(world: World, cssWidth: number, cssHeight: number): void {
    if (this.disposed) return;
    const stamp = ++this.stamp;
    for (const t of world._componentsOfType(Text)) this.syncText(t, cssWidth, cssHeight, stamp);
    for (const [t, e] of this.texts) {
      if (e.stamp === stamp) continue;
      this.textRoot.removeControl(e.control);
      e.control.dispose();
      this.texts.delete(t);
    }
  }

  /** Forget a removed component's control. */
  release(c: Component): void {
    if (c instanceof Text) {
      const e = this.texts.get(c);
      if (!e) return;
      this.textRoot.removeControl(e.control);
      e.control.dispose();
      this.texts.delete(c);
      return;
    }
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
    this.texts.clear();
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
    const root = new Container(`myco.canvas.${c.comp.owner.name}`);
    placeBox(root);
    this.screen.addControl(root);
    return { comp: c.comp, root, adt: this.screen, mesh: null, last: {}, stamp: 0 };
  }

  private createWorldCanvas(c: UILaidOutCanvas): CanvasEntry {
    const name = `myco.canvas.${c.comp.owner.name}`;
    const mesh = CreatePlane(name, { width: Math.max(1e-6, c.width * c.pixelSize), height: Math.max(1e-6, c.height * c.pixelSize) }, this.scene);
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = false;
    const w = Math.max(1, Math.round(c.width * WORLD_RESOLUTION));
    const h = Math.max(1, Math.round(c.height * WORLD_RESOLUTION));
    // Facing: the plane's UVs run +x right and +y up, so seen from the node's +Z the texture reads upright.
    // The material doesn't cull, so the winding doesn't matter (the back reads mirrored, as a sign does).
    const adt = AdvancedDynamicTexture.CreateForMesh(mesh, w, h, false);
    quiet(adt);
    const material = mesh.material as StandardMaterial | null;
    if (material) {
      material.disableLighting = true;
      material.backFaceCulling = false;
    }
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
        this.syncPanel(e, c as UIPanel);
        break;
      case "text":
        this.syncUIText(e, c as UIText, el);
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
      const t = new TextBlock(name);
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
      const r = new Rectangle(name);
      if (el.kind === "input") {
        label = new TextBlock(`${name}.text`);
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
    return { comp: el.comp, canvas, control, label, caret, last: {}, stamp: 0, dead: false };
  }

  private removeElement(c: UIComponentType, e: ElementEntry, canvasGone = false): void {
    e.dead = true;
    this.elements.delete(c);
    if (!canvasGone) e.canvas.root.removeControl(e.control);
    e.control.dispose();
  }

  private syncPanel(e: ElementEntry, c: UIPanel): void {
    const r = e.control as Rectangle;
    let background = c.backgroundColor;
    if (c instanceof UIButton && c.interactable) {
      // As UIRuntime.properties(): pressed needs hovered too.
      if (c.pressed && c.hovered) background = c.pressedColor;
      else if (c.hovered) background = c.hoverColor;
    }
    const bk = background ? colorKey(background) : -1;
    if (put(r, "bg", bk)) r.background = background ? background.toCss() : "";
    if (put(r, "radius", c.borderRadius)) r.cornerRadius = c.borderRadius;
    if (put(r, "border", c.borderWidth)) r.thickness = c.borderWidth;
    const ck = colorKey(c.borderColor);
    if (put(r, "color", ck)) r.color = c.borderColor.toCss();
  }

  private syncUIText(e: ElementEntry, c: UIText, el: UILaidOutElement): void {
    const t = e.control as TextBlock;
    if (put(t, "text", c.text)) t.text = c.text;
    this.setFont(t, c.fontSize, cssWeight(c.fontWeight), fontFamilyOf(c.font), UI_LINE_HEIGHT);
    const ck = colorKey(c.color);
    if (put(t, "color", ck)) t.color = c.color.toCss();
    const align = c.textAlign === "center" ? Control.HORIZONTAL_ALIGNMENT_CENTER : c.textAlign === "right" ? Control.HORIZONTAL_ALIGNMENT_RIGHT : Control.HORIZONTAL_ALIGNMENT_LEFT;
    if (put(t, "align", align)) t.textHorizontalAlignment = align;
    if (put(t, "wordBreak", c.wordBreak)) {
      t.textWrapping = c.wordBreak === "keep-all" ? WRAP_CLIP : WRAP_WORD;
      // break-all: any character may end a line (the splitter hands the wrapper letters, joined with nothing).
      t.wordSplittingFunction = c.wordBreak === "break-all" ? (line: string) => [...line] : null;
      t.wordDivider = c.wordBreak === "break-all" ? "" : " ";
    }
    void el;
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
    this.syncPanel(e, c);
    const label = e.label!;
    const caret = e.caret!;
    const inset = c.borderWidth; // the Rectangle already insets its children by its thickness
    const text = c.value || c.placeholder;
    if (put(label, "text", text)) label.text = text;
    const family = fontFamilyOf(c.font);
    this.setFont(label, c.fontSize, "400", family, UI_LINE_HEIGHT);
    const color = c.value ? c.color : c.placeholderColor;
    if (put(label, "color", colorKey(color))) label.color = color.toCss();
    if (put(label, "left", c.padding)) label.leftInPixels = c.padding;
    const lw = Math.max(0, el.width - 2 * (inset + c.padding));
    if (put(label, "w", lw)) label.widthInPixels = lw;
    const lh = Math.max(0, el.height - 2 * inset);
    if (put(label, "h", lh)) label.heightInPixels = lh;

    const index = c.focused ? (extra.caretOf?.(c) ?? null) : null;
    if (index === null) {
      caret.isVisible = false;
      return;
    }
    const prefix = c.value.slice(0, Math.max(0, index));
    const pw = prefix ? textSize(prefix, c.fontSize, "400", family, UI_LINE_HEIGHT).width : 0; // exact, unlike layout's roomier measure
    caret.isVisible = true;
    const ch = c.fontSize * UI_LINE_HEIGHT;
    if (put(caret, "left", c.padding + pw)) caret.leftInPixels = c.padding + pw;
    if (put(caret, "h", ch)) caret.heightInPixels = ch;
    if (put(caret, "color", colorKey(c.color))) caret.background = c.color.toCss();
  }

  /** Font properties of a TextBlock; line spacing makes the line height `lineHeight` times the size. */
  private setFont(t: TextBlock, size: number, weight: string, family: string, lineHeight: number): void {
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

  // --- interim Text ---

  private syncText(t: Text, W: number, H: number, stamp: number): void {
    let e = this.texts.get(t);
    if (!e) {
      const control = new TextBlock(`myco.text.${t.owner.name}`);
      control.resizeToFit = false;
      control.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      control.clipContent = false; // descenders and outlines may reach past the box
      placeBox(control);
      control.isHitTestVisible = false;
      this.textRoot.addControl(control);
      e = { control, last: {}, stamp: 0 };
      this.texts.set(t, e);
    }
    e.stamp = stamp;
    const ctl = e.control;
    const visible = t.isActiveAndEnabled && t.text.length > 0;
    ctl.isVisible = visible;
    if (!visible) return;

    const outline = t.outlineColor && t.outlineWidth > 0 ? t.outlineWidth : 0;
    if (put(ctl, "text", t.text)) ctl.text = t.text;
    const weight = t.fontWeight;
    this.setFont(ctl, t.fontSize, weight, t.fontFamily, t.lineHeight);
    if (put(ctl, "color", colorKey(t.color))) ctl.color = t.color.toCss();
    if (put(ctl, "outline", `${outline}|${t.outlineColor ? colorKey(t.outlineColor) : -1}`)) {
      // The three.js backend strokes with lineWidth `outlineWidth * 2`, centred on the glyph edge.
      ctl.outlineWidth = outline * 2;
      if (t.outlineColor) ctl.outlineColor = t.outlineColor.toCss();
    }
    const align = t.align === "left" ? Control.HORIZONTAL_ALIGNMENT_LEFT : t.align === "right" ? Control.HORIZONTAL_ALIGNMENT_RIGHT : Control.HORIZONTAL_ALIGNMENT_CENTER;
    if (put(ctl, "align", align)) ctl.textHorizontalAlignment = align;

    // The box, as RenderBackend.drawText: the text plus `pad` on every side.
    const pad = Math.ceil(outline + 2);
    const size = textSize(t.text, t.fontSize, weight, t.fontFamily, t.lineHeight);
    const w = Math.ceil(size.width + pad * 2);
    const h = Math.ceil(t.lineHeight * t.fontSize * size.lines + pad * 2);
    if (put(ctl, "pad", pad)) {
      ctl.paddingLeftInPixels = ctl.paddingRightInPixels = ctl.paddingTopInPixels = ctl.paddingBottomInPixels = pad;
    }
    if (put(ctl, "w", w)) ctl.widthInPixels = w;
    if (put(ctl, "h", h)) ctl.heightInPixels = h;
    // Anchor point + offset (offset.y down), and the box's own anchor point on it.
    const [ax, ay] = anchorFactors(t.anchor);
    const left = ax * (W - w) + t.offset.x;
    const top = ay * (H - h) + t.offset.y;
    if (put(ctl, "x", left)) ctl.leftInPixels = left;
    if (put(ctl, "y", top)) ctl.topInPixels = top;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}

// --- helpers ---

/** Controls sit at absolute pixel boxes from the top-left; the core did the layout. */
function placeBox(c: Control): void {
  c.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  c.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  if (c instanceof Container) {
    c.transformCenterX = 0;
    c.transformCenterY = 0;
  }
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

/** UIText.fontWeight (`"bold"`, `300`...) as a CSS weight. */
export function cssWeight(w: string): string {
  switch (w) {
    case "light": return "300";
    case "normal": return "400";
    case "medium": return "500";
    case "semi-bold": return "600";
    case "bold": return "700";
    default: return /^\d+$/.test(w) ? w : "400";
  }
}

function anchorFactors(anchor: Anchor): [number, number] {
  switch (anchor) {
    case "top-left": return [0, 0];
    case "top": return [0.5, 0];
    case "top-right": return [1, 0];
    case "left": return [0, 0.5];
    case "right": return [1, 0.5];
    case "bottom-left": return [0, 1];
    case "bottom": return [0.5, 1];
    case "bottom-right": return [1, 1];
    default: return [0.5, 0.5];
  }
}

// --- uploading only what was redrawn ---

/** A rectangle of a texture, in its pixels from the top-left. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * @internal The whole pixels a redraw touched: Babylon GUI's invalidated rectangle (fractional, and
 * possibly past the edges) grown by a pixel for antialiasing and clamped to the texture. Null when
 * nothing of it is on the texture.
 */
export function redrawnPixels(r: { left: number; top: number; width: number; height: number }, width: number, height: number): PixelRect | null {
  const x = Math.max(0, Math.floor(r.left) - 1), y = Math.max(0, Math.floor(r.top) - 1);
  const w = Math.min(width, Math.ceil(r.left + r.width) + 1) - x, h = Math.min(height, Math.ceil(r.top + r.height) + 1) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

/** @internal `rows` rows of RGBA pixels, `rowBytes` each, in reverse order, into `into` (grown as needed). */
export function flipRows(pixels: Uint8ClampedArray | Uint8Array, rowBytes: number, rows: number, into: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = into.length >= rows * rowBytes ? into : new Uint8Array(rows * rowBytes);
  for (let j = 0; j < rows; j++) out.set(pixels.subarray(j * rowBytes, (j + 1) * rowBytes), (rows - 1 - j) * rowBytes);
  return out;
}

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

/** @internal Tests: forget the cached 2D context (after stubbing `OffscreenCanvas`). */
export function _resetTextMeasurer(): void {
  measureContext = undefined;
}

/** Text's lines (wrapped to `maxWidth` at spaces, as the GUI's word wrapping does) and the widest one. */
function textSize(text: string, fontSize: number, weight: string, family: string, lineHeight: number, maxWidth = Infinity): { width: number; height: number; lines: number } {
  const ctx = context();
  const width = (s: string) => {
    if (!ctx) return s.length * fontSize * 0.55; // no canvas (Node): a per-character estimate
    return ctx.measureText(s).width;
  };
  if (ctx) ctx.font = `${weight} ${fontSize}px ${family}`;
  let lines = 0;
  let widest = 0;
  for (const paragraph of text.split("\n")) {
    if (!Number.isFinite(maxWidth)) {
      lines++;
      widest = Math.max(widest, width(paragraph));
      continue;
    }
    const words = paragraph.split(" ");
    let line = words[0];
    let lineWidth = width(line);
    for (let n = 1; n < words.length; n++) {
      const test = `${line} ${words[n]}`;
      const w = width(test);
      if (w > maxWidth) {
        lines++;
        widest = Math.max(widest, lineWidth);
        line = words[n];
        lineWidth = width(line);
      } else {
        line = test;
        lineWidth = w;
      }
    }
    lines++;
    widest = Math.max(widest, lineWidth);
  }
  lines = Math.max(1, lines);
  return { width: widest, height: lines * lineHeight * fontSize, lines };
}

/**
 * Measure text in UI pixels for the core's layout (`UICoreHost.measureText`): a 2D canvas's `measureText`
 * with the font string the GUI text blocks use, wrapped at spaces to `maxWidth`. Empty text is one line
 * tall and zero wide. Without a canvas (Node) it estimates.
 */
export function measureText(req: TextMeasureRequest): { width: number; height: number } {
  // The GUI measures text at the size it's drawn: a canvas's scale × the pixel ratio. Font hinting doesn't
  // scale linearly, so at small drawn sizes text comes out a little wider than measured here at full size,
  // and the GUI wrapped a one-line title onto a second, clipped line. So wrap against a narrower width
  // (never fewer lines than the GUI draws) and report a slightly wider box.
  const { width, height } = textSize(req.text, req.fontSize, req.fontWeight, req.fontFamily, req.lineHeight, req.maxWidth / TEXT_SLACK);
  if (width <= 0) return { width: 0, height };
  const roomy = width * TEXT_SLACK + 1;
  return { width: width <= req.maxWidth ? Math.min(req.maxWidth, roomy) : roomy, height }; // a word wider than maxWidth overflows, as before
}

/** Room measured text gets over its full-size measurement (see `measureText`). */
const TEXT_SLACK = 1.05;
