/**
 * The `filter` property of UI stylesheets (ADR 0430), parsed from CSS text into the filter fields (`ui/filters.ts`).
 * The cascade expands it where it's declared, as the paint and transform shorthands. Pure: a value that can't be read
 * comes back as a message saying why.
 *
 * `none`, or a list of `blur()`, `brightness()`, `contrast()`, `grayscale()`, `hue-rotate()`, `invert()`, `opacity()`,
 * `saturate()`, `sepia()` and `drop-shadow()`. Every field the property covers is set (those not listed to their
 * initial values), so a later `filter` replaces an earlier one, as in CSS. The fields apply in one fixed order, so a list
 * in another order draws in that order. A function listed twice folds where the two compose into one: factors of
 * `brightness`, `contrast`, `saturate` and `opacity` multiply, `hue-rotate` angles add, and blurs combine as Gaussians
 * do (√(a² + b²); Svelte's `blur` transition appends its blur to the element's own). `grayscale`, `sepia` and `invert`
 * twice, several drop shadows, and `url()` (SVG filters) are refused.
 */
import { Color } from "../../core/math";
import { FILTER_DEFAULTS, type UIFilterFields } from "../filters";
import { parseShadow, splitTopLevel, type PaintParse } from "./paintValues";
import { parseAngle } from "./transformValues";

const ok = <T>(value: T): PaintParse<T> => ({ ok: true, value });
const fail = <T>(problem: string): PaintParse<T> => ({ ok: false, problem });

const NUMBER = "-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?";
const FACTOR = new RegExp(`^(${NUMBER})(%)?$`, "i");
const LENGTH = new RegExp(`^(${NUMBER})(px)?$`, "i");

/** Every field `filter` sets. */
export const FILTER_FIELDS = Object.keys(FILTER_DEFAULTS) as (keyof UIFilterFields)[];

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const FACTORS: Readonly<Record<string, keyof UIFilterFields>> = {
  brightness: "filterBrightness",
  contrast: "filterContrast",
  grayscale: "filterGrayscale",
  invert: "filterInvert",
  opacity: "filterOpacity",
  saturate: "filterSaturate",
  sepia: "filterSepia",
};
/** Factors that compose by multiplying when listed twice. */
const MULTIPLY = new Set(["brightness", "contrast", "saturate", "opacity"]);

/** `filter`: the filter fields' values, or why the value can't be read. */
export function parseFilter(raw: string): PaintParse<UIFilterFields> {
  const out = { ...FILTER_DEFAULTS } as Mutable<UIFilterFields>;
  const v = raw.trim();
  if (v === "" || v.toLowerCase() === "none") return ok(out);
  const seen = new Set<string>();
  const re = /([a-zA-Z-]+)\(((?:[^()]|\([^()]*\))*)\)/y;
  let i = 0;
  while (i < v.length) {
    while (i < v.length && /\s/.test(v[i])) i++;
    if (i >= v.length) break;
    re.lastIndex = i;
    const m = re.exec(v);
    if (!m) return fail("isn't a list of filter functions (blur(), brightness(), drop-shadow()…).");
    i = re.lastIndex;
    const name = m[1].toLowerCase();
    const arg = m[2].trim();
    const twice = seen.has(name);
    seen.add(name);
    if (name === "url") return fail("uses url(), an SVG filter, which isn't supported.");
    if (name === "blur") {
      const l = arg === "" ? { n: 0 } : (() => {
        const x = LENGTH.exec(arg);
        return x ? { n: parseFloat(x[1]) } : null;
      })();
      if (!l || l.n < 0) return fail("has a blur() that isn't one length in px, 0 or more.");
      out.filterBlur = Math.sqrt(out.filterBlur * out.filterBlur + l.n * l.n);
    } else if (name === "hue-rotate") {
      const a = arg === "" ? 0 : parseAngle(arg);
      if (a === undefined) return fail("has a hue-rotate() that isn't one angle (90deg, 0.5turn).");
      out.filterHueRotate += a;
    } else if (name in FACTORS) {
      const x = arg === "" ? null : FACTOR.exec(arg);
      if (arg !== "" && !x) return fail(`has a ${m[1]}() that isn't one number or percentage.`);
      const k = !x ? 1 : x[2] ? parseFloat(x[1]) / 100 : parseFloat(x[1]);
      if (k < 0) return fail(`has a negative ${m[1]}().`);
      const field = FACTORS[name];
      if (twice && !MULTIPLY.has(name)) return fail(`lists ${m[1]}() twice, which one field can't hold.`);
      (out as Record<string, unknown>)[field] = twice ? (out[field] as number) * k : k;
    } else if (name === "drop-shadow") {
      if (twice) return fail("has several drop-shadow()s; one is supported.");
      if (splitTopLevel(arg, " ").length < 2) return fail("has a drop-shadow() without an x and a y offset.");
      const s = parseShadow(arg);
      if (!s.ok) return fail(`has a drop-shadow() that ${s.problem.replace(/^takes/, "takes")}`);
      out.filterDropShadowColor = s.value.color ?? new Color(0, 0, 0, 1);
      out.filterDropShadowOffsetX = s.value.offsetX;
      out.filterDropShadowOffsetY = s.value.offsetY;
      out.filterDropShadowBlur = s.value.blur;
    } else return fail(`uses ${m[1]}(), which isn't a filter function.`);
  }
  if (!seen.size) return fail("is empty.");
  return ok(out);
}
