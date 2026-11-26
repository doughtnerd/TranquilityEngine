/**
 * SVG geometry for inline SVG in UI (ADR 0426): shapes as path commands, a path's length and the point at a length
 * (`getTotalLength()`/`getPointAtLength()`, which Svelte's `draw` transition reads), shapes flattened for hit-testing
 * (`pointer-events` on shapes), SVG `transform` attributes and the `viewBox` map. Pure and renderer-neutral: the
 * drawing itself is the browser's (the subtree is rasterised as an SVG image). Not public API.
 *
 * Lengths are SVG 2's: the arc length of each command, lines exactly, Bézier curves and elliptical arcs by 16-point
 * Gauss–Legendre quadrature (a curve is split until each piece's estimate settles), in the shape's user units.
 */
import { multiply, type UIAffine } from "../transform2d";

/** An absolute path command: move, line, cubic Bézier, quadratic Bézier, elliptical arc (endpoint form), close. */
export type SvgCommand =
  | { readonly c: "M"; readonly x: number; readonly y: number }
  | { readonly c: "L"; readonly x: number; readonly y: number }
  | { readonly c: "C"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number }
  | { readonly c: "Q"; readonly x1: number; readonly y1: number; readonly x: number; readonly y: number }
  | { readonly c: "A"; readonly rx: number; readonly ry: number; readonly rotation: number; readonly large: boolean; readonly sweep: boolean; readonly x: number; readonly y: number }
  | { readonly c: "Z" };

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Path data (`d`) as absolute commands; reading stops at the first error, keeping what came before (as SVG renders it). */
export function parsePathData(d: string): SvgCommand[] {
  const out: SvgCommand[] = [];
  let i = 0;
  const n = d.length;
  const skip = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const number = (): number | null => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return null;
    i = NUM.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = (): boolean | null => {
    skip();
    if (d[i] === "0" || d[i] === "1") return d[i++] === "1";
    return null;
  };
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC: [number, number] | null = null, lastQ: [number, number] | null = null;
  let cmd = "";
  for (;;) {
    skip();
    if (i >= n) break;
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    else if (!cmd || cmd === "Z" || cmd === "z") break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    const pair = (): [number, number] | null => {
      const x = number();
      if (x === null) return null;
      const y = number();
      return y === null ? null : [x + ox, y + oy];
    };
    if (C === "Z") {
      out.push({ c: "Z" });
      cx = sx;
      cy = sy;
      lastC = lastQ = null;
      continue;
    }
    if (C === "M" || C === "L" || C === "T") {
      const p = pair();
      if (!p) break;
      if (C === "M") {
        out.push({ c: "M", x: p[0], y: p[1] });
        sx = p[0];
        sy = p[1];
        cmd = rel ? "l" : "L"; // more pairs after a move are lines
        lastC = lastQ = null;
      } else if (C === "L") {
        out.push({ c: "L", x: p[0], y: p[1] });
        lastC = lastQ = null;
      } else {
        const q: [number, number] = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
        out.push({ c: "Q", x1: q[0], y1: q[1], x: p[0], y: p[1] });
        lastQ = q;
        lastC = null;
      }
      [cx, cy] = p;
    } else if (C === "H" || C === "V") {
      const v = number();
      if (v === null) break;
      if (C === "H") cx = v + (rel ? cx : 0);
      else cy = v + (rel ? cy : 0);
      out.push({ c: "L", x: cx, y: cy });
      lastC = lastQ = null;
    } else if (C === "C" || C === "S") {
      const c1: [number, number] | null = C === "C" ? pair() : lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
      if (!c1) break;
      const c2 = pair();
      const p = c2 && pair();
      if (!c2 || !p) break;
      out.push({ c: "C", x1: c1[0], y1: c1[1], x2: c2[0], y2: c2[1], x: p[0], y: p[1] });
      lastC = c2;
      lastQ = null;
      [cx, cy] = p;
    } else if (C === "Q") {
      const c1 = pair();
      const p = c1 && pair();
      if (!c1 || !p) break;
      out.push({ c: "Q", x1: c1[0], y1: c1[1], x: p[0], y: p[1] });
      lastQ = c1;
      lastC = null;
      [cx, cy] = p;
    } else if (C === "A") {
      const rx = number(), ry = number(), rot = number();
      const large = flag(), sweep = flag();
      const p = rx !== null && ry !== null && rot !== null && large !== null && sweep !== null ? pair() : null;
      if (!p) break;
      out.push({ c: "A", rx: Math.abs(rx!), ry: Math.abs(ry!), rotation: rot!, large: large!, sweep: sweep!, x: p[0], y: p[1] });
      lastC = lastQ = null;
      [cx, cy] = p;
    } else break;
  }
  return out;
}

/** A number attribute (lengths in user units; `px` allowed), or `fallback`. */
function num(v: string | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** A points list (`polyline`, `polygon`). */
function points(v: string | null): [number, number][] {
  const ns = (v ?? "").split(/[\s,]+/).filter((s) => s !== "").map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ns.length; i += 2) if (Number.isFinite(ns[i]) && Number.isFinite(ns[i + 1])) out.push([ns[i], ns[i + 1]]);
  return out;
}

/** The SVG shape tags with geometry. */
export const SVG_GEOMETRY_TAGS: ReadonlySet<string> = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

/** A shape element's geometry as path commands, as SVG 2 defines each shape's equivalent path. Empty for other tags. */
export function shapePath(tag: string, attr: (name: string) => string | null): SvgCommand[] {
  switch (tag.toLowerCase()) {
    case "path":
      return parsePathData(attr("d") ?? "");
    case "rect": {
      const x = num(attr("x")), y = num(attr("y")), w = num(attr("width")), h = num(attr("height"));
      if (w <= 0 || h <= 0) return [];
      let rx = attr("rx") !== null ? num(attr("rx")) : NaN, ry = attr("ry") !== null ? num(attr("ry")) : NaN;
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(0, rx), w / 2);
      ry = Math.min(Math.max(0, ry), h / 2);
      if (rx === 0 || ry === 0) return [{ c: "M", x, y }, { c: "L", x: x + w, y }, { c: "L", x: x + w, y: y + h }, { c: "L", x, y: y + h }, { c: "Z" }];
      const a = (ex: number, ey: number): SvgCommand => ({ c: "A", rx, ry, rotation: 0, large: false, sweep: true, x: ex, y: ey });
      return [
        { c: "M", x: x + rx, y }, { c: "L", x: x + w - rx, y }, a(x + w, y + ry), { c: "L", x: x + w, y: y + h - ry }, a(x + w - rx, y + h),
        { c: "L", x: x + rx, y: y + h }, a(x, y + h - ry), { c: "L", x, y: y + ry }, a(x + rx, y), { c: "Z" },
      ];
    }
    case "circle":
    case "ellipse": {
      const cx = num(attr("cx")), cy = num(attr("cy"));
      const rx = tag.toLowerCase() === "circle" ? num(attr("r")) : num(attr("rx")), ry = tag.toLowerCase() === "circle" ? rx : num(attr("ry"));
      if (rx <= 0 || ry <= 0) return [];
      const a = (ex: number, ey: number): SvgCommand => ({ c: "A", rx, ry, rotation: 0, large: false, sweep: true, x: ex, y: ey });
      // From the rightmost point, clockwise in four quarters (SVG 2's equivalent path for circle and ellipse).
      return [{ c: "M", x: cx + rx, y: cy }, a(cx, cy + ry), a(cx - rx, cy), a(cx, cy - ry), a(cx + rx, cy), { c: "Z" }];
    }
    case "line":
      return [{ c: "M", x: num(attr("x1")), y: num(attr("y1")) }, { c: "L", x: num(attr("x2")), y: num(attr("y2")) }];
    case "polyline":
    case "polygon": {
      const ps = points(attr("points"));
      if (!ps.length) return [];
      const out: SvgCommand[] = ps.map(([x, y], i) => ({ c: i ? "L" : "M", x, y }) as SvgCommand);
      if (tag.toLowerCase() === "polygon") out.push({ c: "Z" });
      return out;
    }
  }
  return [];
}

// --- Lengths --------------------------------------------------------------------------------------

/** 16-point Gauss–Legendre abscissae and weights on [-1, 1] (positive half). */
const GL_X = [0.0950125098376374, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438, 0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
const GL_W = [0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767, 0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541];

/** ∫ speed(t) dt over [a, b] by 16-point Gauss–Legendre. */
function gauss(speed: (t: number) => number, a: number, b: number): number {
  const h = (b - a) / 2, m = (a + b) / 2;
  let s = 0;
  for (let i = 0; i < 8; i++) s += GL_W[i] * (speed(m - h * GL_X[i]) + speed(m + h * GL_X[i]));
  return s * h;
}

/** ∫ over [a, b], halving until the halves agree with the whole (smooth curves settle at once). */
function integrate(speed: (t: number) => number, a: number, b: number, depth = 0): number {
  const whole = gauss(speed, a, b);
  if (depth >= 6) return whole;
  const mid = (a + b) / 2;
  const left = gauss(speed, a, mid), right = gauss(speed, mid, b);
  if (Math.abs(left + right - whole) <= 1e-9 * Math.max(1, Math.abs(whole))) return left + right;
  return integrate(speed, a, mid, depth + 1) + integrate(speed, mid, b, depth + 1);
}

/** A drawable segment: its point at t ∈ [0, 1] and its speed |dP/dt|. */
interface Segment {
  at(t: number): [number, number];
  speed(t: number): number;
  readonly length: number;
}

/** An endpoint arc in centre form (SVG 2 Appendix B.2.4), or null when it's a straight line (a zero radius). */
function arcCentre(x1: number, y1: number, a: Extract<SvgCommand, { c: "A" }>): { cx: number; cy: number; rx: number; ry: number; phi: number; t1: number; dt: number } | null {
  let { rx, ry } = a;
  const { x: x2, y: y2 } = a;
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return null;
  const phi = (a.rotation * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = Math.sqrt(Math.max(0, num / den));
  if (a.large === a.sweep) k = -k;
  const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!a.sweep && dt > 0) dt -= 2 * Math.PI;
  else if (a.sweep && dt < 0) dt += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, t1, dt };
}

function line(x0: number, y0: number, x1: number, y1: number): Segment {
  const len = Math.hypot(x1 - x0, y1 - y0);
  return { at: (t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], speed: () => len, length: len };
}

/** A subpath's segments, and whether a close ended it. */
interface Subpath extends Array<Segment> {
  closed?: boolean;
}

/** The commands as segments (moves start subpaths; a close is a line back to the subpath's start). */
function segmentsOf(cmds: readonly SvgCommand[]): Subpath[] {
  const paths: Subpath[] = [];
  let cur: Subpath = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  const push = (s: Segment) => cur.push(s);
  for (const c of cmds) {
    switch (c.c) {
      case "M":
        if (cur.length) paths.push(cur);
        cur = [];
        x = sx = c.x;
        y = sy = c.y;
        break;
      case "L":
        push(line(x, y, c.x, c.y));
        x = c.x;
        y = c.y;
        break;
      case "Z":
        push(line(x, y, sx, sy));
        x = sx;
        y = sy;
        cur.closed = true;
        paths.push(cur);
        cur = [];
        break;
      case "C": {
        const [x0, y0] = [x, y];
        const at = (t: number): [number, number] => {
          const u = 1 - t;
          return [u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y];
        };
        const speed = (t: number) => {
          const u = 1 - t;
          const dx = 3 * u * u * (c.x1 - x0) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (c.x - c.x2);
          const dy = 3 * u * u * (c.y1 - y0) + 6 * u * t * (c.y2 - c.y1) + 3 * t * t * (c.y - c.y2);
          return Math.hypot(dx, dy);
        };
        push({ at, speed, length: integrate(speed, 0, 1) });
        x = c.x;
        y = c.y;
        break;
      }
      case "Q": {
        const [x0, y0] = [x, y];
        const at = (t: number): [number, number] => {
          const u = 1 - t;
          return [u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y];
        };
        const speed = (t: number) => Math.hypot(2 * (1 - t) * (c.x1 - x0) + 2 * t * (c.x - c.x1), 2 * (1 - t) * (c.y1 - y0) + 2 * t * (c.y - c.y1));
        push({ at, speed, length: integrate(speed, 0, 1) });
        x = c.x;
        y = c.y;
        break;
      }
      case "A": {
        const e = arcCentre(x, y, c);
        if (!e) push(line(x, y, c.x, c.y));
        else {
          const cos = Math.cos(e.phi), sin = Math.sin(e.phi);
          const at = (t: number): [number, number] => {
            const th = e.t1 + e.dt * t;
            const px = e.rx * Math.cos(th), py = e.ry * Math.sin(th);
            return [e.cx + cos * px - sin * py, e.cy + sin * px + cos * py];
          };
          const speed = (t: number) => {
            const th = e.t1 + e.dt * t;
            return Math.abs(e.dt) * Math.hypot(e.rx * Math.sin(th), e.ry * Math.cos(th));
          };
          push({ at, speed, length: integrate(speed, 0, 1) });
        }
        x = c.x;
        y = c.y;
        break;
      }
    }
  }
  if (cur.length) paths.push(cur);
  return paths;
}

/** A path's total length (`getTotalLength()`), in its user units. */
export function pathLength(cmds: readonly SvgCommand[]): number {
  let total = 0;
  for (const p of segmentsOf(cmds)) for (const s of p) total += s.length;
  return total;
}

/** The point `distance` along the path (`getPointAtLength()`), clamped to its ends; the origin for an empty path. */
export function pointAtLength(cmds: readonly SvgCommand[], distance: number): { x: number; y: number } {
  const paths = segmentsOf(cmds);
  const all = paths.flat();
  if (!all.length) {
    const m = cmds.find((c) => c.c === "M") as { x: number; y: number } | undefined;
    return { x: m?.x ?? 0, y: m?.y ?? 0 };
  }
  let left = Math.max(0, distance);
  for (const s of all) {
    if (left <= s.length || s === all[all.length - 1]) {
      if (s.length <= 0) {
        const [x, y] = s.at(0);
        return { x, y };
      }
      const want = Math.min(left, s.length);
      if (want >= s.length) {
        const [x, y] = s.at(1);
        return { x, y };
      }
      // The parameter whose arc length from 0 is `want`: bisection on the integral.
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (integrate(s.speed, 0, mid, 4) < want) lo = mid;
        else hi = mid;
      }
      const [x, y] = s.at((lo + hi) / 2);
      return { x, y };
    }
    left -= s.length;
  }
  const [x, y] = all[all.length - 1].at(1);
  return { x, y };
}

// --- Hit-testing ----------------------------------------------------------------------------------

/** The path flattened into polylines (one per subpath, closed ones marked), each curve in `steps` straight pieces. */
export function flattenPath(cmds: readonly SvgCommand[], steps = 24): { points: [number, number][]; closed: boolean }[] {
  return segmentsOf(cmds).map((p) => {
    const pts: [number, number][] = [];
    for (const seg of p) {
      if (!pts.length) pts.push(seg.at(0));
      // Straight pieces once; curves (whose speed varies, or arcs) in `steps`.
      const curved = seg.speed(0) !== seg.speed(0.37) || seg.speed(0.37) !== seg.speed(0.81) || Math.hypot(seg.at(0.5)[0] - (seg.at(0)[0] + seg.at(1)[0]) / 2, seg.at(0.5)[1] - (seg.at(0)[1] + seg.at(1)[1]) / 2) > 1e-9;
      const n = curved ? steps : 1;
      for (let i = 1; i <= n; i++) pts.push(seg.at(i / n));
    }
    return { points: pts, closed: !!p.closed };
  });
}

/** Whether (x, y) is inside the filled shape, by `fill-rule` (`nonzero`, the default, or `evenodd`); every subpath counts as closed. */
export function insideFill(polys: readonly { points: readonly (readonly [number, number])[] }[], x: number, y: number, rule: "nonzero" | "evenodd" = "nonzero"): boolean {
  let winding = 0, crossings = 0;
  for (const { points: pts } of polys) {
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      if (y0 <= y ? y1 > y : y1 <= y) {
        const xi = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
        if (xi > x) {
          crossings++;
          winding += y1 > y0 ? 1 : -1;
        }
      }
    }
  }
  return rule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
}

/** The distance from (x, y) to the nearest point of the outline (closed subpaths include their closing edge). */
export function distanceToOutline(polys: readonly { points: readonly (readonly [number, number])[]; closed: boolean }[], x: number, y: number): number {
  let best = Infinity;
  for (const { points: pts, closed } of polys) {
    const n = closed ? pts.length : pts.length - 1;
    if (pts.length === 1) best = Math.min(best, Math.hypot(x - pts[0][0], y - pts[0][1]));
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)));
    }
  }
  return best;
}

// --- Transforms and the viewBox ---------------------------------------------------------------------

/** An SVG `transform` attribute's list (`translate`, `scale`, `rotate(a [cx cy])`, `skewX`, `skewY`, `matrix`, unitless) as one map. */
export function parseSvgTransform(text: string | null | undefined): UIAffine | null {
  if (!text) return null;
  let m: UIAffine = [1, 0, 0, 1, 0, 0];
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let any = false;
  for (let r = re.exec(text); r; r = re.exec(text)) {
    const a = r[2].split(/[\s,]+/).filter((s) => s !== "").map(Number);
    if (a.some((v) => !Number.isFinite(v))) return null;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    let step: UIAffine | null = null;
    switch (r[1]) {
      case "translate":
        step = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        step = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const c = Math.cos(rad(a[0] ?? 0)), s = Math.sin(rad(a[0] ?? 0));
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        step = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
        break;
      }
      case "skewX":
        step = [1, 0, Math.tan(rad(a[0] ?? 0)), 1, 0, 0];
        break;
      case "skewY":
        step = [1, Math.tan(rad(a[0] ?? 0)), 0, 1, 0, 0];
        break;
      case "matrix":
        if (a.length === 6) step = a as unknown as UIAffine;
        break;
    }
    if (!step) return null;
    m = multiply(m, step);
    any = true;
  }
  return any ? m : null;
}

/**
 * The map from an `<svg>`'s user units to its box (`width × height` pixels from its top-left): its `viewBox` fitted by
 * `preserveAspectRatio` (`xMidYMid meet` by default, `none`, and the nine alignments with `meet` or `slice`). The
 * identity without a usable `viewBox`.
 */
export function viewBoxMap(viewBox: string | null | undefined, preserve: string | null | undefined, width: number, height: number): UIAffine {
  const vb = (viewBox ?? "").split(/[\s,]+/).filter((s) => s !== "").map(Number);
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v)) || vb[2] <= 0 || vb[3] <= 0) return [1, 0, 0, 1, 0, 0];
  const [vx, vy, vw, vh] = vb;
  const [align = "xMidYMid", mode = "meet"] = (preserve ?? "").trim().split(/\s+/).filter(Boolean);
  let sx = width / vw, sy = height / vh;
  if (align === "none") return [sx, 0, 0, sy, 0 - vx * sx, 0 - vy * sy];
  const s = mode === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
  sx = sy = s;
  const fx = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
  const fy = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
  return [s, 0, 0, s, (width - vw * s) * fx - vx * s + 0, (height - vh * s) * fy - vy * s + 0];
}
