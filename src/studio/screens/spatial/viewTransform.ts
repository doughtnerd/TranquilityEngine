// The Scene view's camera (the prototype's pan and zoom, S:1525-1546): which point of the plan is at the middle of the
// viewport and how many pixels a metre is. North (+z) is up the screen. Wheel and pinch zoom about the pointer, arrows
// and Space-drag pan, +/− zoom ×1.25, 0 and Fit frame the scene.
//
// Pure: no DOM, no signals.
import type { Bounds, P2 } from "./geometry";

export interface View {
  /** The plan point at the middle of the viewport. */
  readonly cx: number;
  readonly cz: number;
  /** Pixels per metre. */
  readonly ppm: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A screen point, pixels from the viewport's top-left. */
export interface Px {
  readonly x: number;
  readonly y: number;
}

/** How far the view zooms, pixels per metre. */
export const PPM_RANGE: readonly [number, number] = [0.5, 120];
/** A +/− press zooms by this. */
export const ZOOM_STEP = 1.25;
/** An arrow press pans by this many pixels (Shift: `PAN_STEP_BIG`). */
export const PAN_STEP = 20;
export const PAN_STEP_BIG = 80;
/** Fit leaves this many pixels free round the scene. */
export const FIT_MARGIN = 32;

export const DEFAULT_VIEW: View = { cx: 0, cz: 0, ppm: 8 };

const clampPpm = (ppm: number) => Math.min(PPM_RANGE[1], Math.max(PPM_RANGE[0], ppm));

export const toScreen = (v: View, size: Size, p: P2): Px => ({ x: size.width / 2 + (p.x - v.cx) * v.ppm, y: size.height / 2 - (p.z - v.cz) * v.ppm });
export const toPlan = (v: View, size: Size, s: Px): P2 => ({ x: v.cx + (s.x - size.width / 2) / v.ppm, z: v.cz - (s.y - size.height / 2) / v.ppm });

/** Zoom by `factor` keeping the plan point under `at` where it is. */
export function zoomAt(v: View, size: Size, at: Px, factor: number): View {
  const ppm = clampPpm(v.ppm * factor);
  if (ppm === v.ppm) return v;
  const before = toPlan(v, size, at);
  const next = { ...v, ppm };
  const after = toPlan(next, size, at);
  return { ppm, cx: v.cx + (before.x - after.x), cz: v.cz + (before.z - after.z) };
}

/** Pan so the content moves by (dx, dy) pixels. */
export const panBy = (v: View, dx: number, dy: number): View => ({ ...v, cx: v.cx - dx / v.ppm, cz: v.cz + dy / v.ppm });

/** The view framing `bounds` in a viewport of `size`. */
export function fitView(bounds: Bounds, size: Size, margin = FIT_MARGIN): View {
  const w = Math.max(1, size.width - margin * 2), h = Math.max(1, size.height - margin * 2);
  const ppm = clampPpm(Math.min(w / Math.max(1e-6, bounds.maxX - bounds.minX), h / Math.max(1e-6, bounds.maxZ - bounds.minZ)));
  return { cx: (bounds.minX + bounds.maxX) / 2, cz: (bounds.minZ + bounds.maxZ) / 2, ppm };
}

/** The grid's spacing in metres for a zoom: about every 40 px, at 1, 2 or 5 × a power of ten. */
export function gridStep(ppm: number, targetPx = 40): number {
  const raw = targetPx / ppm;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** The plan rectangle a viewport shows. */
export function visibleBounds(v: View, size: Size): Bounds {
  const a = toPlan(v, size, { x: 0, y: size.height }), b = toPlan(v, size, { x: size.width, y: 0 });
  return { minX: a.x, minZ: a.z, maxX: b.x, maxZ: b.z };
}

/** The zoom as a percentage of the default (the zoom bar's readout). */
export const zoomPercent = (v: View): number => Math.round((v.ppm / DEFAULT_VIEW.ppm) * 100);

// --- keys ------------------------------------------------------------------------------------------------------------

/** What the view's keys do to it. */
export type ViewKey = "panLeft" | "panRight" | "panUp" | "panDown" | "zoomIn" | "zoomOut";

/** The view after a view key (`big`: Shift held, a bigger pan step). Zoom keys zoom about the middle. */
export function viewKey(v: View, size: Size, key: ViewKey, big = false): View {
  const step = big ? PAN_STEP_BIG : PAN_STEP;
  switch (key) {
    case "panLeft":
      return panBy(v, step, 0);
    case "panRight":
      return panBy(v, -step, 0);
    case "panUp":
      return panBy(v, 0, step);
    case "panDown":
      return panBy(v, 0, -step);
    case "zoomIn":
      return zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, ZOOM_STEP);
    case "zoomOut":
      return zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, 1 / ZOOM_STEP);
  }
}

/** A two-finger gesture: the view following the fingers' midpoint and their spread (pinch zoom and pan together). */
export function pinch(v: View, size: Size, from: readonly [Px, Px], to: readonly [Px, Px]): View {
  const mid = (a: Px, b: Px): Px => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const spread = (a: Px, b: Px) => Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  const m0 = mid(from[0], from[1]), m1 = mid(to[0], to[1]);
  const zoomed = zoomAt(v, size, m0, spread(to[0], to[1]) / spread(from[0], from[1]));
  return panBy(zoomed, m1.x - m0.x, m1.y - m0.y);
}
