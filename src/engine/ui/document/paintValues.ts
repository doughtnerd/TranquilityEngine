/**
 * Paint values of UI stylesheets (ADR 0422 wave 2): shadows (`box-shadow`, `text-shadow`), background images
 * (`url()`, `linear-gradient()`, `radial-gradient()`) and corner radii (`border-radius` with one to four values),
 * parsed from CSS text, and the geometry a gradient is drawn with. The cascade (`stylesheet.ts`) expands and checks
 * them; the Babylon GUI drawing parses a script-written `backgroundImage` with the same functions. Pure and
 * renderer-neutral: a value that can't be read comes back as a message saying why, never a throw.
 */
import { Color } from "../../core/math";
import { parseColor } from "./cssColor";

/** One shadow: offsets and blur in UI pixels, and its colour (null: no shadow). */
export interface UIShadowValue {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blur: number;
  readonly color: Color | null;
}

/** A gradient's colour stop: `offset` 0..1 along the gradient line (or out from the centre). */
export interface UIColorStop {
  readonly color: Color;
  readonly offset: number;
}

/**
 * A parsed `backgroundImage`: nothing, a texture (`url()`), a linear gradient at a CSS angle (degrees clockwise
 * from "to top", so 180 runs top to bottom), or a radial gradient (a circle at the centre reaching the corners).
 */
export type UIBackgroundImage =
  | { readonly kind: "none" }
  | { readonly kind: "url"; readonly path: string }
  | { readonly kind: "linear-gradient"; readonly angle: number; readonly stops: readonly UIColorStop[] }
  | { readonly kind: "radial-gradient"; readonly stops: readonly UIColorStop[] };

/** Corner radii in CSS order: top-left, top-right, bottom-right, bottom-left. */
export type UICornerRadii = readonly [number, number, number, number];

/** A parse result: the value, or a message saying what's wrong with it. */
export type PaintParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const ok = <T>(value: T): PaintParse<T> => ({ ok: true, value });
const fail = <T>(problem: string): PaintParse<T> => ({ ok: false, problem });

/** Splits on `sep` (a comma, or whitespace for " ") outside parentheses and quotes. */
export function splitTopLevel(value: string, sep: "," | " "): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (sep === "," ? ch === "," : /\s/.test(ch))) {
      if (sep === "," || cur !== "") out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (sep === "," || cur.trim() !== "") out.push(cur.trim());
  return out;
}

function length(token: string): number | undefined {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px)?$/i.exec(token);
  return m ? parseFloat(m[1]) : undefined;
}

/**
 * One shadow, `offset-x offset-y [blur] [colour]` (the colour first or last; black when left out), or `none`.
 * `inset`, a spread and several shadows aren't supported (ADR 0422).
 */
export function parseShadow(raw: string): PaintParse<UIShadowValue> {
  const v = raw.trim();
  if (v.toLowerCase() === "none") return ok({ offsetX: 0, offsetY: 0, blur: 0, color: null });
  if (splitTopLevel(v, ",").length > 1) return fail("takes one shadow; several shadows aren't supported.");
  const lengths: number[] = [];
  let color: Color | undefined;
  let colorLast = false; // the colour came after lengths: nothing may follow it
  for (const token of splitTopLevel(v, " ")) {
    if (token.toLowerCase() === "inset") return fail("inset shadows aren't supported.");
    const n = length(token);
    if (n !== undefined) {
      if (colorLast) return fail("the colour goes before or after the lengths, not between them.");
      lengths.push(n);
      continue;
    }
    const c = parseColor(token);
    if (!c || color) return fail(`"${token}" isn't a length or a colour.`);
    color = c;
    colorLast = lengths.length > 0;
  }
  if (lengths.length < 2) return fail("needs an x and a y offset (offset-x offset-y blur colour).");
  if (lengths.length > 3) return fail("a spread isn't supported; it takes offset-x offset-y blur colour.");
  const blur = lengths[2] ?? 0;
  if (blur < 0) return fail("the blur can't be negative.");
  return ok({ offsetX: lengths[0], offsetY: lengths[1], blur, color: color ?? new Color(0, 0, 0, 1) });
}

/** `border-radius` with one to four lengths (CSS order: top-left, top-right, bottom-right, bottom-left). */
export function parseCornerRadii(raw: string): PaintParse<UICornerRadii> {
  const v = raw.trim();
  if (v.includes("/")) return fail("elliptical corners (with /) aren't supported.");
  const tokens = splitTopLevel(v, " ");
  if (tokens.length < 1 || tokens.length > 4) return fail("takes one to four lengths.");
  const n = tokens.map(length);
  if (n.some((x) => x === undefined || x < 0)) return fail("takes lengths in pixels, not negative.");
  const [a, b = a, c = a, d = b] = n as number[];
  return ok([a, b, c, d]);
}

const SIDE_ANGLES: Readonly<Record<string, number>> = { top: 0, right: 90, bottom: 180, left: 270 };

function angle(token: string): number | undefined {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)$/i.exec(token.trim());
  if (!m) return token.trim() === "0" ? 0 : undefined;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case "turn":
      return n * 360;
    case "rad":
      return (n * 180) / Math.PI;
    case "grad":
      return n * 0.9;
    default:
      return n;
  }
}

function colorStops(args: readonly string[]): PaintParse<UIColorStop[]> {
  if (args.length < 2) return fail("a gradient needs at least two colour stops.");
  const raw: { color: Color; offset: number | null }[] = [];
  for (const arg of args) {
    const tokens = splitTopLevel(arg, " ");
    const color = tokens[0] !== undefined ? parseColor(tokens[0]) : undefined;
    if (!color) return fail(`"${arg}" isn't a colour stop (a colour, then an optional position in %).`);
    if (tokens.length > 2) return fail(`"${arg}": a colour stop takes one position.`);
    let offset: number | null = null;
    if (tokens.length === 2) {
      const m = /^(-?(?:\d+\.?\d*|\.\d+))%$/.exec(tokens[1]);
      if (!m) return fail(`"${arg}": colour stop positions are in % (such as 40%).`);
      offset = parseFloat(m[1]) / 100;
    }
    raw.push({ color, offset });
  }
  // As CSS: the first stop defaults to 0, the last to 100%, the ones between share the gap evenly, and no stop
  // goes back past an earlier one.
  if (raw[0].offset === null) raw[0].offset = 0;
  if (raw[raw.length - 1].offset === null) raw[raw.length - 1].offset = 1;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].offset !== null) continue;
    let j = i;
    while (raw[j].offset === null) j++;
    const from = raw[i - 1].offset!;
    const to = raw[j].offset!;
    for (let k = i; k < j; k++) raw[k].offset = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  let max = -Infinity;
  return ok(
    raw.map((s) => {
      max = Math.max(max, s.offset!);
      return { color: s.color, offset: Math.min(1, Math.max(0, max)) };
    }),
  );
}

/**
 * A `backgroundImage`: `none` (or empty), `url(path)`, `linear-gradient([angle | to side,] stops…)` or
 * `radial-gradient([circle [at center],] stops…)`. A colour stop is a colour and an optional position in `%`.
 */
export function parseBackgroundImage(raw: string): PaintParse<UIBackgroundImage> {
  const v = raw.trim();
  if (v === "" || v.toLowerCase() === "none") return ok({ kind: "none" });
  if (splitTopLevel(v, ",").length > 1) return fail("takes one image; several layers aren't supported.");
  const fn = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(v);
  if (!fn) return fail("isn't url(…), linear-gradient(…) or radial-gradient(…).");
  const name = fn[1].toLowerCase();
  const body = fn[2].trim();
  if (name === "url") {
    const path = (body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'")) ? body.slice(1, -1) : body;
    return path ? ok({ kind: "url", path }) : fail("url() needs a path.");
  }
  const args = splitTopLevel(body, ",");
  if (name === "linear-gradient") {
    let a = 180;
    const first = args[0] ?? "";
    const side = /^to\s+([a-z]+)$/i.exec(first);
    if (side) {
      const s = SIDE_ANGLES[side[1].toLowerCase()];
      if (s === undefined) return fail(`"${first}" isn't a direction (to top, to right, to bottom or to left).`);
      a = s;
      args.shift();
    } else if (/^to\s/i.test(first)) {
      return fail(`"${first}": corner directions aren't supported; use an angle (such as 135deg).`);
    } else {
      const parsed = angle(first);
      if (parsed !== undefined) {
        a = parsed;
        args.shift();
      }
    }
    const stops = colorStops(args);
    return stops.ok ? ok({ kind: "linear-gradient", angle: a, stops: stops.value }) : stops;
  }
  if (name === "radial-gradient") {
    const first = (args[0] ?? "").toLowerCase().replace(/\s+/g, " ");
    if (first === "circle" || first === "circle at center" || first === "at center") args.shift();
    else if (parseColor(splitTopLevel(first, " ")[0] ?? "") === undefined) {
      return fail(`"${args[0]}": a radial gradient is a circle at the centre; shapes, sizes and positions aren't supported.`);
    }
    const stops = colorStops(args);
    return stops.ok ? ok({ kind: "radial-gradient", stops: stops.value }) : stops;
  }
  return fail(`${name}() isn't supported; use url(), linear-gradient() or radial-gradient().`);
}

/** A box, in whatever pixels the gradient is drawn in. */
export interface PaintBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The line a CSS linear gradient at `angle` runs along in `box`: through the centre, long enough that the corners
 * get the first and last stop's colours (CSS Images 3 §3.1.1).
 */
export function linearGradientLine(angleDeg: number, box: PaintBox): { x0: number; y0: number; x1: number; y1: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = (Math.abs(box.width * dx) + Math.abs(box.height * dy)) / 2;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

/** The circle a radial gradient fills `box` with: at its centre, reaching its farthest corner (`circle farthest-corner`). */
export function radialGradientCircle(box: PaintBox): { cx: number; cy: number; r: number } {
  return { cx: box.left + box.width / 2, cy: box.top + box.height / 2, r: Math.hypot(box.width, box.height) / 2 };
}
