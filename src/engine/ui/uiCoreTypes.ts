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

export type UIKind = "canvas" | "panel" | "text" | "image" | "button" | "input";

/** A text to measure, for Yoga's layout of text elements. */
export interface TextMeasureRequest {
  text: string;
  fontSize: number;
  /** CSS font weight: "300" | "400" | "500" | "600" | "700". */
  fontWeight: string;
  /** CSS font family list. */
  fontFamily: string;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Width available in UI pixels (Infinity when unbounded); text wraps to it. */
  maxWidth: number;
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
  /** Draw order within its canvas: parents before children, earlier siblings first. */
  readonly order: number;
  /** Drawn: active and enabled, `visible`, and every ancestor element too. */
  readonly visible: boolean;
  /** `opacity` times every ancestor's. */
  readonly opacity: number;
}

/** A ray in world space, for picking world canvases. */
export interface UIPickRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/** The renderer-neutral UI core (ADR 0076). */
export interface UICoreLike {
  /** Step 8: mirror the World's UI components and lay them out for a drawing canvas of `width × height` CSS pixels. */
  sync(world: World, width: number, height: number, deltaSeconds?: number): void;
  /** Canvases from the last sync, ascending `sortOrder`. */
  canvases(): readonly UILaidOutCanvas[];
  /** Elements from the last sync, grouped by canvas in `canvases()` order, each canvas's in `order`. */
  elements(): readonly UILaidOutElement[];
  /** Increases whenever `sync` changed any box, visibility or the element set (drawing layers can skip work otherwise). */
  readonly layoutVersion: number;
  /** True when there's a visible screen canvas. */
  readonly hasScreenUI: boolean;
  /** Tests and the editor: an element's rectangle in canvas CSS pixels (screen canvases only; null otherwise or before layout). */
  rectOf(c: UIComponentType): { x: number; y: number; width: number; height: number } | null;
  /** Tests: the topmost interactive element under a canvas CSS point, or null. */
  hitTest(x: number, y: number): UIComponentType | null;
  /** Editor (ADR 0077): every drawn element (canvases excepted) under a canvas CSS point, topmost first. */
  pickAll(x: number, y: number, ray?: UIPickRay | null): UIComponentType[];
  /** Editor (ADR 0077): an element's box corners, in canvas CSS pixels (screen canvases) or world space (world canvases); null when not laid out. */
  cornersOf(c: UIComponentType): { space: "screen" | "world"; points: number[][] } | null;
  /** Forget a removed component. */
  release(c: UIComponentType): void;
  dispose(): void;
}
