// ADR 0251: the kernel steps catalogue. Every built-in step is written once in KSL (what WGSL and GLSL
// compile) and once in JavaScript (what the JavaScript executor runs); here each step's KSL runs as
// JavaScript (the shader source module's third output, ADR 0250) next to its JavaScript on random
// particles and uniforms, and they must agree.
import { describe, expect, it } from "vitest";
import { HEADER_VEC4, KERNEL_FLOATS, LOCAL_WIDTH, U, type KLocal } from "../scene/particleKernel";
import { KERNEL_MATH_SHADER } from "../render/particles/gpu/kernelMath";
import { KERNEL_GLOBALS_KSL, KERNEL_HELPERS_KSL, KERNEL_STEPS, shapeKsl, SHAPE_MODES, type BuiltinStmt, type StepFrame } from "../render/particles/gpu/kernelSteps";
import { shaderSource } from "../render/shaderSource/shaderSource";

/** A seeded random source, so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** What the dialect glue gives the steps in a shader: the header uniforms and the look-up table; and a loader for the globals. */
const GLUE = /* KSL */ `
UNIFORM(KV4[${HEADER_VEC4}], ku);
FN(KV4, k_lutAt, KI row, KI i) {
  return KV4(0.0);
}
FN(void, t_load, KV4 b0, KV4 b1, KV4 b2, KV4 b3, KF step, KF speedMod, KF rel, KV3 spos, KV3 sdir) {
  a0 = b0;
  a1 = b1;
  a2 = b2;
  a3 = b3;
  k_step = step;
  k_speedMod = speedMod;
  k_rel = rel;
  k_spos = spos;
  k_sdir = sdir;
  k_dies = 0.0;
  k_hasParent = 0.0;
  k_t = 0.0;
}
`;

const f32 = Math.fround;

/** A node transform (rotation about an axis, translation) and its inverse, as header columns. */
function transform(r: () => number): { m: number[]; inv: number[] } {
  const angle = r() * 6;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = [r() * 10 - 5, r() * 10 - 5, r() * 10 - 5];
  // Rotation about Y.
  const m = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, t[0], t[1], t[2], 1];
  const it = [-(c * t[0] - s * t[2]), -t[1], -(s * t[0] + c * t[2])];
  const inv = [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, it[0], it[1], it[2], 1];
  return { m, inv };
}

interface Case {
  args: number[][];
  st: BuiltinStmt;
  call: string;
}

describe("the kernel steps: one KSL and one JavaScript per step, in agreement (ADR 0251)", () => {
  const steps = Object.keys(KERNEL_STEPS) as (keyof typeof KERNEL_STEPS)[];

  for (const name of steps) {
    it(`${name}`, () => {
      const r = rng(name.length * 7919 + 1);
      for (let trial = 0; trial < 40; trial++) {
        const shapeType = ["point", "sphere", "hemisphere", "cone", "circle", "donut", "rectangle", "grid"][trial % 8];
        const shapeMode = ["random", "loop", "pingpong", "burst"][(trial >> 3) % 4];
        const program = shaderSource(KERNEL_MATH_SHADER, KERNEL_GLOBALS_KSL, GLUE, KERNEL_HELPERS_KSL, Object.values(KERNEL_STEPS).map((s) => s.ksl).join(""), shapeKsl(shapeType));
        // Uniforms: a header with a transform, a time, spawn numbers, world or local space.
        const u = new Float32Array(HEADER_VEC4 * 4);
        const { m, inv } = transform(r);
        u.set(m, U.matrix * 4);
        u.set(inv, U.inverse * 4);
        u[U.time * 4] = r() * 20;
        u[U.time * 4 + 1] = 1 / 60;
        u[U.spawn * 4 + 1] = 1 + Math.floor(r() * 30);
        u[U.spawn * 4 + 2] = 64;
        u[U.misc * 4] = Math.floor(r() * 100);
        u[U.flags * 4 + 2] = r() < 0.5 ? 1 : 0;
        const ku = Array.from({ length: HEADER_VEC4 }, (_, i) => [...u.subarray(i * 4, i * 4 + 4)]);
        const ksl = program.js({ uniforms: { ku } });
        // A particle.
        const s = new Float32Array(KERNEL_FLOATS);
        for (let i = 0; i < KERNEL_FLOATS; i++) s[i] = r() * 4 - 2;
        s[3] = r() * 2; // age
        s[7] = 0.5 + r() * 3; // lifetime
        s[15] = f32(r()); // seed
        const step = f32(r() * 0.05);
        const speedMod = f32(0.5 + r());
        const rel = Math.floor(r() * 20);
        const spos = [f32(r() - 0.5), f32(r() - 0.5), f32(r() - 0.5)];
        const sdir = [f32(r() - 0.5), f32(r() - 0.5), f32(r() - 0.5)];
        const v3 = () => [f32(r() * 4 - 2), f32(r() * 4 - 2), f32(r() * 4 - 2)];
        const sc = () => f32(r() * 3);
        const cases: Record<typeof name, () => Case> = {
          age: () => ({ args: [], st: builtin("age"), call: "k_age" }),
          gravity: () => ({ args: [[sc()]], st: builtin("gravity"), call: "k_gravity" }),
          force: () => ({ args: [v3()], st: builtin("force"), call: "k_force" }),
          gpoint: () => ({ args: [v3(), [sc()]], st: builtin("gpoint"), call: "k_gpoint" }),
          turbulence: () => ({ args: [v3().map((x) => x + 3), [1 + Math.floor(r() * 4)], v3(), v3()], st: builtin("turbulence"), call: "k_turbulence" }),
          limit: () => ({ args: [[sc()], [f32(r())]], st: builtin("limit"), call: "k_limit" }),
          integrate: () => ({ args: [], st: builtin("integrate"), call: "k_integrate" }),
          noise: () => ({ args: [[sc()], [sc()], [f32(r())], [f32(r())]], st: { ...builtin("noise"), index: trial % 3 }, call: "k_noise" }),
          orbit: () => ({ args: [[f32(r() * 360)], v3()], st: builtin("orbit"), call: "k_orbit" }),
          plane: () => ({ args: [[f32(r() * 2 - 1)], [f32(r())], [trial % 2]], st: builtin("plane"), call: "k_plane" }),
          spin: () => ({ args: [[f32(r() * 360)]], st: builtin("spin"), call: "k_spin" }),
          place: () => ({ args: [v3(), [sc()]], st: builtin("place"), call: "k_place" }),
          shape: () => ({
            args: [[f32(r() * 2)], [f32(r() * 60)], [f32(r() * 360)], [f32(r())], [f32(r() * 3)], [f32(r() * 3)], [f32(r())], [1 + Math.floor(r() * 4)], [1 + Math.floor(r() * 4)], [trial % 4 === 0 ? 0 : f32(r() * 0.3)]],
            st: { ...builtin("shape"), shape: { type: shapeType, mode: shapeMode } },
            call: "k_shape",
          }),
        };
        const c = cases[name]();

        // JavaScript.
        const loc = {} as Record<KLocal, Float64Array>;
        for (const k of Object.keys(LOCAL_WIDTH) as KLocal[]) loc[k] = new Float64Array(LOCAL_WIDTH[k]);
        loc.speedMod[0] = speedMod;
        loc.spos.set(spos);
        loc.sdir.set(sdir);
        const js = new Float32Array(s);
        const frame: StepFrame = { s: js, o: 0, idx: 0, rel, u, lut: new Float32Array(4), loc, step, dies: false, parent: null, capacity: 64 };
        KERNEL_STEPS[name].js(frame, c.args.map((a) => Float64Array.from(a)), c.st);

        // KSL.
        ksl.fn("t_load")([...s.subarray(0, 4)], [...s.subarray(4, 8)], [...s.subarray(8, 12)], [...s.subarray(12, 16)], step, speedMod, rel, spos, sdir);
        const callArgs: (number | number[])[] = c.args.map((a) => (a.length === 1 ? a[0] : a));
        if (name === "noise") callArgs.push(c.st.index ?? 0);
        if (name === "shape") callArgs.push(SHAPE_MODES[shapeMode]);
        ksl.fn(c.call)(...callArgs);
        const got = ["a0", "a1", "a2", "a3"].flatMap((g) => ksl.global(g) as number[]);

        const at = `${name} trial ${trial}${name === "shape" ? ` (${shapeType}, ${shapeMode})` : ""}`;
        for (let i = 0; i < KERNEL_FLOATS; i++) expect(got[i], `${at}, state[${i}]`).toBeCloseTo(js[i], 3);
        expect(ksl.global("k_dies") === 1, `${at}, dies`).toBe(frame.dies);
        if (name === "age") {
          expect(ksl.global("k_step"), `${at}, step`).toBeCloseTo(frame.step, 5);
          expect(ksl.global("k_t"), `${at}, t`).toBeCloseTo(loc.t[0], 5);
        }
        if (name === "shape") {
          (ksl.global("k_spos") as number[]).forEach((v, i) => expect(v, `${at}, spos[${i}]`).toBeCloseTo(loc.spos[i], 4));
          (ksl.global("k_sdir") as number[]).forEach((v, i) => expect(v, `${at}, sdir[${i}]`).toBeCloseTo(loc.sdir[i], 4));
        }
      }
    });
  }
});

function builtin(b: BuiltinStmt["b"]): BuiltinStmt {
  return { s: "builtin", b, args: [] };
}
