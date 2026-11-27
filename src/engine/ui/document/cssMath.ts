/**
 * CSS math functions (ADR 0422 wave 5): `calc()`, `min()`, `max()` and `clamp()` in a value, worked out where it's
 * declared, after `var()` substitution. Each function is replaced by its result:
 *
 * - numbers and single-unit lengths and angles resolve to a plain value (`calc(2 * 8px)` → `16px`);
 * - lengths mixing `px` and `%` (`calc(100% - 24px)`) can't resolve without the containing box, so they become the
 *   normal form `calc(<p>% + <q>px)`, which length fields keep and the UI core resolves at layout against the parent's
 *   size (`linearLength`).
 *
 * `+` and `-` take values of one kind (numbers, or lengths, where px and % mix); `*` needs a number on one side; `/` a
 * non-zero number on the right. `min()`, `max()` and `clamp()` compare values of one unit. Pure, no CSS parser.
 */

/** A value as a sum of unit terms: `{ "": 2 }` is the number 2, `{ px: 10, "%": 50 }` is 50% + 10px. */
type Terms = Map<string, number>;

const UNITS: ReadonlySet<string> = new Set(["", "px", "%", "deg", "rad", "grad", "turn", "s", "ms"]);
const FUNCTION = /(?<![\w-])(calc|min|max|clamp)\(/i;

/** True when a value has a math function to work out. */
export function hasMath(value: string): boolean {
  return FUNCTION.test(value);
}

/** The value with every math function replaced by its result, or why one can't be worked out. */
export function resolveMath(value: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: string } {
  if (!hasMath(value)) return { ok: true, value };
  let out = "";
  let i = 0;
  for (;;) {
    const m = FUNCTION.exec(value.slice(i));
    if (!m) break;
    const start = i + m.index;
    out += value.slice(i, start);
    const r: Reader = { text: value, i: start };
    try {
      out += format(readFunction(r));
    } catch (err) {
      return { ok: false, problem: `has a math function that can't be worked out: ${(err as Error).message}.` };
    }
    i = r.i;
  }
  return { ok: true, value: out + value.slice(i) };
}

// --- Relative lengths (ADR 0432) ------------------------------------------------------------------

/**
 * What relative lengths resolve against (ADR 0432): `em` the element's font size (its parent's, in `font-size` itself),
 * `rem` the root canvas element's, and the canvas in UI pixels for `vw`/`vh`/`vmin`/`vmax` (null: not known, so a
 * viewport length can't resolve).
 */
export interface UIRelativeUnits {
  readonly em: number;
  readonly rem: number;
  readonly viewport: { readonly width: number; readonly height: number } | null;
}

const RELATIVE = /(?<![\w.#-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(rem|em|vw|vh|vmin|vmax)(?![\w-])/gi;
const VIEWPORT = /(?<![\w.#-])[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:vw|vh|vmin|vmax)(?![\w-])/i;

/** The parts of a value outside quoted strings and `url()`, where lengths can be: `[text, isValuePart]` in order. */
function valueSegments(value: string): [string, boolean][] {
  const out: [string, boolean][] = [];
  let i = 0;
  let start = 0;
  while (i < value.length) {
    const ch = value[i];
    let end = -1;
    if (ch === '"' || ch === "'") {
      end = value.indexOf(ch, i + 1);
      end = end < 0 ? value.length : end + 1;
    } else if ((ch === "u" || ch === "U") && /^url\(/i.test(value.slice(i, i + 4)) && !/[\w-]/.test(value[i - 1] ?? "")) {
      end = value.indexOf(")", i);
      end = end < 0 ? value.length : end + 1;
    }
    if (end < 0) {
      i++;
      continue;
    }
    if (i > start) out.push([value.slice(start, i), true]);
    out.push([value.slice(i, end), false]);
    i = start = end;
  }
  if (start < value.length) out.push([value.slice(start), true]);
  return out;
}

/** True when a value has a viewport length (`50vw`), outside strings and `url()`: it changes with the canvas size. */
export function hasViewportUnits(value: string): boolean {
  return VIEWPORT.test(value) && valueSegments(value).some(([text, part]) => part && VIEWPORT.test(text));
}

/**
 * The value with every `em`, `rem`, `vw`, `vh`, `vmin` and `vmax` length written in px (`2em` at a 16px font is
 * `32px`), outside strings and `url()`, so every length and `calc()` takes them. Undefined when a viewport length
 * can't resolve (no canvas size).
 */
export function resolveRelativeUnits(value: string, units: UIRelativeUnits): string | undefined {
  if (!/\d(?:r?em|vw|vh|vmin|vmax)/i.test(value)) return value;
  let failed = false;
  const out = valueSegments(value)
    .map(([text, part]) =>
      !part
        ? text
        : text.replace(RELATIVE, (_, n: string, unit: string) => {
            const v = parseFloat(n);
            const u = unit.toLowerCase();
            let px: number;
            if (u === "em") px = v * units.em;
            else if (u === "rem") px = v * units.rem;
            else if (!units.viewport) {
              failed = true;
              return _;
            } else {
              const { width, height } = units.viewport;
              const per = u === "vw" ? width : u === "vh" ? height : u === "vmin" ? Math.min(width, height) : Math.max(width, height);
              px = (v * per) / 100;
            }
            return `${round(px)}px`;
          }),
    )
    .join("");
  return failed ? undefined : out;
}

const MIXED = /^calc\((-?\d+(?:\.\d+)?)% \+ (-?\d+(?:\.\d+)?)px\)$/;

/** A length that mixes % and px, in the normal form `resolveMath` writes (`calc(50% + -12px)`): its parts, or null. */
export function linearLength(value: string): { readonly percent: number; readonly px: number } | null {
  const m = MIXED.exec(value.trim());
  return m ? { percent: parseFloat(m[1]), px: parseFloat(m[2]) } : null;
}

// --- Reading and working out ---------------------------------------------------------------------

interface Reader {
  readonly text: string;
  i: number;
}

function space(r: Reader): void {
  while (r.i < r.text.length && /\s/.test(r.text[r.i])) r.i++;
}

/** `calc(…)`, `min(…)`, `max(…)` or `clamp(…)` at the reader. */
function readFunction(r: Reader): Terms {
  const m = /^(calc|min|max|clamp)\(/i.exec(r.text.slice(r.i))!;
  const name = m[1].toLowerCase();
  r.i += m[0].length;
  const args: Terms[] = [readSum(r)];
  space(r);
  while (r.text[r.i] === ",") {
    r.i++;
    args.push(readSum(r));
    space(r);
  }
  if (r.text[r.i] !== ")") throw new Error(`${name}( isn't closed`);
  r.i++;
  if (name === "calc") {
    if (args.length !== 1) throw new Error("calc() takes one expression");
    return args[0];
  }
  if (name === "clamp" && args.length !== 3) throw new Error("clamp() takes a minimum, a value and a maximum");
  const unit = singleUnit(args[0], name);
  for (const a of args) if (singleUnit(a, name) !== unit) throw new Error(`${name}() compares values of one unit`);
  const n = args.map((a) => a.get(unit) ?? 0);
  const result = name === "min" ? Math.min(...n) : name === "max" ? Math.max(...n) : Math.max(n[0], Math.min(n[1], n[2]));
  return new Map([[unit, result]]);
}

/** The one unit a value has (a number has ""), for comparing. */
function singleUnit(t: Terms, fn: string): string {
  const units = [...t.keys()];
  if (units.length !== 1) throw new Error(`${fn}() can't compare a value mixing ${units.join(" and ")}`);
  return units[0];
}

function readSum(r: Reader): Terms {
  let left = readProduct(r);
  for (;;) {
    space(r);
    const c = r.text[r.i];
    if (c !== "+" && c !== "-") return left;
    // CSS needs spaces around + and -, so `-` before a number belongs to it; here an operator follows a value.
    r.i++;
    const right = readProduct(r);
    left = add(left, right, c === "-" ? -1 : 1);
  }
}

function readProduct(r: Reader): Terms {
  let left = readValue(r);
  for (;;) {
    space(r);
    const c = r.text[r.i];
    if (c !== "*" && c !== "/") return left;
    r.i++;
    const right = readValue(r);
    if (c === "*") {
      if (isNumber(left)) left = scale(right, left.get("") ?? 0);
      else if (isNumber(right)) left = scale(left, right.get("") ?? 0);
      else throw new Error("* needs a number on one side");
    } else {
      if (!isNumber(right)) throw new Error("/ needs a number on its right");
      const d = right.get("") ?? 0;
      if (d === 0) throw new Error("division by zero");
      left = scale(left, 1 / d);
    }
  }
}

function readValue(r: Reader): Terms {
  space(r);
  const rest = r.text.slice(r.i);
  if (rest.startsWith("(")) {
    r.i++;
    const inner = readSum(r);
    space(r);
    if (r.text[r.i] !== ")") throw new Error("( isn't closed");
    r.i++;
    return inner;
  }
  if (/^(calc|min|max|clamp)\(/i.test(rest)) return readFunction(r);
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-zA-Z]+)?/.exec(rest);
  if (!m) throw new Error(rest.trim() ? `"${rest.trim().split(/[\s,)]/)[0]}" isn't a number or a length` : "a value is missing");
  const unit = (m[2] ?? "").toLowerCase();
  if (!UNITS.has(unit)) throw new Error(`the unit "${m[2]}" isn't supported`);
  r.i += m[0].length;
  return new Map([[unit, parseFloat(m[1])]]);
}

const isNumber = (t: Terms) => t.size === 1 && t.has("");

function scale(t: Terms, k: number): Terms {
  return new Map([...t].map(([u, v]) => [u, v * k]));
}

/** `a + sign·b`: numbers with numbers, lengths with lengths (px and % mix), angles and times each with their own. */
function add(a: Terms, b: Terms, sign: number): Terms {
  const kind = (t: Terms) => [...t.keys()].map((u) => (u === "px" || u === "%" ? "length" : u === "" ? "number" : u)).join();
  const ka = new Set([...a.keys()].map((u) => (u === "px" || u === "%" ? "length" : u)));
  const kb = new Set([...b.keys()].map((u) => (u === "px" || u === "%" ? "length" : u)));
  if (ka.size !== 1 || kb.size !== 1 || [...ka][0] !== [...kb][0]) throw new Error(`can't add ${kind(a) || "?"} and ${kind(b) || "?"}`);
  const out = new Map(a);
  for (const [u, v] of b) out.set(u, (out.get(u) ?? 0) + sign * v);
  return out;
}

const round = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

function format(t: Terms): string {
  const px = t.get("px");
  const pct = t.get("%");
  if (px !== undefined && pct !== undefined) {
    if (round(pct) === 0) return `${round(px)}px`;
    if (round(px) === 0) return `${round(pct)}%`;
    return `calc(${round(pct)}% + ${round(px)}px)`;
  }
  const [[unit, v]] = [...t];
  return `${round(v)}${unit}`;
}
