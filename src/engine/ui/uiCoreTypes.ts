/**
 * The renderer-neutral UI core's contract (ADR 0076): layout with Yoga, pointer and keyboard routing,
 * and input fields' typing, in `UICore.ts`; drawn by a backend's drawing layer
 * (`render/babylon/ui.ts`) from what `elements()` and `canvases()` report. Nothing here is public API.
 *
 * Coordinates:
 * - **UI pixels**: a canvas's own units. A screen canvas is `width × height` UI pixels (the canvas's CSS
 *   size divided by its scale); a world canvas is `referenceResolution`. Origin top-left, y down.
 * - **Canvas CSS pixels**: the drawing canvas's CSS pixels, origin top-left. A screen canvas maps UI
 *   pixel (x, y) to (x × scale, y × scale).
 * - **World canvases**: a plane centred on the canvas node, facing its +Z, `width × pixelSize` by
 *   `height × pixelSize` world units. UI pixel (x, y) is at local
 *   `((x − width / 2) × pixelSize, (height / 2 − y) × pixelSize, 0)`, then the node's world matrix.
 */
import type { World } from "../core/World";
import type { Camera } from "../render/components";
import type { UICanvas, UIComponentType } from "./components";
import type { UIRect } from "./layout";
import type { UIAffine } from "./transform2d";
import type { UIFilterStep } from "./filters";

export type UIKind = "canvas" | "panel" | "text" | "image" | "button" | "input"
  // ADR 0424: form elements.
  | "textarea" | "toggle" | "radio" | "slider" | "select" | "option" | "progress" | "meter" | "label" | "form";

/** How a text run wraps: at spaces (`UIText.wordBreak` `break-word`), at any character (`break-all`), or never (`keep-all`, input fields). */
export type UITextWrap = "word" | "anywhere" | "none";

/**
 * An element's resolved text (ADR 0271, `textRunOf` in `elementKinds.ts`): what the core measures and
 * the drawing layer draws, so the two can't disagree.
 */
export interface UITextRun {
  readonly text: string;
  readonly fontSize: number;
  /** CSS font weight: a whole number from 1 to 1000 ("400", "700", "350"). */
  readonly fontWeight: string;
  /** CSS font family list. */
  readonly fontFamily: string;
  /** Line height as a multiple of the font size. */
  readonly lineHeight: number;
  readonly wrap: UITextWrap;
  /** The base direction it is drawn in: the current language's (ADR 0356 §5). */
  readonly direction: "ltr" | "rtl";
  /** Its alignment as an edge, `start`/`end` resolved for `direction`. */
  readonly align: "left" | "center" | "right" | "justify";
}

/** A text run to measure, for Yoga's layout of text elements (direction and alignment don't change its size). */
export interface TextMeasureRequest extends Omit<UITextRun, "direction" | "align"> {
  /** Width available in UI pixels (Infinity when unbounded, and always for `wrap: "none"`); text wraps to it. */
  readonly maxWidth: number;
}

/** What a backend gives the core. All optional: without a host, layout and routing still work (tests, servers). */
export interface UICoreHost {
  /** The Camera component that draws the view, for world canvases' pointer rays (ADR 0073). */
  viewCamera?(): Camera | null;
  /** Measure text in UI pixels. Without it, the core estimates (Node). */
  measureText?(request: TextMeasureRequest): { width: number; height: number };
}

export interface UICoreOptions {
  /** Route the pointer and keyboard to UI (false in the editor's own World: clicks select there). */
  interactive?: boolean;
  /**
   * Lay out only: no pointer routing and no typing. For a second layout of the same UI at another
   * size (the editor's camera preview inset), beside the core that routes.
   */
  passive?: boolean;
  host?: UICoreHost;
}

/** A canvas as laid out in the last `sync`. */
export interface UILaidOutCanvas {
  readonly comp: UICanvas;
  readonly mode: "screen" | "world";
  readonly sortOrder: number;
  /** Size in UI pixels. */
  readonly width: number;
  readonly height: number;
  /** Screen canvases: canvas CSS pixels per UI pixel. World canvases: 1. */
  readonly scale: number;
  /** World canvases: UI pixels to world units. Screen canvases: 1. */
  readonly pixelSize: number;
  /** World canvases: the canvas node's world matrix (16 numbers, column-major). Screen canvases: null. */
  readonly worldMatrix: Float32Array | null;
  /** Active and enabled. */
  readonly visible: boolean;
}

/** ADR 0423: one scrollbar as drawn, in its canvas's UI pixels in layout space (the scroller's transform applies to it). */
export interface UIScrollbar {
  readonly track: UIRect;
  readonly thumb: UIRect;
}

/**
 * ADR 0423: a clipping element's scroll state at the last layout. Lengths in UI pixels; the padding box is the area its
 * content scrolls in (`clientWidth`/`clientHeight`), the content's extent the union of its children's margin boxes plus
 * its end padding (`scrollWidth`/`scrollHeight`, at least the padding box).
 */
export interface UIScrollInfo {
  /** Its scroll offset after clamping (what's drawn). */
  readonly x: number;
  readonly y: number;
  /** The largest offsets: how far the content reaches past the padding box. */
  readonly maxX: number;
  readonly maxY: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  /** Whether the player scrolls the axis (`overflow` `auto` or `scroll` on it); a `hidden` axis scrolls only by script. */
  readonly userX: boolean;
  readonly userY: boolean;
  /** The padding box in layout space (canvas UI pixels before transforms). */
  readonly client: UIRect;
  /** The scrollbars shown (null: none on that axis). */
  readonly barX: UIScrollbar | null;
  readonly barY: UIScrollbar | null;
}

/** An element (not a canvas) as laid out in the last `sync`. */
export interface UILaidOutElement {
  readonly comp: UIComponentType;
  readonly kind: Exclude<UIKind, "canvas">;
  readonly canvas: UICanvas;
  /** Its box in its canvas's UI pixels: border box, top-left origin. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * Draw order within its canvas (ADR 0418): parents before children, then siblings by `zIndex` and document order;
   * an element with a non-zero `zIndex` or an `overflow` other than `visible` draws its descendants right after itself. The pointer
   * goes to the highest first.
   */
  readonly order: number;
  /**
   * The overlap of every `overflow: hidden` ancestor's padding box, in layout space (before transforms); null when none
   * clips it. With transforms (ADR 0418 wave 3), each clip moves with its clipper: `bounds` is what's drawn.
   */
  readonly clip: UIRect | null;
  /** Its nearest `overflow: hidden` ancestor (the drawing layer draws it inside that one's clip), or null. */
  readonly clipper: UIComponentType | null;
  /** With `overflow` other than `visible` (`hidden`, or scrolling, ADR 0423): its padding box (inside its border), which its descendants are clipped to; else null. */
  readonly childClip: UIRect | null;
  /** Drawn: active and enabled, `visible`, and every ancestor element too. */
  readonly visible: boolean;
  /** `opacity` times every ancestor's. */
  readonly opacity: number;
  /** Text and input field elements: the text run the core measured, which the drawing layer draws. Null for other kinds. */
  readonly text: UITextRun | null;
  /**
   * ADR 0418 wave 3: where it's drawn, as a map from its laid-out box (the fields above) to canvas UI pixels: its
   * ancestors' transforms and its own (`transform2d.ts`). Null when nothing transforms it.
   */
  readonly transform: UIAffine | null;
  /** The axis-aligned bounds of what's drawn of it, in canvas UI pixels: its box transformed, cut down by its clips. Its box when nothing transforms or clips it. */
  readonly bounds: UIRect;
  /**
   * ADR 0423: `bounds` cut down only by clips that don't scroll (`overflow: hidden` on both axes), so navigation can find an
   * element scrolled out of view and scroll it back. The same as `bounds` when no scrolling element clips it.
   */
  readonly reach: UIRect;
  /** ADR 0423: with `overflow` other than `visible`: its scroll state; else null. */
  readonly scroll: UIScrollInfo | null;
  /**
   * ADR 0426: the CSS filter drawn over it (`filters.ts`): its own steps, then each ancestor's, nearest first, as a
   * filter applies to an element's subtree; lengths in canvas UI pixels through each filtering element's transform.
   * Null or absent: none.
   */
  readonly filter?: readonly UIFilterStep[] | null;
  /**
   * ADR 0424: what a form element draws over its own box (a checkbox's fill and mark, a slider's track, fill and thumb,
   * a progress bar's fill, a select's arrow), in its box's frame; null for other elements and when there's nothing.
   */
  readonly parts: readonly UIPart[] | null;
}

/**
 * ADR 0424: one part of a form element, a filled rectangle in its border box's frame (origin its top-left corner, UI
 * pixels): `rotate` (degrees, clockwise about its centre) turns it, so strokes such as a check mark are thin rectangles.
 * `color` is RGBA in 0..1.
 */
export interface UIPart {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: readonly [number, number, number, number];
  readonly radius: number;
  readonly rotate: number;
}

/** A ray in world space, for picking world canvases. */
export interface UIPickRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * Editor (ADR 0077): an element's laid-out box. `points` are its corners (top-left, top-right,
 * bottom-right, bottom-left): canvas CSS pixels `[x, y]` on a screen canvas, world points
 * `[x, y, z]` on a world canvas. `size` is the box's width and height in UI pixels.
 */
export interface UICorners {
  readonly space: "screen" | "world";
  readonly points: number[][];
  readonly size: readonly [number, number];
  /** The corners of the part that is drawn, as `points`, when an `overflow: hidden` ancestor clips it (ADR 0418); null when nothing does. */
  readonly clip: number[][] | null;
  /**
   * ADR 0418 wave 3: `points` is the box as drawn, after its transforms. These are its laid-out box's corners with only
   * its ancestors' transforms: where layout put it in its parent's frame. The same as `points` without a transform of its own.
   */
  readonly layoutPoints: number[][];
}

/** The renderer-neutral UI core (ADR 0076). */
export interface UICoreLike {
  /** Step 8: mirror the World's UI components and lay them out for a drawing canvas of `width × height` CSS pixels. */
  sync(world: World, width: number, height: number, deltaSeconds?: number): void;
  /** Canvases from the last sync, ascending `sortOrder`. */
  canvases(): readonly UILaidOutCanvas[];
  /** Elements from the last sync, grouped by canvas in `canvases()` order, each canvas's in tree order (parents first; `order` is the draw order). */
  elements(): readonly UILaidOutElement[];
  /** Increases whenever `sync` changed any box, visibility, text run or the element set (drawing layers can skip work otherwise). */
  readonly layoutVersion: number;
  /** True when there's a visible screen canvas. */
  readonly hasScreenUI: boolean;
  /** Tests and the editor: an element's rectangle in canvas CSS pixels (screen canvases only; null otherwise or before layout). */
  rectOf(c: UIComponentType): { x: number; y: number; width: number; height: number } | null;
  /** Tests: the element the pointer goes to at a canvas CSS point (ADR 0385): the button or input field it presses, else the element that only blocks it; null when it reaches the game. */
  hitTest(x: number, y: number): UIComponentType | null;
  /** Editor (ADR 0077): every drawn element (canvases excepted) under a canvas CSS point, topmost first. */
  pickAll(x: number, y: number, ray?: UIPickRay | null): UIComponentType[];
  /** Editor (ADR 0117): the canvases under a point, topmost first: world canvases by their rect, screen canvases by their frame's edge strip only. */
  pickCanvases(x: number, y: number, ray?: UIPickRay | null, edge?: number): UICanvas[];
  /** Editor (ADR 0077): an element's box corners, in canvas CSS pixels (screen canvases) or world space (world canvases); null when not laid out. */
  cornersOf(c: UIComponentType): UICorners | null;
  /** Forget a removed component. */
  release(c: UIComponentType): void;
  dispose(): void;
}
