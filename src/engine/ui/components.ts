/**
 * Game UI components (ADR 0069): the element types of UI documents (ADR 0077). A document's element
 * is a node with one UI component, and the node tree is the UI tree: an element's children lay out
 * inside it with flexbox. A `UICanvas` is the root.
 *
 * Only a `UIDocument` building its markup makes them (ADR 0417): `addComponent` throws for these
 * types, and a scene or prefab saving one fails to load. Scripts reach them through a document's
 * elements (`element.as(UIButton)`) and write their fields at runtime.
 *
 * They are plain data, like other components: they hold values in any World. Only a World with a
 * render backend lays them out (the UI core, ADR 0076) and draws them (Babylon GUI), loaded the first
 * time it has a `UICanvas`, so servers and tests can build documents without WebGL. No renderer types
 * appear here (ADR 0010).
 */
import { Component } from "../core/Component";
import { Color, Vector2 } from "../core/math";
import { AssetRef, component, field } from "../core/registry";
import { GameObject } from "../scene/GameObject";
import { uiInteractions } from "./interactions";
// Keyboard and gamepad navigation (ADR 0340) comes with the components: `engine.UIActions`, the `ui` context and `engine.UINavigation`.
import "./navigation";

/** A length in UI pixels (a number or `"120"`), a percentage of the parent (`"50%"`), or `"auto"`. */
export type UILength = number | string;
export type UIFlexDirection = "row" | "column" | "row-reverse" | "column-reverse";
export type UIJustify = "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
export type UIAlign = "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
export type UIPositionType = "relative" | "absolute";
/** `none` takes an element and its children out of layout, drawing and the pointer. */
export type UIDisplay = "flex" | "none";
export type UICanvasMode = "screen" | "world";
/**
 * `start` and `end` follow the text direction of the current language (ADR 0356 §5): `start` is the left edge in
 * left-to-right languages and the right edge in right-to-left ones.
 */
export type UITextAlign = "start" | "end" | "left" | "center" | "right" | "justify";
export type UIWordBreak = "break-word" | "break-all" | "keep-all";
export type UIImageFit = "cover" | "contain" | "fill";
/**
 * How `navigate` leaves a focusable element (ADR 0340): `auto` takes its explicit neighbours, else the
 * spatial search; `explicit` only its neighbours; `none` neither.
 */
export type UINavigationMode = "auto" | "explicit" | "none";
// 0418 wave 1: layout
export type UIFlexWrap = "nowrap" | "wrap" | "wrap-reverse";
/** `auto` takes the parent's `alignItems`. */
export type UIAlignSelf = "auto" | UIAlign;
export type UIAlignContent = "flex-start" | "center" | "flex-end" | "stretch" | "space-between" | "space-around" | "space-evenly";
/** `hidden` clips the element's children (drawing and the pointer) to its padding box. */
export type UIOverflow = "visible" | "hidden";

const FLEX_DIRECTIONS = ["row", "column", "row-reverse", "column-reverse"];
const JUSTIFY = ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"];
const ALIGN = ["flex-start", "center", "flex-end", "stretch", "baseline"];
// 0418 wave 1: layout
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
  @field(String, { choices: ["flex", "none"] }) display: UIDisplay = "flex";
  /**
   * Whether the pointer stops at this element, like Unity's `Graphic.raycastTarget` (ADR 0385). True (the default):
   * a press over it goes to the UI, never to the game (`Input.pointerOverUI` is true), and reaches the button or
   * input field it's in, if any; over text, an image or a panel outside one, it does nothing. False: the pointer
   * passes through to whatever is behind it (other UI, or the game). Text, images, buttons and input fields stop
   * it; a panel only when it draws a background (even a transparent one) or a border, as a panel without either is
   * a layout box (Unity's empty RectTransform). Children aren't affected: each element has its own.
   */
  @field(Boolean) raycastTarget = true;

  // 0418 wave 1: layout
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
   */
  @field(String, { choices: ["visible", "hidden"] }) overflow: UIOverflow = "visible";
  /**
   * Draw and pointer order among its siblings (higher on top, then document order), as in CSS. A non-zero value
   * draws the element and its children together, ordered within it.
   */
  @field(Number) zIndex = 0;
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
  // 0418 wave 1: layout
  /** The border's width on one side (`border-top-width` …). Null (the default): `borderWidth`. Unequal sides draw each side as its own edge. */
  @field(Number) borderTopWidth: number | null = null;
  @field(Number) borderRightWidth: number | null = null;
  @field(Number) borderBottomWidth: number | null = null;
  @field(Number) borderLeftWidth: number | null = null;

  // 0418 wave 2: paint
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
   * A shadow under the background, `box-shadow: offset-x offset-y blur colour` in a stylesheet (ADR 0418). It's
   * drawn by the background, so a panel without a `backgroundColor` or gradient casts none. Null: no shadow.
   */
  @field(Color) boxShadowColor: Color | null = null;
  /** The shadow's offset to the right, in UI pixels. */
  @field(Number) boxShadowOffsetX = 0;
  /** The shadow's offset down, in UI pixels. */
  @field(Number) boxShadowOffsetY = 0;
  /** How far the shadow blurs, in UI pixels (CSS's blur radius). */
  @field(Number) boxShadowBlur = 0;
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
   * The colour of an outline drawn around the glyphs (ADR 0417; `text-outline-color` in a stylesheet, inherited like
   * `color`); null draws none. It shows only with a `textOutlineWidth` above 0.
   */
  @field(Color) textOutlineColor: Color | null = null;
  /** How far the outline reaches outside the glyphs, in UI pixels (`text-outline-width`, inherited); 0 draws none. It doesn't change the layout. */
  @field(Number) textOutlineWidth = 0;

  // 0418 wave 2: paint
  /** A shadow under the glyphs (`text-shadow: offset-x offset-y blur colour`, inherited); null draws none. */
  @field(Color) textShadowColor: Color | null = null;
  /** The text shadow's offset to the right, in UI pixels (`text-shadow-offset-x`, inherited). */
  @field(Number) textShadowOffsetX = 0;
  /** The text shadow's offset down, in UI pixels (`text-shadow-offset-y`, inherited). */
  @field(Number) textShadowOffsetY = 0;
  /** How far the text shadow blurs, in UI pixels (`text-shadow-blur`, inherited). */
  @field(Number) textShadowBlur = 0;
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
 * What buttons and input fields share (ADR 0340): they take focus, from the pointer, scripts, and
 * keyboard and gamepad navigation (`engine.UINavigation`, driven by `engine.UIActions`). One element
 * of a World has focus at a time.
 */
abstract class UIFocusable extends UIPanel {
  /** False takes it out of focus: navigation skips it and a click doesn't focus it. */
  @field(Boolean) focusable = true;
  /** Drawn while it has focus and the last UI input was navigation, not the pointer. */
  @field(Color) focusColor = new Color(0.29, 0.45, 0.75, 1);
  /** `auto`: explicit neighbours, else the nearest element that way; `explicit`: neighbours only; `none`: `navigate` doesn't leave it. */
  @field(String, { choices: ["auto", "explicit", "none"] }) navigation: UINavigationMode = "auto";
  /** Explicit neighbours: where `navigate` up, down, left and right goes from here (null: the search, in `auto`). */
  @field(GameObject) navUp: GameObject | null = null;
  @field(GameObject) navDown: GameObject | null = null;
  @field(GameObject) navLeft: GameObject | null = null;
  @field(GameObject) navRight: GameObject | null = null;

  /** True while it has focus. */
  abstract get focused(): boolean;
  abstract set focused(value: boolean);

  /** True for the one frame the player (the pointer or navigation) gave it focus or took it away, in every phase of that frame. */
  get focusedChanged(): boolean {
    const log = uiInteractions(this._world);
    const self = this as unknown as UIFocusableElement;
    return log.happened(self, "focus") || log.happened(self, "blur");
  }
}

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
  /** False: the button ignores the pointer (it still blocks it from the game) and stays unhovered. */
  @field(Boolean) interactable = true;

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

  /** True while it has focus (a click, a script or navigation gave it). Set it to focus or unfocus the button. */
  get focused(): boolean {
    return uiInteractions(this._world).isFocused(this) && this.isActiveAndEnabled;
  }

  set focused(value: boolean) {
    const log = uiInteractions(this._world);
    if (value) log.focus(this, "script");
    else log.blur(this, "script");
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
  @field(Color) placeholderColor = new Color(1, 1, 1, 0.45);

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
    if (value) log.focus(this, "script", true);
    else log.blur(this, "script");
  }

  /** True while it takes the keyboard: from a click, a script's `focused = true` or `submit`, until Escape, Tab or navigation leaves it. */
  get typing(): boolean {
    return uiInteractions(this._world).isTyping(this) && this.isActiveAndEnabled;
  }

  /** True for the one frame the player changed the value (typed, pasted, deleted). */
  get changed(): boolean {
    return uiInteractions(this._world).happened(this, "change");
  }

  /** True for the one frame Enter was pressed in the field while typing. */
  get submitted(): boolean {
    return uiInteractions(this._world).happened(this, "submit");
  }
}

/** Every UI component type, for the render backend and the routing. */
export const UI_TYPES = [UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField] as const;

/** An element that takes focus (ADR 0340). */
export type UIFocusableElement = UIButton | UIInputField;

/** Any UI component. */
export type UIComponentType = UICanvas | UIPanel | UIText | UIImage | UIButton | UIInputField;

/** @internal True for a UI component (the render backend releases those through its UI runtime). */
export function isUIComponent(c: Component): c is UIComponentType {
  return c instanceof UIComponent;
}
