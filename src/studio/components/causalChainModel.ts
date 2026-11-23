// "Why it played" (ADR 0349 `CausalChain`): the chain of steps from the game's request to the bus a voice played on
// (game trigger → sequence → playlists → sample → bus), each with why it went that way and how bad it was, drawn on a
// pan/zoom grid. This model holds the view's maths: zoom about a point (25 %–250 %), panning, the keys (arrows pan
// 48 px, + and − zoom ×1.25, 0 fits, 1 is 100 %), fitting the chain to the panel, and when a narrow panel stacks it
// top to bottom instead of left to right.

/** What a step is. */
export type StepKind = "game" | "sequence" | "playlist" | "sample" | "bus" | "effect" | "limit";

/** How a step went: fine, a warning (stolen, blocked), or an error (a missing file). */
export type StepSeverity = "ok" | "warning" | "error";

export interface CausalStep {
  readonly kind: StepKind;
  /** "HoverBike/Land", "land_hard_04.wav", "SFX › Vehicles". */
  readonly name: string;
  /** Why it went this way ("Surface → Metal", "Round robin → #4"). */
  readonly why: string;
  readonly severity: StepSeverity;
  /** Where clicking it goes (a screen and asset); null for nowhere. Opaque to the chain. */
  readonly target?: unknown;
  /** A short tag after the kind ("SW", "1D", "RND"). */
  readonly tag?: string;
}

/** The kind's caption. */
export const KIND_TEXT: Readonly<Record<StepKind, string>> = {
  game: "Game",
  sequence: "Sequence",
  playlist: "Playlist",
  sample: "Sample",
  bus: "Bus",
  effect: "Effect",
  limit: "Limit",
};

/** The pan and zoom: content translated by (x, y) pixels, then scaled by s. */
export interface ChainView {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;
/** An arrow key pans this far, px. */
export const PAN_STEP = 48;
/** + and − zoom by this factor. */
export const ZOOM_STEP = 1.25;
/** A step card's width plus its arrow, px (for deciding when to stack). */
export const STEP_PITCH = 194;
/** The smallest zoom a left-to-right chain may be shown at before it stacks instead. */
export const READABLE_ZOOM = 0.6;

export const START_VIEW: ChainView = { x: 12, y: 12, s: 1 };

const clampZoom = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));
const round = (n: number) => Math.round(n);

/** The view zoomed by `factor` about the point (cx, cy) in the panel, so that point stays put. */
export function zoomAt(view: ChainView, factor: number, cx: number, cy: number): ChainView {
  const s = clampZoom(view.s * factor);
  const k = s / view.s;
  return { x: round(cx - (cx - view.x) * k), y: round(cy - (cy - view.y) * k), s };
}

/** The view panned by (dx, dy). */
export const panBy = (view: ChainView, dx: number, dy: number): ChainView => ({ x: round(view.x + dx), y: round(view.y + dy), s: view.s });

/**
 * The view that shows content `content` (unscaled px) in a panel `panel` px: centred, scaled to fit but never above
 * 100 %; `full` fits however small (down to 25 %), otherwise it stays readable (≥ 60 %) and starts at the left.
 */
export function fitView(panel: { readonly width: number; readonly height: number }, content: { readonly width: number; readonly height: number }, full: boolean): ChainView {
  if (!(content.width > 0) || !(panel.width > 0) || !(panel.height > 0)) return START_VIEW;
  const s = Math.min(MAX_ZOOM, Math.max(full ? MIN_ZOOM : READABLE_ZOOM, Math.min(1, panel.width / content.width, panel.height / content.height)));
  return { x: round(content.width * s <= panel.width ? (panel.width - content.width * s) / 2 : 0), y: round(Math.max(0, (panel.height - content.height * s) / 2)), s };
}

/** Whether a chain of `steps` steps stacks top to bottom in a panel `width` px wide (left to right it would shrink below readable). */
export const shouldStack = (steps: number, width: number): boolean => steps > 1 && width > 0 && width < (steps * STEP_PITCH + 24) * READABLE_ZOOM;

/** What a key does to the view: a new view, "fit", or null for keys it doesn't use. `center` is the panel's middle (zoom point). */
export function chainKey(view: ChainView, key: string, center: { readonly x: number; readonly y: number }): ChainView | "fit" | null {
  switch (key) {
    case "ArrowLeft":
      return panBy(view, PAN_STEP, 0);
    case "ArrowRight":
      return panBy(view, -PAN_STEP, 0);
    case "ArrowUp":
      return panBy(view, 0, PAN_STEP);
    case "ArrowDown":
      return panBy(view, 0, -PAN_STEP);
    case "+":
    case "=":
      return zoomAt(view, ZOOM_STEP, center.x, center.y);
    case "-":
    case "_":
      return zoomAt(view, 1 / ZOOM_STEP, center.x, center.y);
    case "0":
      return "fit";
    case "1":
      return zoomAt(view, 1 / view.s, center.x, center.y);
    default:
      return null;
  }
}

/** A wheel turn: Ctrl/⌘ zooms about the pointer, Shift pans sideways, otherwise it pans. */
export function chainWheel(view: ChainView, e: { readonly deltaX: number; readonly deltaY: number; readonly ctrl: boolean; readonly shift: boolean; readonly x: number; readonly y: number }): ChainView {
  if (e.ctrl) return zoomAt(view, Math.exp(-e.deltaY * 0.01), e.x, e.y);
  const dx = e.shift && !e.deltaX ? e.deltaY : e.deltaX;
  const dy = e.shift ? 0 : e.deltaY;
  return panBy(view, -dx, -dy);
}

/** The worst severity in the chain (the panel's headline). */
export function worstSeverity(steps: readonly CausalStep[]): StepSeverity {
  return steps.some((s) => s.severity === "error") ? "error" : steps.some((s) => s.severity === "warning") ? "warning" : "ok";
}

/** The chain as one sentence for screen readers ("Game Land, then playlist Bike impacts (Surface → Metal), …"). */
export function chainText(steps: readonly CausalStep[]): string {
  return steps.map((s) => `${KIND_TEXT[s.kind].toLowerCase()} ${s.name}${s.why ? ` (${s.why})` : ""}${s.severity !== "ok" ? `, ${s.severity}` : ""}`).join(", then ");
}
