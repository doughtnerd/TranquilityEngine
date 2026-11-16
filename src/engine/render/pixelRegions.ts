/**
 * Regions of a texture's pixels: a redrawn rectangle as whole pixels inside the texture, and rows of
 * RGBA pixels flipped for an upside-down upload. Pure; the UI's partial texture uploads use them
 * (`render/babylon/ui.ts`, ADR 0075 notes).
 */

/** A rectangle of a texture, in its pixels from the top-left. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The whole pixels a redraw touched: Babylon GUI's invalidated rectangle (fractional, and
 * possibly past the edges) grown by a pixel for antialiasing and clamped to the texture. Null when
 * nothing of it is on the texture.
 */
export function redrawnPixels(r: { left: number; top: number; width: number; height: number }, width: number, height: number): PixelRect | null {
  const x = Math.max(0, Math.floor(r.left) - 1), y = Math.max(0, Math.floor(r.top) - 1);
  const w = Math.min(width, Math.ceil(r.left + r.width) + 1) - x, h = Math.min(height, Math.ceil(r.top + r.height) + 1) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

/** `rows` rows of RGBA pixels, `rowBytes` each, in reverse order, into `into` (grown as needed). */
export function flipRows(pixels: Uint8ClampedArray | Uint8Array, rowBytes: number, rows: number, into: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = into.length >= rows * rowBytes ? into : new Uint8Array(rows * rowBytes);
  for (let j = 0; j < rows; j++) out.set(pixels.subarray(j * rowBytes, (j + 1) * rowBytes), (rows - 1 - j) * rowBytes);
  return out;
}
