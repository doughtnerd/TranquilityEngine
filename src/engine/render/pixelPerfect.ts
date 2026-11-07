/**
 * Pixel-perfect 2D camera maths (ADR 0014): pure functions, no renderer or DOM.
 */

export interface PixelPerfectView {
  /** Whole-number screen pixels per texel. */
  zoom: number;
  /** The effective half-height of the view in world units. */
  orthographicSize: number;
  /** World units covered by one device pixel. */
  unitsPerPixel: number;
}

/**
 * The integer zoom and resulting half-height for a canvas `heightPx` device pixels tall, wanting at
 * least `orthographicSize` half-height in units, at `pixelsPerUnit`. The zoom is the largest whole
 * scale that still shows the wanted area; when even zoom 1 shows less, zoom stays 1 and the view
 * shows `heightPx / pixelsPerUnit` units. Bad input (non-positive height, size or pixelsPerUnit)
 * gives zoom 1 and the given size.
 */
export function pixelPerfectView(heightPx: number, orthographicSize: number, pixelsPerUnit: number): PixelPerfectView {
  const ppuOk = Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0;
  if (!ppuOk || !(heightPx > 0) || !Number.isFinite(heightPx) || !(orthographicSize > 0) || !Number.isFinite(orthographicSize)) {
    return { zoom: 1, orthographicSize, unitsPerPixel: ppuOk ? 1 / pixelsPerUnit : 0 };
  }
  const zoom = Math.max(1, Math.floor(heightPx / (2 * orthographicSize * pixelsPerUnit)));
  return { zoom, orthographicSize: heightPx / (2 * pixelsPerUnit * zoom), unitsPerPixel: 1 / (pixelsPerUnit * zoom) };
}

/** `value` rounded to the nearest multiple of `step`; a `step` of 0 or less returns `value`. */
export function snapToGrid(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

/**
 * Half a pixel in world units for an odd pixel size, else 0. With an odd height (or width) the view
 * centre falls in the middle of a pixel, so the renderer adds this to the snapped camera position
 * per axis to keep texel edges on pixel edges.
 */
export function pixelCenterOffset(sizePx: number, unitsPerPixel: number): number {
  return Math.round(sizePx) % 2 === 1 ? unitsPerPixel / 2 : 0;
}
