// ADR 0325: the kernel operator catalogue. Every expression operator and the set statement are written once
// in KSL (what WGSL and GLSL compile) and once in JavaScript (what the JavaScript executor runs); here each
// one's KSL runs as JavaScript (the shader source module's third output, ADR 0250) next to its closure, on
// random arguments of every width, and they must agree. A KSL that doesn't type check (a `.xyz` on a vec2)
// fails here too.
import { describe, expect, it } from "vitest";
import { ATTR, KERNEL_FLOATS, LOCAL_WIDTH, resultWidth, type AttrName, type KExpr, type KLocal, type KOp } from "../scene/particleKernel";
import { KERNEL_MATH_SHADER } from "../render/particles/gpu/kernelMath";
import { fitKsl, KERNEL_OPS, KERNEL_OPS_KSL, setJs, setKsl, VEC, type OpExpr, type SetStmt, type ValueFn } from "../render/particles/gpu/kernelOps";
import { KERNEL_GLOBALS_KSL, type StepFrame } from "../render/particles/gpu/kernelSteps";
import { shaderSource } from "../render/shaderSource/shaderSource";

/** A seeded random source, so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** A random argument value: sometimes 0, 1 or -1, so safe division and equal edges are exercised. */
function value(r: () => number): number {
  const p = r();
  if (p < 0.25) return [0, 1, -1][Math.floor(r() * 3)];
  return Math.round((r() * 6 - 3) * 1000) / 1000;
}

/** A KSL emitter collecting temporaries, as a stage's. */
function emitter(): { lines: string[]; tmp(w: number, v: string): string; line(t: string): void } {
  let n = 0;
  const lines: string[] = [];
  return {
    lines,
    tmp(w, v) {
      const name = `t_${n++}`;
      lines.push(`VAR(${VEC[w]}, ${name}) = ${v};`);
      return name;
    },
    line: (t) => lines.push(t),
  };
}

const ksl = (v: number[]) => (v.length === 1 ? v[0] : v);
const konst = (v: number[]): ValueFn => {
  const a = Float64Array.from(v);
  return () => a;
};

/** Argument count and result widths each operator is tried with (by `resultWidth`, as the kernel compiler builds them). */
const SHAPES: Record<KOp, { n: number; widths: number[]; argWidths?: (w: number, r: () => number) => number[] }> = {
  add: { n: 2, widths: [1, 2, 3, 4] },
  sub: { n: 2, widths: [1, 2, 3, 4] },
  mul: { n: 2, widths: [1, 2, 3, 4] },
  div: { n: 2, widths: [1, 2, 3, 4] },
  neg: { n: 1, widths: [1, 2, 3, 4] },
  abs: { n: 1, widths: [1, 2, 3, 4] },
  min: { n: 2, widths: [1, 2, 3, 4] },
  max: { n: 2, widths: [1, 2, 3, 4] },
  clamp: { n: 3, widths: [1, 2, 3, 4] },
  lerp: { n: 3, widths: [1, 2, 3, 4] },
  remap: { n: 5, widths: [1, 2, 3, 4] },
  step: { n: 2, widths: [1, 2, 3, 4] },
  smoothstep: { n: 3, widths: [1, 2, 3, 4] },
  sin: { n: 1, widths: [1] },
  cos: { n: 1, widths: [1] },
  noise1: { n: 1, widths: [1] },
  vec: { n: 0, widths: [2, 3, 4], argWidths: (w, r) => split(w, r) },
  length: { n: 1, widths: [1], argWidths: (_w, r) => [1 + Math.floor(r() * 4)] },
  normalize: { n: 1, widths: [1, 2, 3, 4], argWidths: (w) => [w] },
  hsv: { n: 4, widths: [4], argWidths: (_w, r) => [0, 0, 0, 0].map(() => 1 + Math.floor(r() * 4)) },
  toLinear: { n: 1, widths: [1, 2, 3, 4], argWidths: (w) => [w] },
};

/** `w` split into random parts (a vec's arguments). */
function split(w: number, r: () => number): number[] {
  const out: number[] = [];
  for (let left = w; left > 0; ) {
    const n = 1 + Math.floor(r() * left);
    out.push(n);
    left -= n;
  }
  return out;
}

/** Component-wise arguments for result width `w`: numbers (they broadcast) or vectors of width `w` or wider (cut). */
function laneWidths(n: number, w: number, r: () => number): number[] {
  if (w === 1) return new Array<number>(n).fill(1);
  const ws = Array.from({ length: n }, () => (r() < 0.3 ? 1 : w + Math.floor(r() * (5 - w))));
  ws[Math.floor(r() * n)] = w;
  return ws;
}

describe("the kernel operators: one KSL and one JavaScript per operator, in agreement (ADR 0325)", () => {
  for (const op of Object.keys(KERNEL_OPS) as KOp[]) {
    it(op, () => {
      const r = rng(op.length * 7919 + op.charCodeAt(0));
      const shape = SHAPES[op];
      for (const w of shape.widths) {
        for (let trial = 0; trial < 30; trial++) {
          const widths = shape.argWidths ? shape.argWidths(w, r) : laneWidths(shape.n, w, r);
          const vals = widths.map((aw) => Array.from({ length: aw }, () => value(r)));
          // The kernel compiler's width rule; and the arguments as leaves (uniforms) of their widths.
          const args: KExpr[] = widths.map((aw, i) => ({ k: "uniform", slot: i, w: aw }));
          const e: OpExpr = { k: "op", op, args, w: resultWidth(op, args), seed: op === "noise1" ? Math.floor(r() * 50) : undefined };
          expect(e.w, `${op} result width`).toBe(w);

          // JavaScript.
          const out = new Float64Array(w);
          const js = [...KERNEL_OPS[op].js(e, vals.map(konst), out)()];

          // KSL.
          const em = emitter();
          const params = widths.map((aw, i) => `${VEC[aw]} p${i}`);
          const kargs = widths.map((aw, i) => ({ text: `p${i}`, width: aw, fitted: fitKsl(`p${i}`, aw, w) }));
          const body = KERNEL_OPS[op].ksl(e, kargs, w, em);
          const src = `FN(${VEC[w]}, t_op${params.length ? ", " : ""}${params.join(", ")}) {\n  ${em.lines.join("\n  ")}\n  return ${body};\n}\n`;
          const program = shaderSource(KERNEL_MATH_SHADER, KERNEL_OPS_KSL, src).js();
          const got = program.fn("t_op")(...vals.map(ksl));
          const gotArr = typeof got === "number" ? [got] : (got as number[]);

          const at = `${op} w${w} (${vals.map((v) => `[${v.join(", ")}]`).join(" ")})`;
          expect(gotArr.length, at).toBe(w);
          gotArr.forEach((x, i) => expect(x, `${at}[${i}]`).toBeCloseTo(js[i], 6));
        }
      }
    });
  }
});

/** KSL loading every global a set can write, and reading them back. */
const SET_GLUE = /* KSL */ `
FN(void, t_load, KV4 b0, KV4 b1, KV4 b2, KV4 b3, KV4 color, KF size, KF tile, KV3 spos, KV3 sdir, KF speedMod, KF t, KF idx) {
  a0 = b0;
  a1 = b1;
  a2 = b2;
  a3 = b3;
  k_oColor = color;
  k_oSize = size;
  k_oTile = tile;
  k_spos = spos;
  k_sdir = sdir;
  k_speedMod = speedMod;
  k_t = t;
  k_idx = idx;
}
`;

describe("the set statement: one KSL and one JavaScript, with one width-fit rule (ADR 0325)", () => {
  const attrs = Object.keys(ATTR) as AttrName[];
  const locals = (Object.keys(LOCAL_WIDTH) as KLocal[]).filter((l) => l !== "speed");
  const targets: SetStmt["target"][] = [...attrs.map((attr) => ({ attr })), ...locals.map((local) => ({ local }))];

  for (const target of targets) {
    const name = "attr" in target ? target.attr : target.local;
    it(name, () => {
      const r = rng(name.length * 104729 + name.charCodeAt(0));
      for (const mode of ["set", "add", "mul"] as const) {
        // Every value width into every target: a number broadcasts, a wider value is cut, a narrower one padded with zeros.
        for (let ew = 1; ew <= 4; ew++) {
          const v = Array.from({ length: ew }, () => value(r));
          const st: SetStmt = { s: "set", target, mode, e: { k: "uniform", slot: 0, w: ew } };
          const state = Array.from({ length: KERNEL_FLOATS }, () => value(r));
          const loc = {} as Record<KLocal, Float64Array>;
          for (const k of Object.keys(LOCAL_WIDTH) as KLocal[]) loc[k] = Float64Array.from({ length: LOCAL_WIDTH[k] }, () => value(r));

          // JavaScript.
          const s = Float32Array.from(state);
          const jsLoc = Object.fromEntries(Object.entries(loc).map(([k, a]) => [k, Float64Array.from(a)])) as Record<KLocal, Float64Array>;
          const f = { s, o: 0, loc: jsLoc } as StepFrame;
          setJs(f, st, konst(v))();

          // KSL.
          const em = emitter();
          setKsl(st, "p0", ew, em);
          const src = `FN(void, t_set, ${VEC[ew]} p0) {\n  ${em.lines.join("\n  ")}\n}\n`;
          const program = shaderSource(KERNEL_GLOBALS_KSL, SET_GLUE, src).js();
          const f32 = Float32Array.from(state);
          program.fn("t_load")(
            [...f32.subarray(0, 4)],
            [...f32.subarray(4, 8)],
            [...f32.subarray(8, 12)],
            [...f32.subarray(12, 16)],
            [...loc.oColor],
            loc.oSize[0],
            loc.oTile[0],
            [...loc.spos],
            [...loc.sdir],
            loc.speedMod[0],
            loc.t[0],
            loc.index[0],
          );
          program.fn("t_set")(ksl(v));

          const at = `${name} ${mode} from width ${ew}`;
          const got = ["a0", "a1", "a2", "a3"].flatMap((g) => program.global(g) as number[]);
          for (let i = 0; i < KERNEL_FLOATS; i++) expect(got[i], `${at}, state[${i}]`).toBeCloseTo(s[i], 4);
          const globals: Record<string, KLocal> = { k_oColor: "oColor", k_oSize: "oSize", k_oTile: "oTile", k_spos: "spos", k_sdir: "sdir", k_speedMod: "speedMod", k_t: "t", k_idx: "index" };
          for (const [g, l] of Object.entries(globals)) {
            const kv = program.global(g);
            const arr = typeof kv === "number" ? [kv] : (kv as number[]);
            arr.forEach((x, i) => expect(x, `${at}, ${l}[${i}]`).toBeCloseTo(jsLoc[l][i], 6));
          }
          // The rule itself: a narrower vector pads with zeros (both executors).
          if ("attr" in target && mode === "set" && ew > 1 && ew < ATTR[target.attr][2]) {
            const [slot, comp, aw] = ATTR[target.attr];
            for (let i = ew; i < aw; i++) expect(s[slot * 4 + comp + i], `${at}, padded component ${i}`).toBe(0);
          }
        }
      }
    });
  }
});
