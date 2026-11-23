// The "Why it played" graph's geometry (spec §4.6.5; the prototype's pannable, zoomable flow chart, P5): the chain's
// nodes in a row when the row fits at 60% or more, else in a column; the scale that fits it (never above 100%, at least
// 60% when it opens, at least 25% when asked to fit all), and where it starts (centred when it fits, else at the game's
// request); zooming about a point and its limits. Pure.

/** A node's size and the connector between two, px at 100%. */
export const NODE_W = 170;
export const NODE_H = 58;
export const LINK = 24;
/** The margin kept around the chart when fitting, px. */
export const PAD = 16;
/** Zoom limits, and the step of + and −. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 1.25;
/** The smallest scale the chart opens at; below it the chart stacks. */
export const OPEN_MIN = 0.6;

export type Layout = "row" | "column";

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface View {
  readonly scale: number;
  /** The chart's top-left corner in the viewport, px. */
  readonly x: number;
  readonly y: number;
}

/** The chart's size at 100% for `n` nodes. */
export function contentSize(n: number, layout: Layout): Size {
  const long = n * (layout === "row" ? NODE_W : NODE_H) + Math.max(0, n - 1) * LINK;
  return layout === "row" ? { w: long, h: NODE_H } : { w: NODE_W, h: long };
}

/** The scale at which `content` fits `box` with the margin (never above 1). */
export function fitScale(box: Size, content: Size): number {
  if (content.w <= 0 || content.h <= 0) return 1;
  return Math.min(1, (box.w - 2 * PAD) / content.w, (box.h - 2 * PAD) / content.h);
}

/** Row when the row fits at `OPEN_MIN` or more, else column. */
export function chooseLayout(n: number, box: Size): Layout {
  return fitScale(box, contentSize(n, "row")) >= OPEN_MIN ? "row" : "column";
}

const clampZoom = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

/**
 * The view that shows the chart: scaled to fit, at least `min` (`OPEN_MIN` when it opens, `MIN_ZOOM` for Fit), centred
 * along each axis it fits on, else starting at the first node (the game's request).
 */
export function fitView(box: Size, content: Size, min = OPEN_MIN): View {
  const scale = clampZoom(Math.max(min, fitScale(box, content)));
  const w = content.w * scale, h = content.h * scale;
  return { scale, x: w + 2 * PAD <= box.w ? (box.w - w) / 2 : PAD, y: h + 2 * PAD <= box.h ? (box.h - h) / 2 : PAD };
}

/** `view` zoomed by `factor` about the viewport point (`px`, `py`), within the limits. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = clampZoom(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}
