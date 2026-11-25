/**
 * Image-to-polygon tracing (ADR 0414): the outlines of the pixels whose alpha is above a threshold, simplified. A
 * generic library function: the Sprite Editor's Generate Outline calls it on a slice, and slice outlines feed 2D shadow
 * casters (ADR 0413). Nothing traces at run time: outlines are authored data in the sidecar.
 *
 * The trace walks pixel edges (each solid pixel's side that faces a clear pixel or the rect's edge), chains them into
 * closed loops with the solid on the left (counter-clockwise, y up), drops holes (clockwise loops), and simplifies each
 * loop with Douglas–Peucker at `tolerance` pixels. Coordinates are slice pixels from the rect's bottom-left, y up.
 */

/** An image's alpha: one byte per pixel, row-major from the top-left (as `ImageData`'s every fourth byte). */
export interface AlphaImage {
  width: number;
  height: number;
  alpha: Uint8Array | Uint8ClampedArray;
}

export interface TraceOptions {
  /** Pixels with alpha above this (0–255) are solid. Default 0 (any alpha). */
  threshold?: number;
  /** How far (pixels) the simplified outline may stray from the traced one. Default 1. */
  tolerance?: number;
  /** Loops with less area (pixels²) are dropped. Default 4. */
  minArea?: number;
}

type P = [number, number];

/** The outlines of `rect` (`[x, y, width, height]` in pixels from the image's top-left; default the whole image). */
export function traceOutline(image: AlphaImage, rect: readonly [number, number, number, number] = [0, 0, image.width, image.height], options: TraceOptions = {}): P[][] {
  const threshold = options.threshold ?? 0, tolerance = Math.max(options.tolerance ?? 1, 0), minArea = options.minArea ?? 4;
  const [rx, ry, rw, rh] = rect.map((v) => Math.round(v)) as [number, number, number, number];
  const w = Math.max(0, Math.min(rw, image.width - rx)), h = Math.max(0, Math.min(rh, image.height - ry));
  // solid(i, j): pixel column i, row j counted from the rect's bottom (y up).
  const solid = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && image.alpha[(ry + (h - 1 - j)) * image.width + rx + i]! > threshold;
  const key = (x: number, y: number) => y * (w + 1) + x;
  const next = new Map<number, number[]>(); // start vertex → end vertices
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay);
    const list = next.get(k);
    if (list) list.push(key(bx, by));
    else next.set(k, [key(bx, by)]);
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!solid(i, j)) continue;
      if (!solid(i, j - 1)) add(i, j, i + 1, j);
      if (!solid(i + 1, j)) add(i + 1, j, i + 1, j + 1);
      if (!solid(i, j + 1)) add(i + 1, j + 1, i, j + 1);
      if (!solid(i - 1, j)) add(i, j + 1, i, j);
    }
  }
  const loops: P[][] = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop: P[] = [];
      let at = start;
      for (let guard = 0; guard <= 4 * (w + 1) * (h + 1); guard++) {
        loop.push([at % (w + 1), Math.floor(at / (w + 1))]);
        const outs = next.get(at);
        if (!outs || outs.length === 0) break;
        at = outs.shift()!;
        if (at === start) break;
      }
      const clean = dropCollinear(loop);
      if (clean.length >= 3 && area(clean) >= minArea) loops.push(clean);
    }
  }
  return loops.map((l) => simplifyLoop(l, tolerance)).filter((l) => l.length >= 3);
}

/** Twice the signed area: positive counter-clockwise. Holes (clockwise) come out negative and are dropped by `minArea`. */
function area(p: readonly P[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
  return a / 2;
}

function dropCollinear(p: P[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i + p.length - 1) % p.length]!, b = p[i]!, c = p[(i + 1) % p.length]!;
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

/** Douglas–Peucker on a closed loop: split at the two points farthest apart, simplify each half. */
export function simplifyLoop(loop: readonly P[], tolerance: number): P[] {
  if (loop.length <= 3 || tolerance <= 0) return [...loop];
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < loop.length; i++) {
    const d = (loop[i]![0] - loop[0]![0]) ** 2 + (loop[i]![1] - loop[0]![1]) ** 2;
    if (d > best) [best, b] = [d, i];
  }
  best = -1;
  for (let i = 0; i < loop.length; i++) {
    const d = (loop[i]![0] - loop[b]![0]) ** 2 + (loop[i]![1] - loop[b]![1]) ** 2;
    if (d > best) [best, a] = [d, i];
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const first = loop.slice(lo, hi + 1);
  const second = [...loop.slice(hi), ...loop.slice(0, lo + 1)];
  const out = [...simplifyChain(first, tolerance).slice(0, -1), ...simplifyChain(second, tolerance).slice(0, -1)];
  return out.length >= 3 ? out : [...loop];
}

function simplifyChain(chain: readonly P[], tolerance: number): P[] {
  if (chain.length <= 2) return [...chain];
  const [ax, ay] = chain[0]!, [bx, by] = chain[chain.length - 1]!;
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  let far = 0, at = 0;
  for (let i = 1; i < chain.length - 1; i++) {
    const [px, py] = chain[i]!;
    const d = len > 0 ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
    if (d > far) [far, at] = [d, i];
  }
  if (far <= tolerance) return [chain[0]!, chain[chain.length - 1]!];
  return [...simplifyChain(chain.slice(0, at + 1), tolerance).slice(0, -1), ...simplifyChain(chain.slice(at), tolerance)];
}
