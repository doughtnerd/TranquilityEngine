/**
 * CSS filters worked out on pixels (ADR 0426): the drawing layer's fallback where the browser's Canvas2D has no
 * `filter` (it draws the filtered subtree to an offscreen canvas, runs this on its pixels and draws the result). A pure,
 * renderer-neutral library function over ImageData-shaped data (unpremultiplied RGBA bytes, row by row).
 *
 * Colour functions use the matrices and transfer functions of Filter Effects 1 (§ Shorthands), on sRGB values as
 * browsers apply them. `blur` is approximated, as the spec allows, by three box blurs a pass across and a pass down
 * (on premultiplied colour, so edges don't darken); `drop-shadow` is the alpha blurred the same way, coloured, offset,
 * and drawn under the image.
 */
import type { UIFilterStep } from "../ui/filters";

/** What `getImageData` returns, in the parts used. */
export interface FilterImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

function colourMatrix(step: UIFilterStep): Matrix3 | null {
  switch (step.kind) {
    case "grayscale": {
      const a = 1 - Math.min(1, step.amount);
      return [0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a, 0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a, 0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a];
    }
    case "sepia": {
      const a = 1 - Math.min(1, step.amount);
      return [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a];
    }
    case "saturate": {
      const s = step.amount;
      return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
    }
    case "hue-rotate": {
      const r = (step.degrees * Math.PI) / 180;
      const c = Math.cos(r), s = Math.sin(r);
      return [
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
      ];
    }
  }
  return null;
}

/** Per-channel colour transfer `c' = slope · c + intercept` (brightness, contrast, invert), or null. */
function transfer(step: UIFilterStep): [number, number] | null {
  switch (step.kind) {
    case "brightness":
      return [step.amount, 0];
    case "contrast":
      return [step.amount, 0.5 - 0.5 * step.amount];
    case "invert": {
      const a = Math.min(1, step.amount);
      return [1 - 2 * a, a];
    }
  }
  return null;
}

/** Box sizes approximating a Gaussian of standard deviation `sigma` with three passes (odd, at least 1). */
function boxSize(sigma: number): number {
  const d = Math.floor((sigma * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5);
  return d % 2 === 0 ? d + 1 : d;
}

/** One centred box blur of `channels` interleaved floats along rows (`horizontal`) or columns, edges transparent. */
function boxPass(src: Float32Array, dst: Float32Array, width: number, height: number, channels: number, size: number, horizontal: boolean): void {
  const r = (size - 1) / 2;
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const stride = horizontal ? channels : width * channels;
  const lineStep = horizontal ? width * channels : channels;
  const sums = new Float64Array(channels);
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    sums.fill(0);
    for (let i = -r; i <= r; i++) if (i >= 0 && i < length) for (let k = 0; k < channels; k++) sums[k] += src[base + i * stride + k];
    for (let i = 0; i < length; i++) {
      for (let k = 0; k < channels; k++) dst[base + i * stride + k] = sums[k] / size;
      const out = i - r, inn = i + r + 1;
      for (let k = 0; k < channels; k++) {
        if (out >= 0 && out < length) sums[k] -= src[base + out * stride + k];
        if (inn >= 0 && inn < length) sums[k] += src[base + inn * stride + k];
      }
    }
  }
}

/** Three box blurs across and down, in place. */
function gaussian(buf: Float32Array, width: number, height: number, channels: number, sigma: number): void {
  if (sigma <= 0) return;
  const size = boxSize(sigma);
  if (size <= 1) return;
  const tmp = new Float32Array(buf.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(buf, tmp, width, height, channels, size, true);
    boxPass(tmp, buf, width, height, channels, size, false);
  }
}

/** Filters `image`'s pixels in place with the steps in order (lengths in its pixels). */
export function filterPixels(image: FilterImage, steps: readonly UIFilterStep[]): void {
  const { data, width, height } = image;
  const n = width * height;
  if (!steps.length || n === 0) return;
  // Unpremultiplied floats 0–1.
  const px = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) px[i] = data[i] / 255;
  for (const step of steps) {
    const m = colourMatrix(step);
    const t = transfer(step);
    if (m) {
      for (let i = 0; i < n * 4; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        px[i] = m[0] * r + m[1] * g + m[2] * b;
        px[i + 1] = m[3] * r + m[4] * g + m[5] * b;
        px[i + 2] = m[6] * r + m[7] * g + m[8] * b;
      }
    } else if (t) {
      for (let i = 0; i < n * 4; i += 4) for (let k = 0; k < 3; k++) px[i + k] = t[0] * px[i + k] + t[1];
    } else if (step.kind === "opacity") {
      const a = Math.min(1, step.amount);
      for (let i = 3; i < n * 4; i += 4) px[i] *= a;
    } else if (step.kind === "blur") {
      for (let i = 0; i < n * 4; i += 4) for (let k = 0; k < 3; k++) px[i + k] *= px[i + 3];
      gaussian(px, width, height, 4, step.radius);
      for (let i = 0; i < n * 4; i += 4) {
        const a = px[i + 3];
        for (let k = 0; k < 3; k++) px[i + k] = a > 1e-6 ? px[i + k] / a : 0;
      }
    } else if (step.kind === "drop-shadow") {
      const alpha = new Float32Array(n);
      for (let i = 0; i < n; i++) alpha[i] = px[i * 4 + 3];
      gaussian(alpha, width, height, 1, step.blur);
      const dx = Math.round(step.x), dy = Math.round(step.y);
      const { r: cr, g: cg, b: cb, a: ca } = step.color;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sx = x - dx, sy = y - dy;
          const sa = sx >= 0 && sx < width && sy >= 0 && sy < height ? alpha[sy * width + sx] * ca : 0;
          const i = (y * width + x) * 4;
          // The image over its shadow.
          const a = px[i + 3];
          const outA = a + sa * (1 - a);
          if (outA <= 1e-6) {
            px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
            continue;
          }
          px[i] = (px[i] * a + cr * sa * (1 - a)) / outA;
          px[i + 1] = (px[i + 1] * a + cg * sa * (1 - a)) / outA;
          px[i + 2] = (px[i + 2] * a + cb * sa * (1 - a)) / outA;
          px[i + 3] = outA;
        }
      }
    }
    // Values clamp between steps, as each function's result is a colour.
    for (let i = 0; i < n * 4; i++) px[i] = px[i] < 0 ? 0 : px[i] > 1 ? 1 : px[i];
  }
  for (let i = 0; i < n * 4; i++) data[i] = Math.round(px[i] * 255);
}
