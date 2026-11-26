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
//
// Transforms (ADR 0418 wave 3): the core gives each element its whole transform (ancestors' and its own, `transform2d.ts`).
// Controls stay flat (each in its canvas root, or in its clipper's clip container) so the draw order stays the core's, and
// Babylon GUI composes a control's transform with its parent control's only. So each control gets its transform relative
// to the control it's drawn in (`inverse(clipper's) · its own`): placed at where that takes its box's top-left corner,
// turned and scaled about that corner (`transformCenterX/Y` 0) by the map's rotation and scales. A clip container moves
// with its clipper, so what it clips is clipped where the clipper is drawn. ADR 0426: a map that skews (`skew()`,
// `matrix()`, a rotation inside an unequal scale) isn't a rotation and scales: such a control is placed where layout put
// it and drawn through the whole map, its `_transform` overridden with the element's Matrix2D (`Drawn`).
//
// ADR 0426 also draws CSS filters (the context's `filter`, or an offscreen pass where Canvas2D lacks it), inline SVG (an
// SVG image rasterised from `UISvg.markup`) and video (a `UIVideo`'s media element's current frame) — `Drawn`,
// `MediaImage`.
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
import { Matrix2D } from "@babylonjs/gui/2D/math2D.js";
import type { ICanvas } from "@babylonjs/core/Engines/ICanvas.js";
import type { Nullable } from "@babylonjs/core/types.js";
import type { Component } from "../../core/Component";
import { Color } from "../../core/math";
import type { World } from "../../core/World";
import { splitSpriteRef } from "../../scene/importSettings";
import type { WarmContent } from "../../scene/warmUp";
import { WARM_PREFIX, type WarmItem } from "./warmUp";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UISelect, UISvg, UIText, UITextArea, UIVideo, isFocusableUI, type UIComponentType } from "../../ui/components";
import type { ICanvasRenderingContext } from "@babylonjs/core/Engines/ICanvas.js";
import { fontEpoch, onFontLoaded } from "../../ui/fonts";
import { uiInteractions } from "../../ui/interactions";
import { uiBorderEdges, uiEdges } from "../../ui/layout";
import { wrapLine, wrapText, type LineBreakMode } from "../../ui/text/lineBreak";
import type { TextMeasureRequest, UICoreLike, UIInlineEditing, UIInlineRun, UILaidOutCanvas, UILaidOutElement, UITextRun, UITextWrap } from "../../ui/uiCoreTypes";
import { INLINE_ASCENT, inlineFont, type UIInlineLayout } from "../../ui/text/inlineLayout";
import { flipRows, redrawnPixels, type PixelRect } from "../pixelRegions";
import { linearGradientLine, parseBackgroundImage, radialGradientCircle, type PaintBox, type UIBackgroundImage } from "../../ui/document/paintValues";
import { applyAffine, decompose, invert, multiply, type UIAffine } from "../../ui/transform2d";
import { filterReach, filterText, transformFilterSteps, type UIFilterStep } from "../../ui/filters";
import { filterPixels } from "../filterPixels";

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
  /** ADR 0424: a form element's parts, drawn over its box (`syncParts`), made on first need. */
  parts: Rectangle[] | null;
  /** Panels whose border sides differ (ADR 0418): one filled rectangle per side (top, right, bottom, left), made on first need. */
  edges: Rectangle[] | null;
  last: Last;
  stamp: number;
  dead: boolean;
}

/**
 * ADR 0418: an `overflow: hidden` element's clip, a container at its padding box that clips what's drawn inside it.
 * The elements it clips are drawn in it, offset by its corner; a nested clip sits in its clipper's.
 */
interface ClipEntry {
  canvas: CanvasEntry;
  container: Rectangle;
  /** Its corner in its canvas's UI pixels: its children's offset. */
  x: number;
  y: number;
  /** ADR 0418 wave 3: its clipper's whole transform (null: none), which the controls drawn in it are placed relative to. */
  transform: UIAffine | null;
  stamp: number;
}

/** ADR 0423: a scroller's drawn scrollbars: a track and a thumb per axis it shows. */
interface BarsEntry {
  canvas: CanvasEntry;
  x: { track: Rectangle; thumb: Rectangle } | null;
  y: { track: Rectangle; thumb: Rectangle } | null;
  stamp: number;
}

/** ADR 0423: scrollbar colours without `scrollbar-color`: a light thumb on a faint dark track. */
const DEFAULT_THUMB = new Color(0.78, 0.8, 0.84, 0.75);
const DEFAULT_TRACK = new Color(0, 0, 0, 0.22);

/** What `Drawn` reaches of Babylon GUI's protected and private control state (checked when Babylon is upgraded, ADR 0426). */
interface ControlInternals {
  _currentMeasure: Measure;
  _evaluatedMeasure: Measure;
  _transformMatrix: Matrix2D;
  _invertTransformMatrix: Matrix2D;
  _host: AdvancedDynamicTexture;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControlClass = new (...args: any[]) => Control;

/** True when a Canvas2D context draws `filter` itself (ADR 0426): `CanvasRenderingContext2D.filter` is a string there. */
function drawsFilters(ctx: ICanvasRenderingContext): boolean {
  return typeof (ctx as unknown as { filter?: unknown }).filter === "string";
}

/**
 * ADR 0426: a control drawn with what Babylon GUI's own state can't express.
 * - **A full matrix** (`affine`): the map from its parent control's frame (UI pixels, the parent's corner at 0, 0) to where
 *   it's drawn, replacing Babylon's left/top, rotation and scales: `_transform` sets it on the context and in its
 *   `_transformMatrix` (which redraw regions, clipping checks and its children use), so skew draws as the core hits it.
 * - **A CSS filter** (`filter`, the context's `filter` text, lengths in texture pixels): set on the context around its
 *   drawing where the browser supports `CanvasRenderingContext2D.filter`; otherwise it's drawn to an offscreen canvas and
 *   filtered there (`filterPixels.ts`). `filterReach` (texture pixels) grows its redraw region and clip for blur and
 *   drop shadows, as Babylon grows them for its own shadow.
 */
function Drawn<T extends ControlClass>(Base: T) {
  class DrawnControl extends Base {
    affine: UIAffine | null = null;
    filter = "";
    /** The filter's steps, lengths in texture pixels: the offscreen fallback's. */
    filterSteps: readonly UIFilterStep[] = [];
    filterReach = 0;
    private readonly local = Matrix2D.Identity();
    private offscreen: { canvas: ICanvas; width: number; height: number } | null = null;

    protected override _transform(context?: ICanvasRenderingContext): void {
      const m = this.affine;
      if (!m) return super._transform(context);
      const self = this as unknown as ControlInternals;
      // Its parent's corner in measure coordinates: where its own corner is, less where it was placed in the parent.
      const ox = self._currentMeasure.left - this.leftInPixels, oy = self._currentMeasure.top - this.topInPixels;
      const e = m[4] + ox - (m[0] * ox + m[2] * oy), f = m[5] + oy - (m[1] * ox + m[3] * oy);
      (context as unknown as { transform?(a: number, b: number, c: number, d: number, e: number, f: number): void } | undefined)?.transform?.(m[0], m[1], m[2], m[3], e, f);
      const l = this.local.m;
      if (l[0] !== m[0] || l[1] !== m[1] || l[2] !== m[2] || l[3] !== m[3] || l[4] !== e || l[5] !== f) {
        this.local.fromValues(m[0], m[1], m[2], m[3], e, f);
        this._flagDescendantsAsMatrixDirty();
      }
      if (this.parent) this.local.multiplyToRef(this.parent._transformMatrix, self._transformMatrix);
      else self._transformMatrix.fromValues(l[0], l[1], l[2], l[3], l[4], l[5]);
      self._transformMatrix.invertToRef(self._invertTransformMatrix);
      self._currentMeasure.transformToRef(self._transformMatrix, self._evaluatedMeasure);
    }

    protected override _applyStates(context: ICanvasRenderingContext): void {
      super._applyStates(context);
      if (this.filter && drawsFilters(context)) context.filter = this.filter;
    }

    protected override _computeAdditionalOffsetX(): number {
      return super._computeAdditionalOffsetX() + this.filterReach;
    }

    protected override _computeAdditionalOffsetY(): number {
      return super._computeAdditionalOffsetY() + this.filterReach;
    }

    override _intersectsRect(rect: Measure, context?: ICanvasRenderingContext): boolean {
      const r = this.filterReach;
      if (r <= 0) return super._intersectsRect(rect, context);
      const m = (this as unknown as ControlInternals)._evaluatedMeasure;
      return !(m.left - r >= rect.left + rect.width || m.top - r >= rect.top + rect.height || m.left + m.width + r <= rect.left || m.top + m.height + r <= rect.top);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
      // `_clip` is private in Babylon's declarations, so it's replaced on the instance (ADR 0426, checked on upgrades).
      const own = (Base.prototype as unknown as { _clip(c: ICanvasRenderingContext, r?: Nullable<Measure>): void })._clip;
      (this as unknown as { _clip(c: ICanvasRenderingContext, r?: Nullable<Measure>): void })._clip = (c, r) => (this.filterReach > 0 ? this.clipFiltered(c) : own.call(this, c, r));
    }

    private clipFiltered(context: ICanvasRenderingContext): void {
      // Grown by the filter's reach in its own frame (the reach is in texture pixels; its frame's are scaled by its matrix).
      const self = this as unknown as ControlInternals;
      const t = self._transformMatrix.m;
      const k = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1;
      const r = this.filterReach / k;
      const m = self._currentMeasure;
      context.beginPath();
      context.rect(m.left - r, m.top - r, m.width + 2 * r, m.height + 2 * r);
      context.clip();
    }

    override _render(context: ICanvasRenderingContext, invalidatedRectangle?: Nullable<Measure>): boolean {
      if (!this.filter || drawsFilters(context) || !this.filterSteps.length) return super._render(context, invalidatedRectangle);
      return this.renderFiltered(context, invalidatedRectangle);
    }

    /** The offscreen fallback: draw into a canvas the size of its drawn bounds (grown by the reach), filter it, and draw that. */
    private renderFiltered(context: ICanvasRenderingContext, invalidatedRectangle?: Nullable<Measure>): boolean {
      if (!this.isVisible || this.notRenderable) return super._render(context, invalidatedRectangle);
      const self = this as unknown as ControlInternals;
      this._transform(); // its matrix and drawn bounds now, as the draw below will make them
      const em = self._evaluatedMeasure;
      const size = self._host.getSize();
      const r = this.filterReach;
      const x0 = Math.max(0, Math.floor(em.left - r)), y0 = Math.max(0, Math.floor(em.top - r));
      const x1 = Math.min(size.width, Math.ceil(em.left + em.width + r)), y1 = Math.min(size.height, Math.ceil(em.top + em.height + r));
      const w = x1 - x0, h = y1 - y0;
      if (w <= 0 || h <= 0) return false;
      const getTransform = (context as unknown as { getTransform?(): { a: number; b: number; c: number; d: number; e: number; f: number } }).getTransform;
      const engine = self._host.getScene()?.getEngine();
      if (!getTransform || !engine) return super._render(context, invalidatedRectangle);
      let off = this.offscreen;
      if (!off || off.width < w || off.height < h) {
        off = this.offscreen = { canvas: engine.createCanvas(Math.max(w, off?.width ?? 0), Math.max(h, off?.height ?? 0)), width: Math.max(w, off?.width ?? 0), height: Math.max(h, off?.height ?? 0) };
      }
      const octx = off.canvas.getContext("2d") as unknown as ICanvasRenderingContext;
      const t = getTransform.call(context);
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, off.width, off.height);
      octx.setTransform(t.a, t.b, t.c, t.d, t.e - x0, t.f - y0);
      const drew = super._render(octx, null);
      octx.setTransform(1, 0, 0, 1, 0, 0);
      const image = octx.getImageData(0, 0, w, h);
      filterPixels(image, this.filterSteps);
      octx.putImageData(image, 0, 0);
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(off.canvas, 0, 0, w, h, x0, y0, w, h);
      context.restore();
      return drew;
    }
  }
  return DrawnControl;
}

const DrawnRectangle = Drawn(Rectangle);
const DrawnImage = Drawn(Image);

/** What `MediaImage` draws: an image element, a video element, a canvas. */
type Drawable = { readonly width?: number; readonly height?: number };

/**
 * ADR 0426: an inline SVG's rasterised image or a video's current frame, drawn into the box by `fit` (`fill` stretches,
 * `contain` fits it whole, `cover` fills the box and crops). Babylon's `Image` waits for an image's `onload`, which a
 * video never fires, and drops its picture while a new source loads (an SVG re-rasterised each frame of a `draw`
 * transition would flicker), so this draws whatever it holds.
 */
class MediaImage extends Drawn(Control) {
  source: Drawable | null = null;
  sourceWidth = 0;
  sourceHeight = 0;
  fit: "fill" | "contain" | "cover" = "fill";

  override _draw(context: ICanvasRenderingContext): void {
    const src = this.source, iw = this.sourceWidth, ih = this.sourceHeight;
    if (!src || iw <= 0 || ih <= 0) return;
    const m = (this as unknown as ControlInternals)._currentMeasure;
    let sx = 0, sy = 0, sw = iw, sh = ih, dx = m.left, dy = m.top, dw = m.width, dh = m.height;
    if (dw <= 0 || dh <= 0) return;
    const box = dw / dh, pic = iw / ih;
    if (this.fit === "contain") {
      if (pic > box) {
        dh = dw / pic;
        dy += (m.height - dh) / 2;
      } else {
        dw = dh * pic;
        dx += (m.width - dw) / 2;
      }
    } else if (this.fit === "cover") {
      if (pic > box) {
        sw = ih * box;
        sx = (iw - sw) / 2;
      } else {
        sh = iw / box;
        sy = (ih - sh) / 2;
      }
    }
    context.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

/**
 * ADR 0426: an inline SVG's text made ready to rasterise at `w × h` pixels: the root's `width` and `height` set to that
 * (keeping its `viewBox`, or making one from the size it had, so it scales rather than crops), and `color` for
 * `currentColor`.
 */
function svgForRaster(markup: string, color: string, w: number, h: number): string {
  const m = /<svg\b([^>]*?)(\/?)>/i.exec(markup);
  if (!m) return markup;
  let attrs = m[1];
  const get = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const value = (name: string) => {
    const g = get(name);
    return g ? (g[2] ?? g[3] ?? "") : null;
  };
  const strip = (name: string) => {
    attrs = attrs.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, "gi"), "");
  };
  const ow = parseFloat(value("width") ?? ""), oh = parseFloat(value("height") ?? "");
  if (value("viewBox") === null && Number.isFinite(ow) && Number.isFinite(oh) && ow > 0 && oh > 0) attrs += ` viewBox="0 0 ${ow} ${oh}"`;
  strip("width");
  strip("height");
  strip("color");
  if (!/\sxmlns\s*=/.test(attrs)) attrs += ` xmlns="http://www.w3.org/2000/svg"`;
  attrs += ` width="${Math.max(1, Math.round(w))}" height="${Math.max(1, Math.round(h))}" color="${color}"`;
  return markup.slice(0, m.index) + `<svg${attrs}${m[2]}>` + markup.slice(m.index + m[0].length);
}

/**
 * A text block in the language's direction, wrapping lines by the engine's line breaking (ADR 0356 §5): the context's
 * base direction is the language's, and lines break where `lineBreak.ts` allows (spaces, between CJK characters with
 * the kinsoku rules, Thai words), measured as `textSize` measures them for layout.
 */
class LocalisedTextBlock extends Drawn(TextBlock) {
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
    return super._computeAdditionalOffsetX() + this.overflow;
  }

  protected override _computeAdditionalOffsetY(): number {
    return super._computeAdditionalOffsetY() + this.overflow;
  }

  /** ADR 0425: the element's own `background-color`, painted over its box under the text (CSS text); null: none. */
  boxBackground: string | null = null;
  /**
   * ADR 0425: inline runs to draw instead of the block's own text: the core's layout (lines and fragments, from the content
   * box's corner `inset`), the runs, and an editable text's caret and selection. Null: plain text, drawn by Babylon.
   */
  inline: { layout: UIInlineLayout; runs: readonly UIInlineRun[]; editing: UIInlineEditing | null } | null = null;
  /** ADR 0425: an inline image's picture by texture path (null while it loads). */
  inlineImage: (src: string) => CanvasImageSource | null = () => null;

  override _draw(context: ICanvasRenderingContext): void {
    if (this.boxBackground) {
      const m = this._currentMeasure;
      context.save();
      context.fillStyle = this.boxBackground;
      context.fillRect(m.left, m.top, m.width, m.height);
      context.restore();
    }
    if (!this.inline) return super._draw(context);
    context.save();
    this._applyStates(context);
    this.drawRuns(context, this.inline);
    context.restore();
  }

  /**
   * ADR 0425: the runs as the core laid them out: selection, backgrounds, then each fragment's glyphs (outline under the
   * fill, the block's shadow under both) or image, and its decorations; the caret last. In UI pixels (the canvas's scale
   * is the context's transform), from the content box's corner.
   */
  private drawRuns(context: ICanvasRenderingContext, inline: NonNullable<LocalisedTextBlock["inline"]>): void {
    const m = this._currentMeasure;
    const { layout, runs, editing } = inline;
    const ox = m.left + (layout.inset?.x ?? 0), oy = m.top + (layout.inset?.y ?? 0);
    for (const r of editing?.selection ?? []) {
      context.fillStyle = SELECTION_COLOR;
      context.fillRect(ox + r.x, oy + r.y, r.width, r.height);
    }
    for (const line of layout.lines) {
      for (const f of line.fragments) {
        const bg = runs[f.run].background;
        if (!bg) continue;
        context.fillStyle = bg;
        context.fillRect(ox + f.x, oy + f.top, f.width, f.height);
      }
    }
    const ctx = context as unknown as CanvasRenderingContext2D;
    if (this.shadowBlur || this.shadowOffsetX || this.shadowOffsetY) {
      const ratio = this.host.idealRatio;
      ctx.shadowColor = this.shadowColor;
      ctx.shadowBlur = this.shadowBlur;
      ctx.shadowOffsetX = this.shadowOffsetX * ratio;
      ctx.shadowOffsetY = this.shadowOffsetY * ratio;
    }
    for (const line of layout.lines) {
      for (const f of line.fragments) {
        const r = runs[f.run];
        const x = ox + f.x;
        if (r.image) {
          const picture = this.inlineImage(r.image.src);
          if (picture) context.drawImage(picture, x, oy + f.top, f.width, f.height);
          continue;
        }
        context.font = inlineFont(r);
        context.fillStyle = r.color;
        if (this.outlineWidth) context.strokeText(f.text, x, oy + f.baseline);
        context.fillText(f.text, x, oy + f.baseline);
        if (r.decoration) {
          const thick = Math.max(1, r.fontSize * 0.07);
          const at = (dy: number) => context.fillRect(x, oy + f.baseline + dy - thick / 2, f.width, thick);
          if (r.decoration.includes("underline")) at(r.fontSize * 0.12);
          if (r.decoration.includes("line-through")) at(-r.fontSize * 0.3);
          if (r.decoration.includes("overline")) at(-r.fontSize * INLINE_ASCENT);
        }
      }
    }
    const caret = editing?.caret;
    if (caret) {
      ctx.shadowColor = "transparent";
      const at = runs.find((r) => !r.image) ?? null;
      context.fillStyle = at?.color ?? "white";
      context.fillRect(ox + caret.x - 0.5, oy + caret.top, 1, caret.height);
    }
  }
}

/** ADR 0425: an editable text's selection, painted under its glyphs. */
const SELECTION_COLOR = "rgba(80, 140, 255, 0.45)";

/**
 * A panel's rectangle with the paint of ADR 0418 wave 2. A Babylon gradient is placed in the texture's pixels, not the
 * control's, so the rectangle rebuilds its gradient for the box it's drawn in, the moment it draws (assigned to the
 * protected field, as a setter would mark it dirty again mid-draw).
 */
class PaintedRectangle extends Drawn(Rectangle) {
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
  /** ADR 0418: clips of `overflow: hidden` elements, by the element. */
  private readonly clips = new Map<UIComponentType, ClipEntry>();
  /** ADR 0423: scrollers' scrollbars, by the element. */
  private readonly bars = new Map<UIComponentType, BarsEntry>();
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
    // Tree order: a clipper's clip exists before the elements drawn in it.
    for (const el of core.elements()) {
      const canvas = this.canvases.get(el.canvas);
      if (!canvas) continue;
      this.syncElement(el, canvas, extra, stamp);
      this.syncClip(el, canvas, stamp);
      this.syncBars(el, canvas, stamp);
    }
    for (const [c, b] of this.bars) {
      if (b.stamp !== stamp) this.removeBars(c, b);
    }
    for (const [c, e] of this.elements) {
      if (e.stamp !== stamp) this.removeElement(c, e);
    }
    for (const [c, clip] of this.clips) {
      if (clip.stamp !== stamp) this.removeClip(c, clip);
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
    const b = this.bars.get(c as UIComponentType);
    if (b) this.removeBars(c as UIComponentType, b);
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
    for (const [comp, clip] of this.clips) if (clip.canvas === e) this.clips.delete(comp); // the root's disposal takes them
    for (const [comp, b] of this.bars) if (b.canvas === e) this.bars.delete(comp);
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
    // ADR 0418: inside its clipper's clip (if any), offset by the clip's corner.
    const into = this.clipOf(el, canvas);
    const parent = into?.container ?? canvas.root;
    if (ctl.parent !== parent) {
      ctl.parent?.removeControl(ctl);
      parent.addControl(ctl);
    }
    ctl.isVisible = el.visible;
    if (!el.visible) return;
    this.place(ctl, el.x, el.y, into, el.transform ?? null, el.comp.owner.name);
    if (put(ctl, "w", el.width)) ctl.widthInPixels = el.width;
    if (put(ctl, "h", el.height)) ctl.heightInPixels = el.height;
    if (put(ctl, "z", el.order)) ctl.zIndex = el.order;
    if (put(ctl, "alpha", el.opacity)) ctl.alpha = el.opacity;
    applyFilter(ctl, el.filter ?? null, canvas.root.scaleX);

    const c = el.comp;
    switch (el.kind) {
      case "panel":
      case "button":
      // ADR 0424: form elements are panels with parts (`syncParts`); a select and a text area have text as a field does.
      case "option":
      case "toggle":
      case "radio":
      case "slider":
      case "progress":
      case "meter":
      case "label":
      case "form":
        this.syncPanel(e, c as UIPanel, el, canvas.root.scaleX);
        break;
      case "text":
        this.syncUIText(e, c as UIText, el.text!, canvas.root.scaleX, el.transform ?? null, el);
        break;
      case "image":
        // ADR 0426: an inline SVG's image and a video's frame; else a texture.
        if (c instanceof UISvg) this.syncSvg(e, c, el, canvas.root.scaleX);
        else if (c instanceof UIVideo) this.syncVideo(e, c);
        else this.syncImage(e, c as UIImage, el);
        break;
      case "input":
      case "select":
      case "textarea":
        this.syncInput(e, c as UIInputField | UISelect, el, extra);
        break;
    }
    this.syncParts(e, el);
  }

  /**
   * ADR 0424: a form element's parts (a checkbox's fill and mark, a slider's track, fill and thumb, a bar's fill, a
   * select's arrow), from the core's `parts`: filled rectangles over its box, made as needed and reused.
   */
  private syncParts(e: ElementEntry, el: UILaidOutElement): void {
    const parts = el.parts ?? [];
    if (!parts.length && !e.parts?.length) return;
    const host = e.control instanceof Rectangle ? e.control : null;
    if (!host) return;
    const list = (e.parts ??= []);
    while (list.length > parts.length) {
      const r = list.pop()!;
      host.removeControl(r);
      r.dispose();
    }
    // The Rectangle insets its children by its stroke (only while every border side is equal).
    const inset = host.thickness;
    parts.forEach((p, i) => {
      let r = list[i];
      if (!r) {
        r = new Rectangle(`${host.name}.part${i}`);
        r.thickness = 0;
        r.isHitTestVisible = false;
        r.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        r.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        r.zIndex = 1; // over an input field's text, under nothing it owns
        host.addControl(r);
        list.push(r);
      }
      if (put(r, "x", p.x - inset)) r.leftInPixels = p.x - inset;
      if (put(r, "y", p.y - inset)) r.topInPixels = p.y - inset;
      if (put(r, "w", p.width)) r.widthInPixels = p.width;
      if (put(r, "h", p.height)) r.heightInPixels = p.height;
      if (put(r, "radius", p.radius)) r.cornerRadius = p.radius;
      if (put(r, "rotate", p.rotate)) r.rotation = (p.rotate * Math.PI) / 180;
      const [cr, cg, cb, ca] = p.color;
      const css = `rgba(${Math.round(cr * 255)}, ${Math.round(cg * 255)}, ${Math.round(cb * 255)}, ${ca})`;
      if (put(r, "color", css)) r.background = css;
    });
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
    } else if (el.comp instanceof UISvg || el.comp instanceof UIVideo) {
      control = new MediaImage(name);
    } else if (el.kind === "image") {
      const image = new DrawnImage(name);
      image.autoScale = false;
      control = image;
    } else {
      const r = new PaintedRectangle(name);
      if (el.kind === "input" || el.kind === "select" || el.kind === "textarea") {
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
    return { comp: el.comp, canvas, control, label, caret, backdrop: null, edges: null, parts: null, last: {}, stamp: 0, dead: false };
  }

  /**
   * Place a control whose untransformed box has its top-left corner at (x, y) in canvas UI pixels, drawn in `into` (a
   * clip container) or its canvas root, with its whole transform `transform` (ADR 0418 wave 3, see the head comment).
   */
  private place(ctl: Control, x: number, y: number, into: ClipEntry | undefined, transform: UIAffine | null, _name: string): void {
    const frame = into?.transform ?? null;
    let rel: UIAffine | null = transform;
    if (frame) {
      const inv = invert(frame);
      rel = inv ? (transform ? multiply(inv, transform) : inv) : null;
    }
    const ix = into?.x ?? 0, iy = into?.y ?? 0;
    const d = rel ? decompose(rel) : null;
    // ADR 0426: a skew (a rotation inside an unequal scale, `skew()`, `matrix()`) isn't Babylon's rotation and scales: the
    // control is placed where layout put it and drawn through the whole map, in its parent's frame (`Drawn`).
    const drawn = ctl as Control & { affine?: UIAffine | null };
    if (rel && d && Math.abs(d.skew) > 1e-6 && "affine" in drawn) {
      const lx = x - ix, ly = y - iy;
      // In the parent control's frame: T(−into) · rel · T(into).
      const m: UIAffine = [rel[0], rel[1], rel[2], rel[3], rel[4] + rel[0] * ix + rel[2] * iy - ix, rel[5] + rel[1] * ix + rel[3] * iy - iy];
      if (put(ctl, "x", lx)) ctl.leftInPixels = lx;
      if (put(ctl, "y", ly)) ctl.topInPixels = ly;
      if (put(ctl, "rot", 0)) ctl.rotation = 0;
      if (put(ctl, "sx", 1)) ctl.scaleX = 1;
      if (put(ctl, "sy", 1)) ctl.scaleY = 1;
      if (put(ctl, "affine", m.join(","))) {
        drawn.affine = m;
        ctl._markMatrixAsDirty();
        ctl._markAsDirty();
      }
      return;
    }
    if (drawn.affine) {
      drawn.affine = null;
      put(ctl, "affine", "");
      ctl._markMatrixAsDirty();
      ctl._markAsDirty();
    }
    let rotation = 0, scaleX = 1, scaleY = 1;
    if (rel && d) {
      [x, y] = applyAffine(rel, x, y);
      rotation = d.rotation;
      scaleX = d.scaleX;
      scaleY = d.scaleY;
    }
    x -= ix;
    y -= iy;
    if (put(ctl, "x", x)) ctl.leftInPixels = x;
    if (put(ctl, "y", y)) ctl.topInPixels = y;
    if (put(ctl, "rot", rotation)) ctl.rotation = rotation;
    if (put(ctl, "sx", scaleX)) ctl.scaleX = scaleX;
    if (put(ctl, "sy", scaleY)) ctl.scaleY = scaleY;
  }

  private removeElement(c: UIComponentType, e: ElementEntry, canvasGone = false): void {
    e.dead = true;
    this.elements.delete(c);
    if (!canvasGone) e.control.parent?.removeControl(e.control);
    e.control.dispose();
  }

  // --- overflow: hidden (ADR 0418) ---

  /** The clip an element is drawn in: its clipper's, or undefined (drawn in its canvas's root). */
  private clipOf(el: UILaidOutElement, canvas: CanvasEntry): ClipEntry | undefined {
    const clip = el.clipper ? this.clips.get(el.clipper) : undefined;
    return clip?.canvas === canvas ? clip : undefined;
  }

  /**
   * An `overflow: hidden` element's clip: a container at its padding box (rounded as its inner corners are) right
   * above it in the draw order, so its descendants, which the core orders right after it, draw inside it.
   */
  private syncClip(el: UILaidOutElement, canvas: CanvasEntry, stamp: number): void {
    const box = el.childClip ?? null;
    if (!box) return;
    let clip = this.clips.get(el.comp);
    if (clip && clip.canvas !== canvas) {
      this.removeClip(el.comp, clip);
      clip = undefined;
    }
    if (!clip) {
      const container = new DrawnRectangle(`${el.comp.owner.name}.clip`);
      container.thickness = 0;
      container.clipContent = true;
      container.clipChildren = true;
      container.isHitTestVisible = false;
      placeBox(container);
      clip = { canvas, container, x: 0, y: 0, transform: null, stamp };
      this.clips.set(el.comp, clip);
    }
    clip.stamp = stamp;
    const ctl = clip.container;
    const into = this.clipOf(el, canvas);
    const parent = into?.container ?? canvas.root;
    if (ctl.parent !== parent) {
      ctl.parent?.removeControl(ctl);
      parent.addControl(ctl);
    }
    ctl.isVisible = el.visible;
    // ADR 0418 wave 3: it moves with its clipper (placed before `clip` takes the clipper's transform for its own children).
    this.place(ctl, box.x, box.y, into, el.transform ?? null, el.comp.owner.name);
    clip.x = box.x;
    clip.y = box.y;
    clip.transform = el.transform ?? null;
    if (put(ctl, "w", box.width)) ctl.widthInPixels = box.width;
    if (put(ctl, "h", box.height)) ctl.heightInPixels = box.height;
    if (put(ctl, "z", el.order + 0.5)) ctl.zIndex = el.order + 0.5;
    const radius = el.comp instanceof UIPanel ? Math.max(0, el.comp.borderRadius - Math.max(...uiBorderEdges(el.comp))) : 0;
    if (put(ctl, "radius", radius)) ctl.cornerRadius = radius;
  }

  private removeClip(c: UIComponentType, clip: ClipEntry): void {
    this.clips.delete(c);
    clip.container.parent?.removeControl(clip.container);
    clip.container.dispose();
  }

  // --- scrollbars (ADR 0423) ---

  /**
   * A scroller's scrollbars: a track and a thumb per axis the core shows one on, drawn where the scroller is drawn
   * (with its transform), over its content (above its clip container) and under whatever is drawn after it.
   */
  private syncBars(el: UILaidOutElement, canvas: CanvasEntry, stamp: number): void {
    const s = el.scroll;
    let b = this.bars.get(el.comp);
    if (!s || (!s.barX && !s.barY)) {
      if (b) this.removeBars(el.comp, b);
      return;
    }
    if (b && b.canvas !== canvas) {
      this.removeBars(el.comp, b);
      b = undefined;
    }
    if (!b) this.bars.set(el.comp, (b = { canvas, x: null, y: null, stamp }));
    b.stamp = stamp;
    const into = this.clipOf(el, canvas);
    const parent = into?.container ?? canvas.root;
    const c = el.comp as UIPanel;
    const thumbColor = c.scrollbarThumbColor ?? DEFAULT_THUMB;
    const trackColor = c.scrollbarTrackColor ?? DEFAULT_TRACK;
    for (const axis of ["x", "y"] as const) {
      const bar = axis === "x" ? s.barX : s.barY;
      let pair: { track: Rectangle; thumb: Rectangle } | null = b[axis];
      if (!bar) {
        if (pair) {
          for (const r of [pair.track, pair.thumb]) {
            r.parent?.removeControl(r);
            r.dispose();
          }
        }
        b[axis] = null;
        continue;
      }
      if (!pair) {
        const make = (name: string) => {
          const r = new DrawnRectangle(`${el.comp.owner.name}.${name}`);
          r.thickness = 0;
          r.isHitTestVisible = false;
          placeBox(r);
          return r;
        };
        pair = b[axis] = { track: make(`scrollbar-${axis}`), thumb: make(`scrollbar-${axis}-thumb`) };
      }
      const parts: [Rectangle, typeof bar.track, Color, number][] = [
        [pair.track, bar.track, trackColor, 0.6],
        [pair.thumb, bar.thumb, thumbColor, 0.7],
      ];
      for (const [r, rect, color, z] of parts) {
        if (r.parent !== parent) {
          r.parent?.removeControl(r);
          parent.addControl(r);
        }
        r.isVisible = el.visible;
        if (!el.visible) continue;
        this.place(r, rect.x, rect.y, into, el.transform ?? null, el.comp.owner.name);
        if (put(r, "w", rect.width)) r.widthInPixels = rect.width;
        if (put(r, "h", rect.height)) r.heightInPixels = rect.height;
        if (put(r, "z", el.order + z)) r.zIndex = el.order + z;
        const radius = Math.min(rect.width, rect.height) / 2;
        if (put(r, "radius", radius)) r.cornerRadius = radius;
        if (put(r, "bg", colorKey(color))) r.background = color.toCss();
        if (put(r, "alpha", el.opacity)) r.alpha = el.opacity;
        applyFilter(r, el.filter ?? null, canvas.root.scaleX);
      }
    }
  }

  private removeBars(c: UIComponentType, b: BarsEntry): void {
    this.bars.delete(c);
    for (const pair of [b.x, b.y]) {
      if (!pair) continue;
      for (const r of [pair.track, pair.thumb]) {
        r.parent?.removeControl(r);
        r.dispose();
      }
    }
  }

  /** A panel, button or input field's box. `scale` is its canvas's texture pixels per UI pixel. */
  private syncPanel(e: ElementEntry, c: UIPanel, el: UILaidOutElement, scale: number): void {
    const r = e.control as PaintedRectangle;
    let background = c.backgroundColor;
    let border = c.borderColor;
    // Focus colours (ADR 0340) show while the last UI input was navigation: a button's fill, a field's border.
    // ADR 0424: every control shows it, a button (and an option) by its fill, the others by their border.
    const showsFocus = isFocusableUI(c) && uiInteractions(c._world).showsFocus(c);
    if (c instanceof UIButton && c.interactable) {
      // Pressed needs hovered too (a press dragged off the button shows it unpressed).
      if (c.pressed && c.hovered) background = c.pressedColor;
      else if (c.hovered) background = c.hoverColor;
      else if (showsFocus) background = c.focusColor;
    } else if (!(c instanceof UIButton) && isFocusableUI(c) && showsFocus) border = c.focusColor;
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
    this.syncBorder(e, r, uiBorderEdges(c), border);
    // The shadow is the background's (Babylon's Rectangle casts it from its fill). Canvas2D shadows ignore the
    // context's transform, so they're scaled here, as the canvas's scale scales everything else.
    const shadow = c.boxShadowColor;
    const lin = linearKey(el.transform ?? null);
    if (put(r, "shadow", shadow ? `${colorKey(shadow)}|${c.boxShadowOffsetX}|${c.boxShadowOffsetY}|${c.boxShadowBlur}|${scale}|${lin}` : "none")) {
      const reach = applyShadow(r, shadow, c.boxShadowOffsetX, c.boxShadowOffsetY, c.boxShadowBlur, scale, el.transform ?? null);
      r.overflow = Math.max(r.shadowReach, reach); // clears the old shadow too when it shrinks or moves
      r.shadowReach = reach;
    }
    if (put(r, "image", c.backgroundImage)) this.setBackgroundImage(e, r, c.backgroundImage, el);
    if (e.backdrop) {
      const inset = r.thickness; // the Rectangle insets its children by its thickness (0 while the sides differ)
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
   * A panel's border (ADR 0418): the Rectangle's own stroke while every side is as wide; unequal sides draw each side
   * as a filled edge rectangle inside the box (top and bottom across it, left and right down it), the stroke off.
   */
  private syncBorder(e: ElementEntry, r: Rectangle, sides: readonly [number, number, number, number], color: Color): void {
    const [top, right, bottom, left] = sides;
    const even = top === right && top === bottom && top === left;
    const thickness = even ? top : 0;
    if (put(r, "border", thickness)) r.thickness = thickness;
    const ck = colorKey(color);
    if (put(r, "color", ck)) r.color = color.toCss();
    if (even && !e.edges) return;
    e.edges ??= [0, 1, 2, 3].map((i) => {
      const edge = new Rectangle(`${r.name}.edge${i}`);
      edge.thickness = 0;
      edge.isHitTestVisible = false;
      edge.horizontalAlignment = i === 1 ? Control.HORIZONTAL_ALIGNMENT_RIGHT : Control.HORIZONTAL_ALIGNMENT_LEFT;
      edge.verticalAlignment = i === 2 ? Control.VERTICAL_ALIGNMENT_BOTTOM : Control.VERTICAL_ALIGNMENT_TOP;
      if (i === 0 || i === 2) edge.width = "100%";
      else edge.height = "100%";
      r.addControl(edge);
      return edge;
    });
    e.edges.forEach((edge, i) => {
      const w = even ? 0 : sides[i];
      edge.isVisible = w > 0;
      if (put(edge, "w", w)) {
        if (i === 0 || i === 2) edge.heightInPixels = w;
        else edge.widthInPixels = w;
      }
      if (put(edge, "color", ck)) edge.background = color.toCss();
    });
  }

  /**
   * A UIText: the core's text run (exactly what it measured), with the component's colour, outline and alignment.
   * `scale` is its canvas's texture pixels per UI pixel.
   */
  private syncUIText(e: ElementEntry, c: UIText, run: UITextRun, scale: number, transform: UIAffine | null, el: UILaidOutElement): void {
    const t = e.control as LocalisedTextBlock;
    // ADR 0425: runs are drawn from the core's layout (the block's own text stays empty); the box's background under them.
    this.syncInline(t, el);
    const shown = el.inline ? "" : run.text;
    if (put(t, "text", shown)) t.text = shown;
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
    if (put(t, "shadow", shadow ? `${colorKey(shadow)}|${c.textShadowOffsetX}|${c.textShadowOffsetY}|${c.textShadowBlur}|${scale}|${linearKey(transform)}` : "none")) {
      const reach = applyShadow(t, shadow, c.textShadowOffsetX, c.textShadowOffsetY, c.textShadowBlur, scale, transform);
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

  /** ADR 0425: a text's box background and inline runs, redrawn when the core's layout, runs or editing state change. */
  private syncInline(t: LocalisedTextBlock, el: UILaidOutElement): void {
    const c = el.comp as UIText;
    const bg = c.backgroundColor && c.backgroundColor.a > 0 ? c.backgroundColor.toCss() : null;
    if (put(t, "boxBackground", bg)) {
      t.boxBackground = bg;
      t._markAsDirty();
    }
    const layout = el.inline ?? null, runs = el.text?.runs ?? null, editing = el.editing ?? null;
    const changed = put(t, "inline", layout);
    if (put(t, "runs", runs) || put(t, "editing", editing) || changed) {
      t.inline = layout && runs ? { layout, runs, editing } : null;
      t.inlineImage = (src) => this.inlineImageOf(src, t);
      t._markAsDirty();
    }
  }

  /** ADR 0425: inline images' pictures by texture path, and the text blocks waiting for each to load. */
  private readonly inlineImages = new Map<string, { picture: CanvasImageSource | null; waiting: Set<Control> }>();

  /** ADR 0425: an inline image's picture, loading it the first time (the text is drawn again once it's there). */
  private inlineImageOf(src: string, t: Control): CanvasImageSource | null {
    const ref = src ? splitSpriteRef(src).path : "";
    if (!ref) return null;
    let entry = this.inlineImages.get(ref);
    if (!entry) {
      entry = { picture: null, waiting: new Set() };
      this.inlineImages.set(ref, entry);
      const e = entry;
      this.options
        .texture(ref)
        .then((tex) => {
          const url = tex.url;
          if (!url || typeof globalThis.Image !== "function") return;
          const img = new globalThis.Image();
          img.onload = () => {
            e.picture = img;
            for (const w of e.waiting) w._markAsDirty();
            e.waiting.clear();
          };
          img.src = url;
        })
        .catch((err) => this.warnOnce(`inline-img|${ref}`, `failed to load inline image "${ref}": ${(err as Error).message}`));
    }
    if (!entry.picture) entry.waiting.add(t);
    return entry.picture;
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

  /**
   * ADR 0426: an inline SVG, rasterised as an SVG image at its box's size in texture pixels, again only when its text,
   * colour or size changed. The image it had stays drawn until the new one has loaded.
   */
  private syncSvg(e: ElementEntry, c: UISvg, el: UILaidOutElement, scale: number): void {
    const img = e.control as MediaImage;
    if (put(img, "fit", c.fit)) img.fit = c.fit;
    const w = Math.max(1, Math.round(el.width * scale)), h = Math.max(1, Math.round(el.height * scale));
    const color = c.color.toCss();
    const key = c.markup ? `${w}x${h}|${color}|${c.markup}` : "";
    if (!put(img, "svg", key)) return;
    if (!key) {
      img.source = null;
      img._markAsDirty();
      return;
    }
    const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement }).Image;
    if (!ImageCtor) return; // no DOM to rasterise in (Node)
    const picture = new ImageCtor();
    picture.onload = () => {
      if (e.dead || lasts.get(img)?.svg !== key) return; // removed, or changed again since
      img.source = picture;
      img.sourceWidth = picture.naturalWidth || w;
      img.sourceHeight = picture.naturalHeight || h;
      img._markAsDirty();
    };
    picture.onerror = () => this.warnOnce(`svg|${c.owner.name}`, `inline SVG "${c.owner.name}" couldn't be drawn: its SVG isn't valid`);
    picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgForRaster(c.markup, color, w, h))}`;
  }

  /** ADR 0426: a video's current frame, redrawn each frame while it plays (and when it seeks while paused). */
  private syncVideo(e: ElementEntry, c: UIVideo): void {
    const img = e.control as MediaImage;
    if (put(img, "fit", c.fit)) img.fit = c.fit;
    const m = c.media;
    const ready = !!m && (m.readyState ?? 4) >= 2 && (m.videoWidth ?? 0) > 0;
    const src = ready ? (m as unknown as Drawable) : null;
    if (img.source !== src) {
      img.source = src;
      img._markAsDirty();
    }
    if (!m || !ready) return;
    img.sourceWidth = m.videoWidth ?? 0;
    img.sourceHeight = m.videoHeight ?? 0;
    // A new frame while it plays; one frame for a seek or a size change while paused.
    if (put(img, "frame", m.paused ? `${m.currentTime}|${img.sourceWidth}x${img.sourceHeight}` : NaN) || !m.paused) img._markAsDirty();
  }

  /**
   * An input field's box, text and caret. ADR 0424: a select's too (its chosen option's label, no caret), and a text
   * area's: its lines from the top, wrapped, moved up by its scroll, the caret on the line it's in (soft wraps aside).
   */
  private syncInput(e: ElementEntry, c: UIInputField | UISelect, el: UILaidOutElement, extra: { caretOf?(c: UIInputField): number | null }): void {
    this.syncPanel(e, c, el, e.canvas.root.scaleX);
    const label = e.label!;
    const caret = e.caret!;
    // Insets per side (ADR 0418). The Rectangle insets its children by its stroke, which it has only while the border's sides are equal.
    const [bt, br, bb, bl] = uiBorderEdges(c);
    const stroke = bt === br && bt === bb && bt === bl ? bt : 0;
    const [pt, pr, , pl] = uiEdges(c.padding, c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft);
    const area = c instanceof UITextArea ? c : null;
    if (put(label, "area", !!area)) {
      label.textVerticalAlignment = area ? Control.VERTICAL_ALIGNMENT_TOP : Control.VERTICAL_ALIGNMENT_CENTER;
      caret.verticalAlignment = area ? Control.VERTICAL_ALIGNMENT_TOP : Control.VERTICAL_ALIGNMENT_CENTER;
    }
    const start = bl - stroke + pl; // the text's left edge inside the Rectangle's children
    const run = el.text!; // the value, or the placeholder while it's empty, as the core measured it
    if (put(label, "text", run.text)) label.text = run.text;
    this.setFont(label, run);
    // From the language's start edge, in its direction (ADR 0356 §5).
    const rtl = run.direction === "rtl";
    if (put(label, "dir", run.direction)) {
      (label as LocalisedTextBlock).direction = run.direction;
      label.textHorizontalAlignment = rtl ? Control.HORIZONTAL_ALIGNMENT_RIGHT : Control.HORIZONTAL_ALIGNMENT_LEFT;
    }
    const field = c instanceof UIInputField ? c : null;
    const color = !field || field.value ? c.color : field.placeholderColor;
    if (put(label, "color", colorKey(color))) label.color = color.toCss();
    if (put(label, "wrap", run.wrap)) label.textWrapping = run.wrap === "none" ? WRAP_CLIP : WRAP_WORD;
    // A text area's lines start below its top padding, moved up by its scroll; it clips them (a Rectangle clips its children).
    const scrollY = el.scroll?.y ?? 0;
    const top = area ? bt - stroke + pt - scrollY : bt - stroke;
    if (put(label, "left", start)) label.leftInPixels = start;
    if (put(label, "top", top)) label.topInPixels = top;
    const lw = Math.max(0, el.width - bl - br - pl - pr);
    if (put(label, "w", lw)) label.widthInPixels = lw;
    const lh = area ? Math.max(0, el.scroll?.scrollHeight ?? el.height) : Math.max(0, el.height - bt - bb);
    if (put(label, "h", lh)) label.heightInPixels = lh;

    const index = field?.typing ? (extra.caretOf?.(field) ?? null) : null;
    if (!field || index === null) {
      caret.isVisible = false;
      return;
    }
    // A text area's caret: on the line (by line breaks) its index is in, from that line's start.
    const before = field.value ? run.text.slice(0, Math.max(0, index)) : "";
    const lineIndex = area ? before.split("\n").length - 1 : 0;
    const prefix = area ? before.slice(before.lastIndexOf("\n") + 1) : before;
    const pw = prefix ? textSize(prefix, run.fontSize, run.fontWeight, run.fontFamily, run.lineHeight).width : 0; // exact, unlike layout's roomier measure
    caret.isVisible = true;
    const ch = run.fontSize * run.lineHeight;
    // Right to left: the text ends at the right edge, so the caret sits that far in from it. Approximate for text that
    // mixes directions (a known limit, ADR 0356 §5).
    const full = rtl && field.value && !area ? textSize(run.text, run.fontSize, run.fontWeight, run.fontFamily, run.lineHeight).width : 0;
    const x = rtl ? start + Math.max(lw, full) - pw : start + pw;
    if (put(caret, "left", x)) caret.leftInPixels = x;
    const caretTop = area ? top + lineIndex * ch : (bt - bb) / 2; // a field's is centred on the text, not the box
    if (put(caret, "top", caretTop)) caret.topInPixels = caretTop;

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

/** A transform's linear part as a key (its shadow's offset turns and scales with it), "" for none. */
function linearKey(m: UIAffine | null): string {
  return m ? `${m[0]},${m[1]},${m[2]},${m[3]}` : "";
}

/**
 * A control's shadow (ADR 0418 wave 2) from UI-pixel values, in texture pixels (`scale` per UI pixel: Canvas2D draws
 * shadows untransformed). Returns how far it reaches past the box, in texture pixels. Null: none. `transform` (wave 3) is
 * the element's whole transform: as in CSS, the offset turns and scales with the element and the blur scales.
 */
function applyShadow(ctl: Control, color: Color | null, offsetX: number, offsetY: number, blur: number, scale: number, transform: UIAffine | null = null): number {
  if (!color) {
    ctl.shadowOffsetX = ctl.shadowOffsetY = ctl.shadowBlur = 0;
    return 0;
  }
  if (transform) {
    const [a, b, c, d] = transform;
    [offsetX, offsetY] = [a * offsetX + c * offsetY, b * offsetX + d * offsetY];
    blur *= Math.sqrt(Math.abs(a * d - b * c));
  }
  ctl.shadowColor = color.toCss();
  ctl.shadowOffsetX = offsetX * scale;
  ctl.shadowOffsetY = offsetY * scale;
  ctl.shadowBlur = Math.max(0, blur) * scale;
  return Math.ceil((Math.max(Math.abs(offsetX), Math.abs(offsetY)) + 2 * Math.max(0, blur)) * scale) + 1;
}

/**
 * ADR 0426: a control's filter from the core's chain (lengths in UI pixels), in texture pixels (`scale` per UI pixel), as
 * the context's `filter` text and the steps the offscreen fallback draws. Marks it dirty when it changed.
 */
function applyFilter(ctl: Control, steps: readonly UIFilterStep[] | null, scale: number): void {
  const d = ctl as Control & { filter?: string; filterSteps?: readonly UIFilterStep[]; filterReach?: number };
  if (d.filter === undefined) return;
  const scaled = steps?.length ? transformFilterSteps(steps, null, scale) : [];
  const text = scaled.length ? filterText(scaled) : "";
  if (d.filter === text) return;
  // Where the old filter reached is redrawn too (a blur shrinking or going leaves nothing behind).
  if (d.filterReach && ctl.host) ctl.invalidateRect();
  d.filter = text;
  d.filterSteps = scaled;
  d.filterReach = filterReach(scaled);
  ctl._markAsDirty();
}

/** Controls sit at absolute pixel boxes from the top-left; the core did the layout. */
function placeBox(c: Control): void {
  c.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  c.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  // Turned and scaled about the top-left corner: canvas roots by their scale, elements by their transform (ADR 0418 wave 3).
  c.transformCenterX = 0;
  c.transformCenterY = 0;
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

/**
 * ADR 0425: one line of text's width in UI pixels in a CSS font (`UICoreHost.measureRunWidth`), the 2D canvas's exact
 * measure the inline runs' layout positions with; drawn with the same font, so fragments sit where they were laid out.
 * Without a canvas (Node) it estimates per character.
 */
export function measureRunWidth(text: string, font: string): number {
  const ctx = context();
  if (!ctx) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    return [...text].length * size * 0.55;
  }
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Room measured text gets over its full-size measurement (see `measureText`). */
const TEXT_SLACK = 1.05;
