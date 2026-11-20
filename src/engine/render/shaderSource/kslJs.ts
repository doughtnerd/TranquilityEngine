/**
 * Internal (ADR 0250): KSL as JavaScript. Parses the KSL text (`shaderSource.ts` describes the
 * language), checks its types and compiles each function to closures (no `eval`, so it runs under a
 * strict CSP). Scalars are numbers (bools are booleans), vectors arrays of numbers, `KM3` an array of
 * three column vectors and `T[N]` an array. Integer maths wraps as on the GPU: `KU` is a uint32
 * (`Math.imul`, `>>>`), `KI` an int32; floats are doubles (the GPU's f32 rounds, so compare with a
 * tolerance).
 */

/** A KSL value in JavaScript. */
export type KslValue = number | boolean | number[] | number[][] | KslValue[];

export interface KslJsOptions {
  /** Preprocessor names defined (`#ifdef NAME`). */
  defines?: readonly string[];
  /** Uniform values by name (`UNI(name)`), read at each access, so they may change between calls. */
  uniforms?: Record<string, KslValue>;
  /** Textures by name (`KTEX(name, uv)`): uv → rgba. */
  textures?: Record<string, (uv: number[]) => number[]>;
}

/** A compiled KSL text. */
export interface KslProgram {
  /** The function `name` of the text, callable with KSL values. */
  fn(name: string): (...args: KslValue[]) => KslValue;
  /** The current value of a `GLOBAL`. */
  global(name: string): KslValue;
}

export function compileKsl(src: string, options: KslJsOptions = {}): KslProgram {
  return new Compiler(parse(tokenize(preprocess(src, options.defines ?? []))), options).program();
}

// --- preprocessor ---------------------------------------------------------------------------------------

/** Evaluate an `#if` condition: `defined(X)`, `!`, `&&`, `||`, parentheses. */
function evalCondition(cond: string, defined: Set<string>): boolean {
  const toks = cond.match(/defined\s*\(\s*\w+\s*\)|&&|\|\||!|\(|\)|\w+/g) ?? [];
  let i = 0;
  const or = (): boolean => {
    let v = and();
    while (toks[i] === "||") {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  const and = (): boolean => {
    let v = unary();
    while (toks[i] === "&&") {
      i++;
      const r = unary();
      v = v && r;
    }
    return v;
  };
  const unary = (): boolean => {
    const t = toks[i++];
    if (t === "!") return !unary();
    if (t === "(") {
      const v = or();
      i++;
      return v;
    }
    const m = /defined\s*\(\s*(\w+)\s*\)/.exec(t ?? "");
    if (m) return defined.has(m[1]);
    if (t !== undefined && /^\d+$/.test(t)) return Number(t) !== 0;
    return t !== undefined && defined.has(t);
  };
  return or();
}

function preprocess(src: string, defines: readonly string[]): string {
  const defined = new Set(defines);
  const out: string[] = [];
  const stack: { taking: boolean; done: boolean }[] = [];
  const taking = () => stack.every((s) => s.taking);
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("#")) {
      out.push(taking() ? line : "");
      continue;
    }
    out.push("");
    const m = /^#\s*(\w+)\s*(.*)$/.exec(t);
    if (!m) continue;
    const [, dir, rest] = m;
    if (dir === "ifdef" || dir === "ifndef") {
      const has = defined.has(rest.trim());
      const v = dir === "ifdef" ? has : !has;
      stack.push({ taking: v, done: v });
    } else if (dir === "if") {
      const v = evalCondition(rest, defined);
      stack.push({ taking: v, done: v });
    } else if (dir === "elif") {
      const top = stack[stack.length - 1];
      const v = !top.done && evalCondition(rest, defined);
      top.taking = v;
      top.done ||= v;
    } else if (dir === "else") {
      const top = stack[stack.length - 1];
      top.taking = !top.done;
      top.done = true;
    } else if (dir === "endif") {
      stack.pop();
    } else if (dir === "define" && taking()) {
      defined.add(rest.trim().split(/\s+/)[0]);
    }
  }
  return out.join("\n");
}

// --- tokens ---------------------------------------------------------------------------------------------

type Tok = { k: "id" | "num" | "op"; v: string; line: number };

const OPS = ["<<=", ">>=", "+=", "-=", "*=", "/=", "%=", "^=", "&=", "|=", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "++", "--"];

function tokenize(src: string): Tok[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
  const toks: Tok[] = [];
  let line = 1;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = s.slice(i);
    const num = /^(?:0[xX][0-9a-fA-F]+u?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[uf]?)/.exec(rest);
    if (num && /[\d.]/.test(c) && !(c === "." && !/^\.\d/.test(rest))) {
      toks.push({ k: "num", v: num[0], line });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_]\w*/.exec(rest);
    if (id) {
      toks.push({ k: "id", v: id[0], line });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => rest.startsWith(o)) ?? c;
    toks.push({ k: "op", v: op, line });
    i += op.length;
  }
  return toks;
}

// --- syntax ---------------------------------------------------------------------------------------------

type Expr =
  | { k: "num"; v: number; t: Type }
  | { k: "id"; name: string }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "arr"; t: Type; args: Expr[] }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "un"; op: string; a: Expr }
  | { k: "mem"; a: Expr; sw: string }
  | { k: "idx"; a: Expr; i: Expr };

type Stmt =
  | { k: "var"; t: Type; name: string; init: Expr | null; constant: boolean }
  | { k: "assign"; op: string; target: Expr; value: Expr }
  | { k: "incdec"; op: string; target: Expr }
  | { k: "expr"; e: Expr }
  | { k: "if"; c: Expr; then: Stmt[]; else: Stmt[] | null }
  | { k: "for"; init: Stmt | null; cond: Expr | null; update: Stmt | null; body: Stmt[] }
  | { k: "break" }
  | { k: "continue" }
  | { k: "return"; e: Expr | null }
  | { k: "block"; body: Stmt[] };

interface FnDecl {
  ret: Type;
  name: string;
  params: { t: Type; name: string }[];
  body: Stmt[];
}

interface Unit {
  fns: FnDecl[];
  globals: { t: Type; name: string; init: Expr | null; constant: boolean }[];
  uniforms: Map<string, Type>;
  textures: Set<string>;
}

/** Types: "f" "i" "u" "b" "v2" "v3" "v4" "m3" "void", or an array "T[N]". */
type Type = string;
const KTYPES: Record<string, Type> = { KF: "f", KI: "i", KU: "u", KB: "b", KV2: "v2", KV3: "v3", KV4: "v4", KM3: "m3", void: "void" };

function parse(toks: Tok[]): Unit {
  let p = 0;
  const peek = (o = 0): Tok | undefined => toks[p + o];
  const fail = (msg: string): never => {
    const t = peek() ?? toks[toks.length - 1];
    throw new Error(`KSL: ${msg} (line ${t?.line ?? 0}, at "${t?.v ?? "end"}")`);
  };
  const is = (v: string, o = 0) => peek(o)?.v === v;
  const eat = (v: string): Tok => {
    if (!is(v)) fail(`expected "${v}"`);
    return toks[p++];
  };
  const ident = (): string => {
    const t = peek();
    if (t?.k !== "id") fail("expected a name");
    p++;
    return t!.v;
  };
  /** A KSL type word, maybe with `[N]`. */
  const type = (): Type => {
    const w = ident();
    const base = KTYPES[w];
    if (!base) fail(`unknown type ${w}`);
    if (is("[") && peek(1)?.k === "num" && is("]", 2)) {
      p++;
      const n = toks[p++].v;
      p++;
      return `${base}[${parseInt(n, 10)}]`;
    }
    return base;
  };

  const unit: Unit = { fns: [], globals: [], uniforms: new Map(), textures: new Set() };

  const PREC: Record<string, number> = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };

  const primary = (): Expr => {
    const t = peek();
    if (!t) return fail("unexpected end");
    if (t.v === "(") {
      p++;
      const e = expr();
      eat(")");
      return e;
    }
    if (t.k === "num") {
      p++;
      let v = t.v;
      let ty: Type = "i";
      if (/u$/.test(v)) {
        ty = "u";
        v = v.slice(0, -1);
      } else if (/f$/.test(v) && !/^0x/i.test(v)) {
        ty = "f";
        v = v.slice(0, -1);
      } else if (!/^0x/i.test(v) && /[.eE]/.test(v)) ty = "f";
      return { k: "num", v: Number(v), t: ty };
    }
    if (t.k === "id") {
      p++;
      if (t.v === "true" || t.v === "false") return { k: "num", v: t.v === "true" ? 1 : 0, t: "b" };
      // Array constructor T[N](…)
      if (KTYPES[t.v] && is("[") && peek(1)?.k === "num" && is("]", 2) && is("(", 3)) {
        p++;
        const n = parseInt(toks[p++].v, 10);
        p++;
        return { k: "arr", t: `${KTYPES[t.v]}[${n}]`, args: argList() };
      }
      if (is("(")) return { k: "call", name: t.v, args: argList() };
      return { k: "id", name: t.v };
    }
    return fail("unexpected token");
  };
  const argList = (): Expr[] => {
    eat("(");
    const args: Expr[] = [];
    while (!is(")")) {
      args.push(expr());
      if (!is(")")) eat(",");
    }
    eat(")");
    return args;
  };
  const postfix = (): Expr => {
    let e = primary();
    for (;;) {
      if (is(".")) {
        p++;
        e = { k: "mem", a: e, sw: ident() };
      } else if (is("[")) {
        p++;
        const i = expr();
        eat("]");
        e = { k: "idx", a: e, i };
      } else return e;
    }
  };
  const unary = (): Expr => {
    if (is("-") || is("!") || is("~") || is("+")) {
      const op = toks[p++].v;
      const a = unary();
      return op === "+" ? a : { k: "un", op, a };
    }
    return postfix();
  };
  const binary = (min: number): Expr => {
    let a = unary();
    for (;;) {
      const op = peek()?.v ?? "";
      const prec = peek()?.k === "op" ? PREC[op] : undefined;
      if (prec === undefined || prec < min) return a;
      p++;
      const b = binary(prec + 1);
      a = { k: "bin", op, a, b };
    }
  };
  const expr = (): Expr => binary(1);

  const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "^=", "&=", "|=", "<<=", ">>="]);

  /** A statement without its `;` (for `for` headers too). */
  const simple = (): Stmt => {
    if (is("VAR") && is("(", 1)) {
      p++;
      eat("(");
      const t = type();
      eat(",");
      const name = ident();
      eat(")");
      let init: Expr | null = null;
      if (is("=")) {
        p++;
        init = expr();
      }
      return { k: "var", t, name, init, constant: false };
    }
    if (is("CONST") && is("(", 1)) {
      p++;
      eat("(");
      const t = type();
      eat(",");
      const name = ident();
      eat(")");
      eat("=");
      return { k: "var", t, name, init: expr(), constant: true };
    }
    const e = expr();
    if (is("++") || is("--")) return { k: "incdec", op: toks[p++].v, target: e };
    const op = peek()?.v ?? "";
    if (ASSIGN.has(op)) {
      p++;
      return { k: "assign", op, target: e, value: expr() };
    }
    return { k: "expr", e };
  };
  const block = (): Stmt[] => {
    eat("{");
    const body: Stmt[] = [];
    while (!is("}")) body.push(statement());
    eat("}");
    return body;
  };
  const statement = (): Stmt => {
    if (is("{")) return { k: "block", body: block() };
    if (is("if")) {
      p++;
      eat("(");
      const c = expr();
      eat(")");
      const then = is("{") ? block() : [statement()];
      let els: Stmt[] | null = null;
      if (is("else")) {
        p++;
        els = is("{") ? block() : [statement()];
      }
      return { k: "if", c, then, else: els };
    }
    if (is("for")) {
      p++;
      eat("(");
      const init = is(";") ? null : simple();
      eat(";");
      const cond = is(";") ? null : expr();
      eat(";");
      const update = is(")") ? null : simple();
      eat(")");
      return { k: "for", init, cond, update, body: is("{") ? block() : [statement()] };
    }
    if (is("break")) {
      p++;
      eat(";");
      return { k: "break" };
    }
    if (is("continue")) {
      p++;
      eat(";");
      return { k: "continue" };
    }
    if (is("return")) {
      p++;
      const e = is(";") ? null : expr();
      eat(";");
      return { k: "return", e };
    }
    const s = simple();
    eat(";");
    return s;
  };

  while (p < toks.length) {
    if (is(";")) {
      p++;
      continue;
    }
    const w = peek()!.v;
    if (w === "FN") {
      p++;
      eat("(");
      const ret = type();
      eat(",");
      const name = ident();
      const params: { t: Type; name: string }[] = [];
      while (is(",")) {
        p++;
        params.push({ t: type(), name: ident() });
      }
      eat(")");
      unit.fns.push({ ret, name, params, body: block() });
    } else if (w === "GLOBAL") {
      p++;
      eat("(");
      const t = type();
      eat(",");
      const name = ident();
      eat(")");
      eat(";");
      unit.globals.push({ t, name, init: null, constant: false });
    } else if (w === "CONST") {
      const s = simple() as Extract<Stmt, { k: "var" }>;
      eat(";");
      unit.globals.push(s);
    } else if (w === "UNIFORM") {
      p++;
      eat("(");
      const t = type();
      eat(",");
      unit.uniforms.set(ident(), t);
      eat(")");
      eat(";");
    } else if (w === "TEXTURE2D") {
      p++;
      eat("(");
      unit.textures.add(ident());
      eat(")");
      eat(";");
    } else fail("expected FN, GLOBAL, CONST, UNIFORM or TEXTURE2D");
  }
  return unit;
}

// --- types and closures ---------------------------------------------------------------------------------

type Frame = KslValue[];
type Ev = (f: Frame) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A compiled statement: 0 runs on, 1 break, 2 continue, 3 return (the value in frame slot 0). */
type Ex = (f: Frame) => number;

const SIZE: Record<string, number> = { v2: 2, v3: 3, v4: 4 };
const isVec = (t: Type) => t === "v2" || t === "v3" || t === "v4";
const isScalar = (t: Type) => t === "f" || t === "i" || t === "u" || t === "b";
const vecOf = (n: number): Type => (n === 1 ? "f" : `v${n}`);
const arrayOf = (t: Type): { elem: Type; n: number } | null => {
  const m = /^(.*)\[(\d+)\]$/.exec(t);
  return m ? { elem: m[1], n: Number(m[2]) } : null;
};
const SWZ: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

/** A fresh copy of a value (vectors, matrices and arrays are values in KSL). */
function copy(v: KslValue): KslValue {
  return Array.isArray(v) ? (v as KslValue[]).map(copy) : v;
}

function zero(t: Type): KslValue {
  const arr = arrayOf(t);
  if (arr) return Array.from({ length: arr.n }, () => zero(arr.elem));
  if (isVec(t)) return new Array(SIZE[t]).fill(0);
  if (t === "m3") return [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  return t === "b" ? false : 0;
}

const toU = (x: number) => (x <= 0 ? 0 : x >= 4294967295 ? 4294967295 : Math.trunc(x) >>> 0);
const toI = (x: number) => (x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : Math.trunc(x) | 0);

/** Component-wise unary over a scalar or vector. */
const cw1 = (t: Type, f: (x: number) => number): ((a: any) => any) => (isVec(t) ? (a: number[]) => a.map(f) : f); // eslint-disable-line @typescript-eslint/no-explicit-any

/** Component-wise n-ary, broadcasting scalars to the result's width. */
function cwN(widths: number[], f: (...xs: number[]) => number): (...a: any[]) => any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const n = Math.max(...widths);
  if (n === 1) return f;
  return (...a: (number | number[])[]) => {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = f(...a.map((x) => (typeof x === "number" ? x : x[i])));
    return out;
  };
}

const width = (t: Type) => (isVec(t) ? SIZE[t] : 1);
const wider = (ts: Type[]): Type => ts.find(isVec) ?? ts[0];

interface Builtin {
  type: (ts: Type[]) => Type;
  impl: (ts: Type[]) => (...a: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const fract = (x: number) => x - Math.floor(x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
const unaryMath = (f: (x: number) => number): Builtin => ({ type: (ts) => ts[0], impl: (ts) => cw1(ts[0], f) });
const naryMath = (f: (...x: number[]) => number, result: (ts: Type[]) => Type = wider): Builtin => ({ type: result, impl: (ts) => cwN(ts.map(width), f) });
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

const BUILTINS: Record<string, Builtin> = {
  abs: unaryMath(Math.abs),
  sign: unaryMath(Math.sign),
  floor: unaryMath(Math.floor),
  ceil: unaryMath(Math.ceil),
  round: unaryMath((x) => {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; // round half to even, as WGSL
  }),
  trunc: unaryMath(Math.trunc),
  fract: unaryMath(fract),
  sqrt: unaryMath(Math.sqrt),
  inversesqrt: unaryMath((x) => 1 / Math.sqrt(x)),
  exp: unaryMath(Math.exp),
  exp2: unaryMath((x) => 2 ** x),
  log: unaryMath(Math.log),
  log2: unaryMath(Math.log2),
  sin: unaryMath(Math.sin),
  cos: unaryMath(Math.cos),
  tan: unaryMath(Math.tan),
  asin: unaryMath(Math.asin),
  acos: unaryMath(Math.acos),
  atan: unaryMath(Math.atan),
  atan2: naryMath(Math.atan2),
  pow: naryMath(Math.pow),
  min: naryMath(Math.min),
  max: naryMath(Math.max),
  clamp: naryMath((x, lo, hi) => Math.min(Math.max(x, lo), hi), (ts) => ts[0]),
  mix: naryMath((a, b, t) => a + (b - a) * t, (ts) => wider([ts[0], ts[1]])),
  step: naryMath((e, x) => (x < e ? 0 : 1), (ts) => wider([ts[1], ts[0]])),
  smoothstep: naryMath(smooth, (ts) => wider([ts[2], ts[0], ts[1]])),
  length: { type: () => "f", impl: (ts) => (isVec(ts[0]) ? (a: number[]) => Math.sqrt(dot(a, a)) : Math.abs) },
  distance: { type: () => "f", impl: (ts) => (isVec(ts[0]) ? (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i])) : (a: number, b: number) => Math.abs(a - b)) },
  dot: { type: () => "f", impl: () => dot },
  cross: { type: () => "v3", impl: () => (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] },
  normalize: {
    type: (ts) => ts[0],
    impl: () => (a: number[]) => {
      const l = Math.sqrt(dot(a, a));
      return a.map((x) => x / l);
    },
  },
  select: { type: (ts) => ts[0], impl: () => (f: KslValue, t: KslValue, c: boolean) => (c ? t : f) },
};

const VEC_CTOR: Record<string, number> = { KV2: 2, KV3: 3, KV4: 4 };

interface Sym {
  kind: "local" | "global" | "uniform";
  slot: number;
  t: Type;
  constant?: boolean;
}

class Compiler {
  private readonly globals: Frame = [];
  private readonly globalSyms = new Map<string, Sym>();
  private readonly fnTypes = new Map<string, FnDecl>();
  private readonly fns = new Map<string, (...a: KslValue[]) => KslValue>();
  private readonly compiling = new Set<string>();
  // Per function being compiled:
  private scopes: Map<string, Sym>[] = [];
  private slots = 0;
  private ret: Type = "void";

  constructor(
    private readonly unit: Unit,
    private readonly options: KslJsOptions,
  ) {
    for (const f of unit.fns) this.fnTypes.set(f.name, f);
    for (const [name, t] of unit.uniforms) this.globalSyms.set(name, { kind: "uniform", slot: -1, t });
    for (const g of unit.globals) {
      const slot = this.globals.length;
      this.scopes = [new Map()];
      this.slots = 1;
      let value = zero(g.t);
      if (g.init) {
        const { ev, t } = this.expr(g.init);
        this.expect(t, g.t, `constant ${g.name}`);
        value = ev([]);
      }
      this.globals.push(value);
      this.globalSyms.set(g.name, { kind: "global", slot, t: g.t, constant: g.constant });
    }
  }

  program(): KslProgram {
    return {
      fn: (name) => {
        const f = this.fn(name);
        if (!f) throw new Error(`KSL: no function ${name}`);
        return f;
      },
      global: (name) => {
        const s = this.globalSyms.get(name);
        if (!s || s.kind !== "global") throw new Error(`KSL: no global ${name}`);
        return this.globals[s.slot];
      },
    };
  }

  private fail(msg: string): never {
    throw new Error(`KSL: ${msg}`);
  }

  private expect(got: Type, want: Type, what: string): void {
    if (got !== want) this.fail(`${what}: expected ${want}, got ${got}`);
  }

  /** The compiled function `name` (compiled on first use, so functions may come in any order). */
  private fn(name: string): ((...a: KslValue[]) => KslValue) | undefined {
    const done = this.fns.get(name);
    if (done) return done;
    const decl = this.fnTypes.get(name);
    if (!decl) return undefined;
    if (this.compiling.has(name)) {
      // A forward reference while compiling: call through the table.
      return (...a) => this.fns.get(name)!(...a);
    }
    this.compiling.add(name);
    const saved = { scopes: this.scopes, slots: this.slots, ret: this.ret };
    this.scopes = [new Map()];
    this.slots = 1;
    this.ret = decl.ret;
    const paramSlots = decl.params.map((p) => this.declare(p.name, p.t, true).slot);
    const body = this.block(decl.body);
    const size = this.slots;
    Object.assign(this, saved);
    const n = paramSlots.length;
    const f = (...args: KslValue[]): KslValue => {
      const fr: Frame = new Array(size);
      for (let i = 0; i < n; i++) fr[i + 1] = args[i];
      body(fr);
      return fr[0];
    };
    this.fns.set(name, f);
    this.compiling.delete(name);
    return f;
  }

  private declare(name: string, t: Type, constant = false): Sym {
    const sym: Sym = { kind: "local", slot: this.slots++, t, constant };
    this.scopes[this.scopes.length - 1].set(name, sym);
    return sym;
  }

  private lookup(name: string): Sym {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i].get(name);
      if (s) return s;
    }
    const g = this.globalSyms.get(name);
    if (g) return g;
    return this.fail(`unknown name ${name}`);
  }

  // --- statements ---

  private block(body: Stmt[]): Ex {
    this.scopes.push(new Map());
    const list = body.map((s) => this.stmt(s));
    this.scopes.pop();
    const n = list.length;
    return (f) => {
      for (let i = 0; i < n; i++) {
        const r = list[i](f);
        if (r) return r;
      }
      return 0;
    };
  }

  private stmt(s: Stmt): Ex {
    switch (s.k) {
      case "var": {
        let init: Ev;
        if (s.init) {
          const e = this.expr(s.init);
          this.expect(e.t, s.t, `${s.name}'s value`);
          init = this.owned(s.init, e.ev);
        } else {
          const t = s.t;
          init = () => zero(t);
        }
        const slot = this.declare(s.name, s.t, s.constant).slot;
        return (f) => {
          f[slot] = init(f);
          return 0;
        };
      }
      case "assign":
        return this.assign(s.target, s.op, s.value);
      case "incdec": {
        const one: Expr = { k: "num", v: 1, t: this.exprType(s.target) };
        return this.assign(s.target, s.op === "++" ? "+=" : "-=", one);
      }
      case "expr": {
        const { ev } = this.expr(s.e);
        return (f) => {
          ev(f);
          return 0;
        };
      }
      case "if": {
        const c = this.expr(s.c);
        this.expect(c.t, "b", "if condition");
        const then = this.block(s.then);
        const els = s.else ? this.block(s.else) : null;
        const cond = c.ev;
        return els ? (f) => (cond(f) ? then(f) : els(f)) : (f) => (cond(f) ? then(f) : 0);
      }
      case "for": {
        this.scopes.push(new Map());
        const init = s.init ? this.stmt(s.init) : null;
        const c = s.cond ? this.expr(s.cond) : null;
        if (c) this.expect(c.t, "b", "for condition");
        const update = s.update ? this.stmt(s.update) : null;
        const body = this.block(s.body);
        this.scopes.pop();
        const cond = c?.ev;
        return (f) => {
          if (init) init(f);
          for (; !cond || cond(f); ) {
            const r = body(f);
            if (r === 1) break;
            if (r === 3) return 3;
            if (update) update(f);
          }
          return 0;
        };
      }
      case "break":
        return () => 1;
      case "continue":
        return () => 2;
      case "return": {
        if (!s.e) return () => 3;
        const e = this.expr(s.e);
        this.expect(e.t, this.ret, "return value");
        const ev = this.owned(s.e, e.ev);
        return (f) => {
          f[0] = ev(f);
          return 3;
        };
      }
      case "block":
        return this.block(s.body);
    }
  }

  /** `ev`, copied when it reads a place (so the value isn't shared with a variable). */
  private owned(e: Expr, ev: Ev): Ev {
    return e.k === "id" || e.k === "mem" || e.k === "idx" ? (f) => copy(ev(f)) : ev;
  }

  private exprType(e: Expr): Type {
    return this.expr(e).t;
  }

  private assign(target: Expr, op: string, value: Expr): Ex {
    const v = this.expr(value);
    const tt = this.exprType(target);
    let val: Ev;
    if (op === "=") {
      this.expect(v.t, tt, "assigned value");
      val = this.owned(value, v.ev);
    } else {
      const bin = this.binary(op.slice(0, -1), { ev: this.expr(target).ev, t: tt }, v);
      this.expect(bin.t, tt, `${op} result`);
      val = bin.ev;
    }
    const ref = this.ref(target);
    return (f) => {
      const [container, key] = ref(f);
      container[key] = val(f);
      return 0;
    };
  }

  /** Where an assignable expression lives: its container and key. */
  private ref(e: Expr): (f: Frame) => [KslValue[], number] {
    if (e.k === "id") {
      const s = this.lookup(e.name);
      if (s.kind === "uniform" || s.constant) this.fail(`${e.name} can't be assigned`);
      const slot = s.slot;
      if (s.kind === "global") {
        const g = this.globals;
        return () => [g, slot];
      }
      return (f) => [f, slot];
    }
    if (e.k === "mem") {
      if (e.sw.length !== 1) this.fail(`multi-component swizzle writes (.${e.sw}) aren't KSL`);
      const base = this.ref(e.a);
      const i = SWZ[e.sw];
      return (f) => {
        const [c, k] = base(f);
        return [c[k] as KslValue[], i];
      };
    }
    if (e.k === "idx") {
      const base = this.ref(e.a);
      const i = this.expr(e.i).ev;
      return (f) => {
        const [c, k] = base(f);
        return [c[k] as KslValue[], i(f)];
      };
    }
    return this.fail("not assignable");
  }

  // --- expressions ---

  private expr(e: Expr): { ev: Ev; t: Type } {
    switch (e.k) {
      case "num": {
        const v = e.t === "b" ? e.v !== 0 : e.v;
        return { ev: () => v, t: e.t };
      }
      case "id": {
        const s = this.lookup(e.name);
        if (s.kind === "uniform") {
          const u = this.options.uniforms ?? {};
          const name = e.name;
          return { ev: () => u[name], t: s.t };
        }
        const slot = s.slot;
        if (s.kind === "global") {
          const g = this.globals;
          return { ev: () => g[slot], t: s.t };
        }
        return { ev: (f) => f[slot], t: s.t };
      }
      case "mem": {
        const a = this.expr(e.a);
        if (!isVec(a.t)) this.fail(`.${e.sw} of a ${a.t}`);
        const idx = [...e.sw].map((c) => SWZ[c]);
        if (idx.some((i) => i === undefined || i >= SIZE[a.t])) this.fail(`bad swizzle .${e.sw}`);
        const ev = a.ev;
        if (idx.length === 1) {
          const i = idx[0];
          return { ev: (f) => ev(f)[i], t: "f" };
        }
        return { ev: (f) => {
          const v = ev(f) as number[];
          return idx.map((i) => v[i]);
        }, t: vecOf(idx.length) };
      }
      case "idx": {
        const a = this.expr(e.a);
        const i = this.expr(e.i);
        if (i.t !== "i" && i.t !== "u") this.fail("index must be an integer");
        const arr = arrayOf(a.t);
        const t = arr ? arr.elem : isVec(a.t) ? "f" : a.t === "m3" ? "v3" : this.fail(`indexing a ${a.t}`);
        const av = a.ev;
        const iv = i.ev;
        return { ev: (f) => av(f)[iv(f)], t };
      }
      case "un": {
        const a = this.expr(e.a);
        const ev = a.ev;
        if (e.op === "!") {
          this.expect(a.t, "b", "!");
          return { ev: (f) => !ev(f), t: "b" };
        }
        if (e.op === "~") {
          if (a.t === "u") return { ev: (f) => ~ev(f) >>> 0, t: "u" };
          this.expect(a.t, "i", "~");
          return { ev: (f) => ~ev(f), t: "i" };
        }
        if (a.t === "i") return { ev: (f) => -ev(f) | 0, t: "i" };
        if (a.t === "u") return { ev: (f) => -ev(f) >>> 0, t: "u" };
        if (a.t === "m3") return { ev: (f) => (ev(f) as number[][]).map((c) => c.map((x) => -x)), t: "m3" };
        const neg = cw1(a.t, (x) => -x);
        return { ev: (f) => neg(ev(f)), t: a.t };
      }
      case "bin":
        return this.binary(e.op, this.expr(e.a), this.expr(e.b));
      case "arr": {
        const arr = arrayOf(e.t)!;
        if (e.args.length !== arr.n) this.fail(`${e.t} takes ${arr.n} values`);
        const args = e.args.map((x) => {
          const a = this.expr(x);
          this.expect(a.t, arr.elem, `${e.t} element`);
          return this.owned(x, a.ev);
        });
        return { ev: (f) => args.map((a) => a(f)), t: e.t };
      }
      case "call":
        return this.call(e.name, e.args);
    }
  }

  private binary(op: string, a: { ev: Ev; t: Type }, b: { ev: Ev; t: Type }): { ev: Ev; t: Type } {
    const A = a.ev;
    const B = b.ev;
    if (op === "&&" || op === "||") {
      this.expect(a.t, "b", op);
      this.expect(b.t, "b", op);
      return { ev: op === "&&" ? (f) => A(f) && B(f) : (f) => A(f) || B(f), t: "b" };
    }
    if (["==", "!=", "<", ">", "<=", ">="].includes(op)) {
      if (!isScalar(a.t) || a.t !== b.t) this.fail(`${a.t} ${op} ${b.t}: compare scalars of one type`);
      const cmp: Record<string, Ev> = {
        "==": (f) => A(f) === B(f),
        "!=": (f) => A(f) !== B(f),
        "<": (f) => A(f) < B(f),
        ">": (f) => A(f) > B(f),
        "<=": (f) => A(f) <= B(f),
        ">=": (f) => A(f) >= B(f),
      };
      return { ev: cmp[op], t: "b" };
    }
    // Integers.
    if (a.t === "i" || a.t === "u") {
      const shift = op === "<<" || op === ">>";
      if (shift ? b.t !== "u" && b.t !== "i" : a.t !== b.t) this.fail(`${a.t} ${op} ${b.t}`);
      const u = a.t === "u";
      const ops: Record<string, Ev> = u
        ? {
            "+": (f) => (A(f) + B(f)) >>> 0,
            "-": (f) => (A(f) - B(f)) >>> 0,
            "*": (f) => Math.imul(A(f), B(f)) >>> 0,
            "/": (f) => {
              const d = B(f);
              return d === 0 ? 0 : Math.floor(A(f) / d) >>> 0;
            },
            "%": (f) => {
              const d = B(f);
              return d === 0 ? 0 : A(f) % d >>> 0;
            },
            "&": (f) => (A(f) & B(f)) >>> 0,
            "|": (f) => (A(f) | B(f)) >>> 0,
            "^": (f) => (A(f) ^ B(f)) >>> 0,
            "<<": (f) => (A(f) << B(f)) >>> 0,
            ">>": (f) => A(f) >>> B(f),
          }
        : {
            "+": (f) => (A(f) + B(f)) | 0,
            "-": (f) => (A(f) - B(f)) | 0,
            "*": (f) => Math.imul(A(f), B(f)),
            "/": (f) => (A(f) / B(f)) | 0,
            "%": (f) => A(f) % B(f) | 0,
            "&": (f) => A(f) & B(f),
            "|": (f) => A(f) | B(f),
            "^": (f) => A(f) ^ B(f),
            "<<": (f) => A(f) << B(f),
            ">>": (f) => A(f) >> B(f),
          };
      if (!ops[op]) this.fail(`${a.t} ${op}`);
      return { ev: ops[op], t: a.t };
    }
    // Matrices.
    if (op === "*" && a.t === "m3") {
      if (b.t === "v3") return { ev: (f) => mulMV(A(f), B(f)), t: "v3" };
      if (b.t === "m3") return { ev: (f) => (B(f) as number[][]).map((c) => mulMV(A(f), c)), t: "m3" };
      if (b.t === "f") return { ev: (f) => (A(f) as number[][]).map((c) => c.map((x) => x * B(f))), t: "m3" };
    }
    if (op === "*" && b.t === "m3" && a.t === "v3") return { ev: (f) => (B(f) as number[][]).map((c) => dot(A(f), c)), t: "v3" };
    // Floats and float vectors.
    const fs = ["f", "v2", "v3", "v4"];
    if (!fs.includes(a.t) || !fs.includes(b.t) || (isVec(a.t) && isVec(b.t) && a.t !== b.t)) this.fail(`${a.t} ${op} ${b.t}`);
    const scalarOps: Record<string, (x: number, y: number) => number> = {
      "+": (x, y) => x + y,
      "-": (x, y) => x - y,
      "*": (x, y) => x * y,
      "/": (x, y) => x / y,
      "%": (x, y) => x % y,
    };
    const fn = scalarOps[op];
    if (!fn) this.fail(`${a.t} ${op} ${b.t}`);
    const t = wider([a.t, b.t]);
    if (t === "f") return { ev: (f) => fn(A(f), B(f)), t };
    const g = cwN([width(a.t), width(b.t)], fn);
    return { ev: (f) => g(A(f), B(f)), t };
  }

  private call(name: string, args: Expr[]): { ev: Ev; t: Type } {
    if (name === "UNI") {
      const id = args[0];
      if (id?.k !== "id") this.fail("UNI(name)");
      const s = this.globalSyms.get(id.name);
      if (!s || s.kind !== "uniform") this.fail(`no UNIFORM ${id.name}`);
      return this.expr(id);
    }
    if (name === "KTEX") {
      const id = args[0];
      if (id?.k !== "id" || !this.unit.textures.has(id.name)) this.fail("KTEX(texture, uv): no TEXTURE2D of that name");
      const uv = this.expr(args[1]);
      this.expect(uv.t, "v2", "KTEX uv");
      const textures = this.options.textures ?? {};
      const tex = id.name;
      const uvEv = uv.ev;
      return { ev: (f) => {
        const t = textures[tex];
        if (!t) this.fail(`no texture ${tex} given`);
        return t(uvEv(f));
      }, t: "v4" };
    }
    const compiled = args.map((a) => this.expr(a));
    const ts = compiled.map((c) => c.t);
    const evs = compiled.map((c) => c.ev);
    const n = evs.length;
    const run = (impl: (...a: any[]) => any): Ev => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (n === 1) {
        const [a0] = evs;
        return (f) => impl(a0(f));
      }
      if (n === 2) {
        const [a0, a1] = evs;
        return (f) => impl(a0(f), a1(f));
      }
      if (n === 3) {
        const [a0, a1, a2] = evs;
        return (f) => impl(a0(f), a1(f), a2(f));
      }
      return (f) => impl(...evs.map((e) => e(f)));
    };
    // Constructors and conversions.
    if (name === "KF" || name === "KI" || name === "KU" || name === "KB" || name === "KBITU") {
      if (n !== 1 || !isScalar(ts[0])) this.fail(`${name}(${ts.join(", ")})`);
      const from = ts[0];
      const asNum = (from === "b" ? (x: boolean) => (x ? 1 : 0) : (x: number) => x) as (x: number | boolean) => number;
      if (name === "KF") return { ev: run((x) => +asNum(x)), t: "f" };
      if (name === "KB") return { ev: run((x) => !!x), t: "b" };
      if (name === "KBITU") return { ev: run((x) => x >>> 0), t: "u" };
      if (name === "KI") return { ev: run(from === "f" ? toI : (x) => asNum(x) | 0), t: "i" };
      return { ev: run(from === "f" ? toU : (x) => asNum(x) >>> 0), t: "u" };
    }
    if (VEC_CTOR[name]) {
      const size = VEC_CTOR[name];
      if (ts.some((t) => t !== "f" && !isVec(t))) this.fail(`${name}(${ts.join(", ")})`);
      if (n === 1 && ts[0] === "f") return { ev: run((x: number) => new Array(size).fill(x)), t: vecOf(size) };
      const total = ts.reduce((s, t) => s + width(t), 0);
      if (total !== size && !(n === 1 && total > size)) this.fail(`${name}(${ts.join(", ")}): ${total} components`);
      return { ev: (f) => evs.flatMap((e) => e(f)).slice(0, size), t: vecOf(size) };
    }
    if (name === "KM3") {
      if (n === 3 && ts.every((t) => t === "v3")) return { ev: (f) => evs.map((e) => [...e(f)]), t: "m3" };
      if (n === 9 && ts.every((t) => t === "f")) return { ev: (f) => {
        const v = evs.map((e) => e(f));
        return [v.slice(0, 3), v.slice(3, 6), v.slice(6, 9)];
      }, t: "m3" };
      this.fail(`KM3(${ts.join(", ")})`);
    }
    // User functions.
    const decl = this.fnTypes.get(name);
    if (decl) {
      if (decl.params.length !== n) this.fail(`${name} takes ${decl.params.length} arguments`);
      decl.params.forEach((p, i) => this.expect(ts[i], p.t, `${name}'s ${p.name}`));
      const fn = this.fn(name)!;
      return { ev: run(fn), t: decl.ret };
    }
    const b = BUILTINS[name];
    if (!b) this.fail(`unknown function ${name}`);
    return { ev: run(b.impl(ts)), t: b.type(ts) };
  }
}

function mulMV(m: number[][], v: number[]): number[] {
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[r] += m[c][r] * v[c];
  return out;
}
