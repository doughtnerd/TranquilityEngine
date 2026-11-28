// Internal (ADR 0325): the kernel operator catalogue. Each expression operator (`KOp`) and the `set`
// statement are written here once per language, side by side: the KSL a stage emits (`kernelShader.ts`,
// compiled to WGSL and GLSL) and the JavaScript closure the JavaScript executor runs (`kernelJs.ts`). Both
// executors read one width-fit rule (`fitSource`) for a value of one width used at another.
// `kernelOps.test.ts` runs every operator's and every set's KSL as JavaScript (the shader source module's
// third output, ADR 0250) against its closure, as `kernelSteps.test.ts` does for the steps (ADR 0251).
import { ATTR, LOCAL_WIDTH, widthOf, type KExpr, type KLocal, type KOp, type KStmt } from "../../../scene/particleKernel";
import { srgbToLinear } from "../../../core/colorSpace";
import { hsv, valueNoise } from "./kernelMath";
import type { StepFrame } from "./kernelSteps";

export type OpExpr = Extract<KExpr, { k: "op" }>;
export type SetStmt = Extract<KStmt, { s: "set" }>;

/** A compiled JavaScript expression: its value now (a scalar at `[0]`). The array is reused. */
export type ValueFn = () => Float64Array;

const COMP = "xyzw";
/** KSL type of each width. */
export const VEC = ["", "KF", "KV2", "KV3", "KV4"];

/** KSL global of each kernel local (`speed` has none: it is computed from the velocity). */
export const LOCAL_KSL: Record<KLocal, string> = {
  t: "k_t",
  index: "k_idx",
  speed: "",
  spos: "k_spos",
  sdir: "k_sdir",
  speedMod: "k_speedMod",
  oColor: "k_oColor",
  oSize: "k_oSize",
  oTile: "k_oTile",
};

// --- the width-fit rule ---------------------------------------------------------------------------------

/**
 * The width-fit rule: a value of width `from` used where width `to` is wanted. Component i comes from the
 * value's only component when it is a number (it broadcasts), from its component i when it has one (a wider
 * value is cut to its first `to` components), else it is 0 (a narrower vector is padded with zeros: a vec2
 * written to a position sets z to 0). The result lists, for each of the `to` components, the source
 * component, or -1 for 0.
 */
export function fitSource(from: number, to: number): Int32Array {
  const src = new Int32Array(to);
  for (let i = 0; i < to; i++) src[i] = from === 1 ? 0 : i < from ? i : -1;
  return src;
}

/** KSL for `s` (width `from`) as width `to`, by `fitSource`: as is, a splat, a prefix swizzle or zero padding. */
export function fitKsl(s: string, from: number, to: number): string {
  if (from === to) return s;
  const src = fitSource(from, to);
  if (from === 1) return `${VEC[to]}(${s})`;
  let kept = 0;
  while (kept < to && src[kept] === kept) kept++;
  const head = kept === from ? s : `${s}.${COMP.slice(0, kept)}`;
  return kept === to ? head : `${VEC[to]}(${head}${", 0.0".repeat(to - kept)})`;
}

// --- operators ------------------------------------------------------------------------------------------

/** What an operator's KSL may ask of the stage emitting it. */
export interface KslEmitter {
  /** Bind `value` (width `w`) to a fresh temporary and return its name. */
  tmp(w: number, value: string): string;
}

/** An operator argument as KSL: its text and width, and the text fitted to the result's width. */
export interface KslArg {
  readonly text: string;
  readonly width: number;
  readonly fitted: string;
}

/** One operator in both languages. */
export interface KernelOp {
  /** The KSL expression of `e` (width `w`) over its arguments; it may bind temporaries with `em`. */
  ksl(e: OpExpr, args: readonly KslArg[], w: number, em: KslEmitter): string;
  /** The same operator as a JavaScript closure over its arguments' closures, writing into `out` (width `w`). */
  js(e: OpExpr, args: readonly ValueFn[], out: Float64Array): ValueFn;
}

/** Component-wise: `lane` on each component of the arguments, each fitted to the result's width. */
function lanes(lane: (e: OpExpr) => (...x: number[]) => number, ksl: (a: readonly string[], w: number, e: OpExpr) => string): KernelOp {
  return {
    ksl: (e, args, w) => ksl(args.map((a) => a.fitted), w, e),
    js(e, args, out) {
      const fn = lane(e);
      const w = out.length;
      const maps = e.args.map((a) => fitSource(widthOf(a), w));
      if (args.length === 1) {
        const [a] = args;
        const [m] = maps;
        return () => {
          const x = a();
          for (let i = 0; i < w; i++) out[i] = fn(m[i] < 0 ? 0 : x[m[i]]);
          return out;
        };
      }
      if (args.length === 2) {
        const [a, b] = args;
        const [ma, mb] = maps;
        return () => {
          const x = a();
          const y = b();
          for (let i = 0; i < w; i++) out[i] = fn(ma[i] < 0 ? 0 : x[ma[i]], mb[i] < 0 ? 0 : y[mb[i]]);
          return out;
        };
      }
      const xs: number[] = new Array(args.length);
      return () => {
        const vs = args.map((g) => g());
        for (let i = 0; i < w; i++) {
          for (let j = 0; j < vs.length; j++) xs[j] = maps[j][i] < 0 ? 0 : vs[j][maps[j][i]];
          out[i] = fn(...xs);
        }
        return out;
      };
    },
  };
}

/** A component-wise helper in KSL for widths 1-4 (`name1` … `name4`), from its one-component body. */
function laneHelpers(name: string, params: readonly string[], body: string): string {
  let src = `FN(KF, ${name}1, ${params.map((p) => `KF ${p}`).join(", ")}) {\n${body}\n}\n`;
  for (let w = 2; w <= 4; w++) {
    const parts = [...COMP.slice(0, w)].map((c) => `${name}1(${params.map((p) => `${p}.${c}`).join(", ")})`);
    src += `FN(${VEC[w]}, ${name}${w}, ${params.map((p) => `${VEC[w]} ${p}`).join(", ")}) {\n  return ${VEC[w]}(${parts.join(", ")});\n}\n`;
  }
  return src;
}

/** The KSL helpers the operators call (every kernel shader includes them). */
export const KERNEL_OPS_KSL = /* KSL */ [
  laneHelpers("k_div", ["a", "b"], "  return select(a / b, 0.0, b == 0.0);"),
  laneHelpers("k_remap", ["x", "a", "b", "c", "d"], "  if (b == a) { return c; }\n  return c + (x - a) / (b - a) * (d - c);"),
  laneHelpers(
    "k_smooth",
    ["e0", "e1", "x"],
    "  if (e0 == e1) { return step(e0, x); }\n  VAR(KF, t) = clamp((x - e0) / (e1 - e0), 0.0, 1.0);\n  return t * t * (3.0 - 2.0 * t);",
  ),
].join("");

const call = (name: string) => (a: readonly string[]) => `${name}(${a.join(", ")})`;

/** Every operator, in both languages. */
export const KERNEL_OPS: Record<KOp, KernelOp> = {
  add: lanes(() => (a, b) => a + b, (a) => `(${a[0]} + ${a[1]})`),
  sub: lanes(() => (a, b) => a - b, (a) => `(${a[0]} - ${a[1]})`),
  mul: lanes(() => (a, b) => a * b, (a) => `(${a[0]} * ${a[1]})`),
  /** Safe division: 0 where the divisor is 0. */
  div: lanes(() => (a, b) => (b === 0 ? 0 : a / b), (a, w) => `k_div${w}(${a[0]}, ${a[1]})`),
  neg: lanes(() => (a) => -a, (a) => `(-${a[0]})`),
  abs: lanes(() => Math.abs, call("abs")),
  min: lanes(() => Math.min, call("min")),
  max: lanes(() => Math.max, call("max")),
  clamp: lanes(() => (x, lo, hi) => Math.min(Math.max(x, lo), hi), (a) => `min(max(${a[0]}, ${a[1]}), ${a[2]})`),
  lerp: lanes(() => (a, b, t) => a + (b - a) * t, call("mix")),
  /** x from [a, b] to [c, d]; c where a = b. */
  remap: lanes(() => (x, a, b, c, d) => (b === a ? c : c + ((x - a) / (b - a)) * (d - c)), (a, w) => `k_remap${w}(${a.join(", ")})`),
  step: lanes(() => (edge, x) => (x >= edge ? 1 : 0), call("step")),
  /** Hermite between the edges; a step where they are equal. */
  smoothstep: lanes(
    () => (e0, e1, x) => {
      if (e0 === e1) return x >= e0 ? 1 : 0;
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    },
    (a, w) => `k_smooth${w}(${a.join(", ")})`,
  ),
  sin: lanes(() => Math.sin, call("sin")),
  cos: lanes(() => Math.cos, call("cos")),
  /** Value noise (one component: `resultWidth` makes it a number). */
  noise1: lanes(
    (e) => {
      const seed = e.seed ?? 0;
      return (x) => valueNoise(x, seed);
    },
    (a, _w, e) => `k_vnoise(${a[0]}, ${Math.round(e.seed ?? 0)})`,
  ),
  /** Its arguments' components, in order. */
  vec: {
    ksl: (_e, args, w) => `${VEC[w]}(${args.map((a) => a.text).join(", ")})`,
    js: (_e, args, out) => () => {
      let k = 0;
      for (const g of args) for (const x of g()) out[k++] = x;
      return out;
    },
  },
  length: {
    ksl: (_e, args) => `length(${args[0].text})`,
    js: (_e, args, out) => () => {
      let s = 0;
      for (const x of args[0]()) s += x * x;
      out[0] = Math.sqrt(s);
      return out;
    },
  },
  /** The unit vector; zero for a zero vector. */
  normalize: {
    ksl(_e, args, w, em) {
      const v = em.tmp(args[0].width, args[0].text);
      const len = em.tmp(1, `length(${v})`);
      return `select((${v} / ${len}), ${fitKsl("0.0", 1, w)}, ${len} == 0.0)`;
    },
    js: (_e, args, out) => () => {
      const v = args[0]();
      let s = 0;
      for (const x of v) s += x * x;
      const len = Math.sqrt(s);
      for (let i = 0; i < out.length; i++) out[i] = len === 0 ? 0 : v[i] / len;
      return out;
    },
  },
  /** An RGBA colour from hue, saturation, value and alpha (the first component of each). */
  hsv: {
    ksl: (_e, args) => `k_hsv(${args.map((a) => fitKsl(a.text, a.width, 1)).join(", ")})`,
    js: (_e, args, out) => () => {
      const [h, s, v, a] = args.map((g) => g()[0]);
      out.set(hsv(h, s, v, a));
      return out;
    },
  },
  /** sRGB to linear on the first three components; the fourth (alpha) is kept. */
  toLinear: {
    ksl(_e, args, w, em) {
      const [a] = args;
      return fitKsl(em.tmp(4, `k_toLinear(${fitKsl(a.text, a.width, 4)})`), 4, w);
    },
    js: (_e, args, out) => () => {
      const v = args[0]();
      for (let i = 0; i < out.length; i++) out[i] = i < 3 ? srgbToLinear(v[i]) : v[i];
      return out;
    },
  },
};

// --- the set statement ----------------------------------------------------------------------------------

/** Where a set writes in KSL: its width and the name of each component. */
function setTarget(st: SetStmt): { width: number; ksl: string[] } {
  if ("attr" in st.target) {
    const [slot, comp, w] = ATTR[st.target.attr];
    return { width: w, ksl: [...COMP.slice(comp, comp + w)].map((c) => `a${slot}.${c}`) };
  }
  const name = LOCAL_KSL[st.target.local];
  const w = LOCAL_WIDTH[st.target.local];
  return { width: w, ksl: w === 1 ? [name] : [...COMP.slice(0, w)].map((c) => `${name}.${c}`) };
}

/** KSL for `st`, its value `value` (width `width`) already emitted: one write per component (KSL has no swizzle writes). */
export function setKsl(st: SetStmt, value: string, width: number, em: KslEmitter & { line(text: string): void }): void {
  const t = setTarget(st);
  const v = em.tmp(t.width, fitKsl(value, width, t.width));
  t.ksl.forEach((dst, i) => {
    const src = t.width === 1 ? v : `${v}.${COMP[i]}`;
    em.line(`${dst} = ${st.mode === "set" ? src : `${dst} ${st.mode === "add" ? "+" : "*"} ${src}`};`);
  });
}

/** `st` as a JavaScript closure on the particle at `f.o`, its value from `value`. */
export function setJs(f: StepFrame, st: SetStmt, value: ValueFn): () => void {
  const mode = st.mode;
  const width = widthOf(st.e);
  const apply = (dst: { [i: number]: number }, j: number, x: number) => {
    dst[j] = mode === "set" ? x : mode === "add" ? dst[j] + x : dst[j] * x;
  };
  if ("attr" in st.target) {
    const [slot, comp, w] = ATTR[st.target.attr];
    const off = slot * 4 + comp;
    const src = fitSource(width, w);
    return () => {
      const v = value();
      for (let i = 0; i < w; i++) apply(f.s, f.o + off + i, src[i] < 0 ? 0 : v[src[i]]);
    };
  }
  const name = st.target.local;
  const src = fitSource(width, LOCAL_WIDTH[name]);
  return () => {
    const v = value();
    const t = f.loc[name];
    for (let i = 0; i < t.length; i++) apply(t, i, src[i] < 0 ? 0 : v[src[i]]);
  };
}
