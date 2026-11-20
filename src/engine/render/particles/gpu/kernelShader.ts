// Internal (ADR 0094, 0250): kernel programs as shaders, written in KSL (`render/shaderSource`), which
// turns them into WGSL (WebGPU compute and draw) and GLSL ES 3.0 (the WebGL2 texture simulation and
// draw), so the built-in steps are written once. The hashes and noise are `kernelMath.ts`'s KSL (`KERNEL_MATH_SHADER`).
// It mirrors `kernelJs.ts` line for line; `npm run bench:particles` compares them in a browser (bench/particles/parity.html).
import {
  ATTR,
  LOCAL_WIDTH,
  LUT_SAMPLES,
  U,
  widthOf,
  type KExpr,
  type KLocal,
  type KStmt,
  type KernelOutput,
  type KernelSystem,
} from "../../../scene/particleKernel";
import { fl, shaderSource, type ShaderDialect } from "../../shaderSource/shaderSource";
import { KERNEL_MATH_SHADER } from "./kernelMath";
import { DEPTH_STEP_KSL, KERNEL_GLOBALS_KSL as GLOBALS, KERNEL_HELPERS_KSL, KERNEL_STEPS_KSL as STEPS, SHAPE_MODES as MODES, shapeKsl } from "./kernelSteps";

/** `src` (KSL) in `dialect`. */
function ksl(src: string, dialect: ShaderDialect): string {
  return shaderSource(src).text(dialect);
}

// --- shared prelude (hashes, noise, colour, the built-in steps) ------------------------------------------

/** KSL helpers every kernel shader includes. Needs `k_lutAt(row, i)` and the globals from `globals()`. */
const PRELUDE = /* KSL */ `${KERNEL_MATH_SHADER.ksl}${KERNEL_HELPERS_KSL}`;



// --- expressions and statements -------------------------------------------------------------------------

const COMP = "xyzw";
const VEC = ["", "KF", "KV2", "KV3", "KV4"];
const LOCAL_NAME: Record<KLocal, string> = {
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

/** Emits KSL for a stage: expressions bound to temporaries, in order. */
class Emitter {
  readonly lines: string[] = [];
  private n = 0;
  constructor(
    private readonly prefix: string,
    private readonly dialect: ShaderDialect,
  ) {}

  private tmp(w: number, value: string): string {
    const name = `${this.prefix}${this.n++}`;
    this.lines.push(`VAR(${VEC[w]}, ${name}) = ${value};`);
    return name;
  }

  /** `s` (width `from`) as width `to`: a splat or a prefix swizzle. */
  private fit(s: string, from: number, to: number): string {
    if (from === to) return s;
    if (from === 1) return `${VEC[to]}(${s})`;
    return `${s}.${COMP.slice(0, to)}`;
  }

  /** Select between a and b (width w) by a boolean of width w. */
  private sel(cond: string, a: string, b: string, w: number): string {
    if (this.dialect === "wgsl") return `select(${b}, ${a}, ${cond})`;
    return w === 1 ? `((${cond}) ? (${a}) : (${b}))` : `mix(${b}, ${a}, ${cond})`;
  }

  private eq(a: string, b: string, w: number): string {
    if (this.dialect === "wgsl" || w === 1) return `(${a} == ${b})`;
    return `equal(${a}, ${b})`;
  }

  private safeDiv(a: string, b: string, w: number): string {
    const zero = w === 1 ? "0.0" : `${VEC[w]}(0.0)`;
    return this.sel(this.eq(b, zero, w), zero, `(${a} / ${b})`, w);
  }

  expr(e: KExpr): string {
    const w = widthOf(e);
    switch (e.k) {
      case "const":
        return w === 1 ? fl(e.v[0]) : `${VEC[w]}(${e.v.map(fl).join(", ")})`;
      case "uniform":
        return w === 4 ? `ku[${e.slot}]` : `ku[${e.slot}].${COMP.slice(0, w)}`;
      case "attr": {
        const [slot, comp, aw] = ATTR[e.name];
        return `a${slot}.${COMP.slice(comp, comp + aw)}`;
      }
      case "local":
        return e.name === "speed" ? "(length(a1.xyz) * k_speedMod)" : LOCAL_NAME[e.name];
      case "rand":
        return `k_rand(a3.w, ${e.salt >>> 0}u)`;
      case "lut": {
        const t = this.fit(this.expr(e.t), widthOf(e.t), 1);
        const v = this.tmp(4, `k_lut(${e.row}, ${t})`);
        return w === 1 ? `${v}.x` : v;
      }
      case "swz": {
        const iw = widthOf(e.e);
        const inner = this.expr(e.e);
        if (iw === 1) return inner;
        return `${this.tmp(iw, inner)}.${COMP[Math.min(e.i, iw - 1)]}`;
      }
      case "op":
        return this.tmp(w, this.op(e, w));
    }
  }

  private op(e: Extract<KExpr, { k: "op" }>, w: number): string {
    const raw = e.args.map((a) => [this.expr(a), widthOf(a)] as const);
    const a = raw.map(([s, aw]) => this.fit(s, aw, w));
    switch (e.op) {
      case "add":
        return `(${a[0]} + ${a[1]})`;
      case "sub":
        return `(${a[0]} - ${a[1]})`;
      case "mul":
        return `(${a[0]} * ${a[1]})`;
      case "div":
        return this.safeDiv(a[0], a[1], w);
      case "neg":
        return `(-${a[0]})`;
      case "abs":
        return `abs(${a[0]})`;
      case "min":
        return `min(${a[0]}, ${a[1]})`;
      case "max":
        return `max(${a[0]}, ${a[1]})`;
      case "clamp":
        return `min(max(${a[0]}, ${a[1]}), ${a[2]})`;
      case "lerp":
        return `mix(${a[0]}, ${a[1]}, ${a[2]})`;
      case "remap": {
        const [x, i0, i1, o0, o1] = a;
        const f = this.tmp(w, this.safeDiv(`(${x} - ${i0})`, `(${i1} - ${i0})`, w));
        return `(${o0} + ${f} * (${o1} - ${o0}))`;
      }
      case "step":
        return `step(${a[0]}, ${a[1]})`;
      case "smoothstep": {
        const [e0, e1, x] = a;
        const t = this.tmp(w, `clamp(${this.safeDiv(`(${x} - ${e0})`, `(${e1} - ${e0})`, w)}, ${this.fit("0.0", 1, w)}, ${this.fit("1.0", 1, w)})`);
        return this.sel(this.eq(e0, e1, w), `step(${e0}, ${x})`, `(${t} * ${t} * (${this.fit("3.0", 1, w)} - ${this.fit("2.0", 1, w)} * ${t}))`, w);
      }
      case "sin":
        return `sin(${a[0]})`;
      case "cos":
        return `cos(${a[0]})`;
      case "noise1":
        return `k_vnoise(${a[0]}, ${Math.round(e.seed ?? 0)})`;
      case "vec":
        return `${VEC[w]}(${raw.map(([s]) => s).join(", ")})`;
      case "length":
        return `length(${raw[0][0]})`;
      case "normalize": {
        const v = this.tmp(raw[0][1], raw[0][0]);
        const len = this.tmp(1, `length(${v})`);
        return this.sel(`(${len} == 0.0)`, `${VEC[w]}(0.0)`, `(${v} / ${len})`, 1);
      }
      case "hsv":
        return `k_hsv(${raw.map(([s, aw]) => this.fit(s, aw, 1)).join(", ")})`;
      case "toLinear":
        return `k_toLinear(${this.fit(raw[0][0], raw[0][1], 4)})`;
    }
  }

  stmt(st: KStmt): void {
    if (st.s === "set") {
      const ew = widthOf(st.e);
      if ("attr" in st.target) {
        const [slot, comp, w] = ATTR[st.target.attr];
        const v = this.tmp(w, this.fit(this.expr(st.e), ew, w));
        for (let i = 0; i < w; i++) {
          const dst = `a${slot}.${COMP[comp + i]}`;
          const src = w === 1 ? v : `${v}.${COMP[i]}`;
          this.lines.push(`${dst} = ${st.mode === "set" ? src : `${dst} ${st.mode === "add" ? "+" : "*"} ${src}`};`);
        }
        return;
      }
      const name = LOCAL_NAME[st.target.local];
      const w = LOCAL_WIDTH[st.target.local];
      const v = this.fit(this.expr(st.e), ew, w);
      this.lines.push(`${name} = ${st.mode === "set" ? v : `${name} ${st.mode === "add" ? "+" : "*"} ${v}`};`);
      return;
    }
    const arg = (i: number, w: number) => this.fit(this.expr(st.args[i]), widthOf(st.args[i]), w);
    switch (st.b) {
      case "shape": {
        const args = st.args.map((_, i) => arg(i, 1));
        this.lines.push(`k_shape(${args.join(", ")}, ${MODES[st.shape?.mode ?? "random"] ?? 0});`);
        if (st.rotation !== undefined) {
          this.lines.push(`k_spos = k_mat3(${st.rotation}, k_spos);`, `k_sdir = k_mat3(${st.rotation}, k_sdir);`);
        }
        return;
      }
      case "place":
        this.lines.push(`k_place(${arg(0, 3)}, ${arg(1, 1)});`);
        return;
      case "age":
        this.lines.push("k_age();");
        return;
      case "gravity":
        this.lines.push(`k_gravity(${arg(0, 1)});`);
        return;
      case "force":
        this.lines.push(`k_force(${arg(0, 3)});`);
        return;
      case "gpoint":
        this.lines.push(`k_gpoint(${arg(0, 3)}, ${arg(1, 1)});`);
        return;
      case "turbulence":
        this.lines.push(`k_turbulence(${arg(0, 3)}, ${arg(1, 1)}, ${arg(2, 3)}, ${arg(3, 3)});`);
        return;
      case "limit":
        this.lines.push(`k_limit(${arg(0, 1)}, ${arg(1, 1)});`);
        return;
      case "integrate":
        this.lines.push("k_integrate();");
        return;
      case "noise":
        this.lines.push(`k_noise(${arg(0, 1)}, ${arg(1, 1)}, ${arg(2, 1)}, ${arg(3, 1)}, ${st.index ?? 0}u);`);
        return;
      case "orbit":
        this.lines.push(`k_orbit(${arg(0, 1)}, ${arg(1, 3)});`);
        return;
      case "plane":
        this.lines.push(`k_plane(${arg(0, 1)}, ${arg(1, 1)}, ${arg(2, 1)});`);
        return;
      case "collidersStart":
      case "colliders":
        return; // JavaScript only (ADR 0251): GPU executors skip collider collision
      case "depth":
        this.lines.push(`k_depthCollide(${arg(0, 1)}, ${arg(1, 1)}, ${arg(2, 1)});`);
        return;
      case "spin":
        this.lines.push(`k_spin(${arg(0, 1)});`);
        return;
    }
  }
}

/** A stage's statements as a KSL function `name`. */
function stageFunction(name: string, stmts: readonly KStmt[], dialect: ShaderDialect): string {
  const em = new Emitter(`${name}_`, dialect);
  for (const s of stmts) em.stmt(s);
  return `FN(void, ${name}) {\n  ${em.lines.join("\n  ")}\n}\n`;
}


/** The body every simulation shader runs for slot `k_idx`, after loading a0..a3 (and `k_spawnHere`). */
function simulationBody(kernel: KernelSystem): string {
  return /* KSL */ `
FN(void, k_run, KF spawnHere) {
  if (spawnHere > 0.5) {
    a0 = KV4(0.0, 0.0, 0.0, 0.0);
    a1 = KV4(0.0, 0.0, 0.0, 0.0);
    a2 = KV4(0.0, 0.0, 0.0, 0.0);
    a3 = KV4(0.0, 0.0, 0.0, k_seed(k_sidx, ku[${U.spawn}].w, ku[${U.misc}].y));
    k_t = 0.0;
    k_init();
    return;
  }
  if (a1.w < 0.0) {
    a1.w = 0.0;
    return;
  }
  if (a1.w == 0.0 || ku[${U.time}].y <= 0.0) { return; }
  k_step = ku[${U.time}].y;
  k_dies = 0.0;
  k_speedMod = 1.0;
  k_update();
  if (k_dies > 0.5) { a1.w = -a1.w; }
}
${kernel.event ? EVENT_MASK : ""}
FN(KF, k_spawnRing) {
  VAR(KF, cap) = ku[${U.spawn}].z;
  VAR(KF, rel) = k_idx - ku[${U.spawn}].x;
  rel = rel - floor(rel / cap) * cap;
  k_rel = rel;
  if (ku[${U.spawn}].y > 0.0 && rel < ku[${U.spawn}].y) { return 1.0; }
  return 0.0;
}
`;
}

/** Event spawning (needs `k_par(i, slot)` and `k_srcLife(j)`), as `JsKernel.eventMask`. Sets the parent globals. */
const EVENT_MASK = /* KSL */ `
FN(KF, k_spawnEvent) {
  VAR(KF, k) = max(1.0, ku[${U.misc}].z);
  VAR(KF, p) = floor(k_idx / k);
  if (p >= ku[${U.misc}].w) { return 0.0; }
  if (k_srcLife(KI(k_idx)) > 0.0) { return 0.0; }
  VAR(KV4, pa0) = k_par(KI(p), 0);
  VAR(KV4, pa1) = k_par(KI(p), 1);
  VAR(KV4, pa3) = k_par(KI(p), 3);
  VAR(KF, trigger) = ku[${U.flags}].x;
  VAR(KF, frame) = ku[${U.spawn}].w;
  VAR(KF, fired) = 0.0;
  if (trigger < 0.5) { if (pa1.w > 0.0 && pa0.w == 0.0) { fired = 1.0; } }
  else if (trigger < 1.5) { if (pa1.w < 0.0) { fired = 1.0; } }
  else { if (pa1.w > 0.0) { fired = 1.0; } }
  if (fired < 0.5) { return 0.0; }
  VAR(KU, salt) = 7001u;
  if (trigger > 1.5) { salt = 7001u + KU(frame); }
  if (k_rand(pa3.w, salt) >= ku[${U.event}].y) { return 0.0; }
  VAR(KF, n) = ku[${U.event}].x;
  if (trigger > 1.5) {
    VAR(KF, rate) = ku[${U.event}].z;
    n = floor(rate);
    if (k_rand(pa3.w, 9001u + KU(frame)) < rate - floor(rate)) { n = n + 1.0; }
  }
  VAR(KF, dead) = 0.0;
  for (VAR(KI, j) = KI(p * k); j < KI(k_idx); j++) {
    if (k_srcLife(j) <= 0.0) { dead = dead + 1.0; }
  }
  if (dead >= n) { return 0.0; }
  // The parent's world position and velocity (from the parent's space).
  k_hasParent = 1.0;
  k_parentPos = pa0.xyz;
  k_parentVel = pa1.xyz;
  if (ku[${U.flags}].w < 0.5) {
    k_parentPos = k_xform(pa0.xyz);
    k_parentVel = k_xformDir(pa1.xyz);
  }
  return 1.0;
}
`;

/** Shared KSL for a kernel's simulation: prelude, steps, the shape, init and update. */
function simulationKsl(kernel: KernelSystem, dialect: ShaderDialect): string {
  const shapeStmt = kernel.init.find((s) => s.s === "builtin" && s.b === "shape") as Extract<KStmt, { s: "builtin" }> | undefined;
  return [
    GLOBALS,
    PRELUDE,
    STEPS,
    kernel.depth ? DEPTH_STEP_KSL : "",
    shapeKsl(shapeStmt?.shape?.type ?? "point"),
    stageFunction("k_init", kernel.init, dialect),
    stageFunction("k_update", kernel.update, dialect),
    simulationBody(kernel),
  ].join("\n");
}

// --- WGSL compute ---------------------------------------------------------------------------------------

export const WORKGROUP = 64;

/**
 * The WGSL compute shader for `kernel`. Bindings (group 0): ku (uniforms), ksrc (state read), kdst
 * (state write), kl (look-up table); kp (the event parent's state) when it has one; kdepth when it
 * collides with the depth buffer. The parent's space flag rides in `ku[flags].w`.
 */
export function wgslSimulation(kernel: KernelSystem, opts: { deadList?: boolean } = {}): string {
  const dead = !!opts.deadList && !kernel.event;
  const head = `
@group(0) @binding(0) var<storage, read> ku: array<vec4f>;
@group(0) @binding(1) var<storage, read> ksrc: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> kdst: array<vec4f>;
@group(0) @binding(3) var<storage, read> kl: array<vec4f>;
${kernel.event ? "@group(0) @binding(4) var<storage, read> kp: array<vec4f>;" : ""}
${kernel.depth ? "@group(0) @binding(5) var kdepth: texture_2d<f32>;" : ""}
${dead ? "@group(0) @binding(6) var<storage, read_write> kdead: array<i32>;\n@group(0) @binding(7) var<storage, read_write> kcount: array<atomic<i32>>;" : ""}
${kernel.trail ? `@group(0) @binding(8) var<storage, read_write> khist: array<vec4f>;\nfn k_trailWrite(i: u32) { khist[(u32(ku[${U.spawn}].w) % ${kernel.trail}u) * ${kernel.capacity}u + i] = vec4f(a0.xyz, a3.w); }` : ""}
fn k_lutAt(row: i32, i: i32) -> vec4f { return kl[row * ${LUT_SAMPLES} + i]; }
${kernel.event ? "fn k_par(i: i32, slot: i32) -> vec4f { return kp[i * 4 + slot]; }\nfn k_srcLife(j: i32) -> f32 { return ksrc[j * 4 + 1].w; }" : ""}
${kernel.depth ? "fn k_depthAt(x: i32, y: i32) -> f32 { return textureLoad(kdepth, vec2i(x, y), 0).r; }" : ""}
`;
  const main = `
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let i = gid.x + gid.y * groups.x * ${WORKGROUP}u;
  if (f32(i) >= ku[${U.spawn}].z) { return; }
  let b = i * 4u;
  a0 = ksrc[b];
  a1 = ksrc[b + 1u];
  a2 = ksrc[b + 2u];
  a3 = ksrc[b + 3u];
  k_idx = f32(i);
  k_rel = k_idx;
  k_sidx = k_idx;
  k_hasParent = 0.0;
  ${
    dead
      ? `let dying = a1.w < 0.0;
  k_run(0.0);
  if (dying) {
    let at = atomicAdd(&kcount[0], 1);
    kdead[at] = i32(i);
  }
  if (a1.w > 0.0) { atomicAdd(&kcount[1], 1); }`
      : kernel.event
        ? "k_run(k_spawnEvent());"
        : "k_run(k_spawnRing());"
  }
  kdst[b] = a0;
  kdst[b + 1u] = a1;
  kdst[b + 2u] = a2;
  kdst[b + 3u] = a3;
  ${kernel.trail ? "k_trailWrite(i);" : ""}
}
${dead ? spawnMain(kernel) : ""}`;
  return head + ksl(simulationKsl(kernel, "wgsl"), "wgsl") + main;
}

/**
 * The dead list's spawn pass (ADR 0126): one invocation per particle this frame spawns, after the update
 * pass. Each pops a free slot (kcount[0] counts them, kdead holds them) and initialises it in the state
 * just written; when none is left the spawn is dropped. The seed hashes the spawn number, not the slot.
 */
const spawnMain = (kernel: KernelSystem): string => `
@compute @workgroup_size(${WORKGROUP})
fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (f32(t) >= ku[${U.spawn}].y) { return; }
  let old = atomicSub(&kcount[0], 1);
  if (old <= 0) {
    atomicAdd(&kcount[0], 1);
    return;
  }
  let i = u32(kdead[old - 1]);
  let b = i * 4u;
  k_idx = f32(i);
  k_rel = f32(t);
  k_sidx = f32(t);
  k_hasParent = 0.0;
  k_run(1.0);
  if (a1.w <= 0.0) {
    // Born without a lifetime: marked finished, so the next update pass frees the slot (no push here,
    // where other invocations are popping).
    a1.w = -1e-20;
  } else {
    atomicAdd(&kcount[1], 1);
  }
  kdst[b] = a0;
  kdst[b + 1u] = a1;
  kdst[b + 2u] = a2;
  kdst[b + 3u] = a3;
  ${kernel.trail ? "k_trailWrite(i);" : ""}
}
`;

/**
 * Trails (ADR 0126), WebGL2: after the simulation pass, one pass copies each slot's position and seed into
 * this frame's block of the history texture (`STATE` width, `rows` per block, block `frame % points`).
 */
export const GLSL_TRAIL_HISTORY = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D ks0;
uniform highp sampler2D ks3;
uniform int yoff;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) - ivec2(0, yoff);
  o = vec4(texelFetch(ks0, c, 0).xyz, texelFetch(ks3, c, 0).w);
}
`;

// --- GLSL ES 3.0 texture simulation ---------------------------------------------------------------------

/** Full-screen triangle for the simulation pass. */
export const GLSL_SIM_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The GLSL ES 3.0 fragment shader for the texture simulation: one fragment per particle slot
 * (`slot = y × width + x`), four render targets (the four state vec4s).
 * Uniforms: ku[N], kw (texture width), ks0..ks3 (state read), kl (look-up table); kp0..kp3 and kpw
 * (the parent's state) with an event; kdepth with depth collision.
 */
export function glslSimulation(kernel: KernelSystem): string {
  const head = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 ku[${kernel.uniformVec4}];
uniform int kw;
uniform sampler2D ks0;
uniform sampler2D ks1;
uniform sampler2D ks2;
uniform sampler2D ks3;
uniform sampler2D kl;
${kernel.event ? "uniform sampler2D kp0;\nuniform sampler2D kp1;\nuniform sampler2D kp2;\nuniform sampler2D kp3;\nuniform int kpw;" : ""}
${kernel.depth ? "uniform sampler2D kdepth;" : ""}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
vec4 k_lutAt(int row, int i) { return texelFetch(kl, ivec2(i, row), 0); }
${
  kernel.event
    ? `vec4 k_par(int i, int slot) {
  ivec2 c = ivec2(i % kpw, i / kpw);
  if (slot == 0) { return texelFetch(kp0, c, 0); }
  if (slot == 1) { return texelFetch(kp1, c, 0); }
  if (slot == 2) { return texelFetch(kp2, c, 0); }
  return texelFetch(kp3, c, 0);
}
float k_srcLife(int j) { return texelFetch(ks1, ivec2(j % kw, j / kw), 0).w; }`
    : ""
}
${kernel.depth ? "float k_depthAt(int x, int y) { return texelFetch(kdepth, ivec2(x, y), 0).r; }" : ""}
`;
  const main = `
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = c.y * kw + c.x;
  a0 = texelFetch(ks0, c, 0);
  a1 = texelFetch(ks1, c, 0);
  a2 = texelFetch(ks2, c, 0);
  a3 = texelFetch(ks3, c, 0);
  if (float(i) < ku[${U.spawn}].z) {
    k_idx = float(i);
    k_rel = k_idx;
    k_sidx = k_idx;
    k_hasParent = 0.0;
    ${kernel.event ? "k_run(k_spawnEvent());" : "k_run(k_spawnRing());"}
  }
  o0 = a0;
  o1 = a1;
  o2 = a2;
  o3 = a3;
}
`;
  return head + ksl(simulationKsl(kernel, "glsl"), "glsl") + main;
}

// --- drawing --------------------------------------------------------------------------------------------

/** The output stage as KSL `k_output()`: k_oColor/k_oSize/k_oTile from the particle (a0..a3 loaded). */
function outputKsl(out: KernelOutput, dialect: ShaderDialect): string {
  return `${stageFunction("k_output", out.stmts, dialect)}
FN(void, k_outputStage) {
  VAR(KF, life) = a1.w;
  k_t = 1.0;
  if (life > 0.0) { k_t = min(1.0, a0.w / life); }
  k_speedMod = 1.0;
  k_oColor = a2;
  k_oSize = a3.x;
  k_oTile = a3.z;
  k_output();
}
`;
}

/** What a draw needs to know about its output (the Babylon side passes it). */
export interface DrawShaderOptions {
  /** Read the depth texture in the fragment shader to fade particles near surfaces. */
  soft: boolean;
  /** Draw instance i as the slot in the sorted pairs' i-th entry (ADR 0126: `kidx`, texture width `kidxW` on GLSL). */
  sorted?: boolean;
  /**
   * Height fog (ADR 0126): the renderer's fragment declarations providing `mycoHeightFogFactor(p, eye)`
   * and `mycoApplyHeightFog(rgb, p, eye)` (Babylon's `heightFogShader`). Absent: no fog.
   */
  fog?: string;
}

/**
 * The output's vertex and fragment shaders for a Babylon `ShaderMaterial` (GLSL, in Babylon's
 * GLSL dialect: attributes and varyings, converted to ES 3.0 on WebGL2). The state comes from four
 * float textures (ks0..ks3, width kw), uniforms from `ku`, the look-up table from `kl`.
 */
export function glslDraw(kernel: KernelSystem, k: number, opts: DrawShaderOptions = { soft: false }): { vertex: string; fragment: string } {
  const out = kernel.outputs[k];
  const vertex = `precision highp float;
precision highp int;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform mat4 view;
uniform vec3 kcam;
uniform vec4 ku[${kernel.uniformVec4}];
uniform float kw;
uniform vec4 kdraw;
uniform vec4 kdraw3;
uniform highp sampler2D ks0;
uniform highp sampler2D ks1;
uniform highp sampler2D ks2;
uniform highp sampler2D ks3;
uniform highp sampler2D kl;
${opts.sorted ? "uniform highp sampler2D kidx;\nuniform float kidxW;" : ""}
varying vec2 vUV;
varying vec2 vUV2;
varying float vBlend;
varying vec4 vColor;
varying float vDepth;
varying vec3 vWorld;
varying vec3 vEye;
vec4 k_lutAt(int row, int i) { return texelFetch(kl, ivec2(i, row), 0); }
${ksl(GLOBALS + PRELUDE + outputKsl(out, "glsl"), "glsl")}
${ksl(ORIENT, "glsl")}
void main() {
  int i = gl_InstanceID;
  ${opts.sorted ? "int sw = int(kidxW);\n  i = int(texelFetch(kidx, ivec2(gl_InstanceID % sw, gl_InstanceID / sw), 0).g);" : ""}
  int w = int(kw);
  ivec2 c = ivec2(i % w, i / w);
  a0 = texelFetch(ks0, c, 0);
  a1 = texelFetch(ks1, c, 0);
  a2 = texelFetch(ks2, c, 0);
  a3 = texelFetch(ks3, c, 0);
  k_idx = float(i);
  k_outputStage();
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
  vec4 placed = k_orient(position, right, up, kcam, kdraw);
  vColor = k_oColor;
  vec4 uvs = k_tileUV(uv, kdraw, kdraw3.x);
  vUV = uvs.xy;
  vUV2 = uvs.zw;
  vBlend = k_tileBlend(kdraw);
  vec4 clip = viewProjection * vec4(placed.xyz, 1.0);
  vDepth = clip.w;
  vWorld = placed.xyz;
  vEye = kcam;
  gl_Position = placed.w > 0.5 ? clip : vec4(0.0, 0.0, -2.0, 1.0);
}
`;
  const fragment = `precision highp float;
varying vec2 vUV;
varying vec2 vUV2;
varying float vBlend;
varying vec4 vColor;
varying float vDepth;
varying vec3 vWorld;
varying vec3 vEye;
uniform sampler2D ktex;
uniform vec4 kdraw2;
${opts.soft ? "uniform sampler2D kdepthTex;\nuniform vec4 ksoft;" : ""}
${opts.fog ?? ""}
void main() {
  vec4 t = texture2D(ktex, vUV);
  if (kdraw2.x > 0.5) { t = mix(t, texture2D(ktex, vUV2), vBlend); }
  vec4 col = t * vColor;
  ${
    opts.soft
      ? `vec2 suv = gl_FragCoord.xy / ksoft.xy;
  float scene = abs(texture2D(kdepthTex, suv).r);
  if (scene == 0.0) { scene = 1e9; }
  col.a *= clamp((scene - vDepth) / max(kdraw2.y, 0.0001), 0.0, 1.0);`
      : ""
  }
  ${opts.fog ? FOG_GLSL : ""}
  if (kdraw2.z > 0.5) { col.rgb *= col.a; }
  gl_FragColor = col;
}
`;
  if (out.type === "trail") return { vertex: glslTrailVertex(kernel, out, opts), fragment };
  return { vertex, fragment };
}

/** Orientation and flipbook helpers for the draws (KSL; globals loaded). `kdraw`: mode, speed scale, length scale, tile columns; `kdraw3.x`: tile rows. */
const ORIENT = /* KSL */ `
FN(KV4, k_orient, KV3 corner, KV3 right0, KV3 up0, KV3 cam, KV4 draw) {
  VAR(KF, alive) = 0.0;
  if (a1.w > 0.0 && a0.w < a1.w) { alive = 1.0; }
  VAR(KV3, p) = a0.xyz;
  VAR(KV3, v) = a1.xyz * k_speedMod;
  if (ku[${U.flags}].z < 0.5) {
    p = k_xform(p);
    v = k_xformDir(v);
  }
  VAR(KF, size) = max(0.0, k_oSize);
  VAR(KF, mode) = draw.x;
  VAR(KF, co) = cos(a3.y);
  VAR(KF, sn) = sin(a3.y);
  VAR(KV2, q) = KV2(corner.x * co - corner.y * sn, corner.x * sn + corner.y * co);
  VAR(KV3, right) = right0;
  VAR(KV3, up) = up0;
  if (mode > 3.5) {
    // mesh: the model's vertex, scaled by size, turned about Y by rotation
    VAR(KV3, m) = KV3(corner.x * co + corner.z * sn, corner.y, -corner.x * sn + corner.z * co) * size;
    return KV4(p + m, alive);
  }
  if (mode > 2.5) {
    // vertical: faces the camera, turning only about Y
    up = KV3(0.0, 1.0, 0.0);
    VAR(KV3, toCam) = cam - p;
    right = normalize(cross(toCam, up) + KV3(0.000001, 0.0, 0.0)); // left-handed (ADR 0164): the camera's right
    return KV4(p + (right * q.x + up * q.y) * size, alive);
  }
  if (mode > 1.5) {
    // horizontal: flat in XZ
    return KV4(p + (KV3(1.0, 0.0, 0.0) * q.x + KV3(0.0, 0.0, 1.0) * q.y) * size, alive);
  }
  if (mode > 0.5) {
    // stretched along the velocity
    VAR(KF, speed) = length(v);
    VAR(KF, len) = size * draw.z + speed * draw.y;
    VAR(KV3, axis) = up0;
    if (speed > 0.000001) { axis = v / speed; }
    VAR(KV3, toCam) = normalize(cam - p);
    VAR(KV3, side) = cross(toCam, axis); // left-handed order (ADR 0164)
    VAR(KF, sl) = length(side);
    if (sl > 0.000001) { side = side / sl; } else { side = right0; }
    return KV4(p + side * corner.y * size - axis * (corner.x + 0.5) * len, alive);
  }
  return KV4(p + (right * q.x + up * q.y) * size, alive);
}
FN(KV3, k_orientCentre) {
  VAR(KV3, p) = a0.xyz;
  if (ku[${U.flags}].z < 0.5) { p = k_xform(p); }
  return p;
}
FN(KV4, k_tileUV, KV2 uv, KV4 draw, KF rows0) {
  VAR(KF, cols) = max(1.0, draw.w);
  VAR(KF, rows) = max(1.0, rows0);
  VAR(KF, n) = cols * rows;
  VAR(KF, whole) = floor(k_oTile);
  VAR(KF, t0) = whole - floor(whole / n) * n;
  VAR(KF, t1) = (t0 + 1.0) - floor((t0 + 1.0) / n) * n;
  VAR(KV2, a) = KV2((t0 - floor(t0 / cols) * cols + uv.x) / cols, (floor(t0 / cols) + uv.y) / rows);
  VAR(KV2, b) = KV2((t1 - floor(t1 / cols) * cols + uv.x) / cols, (floor(t1 / cols) + uv.y) / rows);
  return KV4(a, b);
}
FN(KF, k_tileBlend, KV4 draw) {
  return k_oTile - floor(k_oTile);
}
`;

/**
 * The output's shaders for a Babylon WGSL `ShaderMaterial` on WebGPU: the state from a storage
 * buffer (`ks`, interleaved vec4s), uniforms (`ku`) and the look-up table (`kl`) likewise.
 */
export function wgslDraw(kernel: KernelSystem, k: number, opts: DrawShaderOptions = { soft: false }): { vertex: string; fragment: string } {
  const out = kernel.outputs[k];
  const vertex = `
attribute position : vec3<f32>;
attribute uv : vec2<f32>;
uniform viewProjection : mat4x4<f32>;
uniform view : mat4x4<f32>;
uniform kcam : vec3<f32>;
uniform kdraw : vec4<f32>;
uniform kdraw3 : vec4<f32>;
var<storage, read> ku : array<vec4<f32>>;
var<storage, read> ks : array<vec4<f32>>;
var<storage, read> kl : array<vec4<f32>>;
${opts.sorted ? "var<storage, read> kidx : array<vec2<f32>>;" : ""}
varying vUV : vec2<f32>;
varying vUV2 : vec2<f32>;
varying vBlend : f32;
varying vColor : vec4<f32>;
varying vDepth : f32;
varying vWorld : vec3<f32>;
varying vEye : vec3<f32>;
fn k_lutAt(row: i32, i: i32) -> vec4f { return kl[row * ${LUT_SAMPLES} + i]; }
${ksl(GLOBALS + PRELUDE + outputKsl(out, "wgsl"), "wgsl")}
${ksl(ORIENT, "wgsl")}
@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let i = ${opts.sorted ? "u32(kidx[vertexInputs.instanceIndex].y)" : "vertexInputs.instanceIndex"};
  let b = i * 4u;
  a0 = ks[b];
  a1 = ks[b + 1u];
  a2 = ks[b + 2u];
  a3 = ks[b + 3u];
  k_idx = f32(i);
  k_outputStage();
  let vw = uniforms.view;
  let right = vec3f(vw[0][0], vw[1][0], vw[2][0]);
  let up = vec3f(vw[0][1], vw[1][1], vw[2][1]);
  let placed = k_orient(vertexInputs.position, right, up, uniforms.kcam, uniforms.kdraw);
  vertexOutputs.vColor = k_oColor;
  let uvs = k_tileUV(vertexInputs.uv, uniforms.kdraw, uniforms.kdraw3.x);
  vertexOutputs.vUV = uvs.xy;
  vertexOutputs.vUV2 = uvs.zw;
  vertexOutputs.vBlend = k_tileBlend(uniforms.kdraw);
  let clip = uniforms.viewProjection * vec4f(placed.xyz, 1.0);
  vertexOutputs.vDepth = clip.w;
  vertexOutputs.vWorld = placed.xyz;
  vertexOutputs.vEye = uniforms.kcam;
  vertexOutputs.position = select(vec4f(0.0, 0.0, -2.0, 1.0), clip, placed.w > 0.5);
}
`;
  const fragment = `
varying vUV : vec2<f32>;
varying vUV2 : vec2<f32>;
varying vBlend : f32;
varying vColor : vec4<f32>;
varying vDepth : f32;
varying vWorld : vec3<f32>;
varying vEye : vec3<f32>;
var ktex : texture_2d<f32>;
var ktexSampler : sampler;
uniform kdraw2 : vec4<f32>;
${opts.soft ? "var kdepthTex : texture_2d<f32>;\nuniform ksoft : vec4<f32>;" : ""}
${opts.fog ?? ""}
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  var t = textureSample(ktex, ktexSampler, fragmentInputs.vUV);
  let t2 = textureSample(ktex, ktexSampler, fragmentInputs.vUV2);
  if (uniforms.kdraw2.x > 0.5) { t = mix(t, t2, fragmentInputs.vBlend); }
  var col = t * fragmentInputs.vColor;
  ${
    opts.soft
      ? `let dims = vec2f(textureDimensions(kdepthTex));
  let pc = vec2i(clamp(fragmentInputs.position.xy, vec2f(0.0), dims - 1.0));
  var scene = abs(textureLoad(kdepthTex, pc, 0).r);
  if (scene == 0.0) { scene = 1e9; }
  col.a = col.a * clamp((scene - fragmentInputs.vDepth) / max(uniforms.kdraw2.y, 0.0001), 0.0, 1.0);`
      : ""
  }
  ${opts.fog ? FOG_WGSL : ""}
  if (uniforms.kdraw2.z > 0.5) { col = vec4f(col.rgb * col.a, col.a); }
  fragmentOutputs.color = col;
}
`;
  if (out.type === "trail") return { vertex: wgslTrailVertex(kernel, out, opts), fragment };
  return { vertex, fragment };
}

/** Height fog in the draws' fragment shaders: additive particles fade out (`kdraw2.w` 1), the rest mix towards the fog colour. */
const FOG_GLSL = `if (kdraw2.w > 0.5) { col.rgb *= 1.0 - mycoHeightFogFactor(vWorld, vEye); } else { col.rgb = mycoApplyHeightFog(col.rgb, vWorld, vEye); }`;
const FOG_WGSL = `if (uniforms.kdraw2.w > 0.5) { col = vec4f(col.rgb * (1.0 - mycoHeightFogFactor(fragmentInputs.vWorld, fragmentInputs.vEye)), col.a); } else { col = vec4f(mycoApplyHeightFog(col.rgb, fragmentInputs.vWorld, fragmentInputs.vEye), col.a); }`;

/**
 * The trail ribbon (ADR 0126) as KSL, after the particle (a0..a3) is loaded and its output stage run:
 * `k_hist(k)` reads the k-th newest history point (needs it defined per dialect). Finds how many points
 * belong to this particle (their tag is its seed; a binary search, the newest always does), clamps the
 * strip's point `pt` to them and places one side (`side` ±0.5) of the ribbon there, facing the camera.
 * Returns the world position, w 0 when nothing is drawn; `k_trailU` is how far along (0 at the head).
 */
const TRAIL = /* KSL */ `
GLOBAL(KF, k_trailU);
FN(KV3, k_trailWorld, KV3 p) {
  if (ku[${U.flags}].z < 0.5) { return k_xform(p); }
  return p;
}
FN(KV4, k_trail, KF pt, KF side, KF points, KI widthRow, KV3 cam, KV3 right0) {
  if (!(a1.w > 0.0 && a0.w < a1.w)) { return KV4(0.0, 0.0, 0.0, 0.0); }
  VAR(KF, lo) = 1.0;
  VAR(KF, hi) = points;
  for (VAR(KI, it) = 0; it < 7; it++) {
    if (lo >= hi) { break; }
    VAR(KF, mid) = floor((lo + hi + 1.0) * 0.5);
    if (k_hist(mid - 1.0).w == a3.w) { lo = mid; } else { hi = mid - 1.0; }
  }
  VAR(KF, n) = lo;
  if (n < 2.0) { return KV4(0.0, 0.0, 0.0, 0.0); }
  VAR(KF, k) = min(pt, n - 1.0);
  VAR(KV3, p) = k_trailWorld(k_hist(k).xyz);
  VAR(KV3, a) = k_trailWorld(k_hist(max(k - 1.0, 0.0)).xyz);
  VAR(KV3, b) = k_trailWorld(k_hist(min(k + 1.0, n - 1.0)).xyz);
  VAR(KV3, dir) = cross(cam - p, a - b); // left-handed order (ADR 0164)
  VAR(KF, len) = length(dir);
  VAR(KV3, across) = right0;
  if (len > 0.000000001) { across = dir / len; }
  k_trailU = k / (n - 1.0);
  VAR(KF, width) = max(0.0, k_oSize) * k_lut(widthRow, k_trailU).x;
  return KV4(p + across * side * width, 1.0);
}
`;

function glslTrailVertex(kernel: KernelSystem, out: KernelOutput, opts: DrawShaderOptions): string {
  const points = kernel.trail ?? 0;
  const rows = Math.ceil(kernel.capacity / Math.min(1024, kernel.capacity));
  return `precision highp float;
precision highp int;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform mat4 view;
uniform vec3 kcam;
uniform vec4 ku[${kernel.uniformVec4}];
uniform float kw;
uniform vec4 kdraw;
uniform vec4 kdraw3;
uniform vec4 ktrail;
uniform highp sampler2D ks0;
uniform highp sampler2D ks1;
uniform highp sampler2D ks2;
uniform highp sampler2D ks3;
uniform highp sampler2D kl;
uniform highp sampler2D khist;
${opts.sorted ? "uniform highp sampler2D kidx;\nuniform float kidxW;" : ""}
varying vec2 vUV;
varying vec2 vUV2;
varying float vBlend;
varying vec4 vColor;
varying float vDepth;
varying vec3 vWorld;
varying vec3 vEye;
int k_slot;
vec4 k_lutAt(int row, int i) { return texelFetch(kl, ivec2(i, row), 0); }
vec4 k_hist(float k) {
  int w = int(kw);
  float f = ktrail.x - k;
  int block = int(f - floor(f / ${fl(points)}) * ${fl(points)});
  return texelFetch(khist, ivec2(k_slot % w, block * ${rows} + k_slot / w), 0);
}
${ksl(GLOBALS + PRELUDE + outputKsl(out, "glsl"), "glsl")}
${ksl(ORIENT + TRAIL, "glsl")}
void main() {
  int i = gl_InstanceID;
  ${opts.sorted ? "int sw = int(kidxW);\n  i = int(texelFetch(kidx, ivec2(gl_InstanceID % sw, gl_InstanceID / sw), 0).g);" : ""}
  k_slot = i;
  int w = int(kw);
  ivec2 c = ivec2(i % w, i / w);
  a0 = texelFetch(ks0, c, 0);
  a1 = texelFetch(ks1, c, 0);
  a2 = texelFetch(ks2, c, 0);
  a3 = texelFetch(ks3, c, 0);
  k_idx = float(i);
  k_outputStage();
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec4 placed = k_trail(position.y, position.x, ${fl(points)}, int(ktrail.w), kcam, right);
  vColor = k_oColor;
  vec4 uvs = k_tileUV(vec2(1.0 - k_trailU, uv.y), kdraw, kdraw3.x);
  vUV = uvs.xy;
  vUV2 = uvs.zw;
  vBlend = k_tileBlend(kdraw);
  vec4 clip = viewProjection * vec4(placed.xyz, 1.0);
  vDepth = clip.w;
  vWorld = placed.xyz;
  vEye = kcam;
  gl_Position = placed.w > 0.5 ? clip : vec4(0.0, 0.0, -2.0, 1.0);
}
`;
}

function wgslTrailVertex(kernel: KernelSystem, out: KernelOutput, opts: DrawShaderOptions): string {
  const points = kernel.trail ?? 0;
  return `
attribute position : vec3<f32>;
attribute uv : vec2<f32>;
uniform viewProjection : mat4x4<f32>;
uniform view : mat4x4<f32>;
uniform kcam : vec3<f32>;
uniform kdraw : vec4<f32>;
uniform kdraw3 : vec4<f32>;
uniform ktrail : vec4<f32>;
var<storage, read> ku : array<vec4<f32>>;
var<storage, read> ks : array<vec4<f32>>;
var<storage, read> kl : array<vec4<f32>>;
var<storage, read> khist : array<vec4<f32>>;
${opts.sorted ? "var<storage, read> kidx : array<vec2<f32>>;" : ""}
varying vUV : vec2<f32>;
varying vUV2 : vec2<f32>;
varying vBlend : f32;
varying vColor : vec4<f32>;
varying vDepth : f32;
varying vWorld : vec3<f32>;
varying vEye : vec3<f32>;
var<private> k_slot : u32;
var<private> k_frame : f32;
fn k_lutAt(row: i32, i: i32) -> vec4f { return kl[row * ${LUT_SAMPLES} + i]; }
fn k_hist(k: f32) -> vec4f {
  let f = k_frame - k;
  let block = u32(f - floor(f / ${fl(points)}) * ${fl(points)});
  return khist[block * ${kernel.capacity}u + k_slot];
}
${ksl(GLOBALS + PRELUDE + outputKsl(out, "wgsl"), "wgsl")}
${ksl(ORIENT + TRAIL, "wgsl")}
@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let i = ${opts.sorted ? "u32(kidx[vertexInputs.instanceIndex].y)" : "vertexInputs.instanceIndex"};
  k_slot = i;
  k_frame = uniforms.ktrail.x;
  let b = i * 4u;
  a0 = ks[b];
  a1 = ks[b + 1u];
  a2 = ks[b + 2u];
  a3 = ks[b + 3u];
  k_idx = f32(i);
  k_outputStage();
  let vw = uniforms.view;
  let right = vec3f(vw[0][0], vw[1][0], vw[2][0]);
  let placed = k_trail(vertexInputs.position.y, vertexInputs.position.x, ${fl(points)}, i32(uniforms.ktrail.w), uniforms.kcam, right);
  vertexOutputs.vColor = k_oColor;
  let uvs = k_tileUV(vec2f(1.0 - k_trailU, vertexInputs.uv.y), uniforms.kdraw, uniforms.kdraw3.x);
  vertexOutputs.vUV = uvs.xy;
  vertexOutputs.vUV2 = uvs.zw;
  vertexOutputs.vBlend = k_tileBlend(uniforms.kdraw);
  let clip = uniforms.viewProjection * vec4f(placed.xyz, 1.0);
  vertexOutputs.vDepth = clip.w;
  vertexOutputs.vWorld = placed.xyz;
  vertexOutputs.vEye = uniforms.kcam;
  vertexOutputs.position = select(vec4f(0.0, 0.0, -2.0, 1.0), clip, placed.w > 0.5);
}
`;
}

/**
 * Kernel particles drawn with a material asset (ADR 0126): code spliced into the material's own vertex
 * shader (Babylon's PBR shader, by a material plugin) that reads the particle from textures and places
 * the mesh's vertex. `definitions` goes at module scope; `update` where the shader has `positionUpdated`
 * (and `normalUpdated`, `uvUpdated`, `colorUpdated` under their defines), mesh world matrix identity.
 *
 * Textures: the state as four (kps0..kps3, `kpdraw3.y` wide) or, `interleaved`, one texture of four
 * texels per particle (kpst); the uniforms one row (kpu); the look-up table (kpl); the sorted pairs
 * (kpidx, `kpdraw3.z` wide) when `sorted`. Uniforms: `kpdraw` (mode, speed scale, length scale, tile
 * columns), `kpdraw3` (tile rows, state width, pairs width, unused), `kpcam` (camera position).
 */
export function materialVertexCode(kernel: KernelSystem, k: number, dialect: ShaderDialect, opts: { sorted: boolean; interleaved: boolean }): { definitions: string; update: string; worldPos: string } {
  const out = kernel.outputs[k];
  const wgsl = dialect === "wgsl";
  const u = (name: string) => (wgsl ? `uniforms.${name}` : name);
  // The KSL helpers read uniforms as `ku[i]`; here they come from a texture row.
  const body = ksl(GLOBALS + PRELUDE + outputKsl(out, dialect) + ORIENT, dialect).replace(/\bku\[([^\]]+)\]/g, "k_u($1)");
  const fetch = (tex: string, x: string, y: string) => (wgsl ? `textureLoad(${tex}, vec2i(${x}, ${y}), 0)` : `texelFetch(${tex}, ivec2(${x}, ${y}), 0)`);
  const state = opts.interleaved
    ? wgsl
      ? `fn k_kpState(i: i32, a: i32) -> vec4f { let w = i32(${u("kpdraw3")}.y); return ${fetch("kpst", "(i % w) * 4 + a", "i / w")}; }`
      : `vec4 k_kpState(int i, int a) { int w = int(kpdraw3.y); return ${fetch("kpst", "(i % w) * 4 + a", "i / w")}; }`
    : wgsl
      ? `fn k_kpState(i: i32, a: i32) -> vec4f {
  let w = i32(${u("kpdraw3")}.y);
  let c = vec2i(i % w, i / w);
  if (a == 0) { return textureLoad(kps0, c, 0); }
  if (a == 1) { return textureLoad(kps1, c, 0); }
  if (a == 2) { return textureLoad(kps2, c, 0); }
  return textureLoad(kps3, c, 0);
}`
      : `vec4 k_kpState(int i, int a) {
  int w = int(kpdraw3.y);
  ivec2 c = ivec2(i % w, i / w);
  if (a == 0) { return texelFetch(kps0, c, 0); }
  if (a == 1) { return texelFetch(kps1, c, 0); }
  if (a == 2) { return texelFetch(kps2, c, 0); }
  return texelFetch(kps3, c, 0);
}`;
  const textures = wgsl
    ? [...(opts.interleaved ? ["kpst"] : ["kps0", "kps1", "kps2", "kps3"]), "kpu", "kpl", ...(opts.sorted ? ["kpidx"] : [])].map((t) => `var ${t}: texture_2d<f32>;`).join("\n")
    : [...(opts.interleaved ? ["kpst"] : ["kps0", "kps1", "kps2", "kps3"]), "kpu", "kpl", ...(opts.sorted ? ["kpidx"] : [])].map((t) => `uniform highp sampler2D ${t};`).join("\n");
  const definitions = wgsl
    ? `${textures}
fn k_u(i: i32) -> vec4f { return textureLoad(kpu, vec2i(i, 0), 0); }
fn k_lutAt(row: i32, i: i32) -> vec4f { return textureLoad(kpl, vec2i(i, row), 0); }
${state}
${body}
var<private> k_kpPos: vec3f;
var<private> k_kpNormal: vec3f;
var<private> k_kpUV: vec2f;
fn k_kpPlace(corner: vec3f, cornerNormal: vec3f, instance: u32) {
  var i = i32(instance);
  ${opts.sorted ? `let sw = i32(${u("kpdraw3")}.z);\n  i = i32(textureLoad(kpidx, vec2i(i % sw, i / sw), 0).y);` : ""}
  a0 = k_kpState(i, 0);
  a1 = k_kpState(i, 1);
  a2 = k_kpState(i, 2);
  a3 = k_kpState(i, 3);
  k_idx = f32(i);
  k_outputStage();
  let vw = scene.view;
  let right = vec3f(vw[0][0], vw[1][0], vw[2][0]);
  let up = vec3f(vw[0][1], vw[1][1], vw[2][1]);
  let placed = k_orient(corner, right, up, ${u("kpcam")}.xyz, ${u("kpdraw")});
  let p = k_orientCentre();
  k_kpPos = select(p, placed.xyz, placed.w > 0.5);
  let co = cos(a3.y);
  let sn = sin(a3.y);
  if (${u("kpdraw")}.x > 3.5) {
    k_kpNormal = vec3f(cornerNormal.x * co + cornerNormal.z * sn, cornerNormal.y, -cornerNormal.x * sn + cornerNormal.z * co);
  } else {
    k_kpNormal = normalize(${u("kpcam")}.xyz - p + vec3f(0.0, 0.000001, 0.0));
  }
  k_kpUV = k_tileUV(corner.xy + vec2f(0.5), ${u("kpdraw")}, ${u("kpdraw3")}.x).xy;
}
`
    : `${textures}
vec4 k_u(int i) { return texelFetch(kpu, ivec2(i, 0), 0); }
vec4 k_lutAt(int row, int i) { return texelFetch(kpl, ivec2(i, row), 0); }
${state}
${body}
vec3 k_kpPos;
vec3 k_kpNormal;
vec2 k_kpUV;
void k_kpPlace(vec3 corner, vec3 cornerNormal, int instance) {
  int i = instance;
  ${opts.sorted ? "int sw = int(kpdraw3.z);\n  i = int(texelFetch(kpidx, ivec2(i % sw, i / sw), 0).g);" : ""}
  a0 = k_kpState(i, 0);
  a1 = k_kpState(i, 1);
  a2 = k_kpState(i, 2);
  a3 = k_kpState(i, 3);
  k_idx = float(i);
  k_outputStage();
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
  vec4 placed = k_orient(corner, right, up, kpcam.xyz, kpdraw);
  vec3 p = k_orientCentre();
  k_kpPos = placed.w > 0.5 ? placed.xyz : p;
  float co = cos(a3.y);
  float sn = sin(a3.y);
  if (kpdraw.x > 3.5) {
    k_kpNormal = vec3(cornerNormal.x * co + cornerNormal.z * sn, cornerNormal.y, -cornerNormal.x * sn + cornerNormal.z * co);
  } else {
    k_kpNormal = normalize(kpcam.xyz - p + vec3(0.0, 0.000001, 0.0));
  }
  k_kpUV = k_tileUV(corner.xy + vec2(0.5), kpdraw, kpdraw3.x).xy;
}
`;
  const update = wgsl
    ? `#ifdef NORMAL
k_kpPlace(positionUpdated, normalUpdated, vertexInputs.instanceIndex);
normalUpdated = k_kpNormal;
#else
k_kpPlace(positionUpdated, vec3f(0.0, 1.0, 0.0), vertexInputs.instanceIndex);
#endif
positionUpdated = k_kpPos;
#ifdef UV1
uvUpdated = k_kpUV;
#endif
#ifdef VERTEXCOLOR
colorUpdated = k_oColor;
#endif
`
    : `#ifdef NORMAL
k_kpPlace(positionUpdated, normalUpdated, gl_InstanceID);
normalUpdated = k_kpNormal;
#else
k_kpPlace(positionUpdated, vec3(0.0, 1.0, 0.0), gl_InstanceID);
#endif
positionUpdated = k_kpPos;
#ifdef UV1
uvUpdated = k_kpUV;
#endif
#ifdef VERTEXCOLOR
colorUpdated = k_oColor;
#endif
`;
  // The draw is instanced (forcedInstanceCount), so Babylon multiplies by per-instance world matrices it
  // has no buffer for: the plugin's positions are world positions already, so take them as they are.
  const worldPos = wgsl
    ? `worldPos = vec4f(positionUpdated, 1.0);
vertexOutputs.vPositionW = positionUpdated;
#ifdef NORMAL
vertexOutputs.vNormalW = normalize(normalUpdated);
#endif
`
    : `worldPos = vec4(positionUpdated, 1.0);
vPositionW = positionUpdated;
#ifdef NORMAL
vNormalW = normalize(normalUpdated);
#endif
`;
  return { definitions, update, worldPos };
}

/** Draw mode numbers (`kdraw.x`). */
export const DRAW_MODE: Record<string, number> = { quad: 0, stretched: 1, horizontal: 2, vertical: 3, mesh: 4 };
