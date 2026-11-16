// Test helper: runs the scalar and small-vector maths of a shader snippet (GLSL or WGSL, as a render
// feature emits it) in JavaScript, so a test can check what the GPU would compute without a GPU. It
// handles the subset Myco's fragment snippets use: `#ifdef`/`#ifndef`/`#else`/`#endif`, functions,
// `float`/`vecN` (GLSL) and `let`/`var` (WGSL) locals, `if`, the ternary, swizzles, the built-ins
// below, and `(matrix * vec4(...))` where the test gives the matrix as a function. Textures are
// whatever the test passes as `texture2D`/`textureLoad`.

/** A shader vector: components with `xyzw`/`rgba` names and two- and three-letter swizzles. */
export class Vec {
  readonly c: number[];
  constructor(c: number[]) {
    this.c = c;
  }
}
const NAMES: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
for (const [name, i] of Object.entries(NAMES)) {
  Object.defineProperty(Vec.prototype, name, {
    get(this: Vec) {
      return this.c[i];
    },
    set(this: Vec, v: number) {
      this.c[i] = v;
    },
  });
}
for (const swizzle of ["xy", "yz", "xz", "xyz", "rgb", "rg"]) {
  Object.defineProperty(Vec.prototype, swizzle, {
    get(this: Vec) {
      return new Vec([...swizzle].map((n) => this.c[NAMES[n]!]!));
    },
  });
}

/** A vector from numbers and vectors, flattened (`vec4(v3, 1.0)`); one number fills every component. */
export function vec(size: number, ...parts: (number | Vec)[]): Vec {
  const flat = parts.flatMap((p) => (typeof p === "number" ? [p] : p.c));
  return new Vec(flat.length === 1 ? Array(size).fill(flat[0]) : flat.slice(0, size));
}

const each = (a: number | Vec, f: (x: number, i: number) => number): number | Vec => (typeof a === "number" ? f(a, 0) : new Vec(a.c.map(f)));
const at = (v: number | Vec, i: number): number => (typeof v === "number" ? v : v.c[i]!);

const BUILTINS = {
  exp: (a: number | Vec) => each(a, Math.exp),
  abs: (a: number | Vec) => each(a, Math.abs),
  max: (a: number | Vec, b: number | Vec) => each(a, (x, i) => Math.max(x, at(b, i))),
  min: (a: number | Vec, b: number | Vec) => each(a, (x, i) => Math.min(x, at(b, i))),
  clamp: (a: number | Vec, lo: number | Vec, hi: number | Vec) => each(a, (x, i) => Math.min(Math.max(x, at(lo, i)), at(hi, i))),
  mix: (a: number | Vec, b: number | Vec, t: number | Vec) => each(a, (x, i) => x + (at(b, i) - x) * at(t, i)),
  distance: (a: Vec, b: Vec) => Math.hypot(...a.c.map((x, i) => x - b.c[i]!)),
  vec2: (...p: (number | Vec)[]) => vec(2, ...p),
  vec3: (...p: (number | Vec)[]) => vec(3, ...p),
  vec4: (...p: (number | Vec)[]) => vec(4, ...p),
  vec2f: (...p: (number | Vec)[]) => vec(2, ...p),
  vec3f: (...p: (number | Vec)[]) => vec(3, ...p),
  vec4f: (...p: (number | Vec)[]) => vec(4, ...p),
  vec2i: (...p: (number | Vec)[]) => vec(2, ...p),
  /** `(m * v)`: the test gives matrices as functions of the vector. */
  mul: (m: (v: Vec) => Vec, v: Vec) => m(v),
};

/** The snippet with only the branches `defines` select. */
function preprocess(source: string, defines: readonly string[]): string {
  const out: string[] = [];
  const stack: { taking: boolean; parent: boolean }[] = [];
  const taking = () => stack.every((s) => s.taking);
  for (const line of source.split("\n")) {
    const t = line.trim();
    const m = /^#(ifdef|ifndef)\s+(\w+)/.exec(t);
    if (m) {
      const has = defines.includes(m[2]!);
      stack.push({ taking: m[1] === "ifdef" ? has : !has, parent: taking() });
    } else if (t.startsWith("#else")) {
      const top = stack[stack.length - 1]!;
      top.taking = !top.taking;
    } else if (t.startsWith("#endif")) {
      stack.pop();
    } else if (!t.startsWith("#") && taking()) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** The snippet as JavaScript. */
function translate(source: string, defines: readonly string[]): string {
  return (
    preprocess(source, defines)
      // Uniform declarations: the test passes uniforms by name.
      .replace(/^\s*uniform\b.*$/gm, "")
      // fn name(a: vec3f, b: vec3f) -> f32 {
      .replace(/\bfn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*[\w<>]+\s*)?\{/g, (_m, name: string, params: string) => `function ${name}(${params.split(",").map((p) => p.split(":")[0]!.trim()).filter(Boolean).join(", ")}) {`)
      // float name(vec3 a, vec3 b) {
      .replace(/\b(?:float|vec[234]|int|bool|void)\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (_m, name: string, params: string) => `function ${name}(${params.split(",").map((p) => p.trim().split(/\s+/).pop()!).filter(Boolean).join(", ")}) {`)
      // Locals.
      .replace(/\b(?:float|vec[234]|int|bool)\s+(\w+)\s*=/g, "let $1 =")
      .replace(/\bvar\s+(\w+)(?:\s*:\s*[\w<>]+)?\s*=/g, "let $1 =")
      .replace(/\blet\s+(\w+)\s*:\s*[\w<>]+\s*=/g, "let $1 =")
      // (matrix * vec4(...))
      .replace(/\(([\w.]+)\s*\*\s*(vec4f?\([^()]*\))\)/g, "mul($1, $2)")
  );
}

/**
 * Run `source` (a GLSL or WGSL snippet) with `defines` on, then `result` (a JavaScript expression over
 * its functions and variables) and return its value. `env` gives the snippet's inputs: uniforms,
 * varyings, the colour it writes, textures as functions.
 */
export function runShader(source: string, options: { defines?: readonly string[]; env?: Record<string, unknown>; result: string }): unknown {
  const env = { ...BUILTINS, ...options.env };
  const names = Object.keys(env);
  const body = `${translate(source, options.defines ?? [])}\nreturn (${options.result});`;
  return new Function(...names, body)(...names.map((n) => env[n as keyof typeof env]));
}
