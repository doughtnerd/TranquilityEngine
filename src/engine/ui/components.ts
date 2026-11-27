/**
 * Game UI components (ADR 0069): the element types a Svelte component's HTML tags render as (ADR 0423). An
 * element is a node with one UI component, and the node tree is the UI tree: an element's children lay out
 * inside it with flexbox. A `UICanvas` is the root.
 *
 * Only a `UIView` rendering its Svelte component makes them (ADR 0421, amended by 0423): `addComponent`
 * throws for these types, and a scene or prefab saving one fails to load. Scripts reach them through a
 * view's elements (`view.query("#play")!.component as UIButton`) and write their fields at runtime.
 *
 * They are plain data, like other components: they hold values in any World. Only a World with a
 * render backend lays them out (the UI core, ADR 0076) and draws them (Babylon GUI), loaded the first
 * time it has a `UICanvas`, so servers and tests can build UI without WebGL. No renderer types
 * appear here (ADR 0010).
 */
import { Component } from "../core/Component";
import { Color, Vector2 } from "../core/math";
import { AssetRef, component, field } from "../core/registry";
import { GameObject } from "../scene/GameObject";
import { uiInteractions } from "./interactions";
import { resetFormEvent, submitForm } from "./formControls";
import { _addMediaPlayer, _removeMediaPlayer, AudioSourceMedia, makeVideoSource, UIMediaPlayer, type UIMediaEvent, type UIMediaEventType, type UIMediaFields, type UIMediaSource } from "./media";
import type { UIStyledStates } from "./paint";
// Keyboard and gamepad navigation (ADR 0340) comes with the components: `engine.UIActions`, the `ui` context and `engine.UINavigation`.
import "./navigation";

/** A length in UI pixels (a number or `"120"`), a percentage of the parent (`"50%"`), or `"auto"`. */
export type UILength = number | string;
export type UIFlexDirection = "row" | "column" | "row-reverse" | "column-reverse";
export type UIJustify = "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
export type UIAlign = "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
export type UIPositionType = "relative" | "absolute";
/**
 * `none` takes an element and its children out of layout, drawing and the pointer. ADR 0432: inside a text element,
 * `inline-block` (or `inline-flex`) lays an element out as an atomic inline box on the text's lines, its content in a
 * layout of its own; elsewhere both lay out as `flex`.
 */
export type UIDisplay = "flex" | "none" | "inline-block" | "inline-flex";
export type UICanvasMode = "screen" | "world";
/**
 * `start` and `end` follow the text direction of the current language (ADR 0356 §5): `start` is the left edge in
 * left-to-right languages and the right edge in right-to-left ones.
 */
export type UITextAlign = "start" | "end" | "left" | "center" | "right" | "justify";
export type UIWordBreak = "break-word" | "break-all" | "keep-all";
/** ADR 0429: a text's `font-style` (`oblique` draws as italic). */
export type UIFontStyle = "normal" | "italic" | "oblique";
/** ADR 0429: an inline run's `vertical-align`. */
export type UIVerticalAlign = "baseline" | "sub" | "super" | "middle" | "top" | "bottom" | "text-top" | "text-bottom";
/**
 * ADR 0432: how a text's spaces and line breaks show (CSS `white-space-collapse`): `collapse` (HTML's default: runs of
 * spaces, tabs and line breaks are one space), `preserve` (kept as written), `preserve-breaks` (line breaks kept, spaces
 * collapsed), `break-spaces` (kept, and spaces at the end of a line take room there and may wrap).
 */
export type UIWhiteSpaceCollapse = "collapse" | "preserve" | "preserve-breaks" | "break-spaces";
/** ADR 0432: whether a text's lines wrap at its width (CSS `text-wrap-mode`). */
export type UITextWrapMode = "wrap" | "nowrap";
export type UIImageFit = "cover" | "contain" | "fill";
/**
 * How `navigate` leaves a focusable element (ADR 0340): `auto` takes its explicit neighbours, else the
 * spatial search; `explicit` only its neighbours; `none` neither.
 */
export type UINavigationMode = "auto" | "explicit" | "none";
// 0422 wave 1: layout
export type UIFlexWrap = "nowrap" | "wrap" | "wrap-reverse";
/** `auto` takes the parent's `alignItems`. */
export type UIAlignSelf = "auto" | UIAlign;
export type UIAlignContent = "flex-start" | "center" | "flex-end" | "stretch" | "space-between" | "space-around" | "space-evenly";
/**
 * `hidden` clips the element's children (drawing and the pointer) to its padding box; `auto` and `scroll` clip them too
 * and let the player scroll them (ADR 0427): `scroll` always shows a scrollbar, `auto` when the content overflows.
 */
export type UIOverflow = "visible" | "hidden" | "auto" | "scroll";
/** ADR 0427: `smooth` animates `scrollTo`, `scrollBy` and `scrollIntoView` (unless they ask for `instant`). */
export type UIScrollBehavior = "auto" | "smooth";
/** ADR 0427: `contain` and `none` keep the wheel and drags from scrolling the element's scrolling ancestors once it can't move further. */
export type UIOverscrollBehavior = "auto" | "contain" | "none";
/** ADR 0427: a scrollbar's thickness: `auto` (10 UI pixels), `thin` (6) or `none` (hidden, the element still scrolls). */
export type UIScrollbarWidth = "auto" | "thin" | "none";
/**
 * ADR 0432: the axes a scroller snaps on (`scroll-snap-type`'s first value): `x`, `y`, `both`, or `block` (vertical)
 * and `inline` (horizontal) in the UI's horizontal writing mode; `none` doesn't snap.
 */
export type UIScrollSnapAxis = "none" | "x" | "y" | "block" | "inline" | "both";
/** ADR 0432: `mandatory` always rests on a snap position; `proximity` only when it ends near one. */
export type UIScrollSnapStrictness = "proximity" | "mandatory";
/** ADR 0432: where a snap area lines up with its scroller's snapport on an axis (`scroll-snap-align`). */
export type UIScrollSnapAlign = "none" | "start" | "end" | "center";
/** ADR 0432: `always` keeps a scroll gesture from passing over this element's snap position (`scroll-snap-stop`). */
export type UIScrollSnapStop = "normal" | "always";
/** ADR 0432: `stable` reserves the vertical scrollbar's space whether or not it shows; `stable both-edges` on both sides. */
export type UIScrollbarGutter = "auto" | "stable" | "stable both-edges";
/** ADR 0432: an element's direction (CSS `direction`, HTML `dir`): `rtl` lays rows out from the right and scrolls from there. */
export type UIDirection = "ltr" | "rtl";
const SNAP_ALIGN = ["none", "start", "end", "center"];

const OVERFLOW = ["visible", "hidden", "auto", "scroll"];
const FLEX_DIRECTIONS = ["row", "column", "row-reverse", "column-reverse"];
const JUSTIFY = ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"];
const ALIGN = ["flex-start", "center", "flex-end", "stretch", "baseline"];
// 0422 wave 1: layout
const ALIGN_CONTENT = ["flex-start", "center", "flex-end", "stretch", "space-between", "space-around", "space-evenly"];

/** Releases what the render backend built for a removed UI component (its layout node and drawing). */
abstract class UIComponent extends Component {
  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

/**
 * The root of a UI tree. In `screen` mode it covers the canvas and draws in the UI pass, after the
 * cameras and their post-processing, in `sortOrder` (higher on top). Its size in UI pixels is
 * `referenceResolution` scaled to the canvas like Unity's Canvas Scaler: `matchHeight` 0 matches
 * the canvas width, 1 its height, in between a blend. In `world` mode it's a panel in the scene at
 * its node's transform, `referenceResolution` UI pixels in size, `pixelSize` world units per pixel.
 */
@component("engine.UICanvas")
export class UICanvas extends UIComponent {
  @field(String, { choices: ["screen", "world"] }) mode: UICanvasMode = "screen";
  /** The UI's design size in UI pixels. */
  @field(Vector2) referenceResolution = new Vector2(1280, 720);
  /** 0: scale with the canvas width; 1: with its height; between: a blend (log-space, as Unity does). */
  @field(Number) matchHeight = 1;
  /** Screen canvases draw (and take the pointer) in ascending order: higher is on top. */
  @field(Number) sortOrder = 0;
  /** World mode: world units per UI pixel. */
  @field(Number) pixelSize = 0.01;
  /**
   * Keyboard and gamepad navigation (ADR 0340): while this canvas has a focusable element, focus can't
   * leave it (a pause menu over a HUD keeps it), and focus elsewhere moves into it.
   */
  @field(Boolean) modal = false;
  /** Focus `firstSelected` (else the first focusable element) when the canvas becomes active. */
  @field(Boolean) autoFocus = false;
  /** Where `autoFocus`, a modal canvas, and `navigate` with nothing focused put focus (null: the first focusable element). */
  @field(GameObject) firstSelected: GameObject | null = null;
  /** The local player whose UI actions drive this canvas; -1: any local player. */
  @field(Number) player = -1;

  /** True for the one frame the player pressed `cancel` (Escape, the east button) with focus on this canvas, in every phase of that frame. */
  get canceled(): boolean {
    return uiInteractions(this._world).happened(this, "cancel");
  }
}

/** Layout fields every element has: Yoga's flexbox, in UI pixels. */
abstract class UIElement extends UIComponent {
  /** How this element lays out its children. */
  @field(String, { choices: FLEX_DIRECTIONS }) flexDirection: UIFlexDirection = "row";
  @field(String, { choices: JUSTIFY }) justifyContent: UIJustify = "flex-start";
  @field(String, { choices: ALIGN }) alignItems: UIAlign = "stretch";
  /** Space between children. */
  @field(Number) gap = 0;
  /** Space inside the element, on every side. */
  @field(Number) padding = 0;
  /** Space around the element, on every side. */
  @field(Number) margin = 0;
  /** Pixels (`120`), a percentage of the parent (`"50%"`) or `"auto"` (sized by its content). */
  @field(String) width: UILength = "auto";
  @field(String) height: UILength = "auto";
  /** `absolute` takes the element out of its parent's flow, placed by `top/right/bottom/left`. */
  @field(String, { choices: ["relative", "absolute"] }) positionType: UIPositionType = "relative";
  @field(String) top: UILength = "auto";
  @field(String) right: UILength = "auto";
  @field(String) bottom: UILength = "auto";
  @field(String) left: UILength = "auto";
  /** How much of the parent's free space this element takes, relative to its siblings. */
  @field(Number) flexGrow = 0;
  /** 0..1, multiplied into its children's. */
  @field(Number) opacity = 1;
  /** False hides the element and its children but keeps its space (a disabled component or inactive node takes none). */
  @field(Boolean) visible = true;
  /**
   * `none` removes the element and its children from layout, drawing and the pointer, like CSS
   * `display: none`, while its node stays active (its scripts run, and its state reads as before).
   * `flex` (the default) lays it out.
   */
  @field(String, { choices: ["flex", "none", "inline-block", "inline-flex"] }) display: UIDisplay = "flex";
  /**
   * Its place on a text's line (`vertical-align`), as an inline run or (ADR 0432) an atomic inline box: `sub` and `super`
   * lower and raise its baseline; `middle`, `top`, `bottom`, `text-top`, `text-bottom` align its box. Outside a text it
   * does nothing.
   */
  @field(String, { choices: ["baseline", "sub", "super", "middle", "top", "bottom", "text-top", "text-bottom"] }) verticalAlign: UIVerticalAlign = "baseline";
  /**
   * Whether the pointer stops at this element, like Unity's `Graphic.raycastTarget` (ADR 0385). True (the default):
   * a press over it goes to the UI, never to the game (`Input.pointerOverUI` is true), and reaches the button or
   * input field it's in, if any; over text, an image or a panel outside one, it does nothing. False: the pointer
   * passes through to whatever is behind it (other UI, or the game). Text, images, buttons and input fields stop
   * it; a panel only when it draws a background (even a transparent one) or a border, as a panel without either is
   * a layout box (Unity's empty RectTransform). Children aren't affected: each element has its own.
   */
  @field(Boolean) raycastTarget = true;
  /**
   * HTML's `inert`: the element and everything inside it are drawn as before but take no part in interaction: the
   * pointer passes through them (to what's behind), and they can't take focus or be navigated to (focus inside leaves).
   * Svelte's outros set it on outroing elements.
   */
  @field(Boolean) inert = false;

  // 0422 wave 1: layout
  /**
   * Space inside the element on one side (`padding-top` …; the `padding` shorthand takes one to four values, as in
   * CSS). Null (the default): `padding`, the all-sides value.
   */
  @field(Number) paddingTop: number | null = null;
  @field(Number) paddingRight: number | null = null;
  @field(Number) paddingBottom: number | null = null;
  @field(Number) paddingLeft: number | null = null;
  /** Space around the element on one side (`margin-top` …; the `margin` shorthand takes one to four values). Null: `margin`. */
  @field(Number) marginTop: number | null = null;
  @field(Number) marginRight: number | null = null;
  @field(Number) marginBottom: number | null = null;
  @field(Number) marginLeft: number | null = null;
  /** The smallest size layout gives it: pixels, a percentage of the parent, or `"auto"` (no minimum). */
  @field(String) minWidth: UILength = "auto";
  @field(String) minHeight: UILength = "auto";
  /** The largest size layout gives it: pixels, a percentage of the parent, or `"none"` (no maximum). */
  @field(String) maxWidth: UILength = "none";
  @field(String) maxHeight: UILength = "none";
  /** Whether children that don't fit on one line wrap onto more (`wrap-reverse`: new lines go before the first). */
  @field(String, { choices: ["nowrap", "wrap", "wrap-reverse"] }) flexWrap: UIFlexWrap = "nowrap";
  /** This element's alignment across its parent's direction; `auto` takes the parent's `alignItems`. */
  @field(String, { choices: ["auto", ...ALIGN] }) alignSelf: UIAlignSelf = "auto";
  /** How wrapped lines share the space across the direction (only with `flexWrap`). */
  @field(String, { choices: ALIGN_CONTENT }) alignContent: UIAlignContent = "stretch";
  /**
   * How much this element shrinks, relative to its siblings, when they don't fit. Null (the default): its kind's,
   * as before: text shrinks (and wraps to what's left), other elements keep their size.
   */
  @field(Number) flexShrink: number | null = null;
  /** Its size along the parent's direction before growing and shrinking: pixels, a percentage, or `"auto"` (its `width`/`height`). */
  @field(String) flexBasis: UILength = "auto";
  /** Width divided by height, kept when only one of them is set (`aspect-ratio: 16 / 9`); 0: none. */
  @field(Number) aspectRatio = 0;
  /**
   * `hidden` clips its children to its padding box (inside its border): they are drawn and take the pointer only
   * there. It also draws them together, at its own place in the order (as an element with a `zIndex` does).
   * `auto` and `scroll` clip them the same way and scroll them (ADR 0427): by the wheel, a touch or pen drag, the
   * keyboard, a draggable scrollbar, navigation and `scrollX`/`scrollY`. The stylesheet's `overflow: x y` sets the
   * two axes (`overflowX`, `overflowY`).
   */
  @field(String, { choices: OVERFLOW }) overflow: UIOverflow = "visible";
  /** ADR 0427: the horizontal axis's overflow (`overflow-x`); null (the default) takes `overflow`. */
  @field(String, { choices: OVERFLOW }) overflowX: UIOverflow | null = null;
  /** ADR 0427: the vertical axis's overflow (`overflow-y`); null takes `overflow`. */
  @field(String, { choices: OVERFLOW }) overflowY: UIOverflow | null = null;
  /**
   * ADR 0427: how far its content is scrolled right and down, in UI pixels (`scrollLeft`/`scrollTop` on the web).
   * Scripts write them; the UI core keeps them between 0 and how far the content reaches past its padding box, at
   * each layout. Only an element that clips (`overflow` other than `visible`) scrolls. ADR 0432: an axis whose content
   * starts at its far end (`row-reverse`, `column-reverse`, `direction: rtl`) is 0 showing that end and negative
   * toward the other, as CSSOM's offsets are.
   */
  @field(Number) scrollX = 0;
  @field(Number) scrollY = 0;
  /** ADR 0427: `smooth` animates scripted scrolling (`scrollTo`, `scrollBy`, `scrollIntoView` and navigation's); `auto` jumps. */
  @field(String, { choices: ["auto", "smooth"] }) scrollBehavior: UIScrollBehavior = "auto";
  /** ADR 0427: `contain` or `none`: once it can't scroll further, the wheel and drags don't go on to scroll its ancestors. */
  @field(String, { choices: ["auto", "contain", "none"] }) overscrollBehavior: UIOverscrollBehavior = "auto";
  /** ADR 0427: its scrollbars' thickness (`scrollbar-width`): `auto`, `thin` or `none`. */
  @field(String, { choices: ["auto", "thin", "none"] }) scrollbarWidth: UIScrollbarWidth = "auto";
  /** ADR 0427: its scrollbars' thumb colour (`scrollbar-color: thumb track`); null: the default, a light grey. */
  @field(Color) scrollbarThumbColor: Color | null = null;
  /** ADR 0427: its scrollbars' track colour; null: the default, a faint dark strip. */
  @field(Color) scrollbarTrackColor: Color | null = null;
  /**
   * ADR 0432: whether the vertical scrollbar's space is kept (`scrollbar-gutter`): `auto` draws the bar over the content;
   * `stable` (on an element that clips) reserves it beside the padding box, on the bar's side, whether or not the bar
   * shows, so `clientWidth` is smaller and the content doesn't move when it appears; `stable both-edges` on both sides.
   */
  @field(String, { choices: ["auto", "stable", "stable both-edges"] }) scrollbarGutter: UIScrollbarGutter = "auto";
  /**
   * ADR 0432: CSS Scroll Snap on a scroller (`scroll-snap-type: <axis> [mandatory | proximity]`): the axes it snaps
   * on. After the wheel settles, a touch drag's momentum, keys, `scrollTo`/`scrollBy`, `scrollIntoView` and
   * navigation, it rests where a descendant's `scroll-snap-align` says; after a layout change it snaps again.
   */
  @field(String, { choices: ["none", "x", "y", "block", "inline", "both"] }) scrollSnapAxis: UIScrollSnapAxis = "none";
  /** ADR 0432: `mandatory` always rests on a snap position; `proximity` (the default) only near one. */
  @field(String, { choices: ["proximity", "mandatory"] }) scrollSnapStrictness: UIScrollSnapStrictness = "proximity";
  /** ADR 0432: how this element lines up in its scroller when snapped, vertically (`scroll-snap-align`'s first value). */
  @field(String, { choices: SNAP_ALIGN }) scrollSnapAlignBlock: UIScrollSnapAlign = "none";
  /** ADR 0432: …and horizontally (`scroll-snap-align`'s second value; one value sets both). */
  @field(String, { choices: SNAP_ALIGN }) scrollSnapAlignInline: UIScrollSnapAlign = "none";
  /** ADR 0432: `always`: a scroll gesture stops at this element's snap position rather than passing over it. */
  @field(String, { choices: ["normal", "always"] }) scrollSnapStop: UIScrollSnapStop = "normal";
  /** ADR 0432: a scroller's snapport inset from its padding box (`scroll-padding`), UI pixels per side. */
  @field(Number) scrollPaddingTop = 0;
  @field(Number) scrollPaddingRight = 0;
  @field(Number) scrollPaddingBottom = 0;
  @field(Number) scrollPaddingLeft = 0;
  /** ADR 0432: this element's snap area outset from its border box (`scroll-margin`), UI pixels per side. */
  @field(Number) scrollMarginTop = 0;
  @field(Number) scrollMarginRight = 0;
  @field(Number) scrollMarginBottom = 0;
  @field(Number) scrollMarginLeft = 0;
  /**
   * ADR 0432: its direction (CSS `direction`, HTML `dir`); null (the default) takes its parent's, and a canvas is `ltr`.
   * In `rtl` a row lays out from the right and a scroller's horizontal scrolling starts at the right: `scrollX` is 0
   * there and negative toward the left, as browsers' `scrollLeft`. A text's base direction (its runs' order, `start`/`end` alignment) is its own or an ancestor's `direction` when one is set, else the language's.
   */
  @field(String, { choices: ["ltr", "rtl"] }) direction: UIDirection | null = null;
  /**
   * ADR 0426: a pointer press on it (or inside it) that moves starts a UI drag: `dragstart` on it, `drag` while it
   * moves, `dragenter`/`dragover`/`dragleave` on the elements under the pointer, `drop` where it's released (if a
   * `dragover` there was prevented), then `dragend`. HTML's `draggable` attribute.
   */
  @field(Boolean) draggable = false;
  /**
   * Draw and pointer order among its siblings (higher on top, then document order), as in CSS. A non-zero value
   * draws the element and its children together, ordered within it.
   */
  @field(Number) zIndex = 0;

  // 0422 wave 3: transforms. Drawn, not laid out: layout ignores them (siblings don't move), as on the web. They apply to
  // the element and its children, and the pointer, picking and navigation follow what's drawn.
  /**
   * How far the element is drawn moved right: pixels, or a percentage of its own width (`"50%"`). A stylesheet's
   * `translate: x y` or `transform: translate(x, y)` sets it with `translateY`. (The `translate` attribute stays
   * HTML's localisation marker: in markup write `transform="translate(…)"` or `translate-x`.)
   */
  @field(String) translateX: UILength = "0";
  /** How far it's drawn moved down: pixels, or a percentage of its own height. */
  @field(String) translateY: UILength = "0";
  /** How much it's drawn stretched across (`scale: 2` sets both; `scale: 2 1` each), about its transform origin. 1: as laid out. */
  @field(Number) scaleX = 1;
  @field(Number) scaleY = 1;
  /** How far it's drawn turned clockwise about its transform origin, in degrees (`rotate: 45deg`, `0.25turn`, `1rad`). */
  @field(Number) rotate = 0;
  /**
   * The point it turns and scales about, across its own box: pixels from its left edge, or a percentage of its width
   * (`transform-origin: left top`, `25% 75%`, `10px 4px`). Default: the middle.
   */
  @field(String) transformOriginX: UILength = "50%";
  @field(String) transformOriginY: UILength = "50%";
  /**
   * ADR 0430: a full 2D matrix applied after translate, rotate and scale, as `matrix(a, b, c, d, e, f)` (pixels); "" (the
   * default) for none. A stylesheet's `transform` list that doesn't fold into the three (one with `skew()`, `skewX()`,
   * `skewY()` or `matrix()`, or a rotation after an unequal scale) sets it. It animates as CSS interpolates matrices.
   */
  @field(String) transformMatrix = "";

  // ADR 0430: CSS filters, drawn over the element and its children (a stylesheet's `filter` sets them). Each function is a
  // field, so transitions and keyframes animate them; they apply in this order whatever order `filter` lists them in.
  /** `blur()`: a Gaussian blur, its standard deviation in UI pixels. 0: none. */
  @field(Number) filterBlur = 0;
  /** `brightness()`: 1 as it is, 0 black, above 1 brighter. */
  @field(Number) filterBrightness = 1;
  /** `contrast()`: 1 as it is, 0 flat grey. */
  @field(Number) filterContrast = 1;
  /** `grayscale()`: 0 as it is, 1 fully grey. */
  @field(Number) filterGrayscale = 0;
  /** `hue-rotate()`, in degrees. */
  @field(Number) filterHueRotate = 0;
  /** `invert()`: 0 as it is, 1 inverted. */
  @field(Number) filterInvert = 0;
  /** `opacity()`: like `opacity`, applied as a filter step (after the ones before it). 1 as it is. */
  @field(Number) filterOpacity = 1;
  /** `saturate()`: 1 as it is, 0 grey, above 1 more saturated. */
  @field(Number) filterSaturate = 1;
  /** `sepia()`: 0 as it is, 1 fully sepia. */
  @field(Number) filterSepia = 0;
  /** `drop-shadow()`'s colour: a shadow of what's drawn (its shape, not its box). Null: none. */
  @field(Color) filterDropShadowColor: Color | null = null;
  /** The drop shadow's offset right and down, and its blur, in UI pixels. */
  @field(Number) filterDropShadowOffsetX = 0;
  @field(Number) filterDropShadowOffsetY = 0;
  @field(Number) filterDropShadowBlur = 0;

  // ADR 0432: `backdrop-filter`, the same functions applied to what's drawn behind the element within its box (and its
  // rounded corners), under its background. Each is a field, so transitions and keyframes animate them. Drawing one reads
  // back the UI texture under the box each time the element is redrawn (the 3D scene behind the UI isn't sampled).
  @field(Number) backdropBlur = 0;
  @field(Number) backdropBrightness = 1;
  @field(Number) backdropContrast = 1;
  @field(Number) backdropGrayscale = 0;
  @field(Number) backdropHueRotate = 0;
  @field(Number) backdropInvert = 0;
  @field(Number) backdropOpacity = 1;
  @field(Number) backdropSaturate = 1;
  @field(Number) backdropSepia = 0;
  @field(Color) backdropDropShadowColor: Color | null = null;
  @field(Number) backdropDropShadowOffsetX = 0;
  @field(Number) backdropDropShadowOffsetY = 0;
  @field(Number) backdropDropShadowBlur = 0;
}

/** A box: background, border and rounded corners, laying out its children. */
@component("engine.UIPanel")
export class UIPanel extends UIElement {
  /** Null: transparent. */
  @field(Color) backgroundColor: Color | null = null;
  /** Every corner's radius, for the corners whose own radius below is -1. */
  @field(Number) borderRadius = 0;
  /** The border's width on every side (`border-width` takes one to four values; `border` a width, `solid` or `none`, and a colour). */
  @field(Number) borderWidth = 0;
  @field(Color) borderColor = Color.black;
  // 0422 wave 1: layout
  /** The border's width on one side (`border-top-width` …). Null (the default): `borderWidth`. Unequal sides draw each side as its own edge. */
  @field(Number) borderTopWidth: number | null = null;
  @field(Number) borderRightWidth: number | null = null;
  @field(Number) borderBottomWidth: number | null = null;
  @field(Number) borderLeftWidth: number | null = null;

  // 0422 wave 2: paint
  /**
   * One corner's radius in UI pixels; -1 (the default) takes `borderRadius`. A stylesheet's `border-radius` with two
   * to four values sets these, as CSS does (top-left, top-right, bottom-right, bottom-left).
   */
  @field(Number) borderTopLeftRadius = -1;
  @field(Number) borderTopRightRadius = -1;
  @field(Number) borderBottomRightRadius = -1;
  @field(Number) borderBottomLeftRadius = -1;
  /**
   * Drawn over the background: `url(asset:images/wood.png)` (stretched to the box), `linear-gradient(angle, stops…)`
   * or `radial-gradient(stops…)` (a circle at the centre), stops being a colour and an optional position in `%`.
   * A gradient replaces `backgroundColor`. Empty: none.
   */
  @field(String) backgroundImage = "";
  /**
   * A shadow under the background, `box-shadow: offset-x offset-y blur colour` in a stylesheet (ADR 0422). It's
   * drawn by the background, so a panel without a `backgroundColor` or gradient casts none. Null: no shadow.
   */
  @field(Color) boxShadowColor: Color | null = null;
  /** The shadow's offset to the right, in UI pixels. */
  @field(Number) boxShadowOffsetX = 0;
  /** The shadow's offset down, in UI pixels. */
  @field(Number) boxShadowOffsetY = 0;
  /** How far the shadow blurs, in UI pixels (CSS's blur radius). */
  @field(Number) boxShadowBlur = 0;
  /**
   * @internal ADR 0437: the pseudo-classes of its own (`:hover`, `:pressed`, `:focus`) named by the style rules that give
   * it its `backgroundColor` and `borderColor`, written by the UI host as it styles it; null: unstyled. In those states
   * its resolved paint (`paint.ts`) draws its style's colour, not the Unity-style state colour.
   */
  _styledStates: UIStyledStates | null = null;
}

/**
 * Text laid out as an element. Its font is the bundled Inter (weights 100–900; Latin, Latin-1 and
 * common punctuation, other characters falling back to the system font), or the project font file
 * `font` names.
 */
@component("engine.UIText")
export class UIText extends UIElement {
  @field(String) text = "";
  /**
   * A font file in the project (`asset:fonts/Pirata.ttf`; `.ttf`, `.otf`, `.woff` or `.woff2`), loaded
   * the first time it's used; empty is the bundled Inter. Characters the font lacks use Inter.
   */
  @field(AssetRef, { kind: "font" }) font = "";
  @field(Number) fontSize = 16;
  @field(Color) color = Color.white;
  /** `"light"` (300), `"normal"` (400), `"medium"` (500), `"semi-bold"` (600), `"bold"` (700), or a whole number 1–1000 (anything else is 400). */
  @field(String, { choices: ["light", "normal", "medium", "semi-bold", "bold"] }) fontWeight = "normal";
  /** `start` (the default) and `end` follow the language's direction: `start` is left in English, right in Arabic. */
  @field(String, { choices: ["start", "end", "left", "center", "right", "justify"] }) textAlign: UITextAlign = "start";
  /** How lines wrap: at word boundaries, anywhere, or never. */
  @field(String, { choices: ["break-word", "break-all", "keep-all"] }) wordBreak: UIWordBreak = "break-word";
  /**
   * The colour of an outline drawn around the glyphs (ADR 0421; `text-outline-color` in a stylesheet, inherited like
   * `color`); null draws none. It shows only with a `textOutlineWidth` above 0.
   */
  @field(Color) textOutlineColor: Color | null = null;
  /** How far the outline reaches outside the glyphs, in UI pixels (`text-outline-width`, inherited); 0 draws none. It doesn't change the layout. */
  @field(Number) textOutlineWidth = 0;

  // 0422 wave 2: paint
  /** A shadow under the glyphs (`text-shadow: offset-x offset-y blur colour`, inherited); null draws none. */
  @field(Color) textShadowColor: Color | null = null;
  /** The text shadow's offset to the right, in UI pixels (`text-shadow-offset-x`, inherited). */
  @field(Number) textShadowOffsetX = 0;
  /** The text shadow's offset down, in UI pixels (`text-shadow-offset-y`, inherited). */
  @field(Number) textShadowOffsetY = 0;
  /** How far the text shadow blurs, in UI pixels (`text-shadow-blur`, inherited). */
  @field(Number) textShadowBlur = 0;

  // ADR 0429: inline runs. A text element's inline children (`<b>`, `<span>`, `<a>`, `<img>`, `<br>`…) are runs of it,
  // laid out and drawn with it; these fields style a run (and, where it makes sense, the whole text).
  /** `italic` (or `oblique`, drawn italic) slants the glyphs (`font-style`, inherited). */
  @field(String, { choices: ["normal", "italic", "oblique"] }) fontStyle: UIFontStyle = "normal";
  /** Lines drawn with the glyphs (`text-decoration`): `none`, or any of `underline`, `line-through` and `overline`, space-separated. A run's reach its inline children. */
  @field(String) textDecoration = "none";
  /** Painted behind the text: an inline run's glyphs (and its inline children's), or the whole box of a text element; null paints nothing. */
  @field(Color) backgroundColor: Color | null = null;
  /** `contenteditable`: the player edits the text (a press puts the caret, typing and the IME go through the hidden input, `input` events follow); whitespace is kept as typed. */
  @field(Boolean) contentEditable = false;
  /** ADR 0432: an editable text's selected glyphs (`::selection`'s `color`); null keeps their own colour. */
  @field(Color) selectionColor: Color | null = null;
  /** ADR 0432: painted behind an editable text's selection (`::selection`'s `background-color`); null: the default highlight. */
  @field(Color) selectionBackgroundColor: Color | null = null;
  /** @internal A run of text between a text element's inline children (not an element): events on it go to its parent. */
  _textPiece = false;
  /** @internal ADR 0432: a `<br>`: a forced line break, whatever the white space rules. */
  _lineBreak = false;

  // ADR 0432: white space, and borders (an inline run's box, or the text's own).
  /** How spaces and line breaks show (`white-space-collapse`, inherited; a stylesheet's `white-space` sets it with `textWrapMode`). An editable text keeps them as typed. */
  @field(String, { choices: ["collapse", "preserve", "preserve-breaks", "break-spaces"] }) whiteSpaceCollapse: UIWhiteSpaceCollapse = "collapse";
  /** Whether lines wrap at the text's width (`text-wrap-mode`, inherited); `nowrap` keeps them whole, so only line breaks break them. */
  @field(String, { choices: ["wrap", "nowrap"] }) textWrapMode: UITextWrapMode = "wrap";
  /**
   * A border on every side, in UI pixels (`border-width`; `border` takes a width, `solid` or `none`, and a colour). It
   * lays out and draws around a text's box; on an inline run, around its part of each line (its start and end sides
   * only where the run starts and ends, as CSS slices an inline box), taking room on the line only at those sides.
   */
  @field(Number) borderWidth = 0;
  /** The border's width on one side (`border-top-width` …). Null (the default): `borderWidth`. */
  @field(Number) borderTopWidth: number | null = null;
  @field(Number) borderRightWidth: number | null = null;
  @field(Number) borderBottomWidth: number | null = null;
  @field(Number) borderLeftWidth: number | null = null;
  @field(Color) borderColor = Color.black;
  /** Rounds the corners of its border and background, in UI pixels (`border-radius` with one value). */
  @field(Number) borderRadius = 0;
  /** @internal ADR 0432: a generated `::before`/`::after` run of a text element (its run comes before or after the element's own text). */
  _pseudo: "before" | "after" | null = null;
}

/** A texture laid out as an element. */
@component("engine.UIImage")
export class UIImage extends UIElement {
  /** Texture asset (`asset:images/logo.png`). */
  @field(AssetRef, { kind: "texture" }) image = "";
  /**
   * `fill` stretches it to the element; `cover` fills the element and crops; `contain` keeps the
   * texture's aspect ratio when the element's size comes from it (one side `auto`).
   */
  @field(String, { choices: ["cover", "contain", "fill"] }) fit: UIImageFit = "fill";
}

/**
 * ADR 0430: an inline SVG (`<svg>` in Svelte UI), drawn as an image of its SVG document: the renderer keeps the `<svg>`
 * and its shapes as a subtree and writes it here as text when anything in it changes, and the drawing layer rasterises
 * that text (once per change). It lays out as an image (its `width` and `height` from the `<svg>`'s attributes or
 * styles), and the pointer stops at its box.
 */
@component("engine.UISvg")
export class UISvg extends UIImage {
  /** The SVG document drawn, as text (`<svg xmlns="http://www.w3.org/2000/svg" …>…</svg>`). Empty: nothing. */
  @field(String) markup = "";
  /** What `currentColor` is in it (`color`, inherited as text's is). */
  @field(Color) color = Color.white;

  constructor() {
    super();
    // HTML's size for an <svg> without one of its own (its attributes or the stylesheet set it).
    this.width = "300";
    this.height = "150";
  }
}

/** The media API `UIVideo` and `UIAudio` share (ADR 0430, `media.ts`). */
interface UIMediaElement {
  readonly _player: UIMediaPlayer;
}

function mediaPlay(c: UIMediaElement): Promise<void> {
  return c._player.play();
}

/**
 * ADR 0430: a video (`<video>` in Svelte UI): an image whose picture is a video's current frame, drawn each frame while
 * it plays. Its source is an `HTMLVideoElement` made from `src` in a browser, or any media element a script hands to
 * `media` (a stream, or one it made). `play()`, `pause()`, `currentTime`, `duration`, `paused` and `ended` are the
 * media element's; `loop`, `muted`, `volume` and `playbackRate` are fields kept on it each frame. `on("ended", …)` and
 * the other media events come from it.
 */
@component("engine.UIVideo")
export class UIVideo extends UIImage implements UIMediaElement, UIMediaFields {
  /** The video: a file in the project (`asset:videos/intro.webm`) or a URL. */
  @field(String) src = "";
  /** Start playing once it's shown (browsers allow only muted video to start without a gesture). */
  @field(Boolean) autoplay = false;
  @field(Boolean) loop = false;
  @field(Boolean) muted = false;
  /** 0..1. */
  @field(Number) volume = 1;
  /** 1: normal speed. */
  @field(Number) playbackRate = 1;

  /** @internal */
  readonly _player: UIMediaPlayer = new UIMediaPlayer(this, () => makeVideoSource());

  /** The media element it shows: one made from `src` in a browser (null headless until one is set), or one a script set. */
  get media(): UIMediaSource | null {
    return this._player.media;
  }

  set media(source: UIMediaSource | null) {
    this._player.media = source;
  }

  play(): Promise<void> {
    return mediaPlay(this);
  }

  pause(): void {
    this._player.pause();
  }

  get paused(): boolean {
    return this._player.current?.paused ?? true;
  }

  get ended(): boolean {
    return this._player.current?.ended ?? false;
  }

  /** Seconds; set it to seek. */
  get currentTime(): number {
    return this._player.current?.currentTime ?? 0;
  }

  set currentTime(seconds: number) {
    const m = this._player.media;
    if (m) m.currentTime = seconds;
  }

  /** Seconds; NaN until known. */
  get duration(): number {
    return this._player.current?.duration ?? NaN;
  }

  /** Listen to a media event (`play`, `pause`, `ended`, `timeupdate`, `volumechange`, `durationchange`…). */
  on(type: UIMediaEventType, listener: (e: UIMediaEvent) => void): void {
    this._player.on(type, listener);
  }

  off(type: UIMediaEventType, listener: (e: UIMediaEvent) => void): void {
    this._player.off(type, listener);
  }

  override _onActivate(): void {
    super._onActivate();
    _addMediaPlayer(this._world, this._player);
  }

  override _onDeactivate(): void {
    _removeMediaPlayer(this._world, this._player);
    this._player.stop();
    super._onDeactivate();
  }

  override _onDetach(): void {
    _removeMediaPlayer(this._world, this._player);
    this._player.dispose();
    super._onDetach();
  }
}

/**
 * ADR 0430: a sound (`<audio>` in Svelte UI). Not drawn (`display: none`, as an `<audio>` without controls). It plays
 * through the audio plugin: an `AudioSource` on its node, made the first time it plays, its mixer bus Master. The media
 * API is `UIVideo`'s; a script may hand `media` any media element instead (an `HTMLAudioElement`).
 */
@component("engine.UIAudio")
export class UIAudio extends UIPanel implements UIMediaElement, UIMediaFields {
  /** The sound: a clip in the project (`asset:sounds/theme.ogg`). */
  @field(String) src = "";
  @field(Boolean) autoplay = false;
  @field(Boolean) loop = false;
  @field(Boolean) muted = false;
  @field(Number) volume = 1;
  /** 1: normal speed. Through the engine's audio it changes the pitch too. */
  @field(Number) playbackRate = 1;

  /** @internal */
  readonly _player: UIMediaPlayer = new UIMediaPlayer(this, (o) => new AudioSourceMedia(o.node));

  constructor() {
    super();
    this.display = "none";
    this.raycastTarget = false;
  }

  get media(): UIMediaSource | null {
    return this._player.media;
  }

  set media(source: UIMediaSource | null) {
    this._player.media = source;
  }

  play(): Promise<void> {
    return mediaPlay(this);
  }

  pause(): void {
    this._player.pause();
  }

  get paused(): boolean {
    return this._player.current?.paused ?? true;
  }

  get ended(): boolean {
    return this._player.current?.ended ?? false;
  }

  get currentTime(): number {
    return this._player.current?.currentTime ?? 0;
  }

  set currentTime(seconds: number) {
    const m = this._player.media;
    if (m) m.currentTime = seconds;
  }

  get duration(): number {
    return this._player.current?.duration ?? NaN;
  }

  on(type: UIMediaEventType, listener: (e: UIMediaEvent) => void): void {
    this._player.on(type, listener);
  }

  off(type: UIMediaEventType, listener: (e: UIMediaEvent) => void): void {
    this._player.off(type, listener);
  }

  override _onActivate(): void {
    super._onActivate();
    _addMediaPlayer(this._world, this._player);
  }

  override _onDeactivate(): void {
    _removeMediaPlayer(this._world, this._player);
    this._player.stop();
    super._onDeactivate();
  }

  override _onDetach(): void {
    _removeMediaPlayer(this._world, this._player);
    this._player.dispose();
    super._onDetach();
  }
}

/**
 * What buttons and input fields share (ADR 0340): they take focus, from the pointer, scripts, and
 * keyboard and gamepad navigation (`engine.UINavigation`, driven by `engine.UIActions`). One element
 * of a World has focus at a time.
 */
abstract class UIFocusable extends UIPanel {
  /** False takes it out of focus: navigation skips it and a click doesn't focus it. */
  @field(Boolean) focusable = true;
  /**
   * False: it ignores the pointer (it still blocks it from the game), can't take focus, and matches `:disabled` (HTML's
   * `disabled` attribute sets it false). ADR 0428: every control has it (buttons, fields, checkboxes, sliders, selects…).
   */
  @field(Boolean) interactable = true;
  /** Drawn while it has focus and the last UI input was navigation, not the pointer. */
  @field(Color) focusColor = new Color(0.29, 0.45, 0.75, 1);
  /** `auto`: explicit neighbours, else the nearest element that way; `explicit`: neighbours only; `none`: `navigate` doesn't leave it. */
  @field(String, { choices: ["auto", "explicit", "none"] }) navigation: UINavigationMode = "auto";
  /** Explicit neighbours: where `navigate` up, down, left and right goes from here (null: the search, in `auto`). */
  @field(GameObject) navUp: GameObject | null = null;
  @field(GameObject) navDown: GameObject | null = null;
  @field(GameObject) navLeft: GameObject | null = null;
  @field(GameObject) navRight: GameObject | null = null;

  /** True while it has focus (a click, a script or navigation gave it). Set it to focus or unfocus it. */
  get focused(): boolean {
    return uiInteractions(this._world).isFocused(this as unknown as UIFocusableElement) && this.isActiveAndEnabled;
  }

  set focused(value: boolean) {
    const log = uiInteractions(this._world);
    const self = this as unknown as UIFocusableElement;
    if (value && isInertUI(this)) return; // HTML's: an inert element can't take focus
    if (value) log.focus(self, "script");
    else log.blur(self, "script");
  }

  /** True for the one frame the player (the pointer or navigation) gave it focus or took it away, in every phase of that frame. */
  get focusedChanged(): boolean {
    const log = uiInteractions(this._world);
    const self = this as unknown as UIFocusableElement;
    return log.happened(self, "focus") || log.happened(self, "blur");
  }

  /** ADR 0428: true for the one frame the player changed it (typed, toggled, dragged, chose), in every phase of that frame; a script's write never counts. */
  get changed(): boolean {
    return uiInteractions(this._world).happened(this as unknown as UIFocusableElement, "change");
  }
}

/** ADR 0428: a `UIButton`'s `type`, as HTML's: what a click does inside a form. */
export type UIButtonType = "submit" | "reset" | "button";
/** ADR 0428: an input field's `type`: plain text, `password` (drawn as dots) or `number` (arrow keys step it between `min` and `max`). */
export type UIInputType = "text" | "password" | "number";
/** ADR 0428: whether a text area's lines wrap at its width (`soft`, the default) or only at line breaks (`off`). */
export type UITextAreaWrap = "soft" | "off";

/**
 * A panel that takes the pointer. Its children (usually a `UIText`, which has the font) are its label. Read its state
 * from scripts: `hovered`, `pressed`, and `clicked`, true for the frame a click finished, like
 * `Input.getMouseButtonUp`. A pointer press on a button goes to the UI, not to `Input`. The state is the
 * UI core's (its interaction log, ADR 0309).
 */
@component("engine.UIButton")
export class UIButton extends UIFocusable {
  @field(Color) hoverColor = new Color(0.33, 0.36, 0.43, 1);
  @field(Color) pressedColor = new Color(0.17, 0.19, 0.23, 1);
  /**
   * ADR 0428: what a click does inside a `UIForm`: `submit` (the default, as in HTML) sends the form's `submit` event,
   * `reset` puts its controls back as they were built, `button` nothing.
   */
  @field(String, { choices: ["submit", "reset", "button"] }) type: UIButtonType = "submit";

  constructor() {
    super();
    this.backgroundColor = new Color(0.24, 0.27, 0.32, 1);
    this.borderRadius = 6;
    this.padding = 12;
    this.justifyContent = "center";
    this.alignItems = "center";
  }

  /** True while the pointer is over the button (and it's interactable). */
  get hovered(): boolean {
    return uiInteractions(this._world).isHovered(this) && this.interactable && this.isActiveAndEnabled;
  }

  /** True from the press on the button until the pointer button is released. */
  get pressed(): boolean {
    return uiInteractions(this._world).isPressed(this) && this.interactable && this.isActiveAndEnabled;
  }

  /** True for the one frame a click on the button finished (pressed and released over it, or `submit` while it had focus), in every phase of that frame. */
  get clicked(): boolean {
    return uiInteractions(this._world).happened(this, "click") && this.interactable;
  }
}

/**
 * A one-line text field. Clicking it focuses it and starts typing; typing goes through a hidden DOM
 * `<input>`, so IME and paste work. While it's `typing`, keys go to it and `Input.getKey*` report false.
 * Navigation (ADR 0340) focuses it without typing: `submit` starts typing, and Tab, Shift+Tab, Escape and
 * the gamepad leave it. `changed` is
 * true for the frame after the player changed `value`, `submitted` for the frame after Enter was
 * pressed in it (both seen by every phase of that frame, like `UIButton.clicked`); a script writing
 * `value` never counts as a change.
 */
@component("engine.UIInputField")
export class UIInputField extends UIFocusable {
  @field(String) value = "";
  @field(String) placeholder = "";
  /** 0: no limit. */
  @field(Number) maxLength = 0;
  /** A font file in the project, as `UIText.font`; empty is the bundled Inter. The text is drawn at weight 400. */
  @field(AssetRef, { kind: "font" }) font = "";
  @field(Number) fontSize = 16;
  @field(Color) color = Color.white;
  /** The placeholder's colour: browsers' default, `darkgray` (#a9a9a9, Chromium's user-agent stylesheet), legible on light and dark fields. */
  @field(Color) placeholderColor = new Color(169 / 255, 169 / 255, 169 / 255, 1);
  /** ADR 0432: the placeholder's slant (`::placeholder`'s `font-style`): `italic` or `oblique` draw it italic. */
  @field(String, { choices: ["normal", "italic", "oblique"] }) placeholderFontStyle: UIFontStyle = "normal";
  /** ADR 0432: selected text's colour while typing (`::selection`'s `color`); null keeps the text's. */
  @field(Color) selectionColor: Color | null = null;
  /** ADR 0432: painted behind selected text while typing (`::selection`'s `background-color`); null: the default highlight. */
  @field(Color) selectionBackgroundColor: Color | null = null;
  /**
   * ADR 0428: `text`; `password`, drawn as dots; or `number`, whose arrow keys (while typing) step `value` by `step`
   * between `min` and `max`. The value stays text, as on the web.
   */
  @field(String, { choices: ["text", "password", "number"] }) type: UIInputType = "text";
  /** ADR 0428, `number` fields: the lowest and highest values the arrow keys step to (null: no limit), and the step. */
  @field(Number) min: number | null = null;
  @field(Number) max: number | null = null;
  @field(Number) step = 1;

  constructor() {
    super();
    this.backgroundColor = new Color(0.1, 0.11, 0.13, 1);
    this.borderColor = new Color(0.35, 0.38, 0.45, 1);
    this.borderWidth = 1;
    this.borderRadius = 4;
    this.padding = 8;
    this.width = "240";
    this.focusColor = new Color(0.36, 0.62, 1, 1);
  }

  /**
   * True while it has focus. Set it to focus the field and start typing in it (as a click does), or to
   * unfocus it; one element in a World has focus, so focusing one unfocuses the others.
   */
  get focused(): boolean {
    return uiInteractions(this._world).isFocused(this) && this.isActiveAndEnabled;
  }

  set focused(value: boolean) {
    const log = uiInteractions(this._world);
    if (value && isInertUI(this)) return; // HTML's: an inert element can't take focus
    if (value) log.focus(this, "script", true);
    else log.blur(this, "script");
  }

  /** True while it takes the keyboard: from a click, a script's `focused = true` or `submit`, until Escape, Tab or navigation leaves it. */
  get typing(): boolean {
    return uiInteractions(this._world).isTyping(this) && this.isActiveAndEnabled;
  }

  /** True for the one frame Enter was pressed in the field while typing (never in a `UITextArea`, where Enter starts a line). */
  get submitted(): boolean {
    return uiInteractions(this._world).happened(this, "submit");
  }
}

// --- ADR 0428: form elements ------------------------------------------------------------------------

/** The accent colour form controls draw their checked box, slider fill and bars in without `accent-color` (a clear blue). */
export const UI_DEFAULT_ACCENT = new Color(0.27, 0.53, 1, 1);

/**
 * ADR 0428: a multi-line text field (HTML's `<textarea>`): an input field whose Enter starts a new line, whose text
 * wraps at its width (`wrap` `soft`) and which scrolls (ADR 0427) when its text is taller than its `rows`.
 */
@component("engine.UITextArea")
export class UITextArea extends UIInputField {
  /** Its height in lines when `height` is `auto`. */
  @field(Number) rows = 2;
  /** `soft`: lines wrap at its width; `off`: only at line breaks. */
  @field(String, { choices: ["soft", "off"] }) wrap: UITextAreaWrap = "soft";

  constructor() {
    super();
    this.overflow = "auto";
  }
}

/**
 * ADR 0428: a checkbox (HTML's `<input type="checkbox">`). A click, `submit` (Space, Enter, the south button) or its
 * label toggles `checked` (clearing `indeterminate`) and sends `input` then `change`; `changed` is true that frame.
 * Its box is the element (styled as a panel); the check mark and the fill are drawn in `accentColor`.
 */
@component("engine.UIToggle")
export class UIToggle extends UIFocusable {
  @field(Boolean) checked = false;
  /** Shown as a dash, and matching `:indeterminate`, until the player toggles it (a script sets it). */
  @field(Boolean) indeterminate = false;
  /** The control's name in its form (Svelte's `bind:group` matches by `value`). */
  @field(String) name = "";
  @field(String) value = "on";
  /** The fill and mark colour (`accent-color`); null: the default blue. */
  @field(Color) accentColor: Color | null = null;

  constructor() {
    super();
    this.width = "16";
    this.height = "16";
    this.backgroundColor = new Color(0.1, 0.11, 0.13, 1);
    this.borderColor = new Color(0.5, 0.53, 0.6, 1);
    this.borderWidth = 1;
    this.borderRadius = 3;
    this.focusColor = new Color(0.36, 0.62, 1, 1);
  }
}

/**
 * ADR 0428: a radio button (HTML's `<input type="radio">`). Checking one unchecks the others with the same `name` in
 * its form (else its canvas). A click, `submit` or its label checks it; the arrow keys left and right check the
 * previous or next one of its group.
 */
@component("engine.UIRadio")
export class UIRadio extends UIFocusable {
  @field(Boolean) checked = false;
  @field(String) name = "";
  @field(String) value = "on";
  @field(Color) accentColor: Color | null = null;

  constructor() {
    super();
    this.width = "16";
    this.height = "16";
    this.backgroundColor = new Color(0.1, 0.11, 0.13, 1);
    this.borderColor = new Color(0.5, 0.53, 0.6, 1);
    this.borderWidth = 1;
    this.borderRadius = 8;
    this.focusColor = new Color(0.36, 0.62, 1, 1);
  }
}

/**
 * ADR 0428: a slider (HTML's `<input type="range">`): `value` between `min` and `max` in steps of `step`. A press on it
 * jumps the thumb there and drags it (`input` as it moves, `change` on release); with focus, the arrow keys left and
 * right step it, Page Up/Down step a tenth, Home/End go to the ends. Drawn as a track, a fill and a thumb.
 */
@component("engine.UISlider")
export class UISlider extends UIFocusable {
  @field(Number) min = 0;
  @field(Number) max = 100;
  /** 0: any value. */
  @field(Number) step = 1;
  @field(Number) value = 50;
  @field(Color) accentColor: Color | null = null;

  constructor() {
    super();
    this.width = "160";
    this.height = "16";
    this.borderRadius = 8;
    this.focusColor = new Color(0.36, 0.62, 1, 1);
  }
}

/**
 * ADR 0428: a drop-down list (HTML's `<select>`), its `UIOption` children the choices. It shows the chosen option's
 * text and an arrow; a click, `submit` or its label (focus) opens the list, a popup drawn above everything else in its
 * canvas and outside its ancestors' clips, below it (above it where it wouldn't fit). Choosing sends `input` then
 * `change`. `value` is the chosen option's `value` (its text without one); with `multiple`, options toggle and `value`
 * is the first chosen one.
 */
@component("engine.UISelect")
export class UISelect extends UIFocusable {
  @field(String) value = "";
  @field(Boolean) multiple = false;
  /** True while its list shows; scripts may open and close it. */
  @field(Boolean) open = false;
  @field(AssetRef, { kind: "font" }) font = "";
  @field(Number) fontSize = 16;
  @field(Color) color = Color.white;
  /** The arrow's and a chosen option's highlight colour; null: the default blue. */
  @field(Color) accentColor: Color | null = null;

  constructor() {
    super();
    this.backgroundColor = new Color(0.1, 0.11, 0.13, 1);
    this.borderColor = new Color(0.35, 0.38, 0.45, 1);
    this.borderWidth = 1;
    this.borderRadius = 4;
    this.padding = 6;
    this.paddingLeft = 8;
    this.paddingRight = 28;
    this.focusColor = new Color(0.36, 0.62, 1, 1);
  }
}

/**
 * ADR 0428: one choice of a `UISelect` (HTML's `<option>`): its text children are its label (or `label`, when set).
 * Shown in its select's list; a click on it chooses it. `interactable` false is HTML's `disabled`.
 */
@component("engine.UIOption")
export class UIOption extends UIButton {
  /** What its select's `value` becomes when it's chosen; empty: its text. */
  @field(String) value = "";
  @field(Boolean) selected = false;
  /** Its label in place of its text (HTML's `label` attribute); empty: its text. */
  @field(String) label = "";

  constructor() {
    super();
    this.type = "button";
    this.focusable = true;
    this.backgroundColor = new Color(0.13, 0.14, 0.17, 1);
    this.hoverColor = new Color(0.22, 0.25, 0.31, 1);
    this.pressedColor = new Color(0.17, 0.19, 0.23, 1);
    this.focusColor = new Color(0.22, 0.25, 0.31, 1);
    this.borderRadius = 0;
    this.padding = 6;
    this.paddingLeft = 8;
    this.paddingRight = 8;
    this.justifyContent = "flex-start";
  }
}

/**
 * ADR 0428: a progress bar (HTML's `<progress>`): `value` out of `max`, drawn as a fill in `accentColor` over its own
 * background; with `value` null it's indeterminate (a moving segment, `:indeterminate`).
 */
@component("engine.UIProgress")
export class UIProgress extends UIPanel {
  @field(Number) value: number | null = null;
  @field(Number) max = 1;
  @field(Color) accentColor: Color | null = null;

  constructor() {
    super();
    this.width = "160";
    this.height = "8";
    this.borderRadius = 4;
    this.backgroundColor = new Color(0.25, 0.27, 0.32, 1);
  }
}

/**
 * ADR 0428: a gauge (HTML's `<meter>`): `value` between `min` and `max`, its fill green where `value` is in the
 * optimum region `low`/`high`/`optimum` mark out, yellow one region away and red two away (HTML's rules).
 */
@component("engine.UIMeter")
export class UIMeter extends UIPanel {
  @field(Number) value = 0;
  @field(Number) min = 0;
  @field(Number) max = 1;
  /** Null: `min` (`low`), `max` (`high`), their middle (`optimum`). */
  @field(Number) low: number | null = null;
  @field(Number) high: number | null = null;
  @field(Number) optimum: number | null = null;

  constructor() {
    super();
    this.width = "160";
    this.height = "8";
    this.borderRadius = 4;
    this.backgroundColor = new Color(0.25, 0.27, 0.32, 1);
  }
}

/**
 * ADR 0428: a label (HTML's `<label>`): a panel whose text children label a control. A click on it focuses or
 * activates the control `for` names (the id of an element in its canvas: its node's name), else the first control
 * inside it: a checkbox toggles, a radio checks, a button clicks, others take focus (a field starts typing).
 */
@component("engine.UILabel")
export class UILabel extends UIPanel {
  /** The id of the control it labels; empty: the first control inside it. */
  @field(String) for = "";

  constructor() {
    super();
    this.alignItems = "center";
    this.gap = 6;
  }
}

/**
 * ADR 0428: a form (HTML's `<form>`): a panel that groups controls. Enter in one of its fields, or a click on a
 * `submit` button in it, sends its `submit` event (cancelable; nothing else happens, a game has no page to send it
 * to); a `reset` button sends `reset`, after which its controls go back to how they were built.
 */
@component("engine.UIForm")
export class UIForm extends UIPanel {
  constructor() {
    super();
    this.flexDirection = "column";
  }

  /** True for the one frame it was submitted (Enter in one of its fields, a submit button, `requestSubmit`), in every phase of that frame. */
  get submitted(): boolean {
    return uiInteractions(this._world).happened(this, "submit");
  }

  /** Submit it as a submit button would: its `submit` event (at once, as the DOM's `requestSubmit`). */
  requestSubmit(): void {
    submitForm(this._world, this);
  }

  /** Reset it as a reset button would: its `reset` event, then (unless prevented) its controls back as they were built. */
  reset(): void {
    resetFormEvent(this._world, this);
  }
}

/** Every UI component type, for the render backend and the routing. */
export const UI_TYPES = [UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField, UITextArea, UIToggle, UIRadio, UISlider, UISelect, UIOption, UIProgress, UIMeter, UILabel, UIForm, UISvg, UIVideo, UIAudio] as const;

/** An element that takes focus (ADR 0340, 0428). */
export type UIFocusableElement = UIButton | UIInputField | UIToggle | UIRadio | UISlider | UISelect;

/** True when the element or an element it's in (up to its canvas) is `inert` (HTML's): it takes no pointer, focus or navigation. */
export function isInertUI(c: UIComponent): boolean {
  for (let n: GameObject | null = c.owner; n?.isValid; n = n.parent) {
    const el = n.getComponent(UIElement);
    if (el?.inert) return true;
    if (!el) return false; // the canvas (or a node outside UI)
  }
  return false;
}

/** True for an element that takes focus (ADR 0340, 0428): buttons, fields and the other form controls. */
export function isFocusableUI(c: unknown): c is UIFocusableElement {
  return c instanceof UIFocusable;
}

/** Any UI component. */
export type UIComponentType = UICanvas | UIPanel | UIText | UIImage | UIButton | UIInputField | UIToggle | UIRadio | UISlider | UISelect | UIProgress | UIMeter | UILabel | UIForm | UISvg | UIVideo | UIAudio;

/** @internal True for a UI component (the render backend releases those through its UI runtime). */
export function isUIComponent(c: Component): c is UIComponentType {
  return c instanceof UIComponent;
}
