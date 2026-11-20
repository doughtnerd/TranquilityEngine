/**
 * Internal (ADR 0250): the shader source module. Shader functions are written once, in KSL (a small
 * shader source language, first written for the particle kernels, ADR 0094), and this module turns
 * that one text into WGSL (WebGPU), GLSL ES 3.0 (the WebGL2 fallback) and JavaScript (a callable
 * program, so a test, or the CPU, runs the very maths the GPU compiles). No renderer here.
 *
 * KSL is the common subset of WGSL and GLSL, with macros where the two spell things differently:
 * - types `KF`, `KV2`, `KV3`, `KV4`, `KU`, `KI`, `KB`, `KM3` (f32/float, vec2f/vec2, …, mat3x3f/mat3),
 *   and fixed arrays `T[N]` (`array<T, N>` / `T name[N]`), with constructors `T[N](a, b, …)`;
 * - `VAR(T, name)` for a mutable local, `GLOBAL(T, name);` for a private global,
 *   `CONST(T, name) = value;` for a constant;
 * - `FN(R, name, T a, T b) {` for a function (R may be `void`); parameters are never assigned (WGSL
 *   parameters are immutable);
 * - `UNIFORM(T, name);` declares a uniform and `UNI(name)` reads it (`uniforms.name` in Babylon's WGSL,
 *   `name` in GLSL); `TEXTURE2D(name);` declares a texture and `KTEX(name, uv)` samples it at level 0.
 *   With `{ declarations: "omit" }` the declarations are left out (a material plugin's uniform buffer and
 *   samplers declare them);
 * - `KBITU(i)` reinterprets an int as uint; `select(f, t, cond)` (scalar `cond`) and `atan2(y, x)` are
 *   spelled for each language;
 * - braces around every `if`/`for` body, no ternaries, no multi-component swizzle writes, no implicit
 *   int/float conversions (a literal with `.` or `e` is a float, `u` a uint, else an int), no vector
 *   comparisons, scalar-vector maths only where both languages allow it (`v * s`, `v + s`; `max(v, KV3(0.0))`
 *   not `max(v, 0.0)`), and parentheses around every mix of bitwise and arithmetic operators;
 * - preprocessor lines (`#ifdef`, `#if defined(…)`, `#else`, `#endif`) pass through to WGSL and GLSL
 *   (Babylon runs them) and are evaluated with `defines` in JavaScript.
 *
 * Language-specific glue (Babylon's injection points, entry points, varyings, Babylon's own helper
 * functions) stays outside KSL, in the module that owns it.
 */
import { compileKsl, type KslJsOptions, type KslProgram, type KslValue } from "./kslJs";

export type { KslJsOptions, KslProgram, KslValue };

export type ShaderDialect = "wgsl" | "glsl";

/** How `text` treats `UNIFORM` and `TEXTURE2D` declarations. */
export interface ShaderTextOptions {
  /** "declare" (default): write them out; "omit": leave them out (they are declared elsewhere). */
  declarations?: "declare" | "omit";
}

/** One shader text in KSL, with its three outputs. */
export interface ShaderSource {
  /** The KSL text. */
  readonly ksl: string;
  /** The text in WGSL or GLSL. */
  text(dialect: ShaderDialect, options?: ShaderTextOptions): string;
  /** The text as a JavaScript program (its functions, callable; uniforms, textures and defines from `options`). */
  js(options?: KslJsOptions): KslProgram;
}

/** A shader source of KSL text and other sources, joined in order. */
export function shaderSource(...parts: (string | ShaderSource)[]): ShaderSource {
  const text = parts.map((p) => (typeof p === "string" ? p : p.ksl)).join("");
  return {
    ksl: text,
    text: (dialect, options) => translate(text, dialect, options),
    js: (options) => compileKsl(text, options),
  };
}

/** A float literal both languages (and KSL) accept. */
export function fl(n: number): string {
  if (!Number.isFinite(n)) n = n > 0 ? 3.4e38 : n < 0 ? -3.4e38 : 0;
  const s = String(n);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

// --- KSL to WGSL / GLSL ---------------------------------------------------------------------------------

const TYPES: Record<ShaderDialect, Record<string, string>> = {
  wgsl: { KF: "f32", KV2: "vec2f", KV3: "vec3f", KV4: "vec4f", KU: "u32", KI: "i32", KB: "bool", KM3: "mat3x3f" },
  glsl: { KF: "float", KV2: "vec2", KV3: "vec3", KV4: "vec4", KU: "uint", KI: "int", KB: "bool", KM3: "mat3" },
};

/** Split a parameter list at top-level commas. */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Replace every call `name(args)` (balanced parentheses) with `f(args)`. */
function replaceCalls(src: string, name: string, f: (args: string[]) => string): string {
  const re = new RegExp(`\\b${name}\\(`, "g");
  let out = "";
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out += src.slice(last, m.index) + f(splitParams(src.slice(m.index + m[0].length, i - 1)));
    last = i;
    re.lastIndex = i;
  }
  return out + src.slice(last);
}

const TYPE = String.raw`\w+(?:\[\d+\])?`;

/** A declaration of `name` with KSL type `t` (maybe an array), in `dialect`, before type words are mapped. */
function declare(t: string, name: string, dialect: ShaderDialect, keyword: string): string {
  const arr = /^(\w+)\[(\d+)\]$/.exec(t);
  if (dialect === "glsl") return `${keyword ? `${keyword} ` : ""}${arr ? `${arr[1]} ${name}[${arr[2]}]` : `${t} ${name}`}`;
  return `${keyword} ${name}: ${arr ? `array<${arr[1]}, ${arr[2]}>` : t}`;
}

function translate(src: string, dialect: ShaderDialect, options: ShaderTextOptions = {}): string {
  const omit = options.declarations === "omit";
  let s = src;
  s = s.replace(/FN\(([^,]+),\s*(\w+)((?:,[^)]*)?)\)\s*\{/g, (_m, ret: string, name: string, rest: string) => {
    const params = splitParams(rest.replace(/^,/, "")).map((p) => p.split(/\s+/));
    if (dialect === "glsl") return `${ret.trim()} ${name}(${params.map(([t, n]) => declare(t, n, "glsl", "")).join(", ")}) {`;
    const r = ret.trim() === "void" ? "" : ` -> ${ret.trim()}`;
    return `fn ${name}(${params.map(([t, n]) => declare(t, n, "wgsl", "").trim()).join(", ")})${r} {`;
  });
  s = s.replace(new RegExp(String.raw`VAR\((${TYPE}),\s*(\w+)\)`, "g"), (_m, t: string, n: string) => declare(t, n, dialect, dialect === "glsl" ? "" : "var"));
  s = s.replace(new RegExp(String.raw`GLOBAL\((${TYPE}),\s*(\w+)\)`, "g"), (_m, t: string, n: string) => declare(t, n, dialect, dialect === "glsl" ? "" : "var<private>"));
  s = s.replace(new RegExp(String.raw`CONST\((${TYPE}),\s*(\w+)\)`, "g"), (_m, t: string, n: string) => declare(t, n, dialect, "const"));
  s = s.replace(new RegExp(String.raw`[ \t]*UNIFORM\((${TYPE}),\s*(\w+)\);[ \t]*\n?`, "g"), (_m, t: string, n: string) => (omit ? "" : `${declare(t, n, dialect, "uniform")};\n`));
  s = s.replace(/[ \t]*TEXTURE2D\((\w+)\);[ \t]*\n?/g, (_m, n: string) =>
    omit ? "" : dialect === "glsl" ? `uniform sampler2D ${n};\n` : `var ${n}Sampler: sampler;\nvar ${n}: texture_2d<f32>;\n`,
  );
  s = s.replace(/\bUNI\((\w+)\)/g, (_m, n: string) => (dialect === "glsl" ? n : `uniforms.${n}`));
  s = replaceCalls(s, "KTEX", ([n, uv]) => (dialect === "glsl" ? `texture2D(${n}, ${uv})` : `textureSampleLevel(${n}, ${n}Sampler, ${uv}, 0.0)`));
  // Array constructors: `T[N](` → `array<T, N>(` in WGSL; GLSL spells them the same as KSL.
  if (dialect === "wgsl") s = s.replace(/\b(\w+)\[(\d+)\]\(/g, (m, t: string, n: string) => (t in TYPES.wgsl ? `array<${t}, ${n}>(` : m));
  if (dialect === "glsl") {
    s = replaceCalls(s, "select", ([f, t, c]) => `((${c}) ? (${t}) : (${f}))`);
    s = s.replace(/\batan2\(/g, "atan(");
  }
  s = s.replace(/KBITU\(/g, dialect === "glsl" ? "uint(" : "bitcast<u32>(");
  const types = TYPES[dialect];
  s = s.replace(/\b(KF|KV2|KV3|KV4|KU|KI|KB|KM3)\b/g, (t) => types[t]);
  return s;
}
