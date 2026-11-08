/**
 * Game UI components (ADR 0069, built as ADR 0020 decided). A UI element is a node with one UI
 * component, and the node tree is the UI tree: an element's children lay out inside it with
 * flexbox. A `UICanvas` is the root.
 *
 * These are plain data, like other components: they register and hold values in any World. Only a
 * World with a render backend lays them out (the UI core, ADR 0076) and draws them (Babylon GUI),
 * loaded the first time it has a `UICanvas`, so servers and tests can create UI without WebGL. No
 * renderer types appear here (ADR 0010).
 */
import { Component } from "../core/Component";
import { Color, Vector2 } from "../core/math";
import { AssetRef, component, field } from "../core/registry";

/** A length in UI pixels (a number or `"120"`), a percentage of the parent (`"50%"`), or `"auto"`. */
export type UILength = number | string;
export type UIFlexDirection = "row" | "column" | "row-reverse" | "column-reverse";
export type UIJustify = "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
export type UIAlign = "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
export type UIPositionType = "relative" | "absolute";
/** `none` takes an element and its children out of layout, drawing and the pointer. */
export type UIDisplay = "flex" | "none";
export type UICanvasMode = "screen" | "world";
export type UITextAlign = "left" | "center" | "right" | "justify";
export type UIWordBreak = "break-word" | "break-all" | "keep-all";
export type UIImageFit = "cover" | "contain" | "fill";

const FLEX_DIRECTIONS = ["row", "column", "row-reverse", "column-reverse"];
const JUSTIFY = ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"];
const ALIGN = ["flex-start", "center", "flex-end", "stretch", "baseline"];

/** Releases what the render backend built for a removed UI component (its layout node and drawing). */
abstract class UIComponent extends Component {
  override _onDetach(): void {
    this.world.render?.release(this);
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
}

/** A box: background, border and rounded corners, laying out its children. */
@component("engine.UIPanel")
export class UIPanel extends UIElement {
  /** Null: transparent. */
  @field(Color) backgroundColor: Color | null = null;
  @field(Number) borderRadius = 0;
  @field(Number) borderWidth = 0;
  @field(Color) borderColor = Color.black;
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
   * the first time it's used; empty is the bundled Inter. Characters the font lacks use Inter. On the
   * three.js renderer it's ignored: text there is always Inter.
   */
  @field(AssetRef, { kind: "font" }) font = "";
  @field(Number) fontSize = 16;
  @field(Color) color = Color.white;
  /** `"normal"`, `"medium"`, `"semi-bold"`, `"bold"`, or a number 100–900. */
  @field(String, { choices: ["light", "normal", "medium", "semi-bold", "bold"] }) fontWeight = "normal";
  @field(String, { choices: ["left", "center", "right", "justify"] }) textAlign: UITextAlign = "left";
  /** How lines wrap: at word boundaries, anywhere, or never. */
  @field(String, { choices: ["break-word", "break-all", "keep-all"] }) wordBreak: UIWordBreak = "break-word";
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
 * A panel that takes the pointer. Its children (usually a `UIText`, which has the font) are its label. Read its state
 * from scripts: `hovered`, `pressed`, and `clicked`, true for the frame a click finished, like
 * `Input.getMouseButtonUp`. A pointer press on a button goes to the UI, not to `Input`.
 */
@component("engine.UIButton")
export class UIButton extends UIPanel {
  @field(Color) hoverColor = new Color(0.33, 0.36, 0.43, 1);
  @field(Color) pressedColor = new Color(0.17, 0.19, 0.23, 1);
  /** False: the button ignores the pointer (it still blocks it from the game) and stays unhovered. */
  @field(Boolean) interactable = true;

  /** @internal The routing writes these (ADR 0069). */
  _hovered = false;
  /** @internal */ _pressed = false;
  /** @internal The World frame whose scripts see `clicked`. */ _clickFrame = -1;

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
    return this._hovered && this.interactable && this.isActiveAndEnabled;
  }

  /** True from the press on the button until the pointer button is released. */
  get pressed(): boolean {
    return this._pressed && this.interactable && this.isActiveAndEnabled;
  }

  /** True for the one frame a click on the button finished (pressed and released over it). */
  get clicked(): boolean {
    return this._clickFrame === this.world.time.frameCount && this.interactable;
  }

  /**
   * @internal Tests and headless Worlds: report a click. Inside a frame, scripts see it this frame;
   * between frames, in the next one.
   */
  _simulateClick(): void {
    this._clickFrame = nextFrame(this);
  }
}

/**
 * A one-line text field. Clicking it focuses it; typing goes through a hidden DOM `<input>`, so IME
 * and paste work. While it's focused, keys go to it and `Input.getKey*` report false. `submitted`
 * is true for the frame Enter was pressed in it.
 */
@component("engine.UIInputField")
export class UIInputField extends UIPanel {
  @field(String) value = "";
  @field(String) placeholder = "";
  /** 0: no limit. */
  @field(Number) maxLength = 0;
  /** A font file in the project, as `UIText.font`; empty is the bundled Inter. Ignored on three.js. */
  @field(AssetRef, { kind: "font" }) font = "";
  @field(Number) fontSize = 16;
  @field(Color) color = Color.white;
  @field(Color) placeholderColor = new Color(1, 1, 1, 0.45);

  /** @internal */ _focused = false;
  /** @internal The World frame whose scripts see `submitted`. */ _submitFrame = -1;

  constructor() {
    super();
    this.backgroundColor = new Color(0.1, 0.11, 0.13, 1);
    this.borderColor = new Color(0.35, 0.38, 0.45, 1);
    this.borderWidth = 1;
    this.borderRadius = 4;
    this.padding = 8;
    this.width = "240";
  }

  /** True while it takes the keyboard. Set it to focus or unfocus the field from a script. */
  get focused(): boolean {
    return this._focused && this.isActiveAndEnabled;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  /** True for the one frame Enter was pressed in the focused field. */
  get submitted(): boolean {
    return this._submitFrame === this.world.time.frameCount;
  }

  /** @internal Tests and headless Worlds: report Enter, like `UIButton._simulateClick`. */
  _simulateSubmit(): void {
    this._submitFrame = nextFrame(this);
  }
}

/** The World frame whose scripts see an event that happens now: this one inside a frame, else the next. */
function nextFrame(c: Component): number {
  const world = c.world;
  return world._inFrame ? world.time.frameCount : world.time.frameCount + 1;
}

/** Every UI component type, for the render backend and the routing. */
export const UI_TYPES = [UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField] as const;

/** Any UI component. */
export type UIComponentType = UICanvas | UIPanel | UIText | UIImage | UIButton | UIInputField;

/** @internal True for a UI component (the render backend releases those through its UI runtime). */
export function isUIComponent(c: Component): c is UIComponentType {
  return c instanceof UIComponent;
}
