/**
 * Transform values of UI stylesheets (ADR 0418 wave 3): `transform`, the individual `translate`, `scale` and `rotate`
 * properties, and `transform-origin`, parsed from CSS text into the transform fields' values. The cascade
 * (`cascade.ts`) expands and checks them. Pure: a value that can't be read comes back as a message saying why.
 *
 * The fields hold one translate, one rotation, one scale and (ADR 0426) a full matrix, applied as CSS applies the
 * individual properties before `transform` (translate, rotate, scale, then the matrix; `transform2d.ts`). A `transform`
 * list is composed left to right and folded into translate, rotate and scale when it can be. A list that can't fold (one
 * with `skew()`, `skewX()`, `skewY()` or `matrix()`, or a rotation after an unequal scale) is held as the matrix, after
 * its leading translates (which keep `%`). A `%` translate later in such a list is refused with a message: a matrix
 * holds pixels, and the axis would no longer be the element's own box's.
 */
import { splitTopLevel, type PaintParse } from "./paintValues";
import { matrixText, multiply, type UIAffine } from "../transform2d";

/** The transform fields a value sets, as the fields store them (lengths as `"12"` or `"50%"`). */
export interface UITransformValue {
  readonly translateX: string;
  readonly translateY: string;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotate: number;
  /** ADR 0426: the full matrix (`matrix(a, b, c, d, e, f)`), or "" when the list folds. */
  readonly transformMatrix: string;
}

const ok = <T>(value: T): PaintParse<T> => ({ ok: true, value });
const fail = <T>(problem: string): PaintParse<T> => ({ ok: false, problem });

const NUMBER = "-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?";

/** A length: `px` (or unitless) or `%`; 0 unitless. */
interface Len {
  readonly n: number;
  readonly pct: boolean;
}

function parseLen(token: string): Len | undefined {
  const m = new RegExp(`^(${NUMBER})(px|%)?$`, "i").exec(token.trim());
  return m ? { n: parseFloat(m[1]), pct: m[2] === "%" } : undefined;
}

const lenText = (l: Len) => (l.pct ? `${round(l.n)}%` : String(round(l.n)));

/** Rounds away floating-point noise (a half turn's sine) so folded values read as written. */
const round = (n: number) => {
  const r = Math.round(n * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
};

/** An angle in degrees: `deg`, `rad`, `grad`, `turn`, or a bare number (degrees; CSS takes only 0 bare). */
export function parseAngle(raw: string): number | undefined {
  const m = new RegExp(`^(${NUMBER})(deg|rad|grad|turn)?$`, "i").exec(raw.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? "deg").toLowerCase()) {
    case "rad":
      return (n * 180) / Math.PI;
    case "grad":
      return n * 0.9;
    case "turn":
      return n * 360;
    default:
      return n;
  }
}

/** A scale factor: a number, or a percentage (`150%` is 1.5). */
function parseFactor(raw: string): number | undefined {
  const m = new RegExp(`^(${NUMBER})(%)?$`, "i").exec(raw.trim());
  if (!m) return undefined;
  return m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
}

/** `rotate`: an angle, or `none` (0). */
export function parseRotate(raw: string): PaintParse<number> {
  const v = raw.trim();
  if (v.toLowerCase() === "none") return ok(0);
  const a = parseAngle(v);
  return a === undefined ? fail("isn't an angle (45deg, 0.25turn, 1rad).") : ok(a);
}

/** `translate`: `x [y]` lengths (px or % of the element's own box), or `none`. */
export function parseTranslate(raw: string): PaintParse<{ translateX: string; translateY: string }> {
  const v = raw.trim();
  if (v.toLowerCase() === "none") return ok({ translateX: "0", translateY: "0" });
  const parts = splitTopLevel(v, " ");
  if (parts.length === 3) return fail("takes x and y only; 3D transforms aren't supported.");
  if (parts.length < 1 || parts.length > 2) return fail("takes one or two lengths (px or %).");
  const x = parseLen(parts[0]), y = parts[1] !== undefined ? parseLen(parts[1]) : { n: 0, pct: false };
  if (!x || !y) return fail("takes lengths in px or % of the element's own box.");
  return ok({ translateX: lenText(x), translateY: lenText(y) });
}

/** `scale`: one factor (both axes) or two, numbers or percentages, or `none`. */
export function parseScale(raw: string): PaintParse<{ scaleX: number; scaleY: number }> {
  const v = raw.trim();
  if (v.toLowerCase() === "none") return ok({ scaleX: 1, scaleY: 1 });
  const parts = splitTopLevel(v, " ");
  if (parts.length === 3) return fail("takes x and y only; 3D transforms aren't supported.");
  if (parts.length < 1 || parts.length > 2) return fail("takes one or two numbers.");
  const x = parseFactor(parts[0]), y = parts[1] !== undefined ? parseFactor(parts[1]) : x;
  if (x === undefined || y === undefined) return fail("takes numbers (2, 0.5) or percentages (150%).");
  return ok({ scaleX: x, scaleY: y });
}

/** `transform-origin` as the two fields' values: pixels from the left and top edges, or percentages of the box. */
export function parseTransformOrigin(raw: string): PaintParse<{ transformOriginX: string; transformOriginY: string }> {
  const parts = splitTopLevel(raw.trim(), " ").map((p) => p.toLowerCase());
  if (parts.length === 3) return fail("takes x and y only; 3D transforms aren't supported.");
  if (parts.length < 1 || parts.length > 2) return fail("takes one or two positions (left, center, right, top, bottom, px or %).");
  const X: Record<string, string> = { left: "0%", center: "50%", right: "100%" };
  const Y: Record<string, string> = { top: "0%", center: "50%", bottom: "100%" };
  const asLen = (p: string) => {
    const l = parseLen(p);
    return l ? lenText(l) : undefined;
  };
  if (parts.length === 1) {
    const p = parts[0];
    if (p in Y && p !== "center") return ok({ transformOriginX: "50%", transformOriginY: Y[p] });
    const x = X[p] ?? asLen(p);
    return x === undefined ? fail("isn't a position (left, center, right, top, bottom, px or %).") : ok({ transformOriginX: x, transformOriginY: "50%" });
  }
  let [a, b] = parts;
  // Keywords may come in either order (`top left`); lengths are x then y.
  if ((a === "top" || a === "bottom") && (b in X || b === "center")) [a, b] = [b, a];
  else if (a === "center" && (b === "left" || b === "right")) [a, b] = [b, a];
  const x = X[a] ?? (a in Y ? undefined : asLen(a));
  const y = Y[b] ?? (b in X && b !== "center" ? undefined : asLen(b));
  return x === undefined || y === undefined ? fail("isn't a position (left, center, right, top, bottom, px or %).") : ok({ transformOriginX: x, transformOriginY: y });
}

/** The fold so far: `T(tx, ty) · R(rotate) · S(sx, sy)`. */
interface Fold {
  tx: Len;
  ty: Len;
  rotate: number;
  sx: number;
  sy: number;
}

const NEAR = 1e-9;

/** Adds a length to an axis's translate; undefined when one is px and the other % (neither zero). */
function addLen(a: Len, b: Len): Len | undefined {
  if (Math.abs(b.n) < NEAR) return a;
  if (Math.abs(a.n) < NEAR) return b;
  return a.pct === b.pct ? { n: a.n + b.n, pct: a.pct } : undefined;
}

/** Appends `translate(v)` on the right: `T·R·S·T(v) = T(t + R·S·v)·R·S`. */
function foldTranslate(f: Fold, vx: Len, vy: Len): string | null {
  const x: Len = { n: vx.n * f.sx, pct: vx.pct }, y: Len = { n: vy.n * f.sy, pct: vy.pct };
  const turn = ((f.rotate % 360) + 360) % 360;
  let dx: Len, dy: Len;
  if (Math.abs(turn) < NEAR || Math.abs(turn - 360) < NEAR) [dx, dy] = [x, y];
  else if (Math.abs(turn - 180) < NEAR) [dx, dy] = [{ n: -x.n, pct: x.pct }, { n: -y.n, pct: y.pct }];
  else {
    if ((x.pct && Math.abs(x.n) > NEAR) || (y.pct && Math.abs(y.n) > NEAR)) return "has a % translate after a rotation; its axis would no longer be the element's own (use px, or put translate first).";
    const r = (f.rotate * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    dx = { n: cos * x.n - sin * y.n, pct: false };
    dy = { n: sin * x.n + cos * y.n, pct: false };
  }
  const tx = addLen(f.tx, dx), ty = addLen(f.ty, dy);
  if (!tx || !ty) return "mixes px and % translates on one axis.";
  f.tx = tx;
  f.ty = ty;
  return null;
}

/** Appends `rotate(a)`: `S·R(a)` is `R(a)·S` only for an equal scale (or a half turn). */
function foldRotate(f: Fold, a: number): string | null {
  const half = Math.abs(((a % 180) + 180) % 180) < NEAR || Math.abs((((a % 180) + 180) % 180) - 180) < NEAR;
  if (Math.abs(f.sx - f.sy) > NEAR && !half) return "rotates after an unequal scale, which skews; write rotate() before scale() (translate, rotate, scale is the order the fields keep).";
  f.rotate += a;
  return null;
}

/** One transform function's arguments, split on commas (CSS) or spaces. */
function args(inner: string): string[] {
  const byComma = splitTopLevel(inner, ",");
  return (byComma.length > 1 ? byComma : splitTopLevel(inner, " ")).filter((s) => s !== "");
}

const FUNCTIONS = ["translate", "translatex", "translatey", "scale", "scalex", "scaley", "rotate", "skew", "skewx", "skewy", "matrix"];

/** One function of a list, read: a translate (lengths), a scale, a rotation or (ADR 0426) a matrix holding a skew or `matrix()`. */
type Step =
  | { readonly kind: "translate"; readonly x: Len; readonly y: Len }
  | { readonly kind: "scale"; readonly x: number; readonly y: number }
  | { readonly kind: "rotate"; readonly angle: number }
  | { readonly kind: "matrix"; readonly m: UIAffine };

const ZERO: Len = { n: 0, pct: false };
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
const NUMBER_ONLY = new RegExp(`^${NUMBER}$`, "i");

/** Reads one function's arguments, or says why it can't. */
function readStep(fn: string, name: string, a: string[]): Step | string {
  if (name === "rotate") {
    const angle = a.length === 1 ? parseAngle(a[0]) : undefined;
    return angle === undefined ? "has a rotate() that isn't one angle (45deg, 0.25turn)." : { kind: "rotate", angle };
  }
  if (name.startsWith("translate")) {
    const lens = a.map(parseLen);
    if (lens.some((l) => !l) || a.length < 1 || a.length > (name === "translate" ? 2 : 1)) return `has a ${fn}() that isn't ${name === "translate" ? "one or two lengths" : "one length"} (px or %).`;
    const [x, y] = name === "translatey" ? [ZERO, lens[0]!] : [lens[0]!, name === "translate" ? (lens[1] ?? ZERO) : ZERO];
    return { kind: "translate", x, y };
  }
  if (name.startsWith("skew")) {
    const angles = a.map(parseAngle);
    if (angles.some((x) => x === undefined) || a.length < 1 || a.length > (name === "skew" ? 2 : 1)) return `has a ${fn}() that isn't ${name === "skew" ? "one or two angles" : "one angle"}.`;
    const ax = name === "skewy" ? 0 : angles[0]!;
    const ay = name === "skewx" ? 0 : name === "skew" ? (angles[1] ?? 0) : angles[0]!;
    return { kind: "matrix", m: [1, tan(ay), tan(ax), 1, 0, 0] };
  }
  if (name === "matrix") {
    const n = a.map((x) => (NUMBER_ONLY.test(x.trim()) ? parseFloat(x) : NaN));
    if (n.length !== 6 || n.some((x) => !Number.isFinite(x))) return "has a matrix() that isn't six numbers (a, b, c, d, e, f).";
    return { kind: "matrix", m: n as unknown as UIAffine };
  }
  const ks = a.map(parseFactor);
  if (ks.some((k) => k === undefined) || a.length < 1 || a.length > (name === "scale" ? 2 : 1)) return `has a ${fn}() that isn't ${name === "scale" ? "one or two numbers" : "one number"}.`;
  const sx = name === "scaley" ? 1 : ks[0]!, sy = name === "scalex" ? 1 : name === "scale" ? (ks[1] ?? ks[0]!) : ks[0]!;
  return { kind: "scale", x: sx, y: sy };
}

/** The fold's problem for a list with a skew or `matrix()`, which never folds. */
const HOLDS_MATRIX = "holds a matrix.";

/** Folds the steps into translate, rotate and scale; a problem when they don't fold. */
function fold(steps: readonly Step[]): UITransformValue | string {
  const f: Fold = { tx: { n: 0, pct: false }, ty: { n: 0, pct: false }, rotate: 0, sx: 1, sy: 1 };
  for (const s of steps) {
    let problem: string | null = null;
    if (s.kind === "matrix") return HOLDS_MATRIX;
    if (s.kind === "rotate") problem = foldRotate(f, s.angle);
    else if (s.kind === "translate") problem = foldTranslate(f, s.x, s.y);
    else {
      f.sx *= s.x;
      f.sy *= s.y;
    }
    if (problem) return problem;
  }
  return { translateX: lenText(f.tx), translateY: lenText(f.ty), scaleX: round(f.sx), scaleY: round(f.sy), rotate: round(f.rotate), transformMatrix: "" };
}

/**
 * ADR 0426: the steps as the leading translates (kept in the translate fields, `%` allowed) and the rest composed into
 * one matrix (pixels only).
 */
function asMatrix(steps: readonly Step[]): UITransformValue | string {
  let tx: Len = ZERO, ty: Len = ZERO;
  let i = 0;
  for (; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "translate") break;
    const x = addLen(tx, s.x), y = addLen(ty, s.y);
    if (!x || !y) return "mixes px and % translates on one axis.";
    tx = x;
    ty = y;
  }
  let m: UIAffine = [1, 0, 0, 1, 0, 0];
  for (; i < steps.length; i++) {
    const s = steps[i];
    let step: UIAffine;
    if (s.kind === "translate") {
      if ((s.x.pct && Math.abs(s.x.n) > NEAR) || (s.y.pct && Math.abs(s.y.n) > NEAR)) return "has a % translate after a skew, matrix or rotation it can't fold; a matrix holds pixels (use px, or put translate first).";
      step = [1, 0, 0, 1, s.x.n, s.y.n];
    } else if (s.kind === "scale") step = [s.x, 0, 0, s.y, 0, 0];
    else if (s.kind === "rotate") {
      const r = (s.angle * Math.PI) / 180;
      step = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
    } else step = s.m;
    m = multiply(m, step);
  }
  return { translateX: lenText(tx), translateY: lenText(ty), scaleX: 1, scaleY: 1, rotate: 0, transformMatrix: matrixText(m) };
}

/**
 * `transform`: `none`, or a list of `translate(x[, y])`, `translateX()`, `translateY()`, `scale(s[, sy])`, `scaleX()`,
 * `scaleY()`, `rotate(angle)` and (ADR 0426) `skew(ax[, ay])`, `skewX()`, `skewY()` and `matrix(a, b, c, d, e, f)`,
 * composed left to right: folded into translate, rotate and scale when it can be, else held as the matrix.
 */
export function parseTransform(raw: string): PaintParse<UITransformValue> {
  const v = raw.trim();
  if (v.toLowerCase() === "none") return ok({ translateX: "0", translateY: "0", scaleX: 1, scaleY: 1, rotate: 0, transformMatrix: "" });
  const re = /([a-zA-Z0-9-]+)\(([^()]*)\)/y;
  const steps: Step[] = [];
  let i = 0;
  while (i < v.length) {
    while (i < v.length && /\s/.test(v[i])) i++;
    if (i >= v.length) break;
    re.lastIndex = i;
    const m = re.exec(v);
    if (!m) return fail("isn't a list of transform functions (translate(), scale(), rotate(), skew(), matrix()).");
    i = re.lastIndex;
    const name = m[1].toLowerCase();
    if (!FUNCTIONS.includes(name)) return fail(`uses ${m[1]}(), which isn't supported (translate, scale, rotate, skew and matrix are; 3D isn't).`);
    const step = readStep(m[1], name, args(m[2]));
    if (typeof step === "string") return fail(step);
    steps.push(step);
  }
  if (!steps.length) return fail("is empty.");
  const folded = fold(steps);
  if (typeof folded !== "string") return ok(folded);
  const held = asMatrix(steps);
  if (typeof held !== "string") return ok(held);
  // Neither: the fold's own reason when it was about lengths, else the matrix's.
  return fail(folded === HOLDS_MATRIX || /skews/.test(folded) ? held : folded);
}
