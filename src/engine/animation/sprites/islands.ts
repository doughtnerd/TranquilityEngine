/**
 * Islands of opaque pixels (ADR 0040, 0371): the shared maths of the Sprite Editor's automatic slicing (each island's
 * bounding box) and of 2D skin meshes (each island's outline, `outline.ts`). Pixels are RGBA rows from the image's
 * top-left, as the canvas API gives them; a pixel is opaque when its alpha is above the threshold, and pixels touching
 * diagonally belong to one island.
 *
 * Pure; no DOM. Internal: not public API.
 */

/** @internal `[x, y, width, height]` in whole pixels from the image's top-left corner, as sidecars store slices. */
export type PixelRect = [number, number, number, number];

/** @internal Pixels as the canvas API gives them: RGBA, 4 bytes per pixel, row by row from the top. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** @internal The islands of a region: a label per pixel of the region (0: transparent, else island number) and each island's box. */
export interface Islands {
  /** The region searched, in image pixels. */
  readonly region: PixelRect;
  /** Row by row over the region: 0 for a transparent pixel, else `1 + ` the island's index. */
  readonly labels: Int32Array;
  /** Each island's bounding box, in image pixels, in the order found (top to bottom, then left to right by first pixel). */
  readonly boxes: readonly PixelRect[];
  /** Each island's opaque pixel count. */
  readonly areas: readonly number[];
}

/** @internal The islands of pixels with alpha above `threshold` inside `region` (default: the whole image), 8-connected. */
export function alphaIslands(pixels: Pixels, threshold = 0, region: PixelRect = [0, 0, pixels.width, pixels.height]): Islands {
  const x0 = Math.max(0, Math.floor(region[0])), y0 = Math.max(0, Math.floor(region[1]));
  const x1 = Math.min(pixels.width, Math.floor(region[0] + region[2])), y1 = Math.min(pixels.height, Math.floor(region[1] + region[3]));
  const W = Math.max(0, x1 - x0), H = Math.max(0, y1 - y0);
  const labels = new Int32Array(W * H);
  const opaque = (x: number, y: number) => pixels.data[((y0 + y) * pixels.width + x0 + x) * 4 + 3] > threshold;
  const boxes: PixelRect[] = [];
  const areas: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (labels[start] || !opaque(start % W, (start - (start % W)) / W)) continue;
    const label = boxes.length + 1;
    let bx0 = W, by0 = H, bx1 = -1, by1 = -1, area = 0;
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % W, y = (i - x) / W;
      area++;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const j = ny * W + nx;
          if (labels[j] || !opaque(nx, ny)) continue;
          labels[j] = label;
          stack.push(j);
        }
      }
    }
    boxes.push([x0 + bx0, y0 + by0, bx1 - bx0 + 1, by1 - by0 + 1]);
    areas.push(area);
  }
  return { region: [x0, y0, W, H], labels, boxes, areas };
}
