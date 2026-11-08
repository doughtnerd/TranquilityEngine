/**
 * Particle kernels (ADR 0094): each particle system compiled to a small, renderer-neutral program of
 * per-particle statements that the kernel executors run (WebGPU compute, WebGL2 textures,
 * JavaScript; `render/particles/gpu/`). Where `particleCompile.ts` lowers a system to 0057's emitter
 * settings for the CPU simulation, this keeps the graph's per-particle maths: operator chains over
 * Particle nodes, Set Attribute blocks (ADR 0095), several outputs, GPU events.
 *
 * A kernel has three stages:
 * - **init** runs once in each newly spawned slot (the Initialize context and the spawn shape);
 * - **update** runs every frame in each live slot (the Update context);
 * - **output** runs per drawn particle, once per Output context, so outputs share one simulation:
 *   it turns the simulated attributes into the colour, size and flipbook tile drawn.
 *
 * Particle state is 16 floats in four vec4 slots (`A0`–`A3`, see `ATTR`); uniforms are vec4s, a
 * fixed header (`U`) and then one vec4 per binding; curves and gradients are rows of a look-up table.
 */
import { blockDef } from "./particleBlocks";
import type { ParticleProgram } from "./particleCompile";
import type { GraphBlock, GraphInputValue, GraphProblem, OutputContext, OutputSettings, OutputType, ParticleGraph, ParticleGraphSystem } from "./particleGraph";
import { compileUniform, curveSetting, gradientSetting, indexOf, inlineValue, isDefinitionNode, nodeDef, portRate, setting, splitRef, type EvalContext, type Index, type NodeValue } from "./particleNodes";
import { evalCurve, parseHexColor, type CurveKey, type ParticleColor, type ParticleGradient, type ParticleNumber } from "./particles";

// --- layout ------------------------------------------------------------------------------------------

/** Floats of state per particle. */
export const KERNEL_FLOATS = 16;
/** Samples per look-up table row. */
export const LUT_SAMPLES = 128;
/** vec4 uniforms before the first binding. */
export const HEADER_VEC4 = 24;

/** Where each attribute lives: [vec4 slot, first component, width]. */
export const ATTR = {
  position: [0, 0, 3],
  age: [0, 3, 1],
  velocity: [1, 0, 3],
  lifetime: [1, 3, 1],
  color: [2, 0, 4],
  size: [3, 0, 1],
  rotation: [3, 1, 1],
  tile: [3, 2, 1],
  seed: [3, 3, 1],
} as const;
export type AttrName = keyof typeof ATTR;

/** Header vec4 indices. */
export const U = {
  /** time, deltaTime, playTime, spawn fraction (0-1 through the spawn cycle). */
  time: 0,
  /** spawnStart, spawnCount, capacity, frame number. */
  spawn: 1,
  /** Node world matrix, 4 columns. */
  matrix: 2,
  /** Its inverse, 4 columns. */
  inverse: 6,
  /** Linear tint. */
  tint: 10,
  /** spawned before this frame, system seed, child slots per parent (events), parent capacity. */
  misc: 11,
  /** Events: count per trigger, probability, rate × dt (frame triggers), inherit velocity (0/1). */
  event: 12,
  /** trigger (0 birth, 1 death, 2 frame; -1 no parent), unused, world space (0/1), the event parent's world space (0/1). */
  flags: 13,
  /** Camera view-projection, 4 columns (depth collision). */
  viewProj: 14,
  /** Depth: width, height, enabled (0/1), near. */
  depth: 18,
  /** The view matrix's z row (view depth of a point = dot(row, p) with p.w = 1). */
  viewZ: 19,
  /** Depth: far, unused ×3. */
  depth2: 20,
} as const;

// --- expressions ---------------------------------------------------------------------------------------

/** Built-in per-particle values besides attributes. */
export type KLocal =
  /** Age over lifetime, 0-1. */
  | "t"
  /** The slot index. */
  | "index"
  /** |velocity| × speed modifier. */
  | "speed"
  /** Init: the spawn shape's sample (stage local, vec3) and direction (vec3). */
  | "spos"
  | "sdir"
  /** Update/output: the speed-over-life multiplier. */
  | "speedMod"
  /** Output: what's drawn. */
  | "oColor"
  | "oSize"
  | "oTile";

export const LOCAL_WIDTH: Record<KLocal, number> = { t: 1, index: 1, speed: 1, spos: 3, sdir: 3, speedMod: 1, oColor: 4, oSize: 1, oTile: 1 };

export type KOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "neg"
  | "abs"
  | "min"
  | "max"
  | "clamp"
  | "lerp"
  | "remap"
  | "step"
  | "smoothstep"
  | "sin"
  | "cos"
  | "noise1"
  | "vec"
  | "length"
  | "normalize"
  | "hsv"
  | "toLinear";

export type KExpr =
  | { k: "const"; v: number[] }
  | { k: "uniform"; slot: number; w: number }
  | { k: "attr"; name: AttrName }
  | { k: "local"; name: KLocal }
  /** A stable random in [0, 1) for this particle and `salt`. */
  | { k: "rand"; salt: number }
  /** Look-up table row `row` at `t` (clamped 0-1): `.x` (w 1) or all four (w 4). */
  | { k: "lut"; row: number; t: KExpr; w: 1 | 4 }
  /** Component `i` of `e`. */
  | { k: "swz"; e: KExpr; i: number }
  | { k: "op"; op: KOp; args: KExpr[]; w: number; seed?: number };

export function widthOf(e: KExpr): number {
  switch (e.k) {
    case "const":
      return e.v.length;
    case "uniform":
      return e.w;
    case "attr":
      return ATTR[e.name][2];
    case "local":
      return LOCAL_WIDTH[e.name];
    case "rand":
    case "swz":
      return 1;
    case "lut":
      return e.w;
    case "op":
      return e.w;
  }
}

export type KTarget = { attr: AttrName } | { local: KLocal };

/** A built-in step with fixed code in every executor. */
export type KBuiltin =
  /** Init: sample the shape into `spos`/`sdir`. args: radius, angle, arc, thickness, width, height, donutRadius, columns, rows, spread. */
  | "shape"
  /** Init: place the particle: position/velocity from the shape, the node (or the parent particle) and the space. args: offset (vec3), speed. */
  | "place"
  /** Update: age the particle (marks it dying). */
  | "age"
  /** Update: gravity from the header. */
  | "gravity"
  /** args: force (vec3). */
  | "force"
  /** args: center (vec3), strength. */
  | "gpoint"
  /** args: scale (vec3), octaves, velocity (vec3), time scale (vec3). */
  | "turbulence"
  /** args: limit, dampen. */
  | "limit"
  /** Update: position += velocity × speedMod × dt. */
  | "integrate"
  /** args: frequency, power, position amount, rotation amount; `index` tells noise blocks apart. */
  | "noise"
  /** args: speed (°/s), axis (vec3). */
  | "orbit"
  /** args: height, bounce, kill (0/1). */
  | "plane"
  /** args: bounce, kill (0/1), thickness. Needs the depth texture (GPU executors). */
  | "depth"
  /** args: speed (°/s). */
  | "spin";

export type KStmt =
  | { s: "set"; target: KTarget; mode: "set" | "add" | "mul"; e: KExpr }
  | { s: "builtin"; b: KBuiltin; args: KExpr[]; index?: number; shape?: { type: string; mode: string }; rotation?: number };

export interface KUniform {
  /** vec4 index. */
  slot: number;
  /** "color": an sRGB colour the executor converts to linear; "matrix3": a shape rotation (3 vec4s) from Euler degrees. */
  kind: "number" | "vector" | "color" | "matrix3";
  evaluate(ctx: EvalContext): NodeValue;
}

export interface KLut {
  row: number;
  /** "curve": `.x`; "gradient": RGBA, linear or sRGB. */
  kind: "curve" | "gradient";
  linear: boolean;
  /** Fixed keys, or a source re-evaluated when properties change (a curve or gradient property). */
  value: CurveKey[] | ParticleGradient;
  source?: (ctx: EvalContext) => NodeValue;
  /** For random-between sources: which of the pair. */
  pick?: 0 | 1;
}

export interface KernelOutput {
  type: OutputType;
  settings: OutputSettings;
  stmts: KStmt[];
  /** Flipbook. */
  tiles: [number, number];
  blendTiles: boolean;
  /** Trail outputs (ADR 0126): the look-up row of the width along the trail (0 at the head). */
  trail?: { widthRow: number };
}

export interface KernelEvent {
  /** Index of the parent kernel in `KernelProgram.systems`. */
  parent: number;
  trigger: "birth" | "death" | "frame";
  probability: number;
  inheritVelocity: boolean;
}

export interface KernelSystem {
  id: string;
  name: string;
  /** Index into `ParticleProgram.effect.emitters` / `.systems`. */
  emitter: number;
  capacity: number;
  space: "local" | "world";
  init: KStmt[];
  update: KStmt[];
  outputs: KernelOutput[];
  uniforms: KUniform[];
  /** vec4 uniforms in all (header + bindings). */
  uniformVec4: number;
  luts: KLut[];
  /** Started by a GPU event from another kernel system. */
  event: KernelEvent | null;
  /** Uses depth-buffer collision. */
  depth: boolean;
  /** Trail history points kept per slot (ADR 0126: the most any trail output asks for), 0 or absent: none. */
  trail?: number;
  /** Why this system needs a kernel ("auto" picks one), empty when it doesn't. */
  needs: string[];
  /** Blocks the kernel doesn't run (the CPU does): reasons, for "auto". */
  unsupported: string[];
}

export interface KernelProgram {
  systems: KernelSystem[];
  problems: GraphProblem[];
}

/** "auto" picks a kernel from this capacity up (ADR 0094). */
export const AUTO_KERNEL_CAPACITY = 4096;

// --- helpers -----------------------------------------------------------------------------------------

const c = (...v: number[]): KExpr => ({ k: "const", v });
const op = (o: KOp, args: KExpr[], w?: number): KExpr => ({ k: "op", op: o, args, w: w ?? resultWidth(o, args) });
const attr = (name: AttrName): KExpr => ({ k: "attr", name });
const local = (name: KLocal): KExpr => ({ k: "local", name });

/** Width of an op's result: component-wise ops take the narrowest vector argument (numbers broadcast). */
export function resultWidth(o: KOp, args: KExpr[]): number {
  if (o === "length") return 1;
  if (o === "vec") return args.reduce((n, a) => n + widthOf(a), 0);
  if (o === "hsv") return 4;
  if (o === "noise1" || o === "sin" || o === "cos") return 1;
  if (o === "toLinear") return widthOf(args[0]);
  let w = 0;
  for (const a of args) {
    const aw = widthOf(a);
    if (aw > 1) w = w === 0 ? aw : Math.min(w, aw);
  }
  return w || 1;
}

const srgbToLinear = (x: number): number => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
/** `#rrggbb[aa]` as linear RGBA. */
export function linearColor(hex: string): number[] {
  const [r, g, b, a] = parseHexColor(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), a];
}
/** sRGB RGBA (0-1) as linear. */
export function toLinearRGBA(v: readonly number[]): number[] {
  return [srgbToLinear(v[0] ?? 1), srgbToLinear(v[1] ?? 1), srgbToLinear(v[2] ?? 1), v[3] ?? 1];
}

/** Bake a look-up table row: LUT_SAMPLES × 4 floats. */
export function bakeLutRow(l: Pick<KLut, "kind" | "linear" | "value">, out: Float32Array, offset: number): void {
  for (let i = 0; i < LUT_SAMPLES; i++) {
    const t = i / (LUT_SAMPLES - 1);
    const o = offset + i * 4;
    if (l.kind === "curve") {
      out[o] = evalCurve(l.value as CurveKey[], t);
      out[o + 1] = out[o + 2] = 0;
      out[o + 3] = 1;
    } else {
      const g = l.value as ParticleGradient;
      const colors = g.colors.length ? g.colors : ([[0, "#ffffff"]] as [number, string][]);
      for (let ch = 0; ch < 3; ch++) {
        // Interpolate in the row's space, as the CPU simulation does (linear) or Sample Gradient (sRGB).
        const keys = colors.map(([k, hex]) => {
          const v = parseHexColor(hex)[ch];
          return [k, l.linear ? srgbToLinear(v) : v] as CurveKey;
        });
        out[o + ch] = evalCurve(keys, t);
      }
      out[o + 3] = g.alphas.length ? evalCurve(g.alphas, t) : 1;
    }
  }
}

/** The 3×3 rotation (row-major) of Euler "XYZ" degrees, as the CPU simulation builds a shape's rotation. */
export function eulerMatrix(deg: readonly number[]): number[] {
  const D = Math.PI / 180;
  const [rx, ry, rz] = [(deg[0] ?? 0) * D, (deg[1] ?? 0) * D, (deg[2] ?? 0) * D];
  const a = Math.cos(rx);
  const b = Math.sin(rx);
  const cc = Math.cos(ry);
  const d = Math.sin(ry);
  const e = Math.cos(rz);
  const f = Math.sin(rz);
  return [cc * e, -cc * f, d, a * f + b * e * d, a * e - b * f * d, -b * cc, b * f - a * e * d, b * e + a * f * d, a * cc];
}

const RENDER_TYPES: readonly OutputType[] = ["quad", "stretched", "horizontal", "vertical", "mesh", "trail"];

/** Trail history points per slot at most, and in all (ADR 0126). */
export const MAX_TRAIL_POINTS = 64;
export const MAX_TRAIL_HISTORY = 4 * 1024 * 1024;
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Block types the kernel runs (others are reported and skipped; the CPU runs them). */
const KERNEL_BLOCKS = new Set([
  "spawn.rate",
  "spawn.rateOverDistance",
  "spawn.burst",
  "spawn.periodicBurst",
  "init.lifetime",
  "init.velocity",
  "init.size",
  "init.rotation",
  "init.color",
  "update.gravity",
  "update.colorOverLife",
  "update.sizeOverLife",
  "update.rotationOverLife",
  "update.speedOverLife",
  "update.forceOverLife",
  "update.gravityPoint",
  "update.noise",
  "update.turbulence",
  "update.orbit",
  "update.frameOverLife",
  "update.limitSpeed",
  "update.colorBySpeed",
  "update.sizeBySpeed",
  "update.collision",
  "update.collisionDepth",
  "update.triggerEvent",
  "output.flipbook",
]);

// --- compiler ----------------------------------------------------------------------------------------

/** A value lowered from a node: an expression, or a curve/gradient definition still to be sampled. */
type Lowered =
  | { e: KExpr; srgb?: boolean }
  | { curve: [number] | [number, number] }
  | { gradient: [number] | [number, number]; linear: boolean };

/**
 * Compile the kernels of `graph`'s enabled systems. `program` is `compileParticleGraph(graph)` (its
 * emitter order and events). Never throws.
 */
export function compileParticleKernels(graph: ParticleGraph, program: ParticleProgram): KernelProgram {
  const problems: GraphProblem[] = [];
  const ix = indexOf(graph);
  const systems = graph.systems.filter((s) => s.enabled !== false);
  const out: KernelSystem[] = systems.map((sys, i) => compileSystem(graph, ix, sys, i, problems));

  // GPU events: Trigger Event blocks wired to another system's start.
  const index = new Map(systems.map((s, i) => [s.id, i]));
  for (const ev of graph.events) {
    const [fromId, blockId] = ev.from.split(".");
    const [toId, end] = ev.to.split(".");
    if (blockId === undefined || end !== "start") continue;
    const parent = index.get(fromId);
    const child = index.get(toId);
    if (parent === undefined || child === undefined) continue;
    const block = systems[parent].update.blocks.find((b) => b.id === blockId) ?? systems[parent].initialize.blocks.find((b) => b.id === blockId);
    if (!block || block.enabled === false) continue;
    const on = String(block.inputs.on ?? "death");
    out[child].event = {
      parent,
      trigger: on === "birth" || on === "frame" ? on : "death",
      probability: num(block.inputs.probability, 1),
      inheritVelocity: block.inputs.inheritVelocity === true,
    };
    out[parent].needs.push("a GPU event");
    out[child].needs.push("a GPU event");
  }
  void program;
  return { systems: out, problems };
}

function compileSystem(graph: ParticleGraph, ix: Index, sys: ParticleGraphSystem, emitter: number, problems: GraphProblem[]): KernelSystem {
  const uniforms: KUniform[] = [];
  const luts: KLut[] = [];
  const needs: string[] = [];
  const unsupported: string[] = [];
  let nextSlot = HEADER_VEC4;
  let salt = 1;
  const report = (message: string, at: string) => problems.push({ severity: "warning", message, at });

  const uniform = (kind: KUniform["kind"], evaluate: KUniform["evaluate"], w: number): KExpr => {
    const slot = nextSlot;
    nextSlot += kind === "matrix3" ? 3 : 1;
    uniforms.push({ slot, kind, evaluate });
    return { k: "uniform", slot, w };
  };
  const lutRow = (l: Omit<KLut, "row">): number => {
    luts.push({ ...l, row: luts.length });
    return luts.length - 1;
  };
  const rand = (): KExpr => ({ k: "rand", salt: salt++ });

  /** A curve/gradient definition sampled at `t` (with a per-particle random for random-between pairs). */
  const sample = (v: Lowered, t: KExpr): { e: KExpr; srgb?: boolean } => {
    if ("e" in v) return v;
    if ("curve" in v) {
      const a: KExpr = { k: "lut", row: v.curve[0], t, w: 1 };
      return { e: v.curve.length === 1 ? a : op("lerp", [a, { k: "lut", row: v.curve[1], t, w: 1 }, rand()]) };
    }
    const a: KExpr = { k: "lut", row: v.gradient[0], t, w: 4 };
    return { e: v.gradient.length === 1 ? a : op("lerp", [a, { k: "lut", row: v.gradient[1], t, w: 4 }, rand()]), srgb: !v.linear };
  };

  /** A ParticleNumber/ParticleColor value (inline, or a property's) as a lowered value. */
  const lowerValue = (v: unknown, kind: "number" | "color" | "vector", source?: (ctx: EvalContext) => NodeValue): Lowered | null => {
    if (typeof v === "number") return { e: source ? uniform("number", source, 1) : c(v) };
    if (typeof v === "boolean") return { e: c(v ? 1 : 0) };
    if (Array.isArray(v) && v.every((x) => typeof x === "number")) return { e: source ? uniform("vector", source, v.length) : c(...(v as number[])) };
    if (typeof v === "string") {
      if (!/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return null;
      return { e: source ? uniform("color", source, 4) : c(...linearColor(v)) };
    }
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if ("random" in o && Array.isArray(o.random)) {
      const [a, b] = o.random as unknown[];
      if (typeof a === "number" && typeof b === "number") {
        if (source) {
          const pair = uniform("vector", (ctx) => {
            const r = source(ctx) as { random?: number[] };
            return Array.isArray(r?.random) ? r.random : [a, b];
          }, 2);
          return { e: op("lerp", [{ k: "swz", e: pair, i: 0 }, { k: "swz", e: pair, i: 1 }, rand()]) };
        }
        return { e: op("lerp", [c(a), c(b), rand()]) };
      }
      if (typeof a === "string" && typeof b === "string") return { e: op("lerp", [c(...linearColor(a)), c(...linearColor(b)), rand()]) };
      return null;
    }
    if ("curve" in o) return { curve: [lutRow({ kind: "curve", linear: false, value: o.curve as CurveKey[], source })] };
    if ("randomCurves" in o) {
      const [a, b] = o.randomCurves as [CurveKey[], CurveKey[]];
      return { curve: [lutRow({ kind: "curve", linear: false, value: a, source, pick: 0 }), lutRow({ kind: "curve", linear: false, value: b, source, pick: 1 })] };
    }
    if ("gradient" in o) return { gradient: [lutRow({ kind: "gradient", linear: true, value: o.gradient as ParticleGradient, source })], linear: true };
    if ("randomGradients" in o) {
      const [a, b] = o.randomGradients as [ParticleGradient, ParticleGradient];
      return { gradient: [lutRow({ kind: "gradient", linear: true, value: a, source, pick: 0 }), lutRow({ kind: "gradient", linear: true, value: b, source, pick: 1 })], linear: true };
    }
    void kind;
    return null;
  };

  /** Lower the node output `ref` ("node.port"). Uniform sub-expressions become uniform slots. */
  const lowerNode = (ref: string, seen: Set<string>): Lowered => {
    const [id, portName] = splitRef(ref);
    const node = ix.nodes.get(id);
    const def = node && nodeDef(node.type);
    if (!node || !def) throw new Error(`There's no node "${id}" to evaluate.`);
    if (seen.has(id)) throw new Error(`Nodes form a loop through "${id}".`);
    if (portRate(graph, ref) === "uniform") {
      const evaluate = compileUniform(graph, ref);
      const v0 = evaluate({ time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: () => 0.5 });
      if (typeof v0 === "number" || typeof v0 === "boolean") return { e: uniform("number", evaluate, 1) };
      if (Array.isArray(v0)) {
        const out = def.outputs.find((o) => o.name === portName);
        const isColor = out?.type === "color" || (node.type === "property" && graph.properties.find((p) => p.name === setting(node, def, "name"))?.type === "color");
        return isColor ? { e: uniform("vector", evaluate, 4), srgb: true } : { e: uniform("vector", evaluate, v0.length) };
      }
      return lowerValue(v0, "number", evaluate) ?? fail(`${def.label} node "${id}" has a value the kernel can't use.`);
    }
    seen.add(id);
    try {
      return lowerParticleNode(node.type, node, def, portName, seen);
    } finally {
      seen.delete(id);
    }
  };

  const fail = (message: string): never => {
    throw new Error(message);
  };

  const inputOf = (node: NonNullable<ReturnType<Index["nodes"]["get"]>>, name: string, seen: Set<string>): Lowered => {
    const def = nodeDef(node.type)!;
    const p = def.inputs.find((i) => i.name === name)!;
    const wired = ix.wires.get(`${node.id}.${name}`);
    if (wired) {
      const src = ix.nodes.get(splitRef(wired)[0]);
      // A Curve or Gradient feeding an operator is a definition (Sample Curve's curve).
      if (src && isDefinitionNode(src.type)) return lowerDefinition(src.type, src);
      return lowerNode(wired, seen);
    }
    const v = inlineValue(node, p);
    if (p.type === "color" && Array.isArray(v)) return { e: c(...v), srgb: true };
    return lowerValue(v, "number") ?? fail(`Node "${node.id}" input "${name}" has a value the kernel can't use.`);
  };

  const lowerDefinition = (type: string, node: NonNullable<ReturnType<Index["nodes"]["get"]>>): Lowered => {
    const def = nodeDef(type)!;
    switch (type) {
      case "curve":
        return { curve: [lutRow({ kind: "curve", linear: false, value: curveSetting(node, def, "keys") })] };
      case "randomCurves":
        return { curve: [lutRow({ kind: "curve", linear: false, value: curveSetting(node, def, "keysA") }), lutRow({ kind: "curve", linear: false, value: curveSetting(node, def, "keysB") })] };
      case "gradient":
        return { gradient: [lutRow({ kind: "gradient", linear: true, value: gradientSetting(node, def, "gradient") })], linear: true };
      default:
        return {
          gradient: [lutRow({ kind: "gradient", linear: true, value: gradientSetting(node, def, "gradientA") }), lutRow({ kind: "gradient", linear: true, value: gradientSetting(node, def, "gradientB") })],
          linear: true,
        };
    }
  };

  const expr = (l: Lowered, what: string): { e: KExpr; srgb?: boolean } => {
    if ("e" in l) return l;
    // A definition used as a plain value: sample it at the particle's age over lifetime.
    void what;
    return sample(l, local("t"));
  };

  const lowerParticleNode = (type: string, node: NonNullable<ReturnType<Index["nodes"]["get"]>>, def: NonNullable<ReturnType<typeof nodeDef>>, portName: string, seen: Set<string>): Lowered => {
    const arg = (name: string) => expr(inputOf(node, name, seen), def.label).e;
    switch (type) {
      case "particle.age":
        return { e: attr("age") };
      case "particle.lifetime":
        return { e: attr("lifetime") };
      case "particle.ageFraction":
        return { e: local("t") };
      case "particle.position":
        return { e: attr("position") };
      case "particle.velocity":
        return { e: attr("velocity") };
      case "particle.speed":
        return { e: local("speed") };
      case "particle.size":
        return { e: attr("size") };
      case "particle.color":
        return { e: attr("color") }; // linear already
      case "particle.index":
        return { e: local("index") };
      case "particle.random":
        return { e: { k: "rand", salt: 100000 + Math.round(num(setting(node, def, "seed"), 0)) } };
      case "randomRange":
        return { e: op("lerp", [arg("min"), arg("max"), rand()]) };
      case "curve":
      case "randomCurves":
      case "gradient":
      case "randomGradients":
        return lowerDefinition(type, node);
      case "add":
      case "subtract":
      case "multiply":
      case "divide":
      case "min":
      case "max": {
        const o = { add: "add", subtract: "sub", multiply: "mul", divide: "div", min: "min", max: "max" }[type] as KOp;
        return { e: op(o, [arg("a"), arg("b")]) };
      }
      case "negate":
        return { e: op("neg", [arg("x")]) };
      case "abs":
        return { e: op("abs", [arg("x")]) };
      case "clamp":
        return { e: op("clamp", [arg("x"), arg("min"), arg("max")]) };
      case "lerp":
        return { e: op("lerp", [arg("a"), arg("b"), arg("t")]) };
      case "remap":
        return { e: op("remap", [arg("x"), arg("inMin"), arg("inMax"), arg("outMin"), arg("outMax")]) };
      case "step":
        return { e: op("step", [arg("edge"), arg("x")]) };
      case "smoothstep":
        return { e: op("smoothstep", [arg("edge0"), arg("edge1"), arg("x")]) };
      case "sine":
        return { e: op("sin", [first(arg("x"))]) };
      case "cosine":
        return { e: op("cos", [first(arg("x"))]) };
      case "noise":
        return { e: { k: "op", op: "noise1", args: [op("mul", [first(arg("x")), first(arg("frequency"))])], w: 1, seed: Math.round(num(setting(node, def, "seed"), 0)) } };
      case "sampleCurve": {
        const curve = inputOf(node, "curve", seen);
        if (!("curve" in curve)) throw new Error(`Sample Curve node "${node.id}" needs a curve.`);
        return { e: sample(curve, first(arg("t"))).e };
      }
      case "sampleGradient": {
        const g = inputOf(node, "gradient", seen);
        if (!("gradient" in g)) throw new Error(`Sample Gradient node "${node.id}" needs a gradient.`);
        // Sample Gradient gives sRGB, as on the CPU: re-bake its rows in sRGB.
        const rows = g.gradient.map((r) => {
          const l = luts[r];
          return lutRow({ ...l, linear: false });
        }) as [number] | [number, number];
        return { e: sample({ gradient: rows, linear: false }, first(arg("t"))).e, srgb: true };
      }
      case "compose2":
        return { e: op("vec", [first(arg("x")), first(arg("y"))]) };
      case "compose3":
        return { e: op("vec", [first(arg("x")), first(arg("y")), first(arg("z"))]) };
      case "split2":
      case "split3":
        return { e: { k: "swz", e: arg("v"), i: portName === "x" ? 0 : portName === "y" ? 1 : 2 } };
      case "length":
        return { e: op("length", [arg("v")]) };
      case "normalize":
        return { e: op("normalize", [arg("v")]) };
      case "colorFromHSV":
        return { e: op("hsv", [first(arg("h")), first(arg("s")), first(arg("v")), first(arg("a"))]), srgb: true };
      case "multiplyColor": {
        const a = expr(inputOf(node, "a", seen), def.label);
        const b = expr(inputOf(node, "b", seen), def.label);
        return { e: op("mul", [a.srgb ? a.e : op("toLinear", [a.e]), b.srgb ? b.e : op("toLinear", [b.e])]), srgb: true };
      }
      default:
        throw new Error(`${def.label} node "${node.id}" can't run per particle.`);
    }
  };

  /** A block input as an expression of `kind`; `t` is what curves are read at (cycle fraction in init, age over life in update). */
  const input = (b: GraphBlock, name: string, kind: "number" | "color" | "vector", t: KExpr, needsKernel = true): KExpr => {
    const def = blockDef(b.type)?.inputs.find((i) => i.name === name);
    const own = b.inputs[name];
    const inline = own !== undefined && !(typeof own === "string" && own.startsWith("@")) ? own : (def?.default ?? 0);
    const from = ix.wires.get(`${sys.id}.${b.id}.${name}`);
    const at = `${sys.id}.${b.id}.${name}`;
    let l: Lowered | null = null;
    if (from) {
      try {
        const src = ix.nodes.get(splitRef(from)[0]);
        l = src && isDefinitionNode(src.type) ? lowerDefinition(src.type, src) : lowerNode(from, new Set());
        if (needsKernel && portRate(graph, from) === "particle" && !(src && (isDefinitionNode(src.type) || src.type === "randomRange" || src.type === "randomCurves" || src.type === "randomGradients" || src.type === "property")))
          needs.push("a per-particle operator chain");
      } catch (err) {
        report(`${(err as Error).message} The input uses its own value.`, at);
        l = null;
      }
    }
    l ??= lowerValue(inline, kind);
    if (!l) {
      report(`The input's value can't be used; it's taken as 0.`, at);
      l = { e: kind === "color" ? c(1, 1, 1, 1) : kind === "vector" ? c(0, 0, 0) : c(0) };
    }
    const s = sample(l, t);
    if (kind === "color") {
      const w = widthOf(s.e);
      const e4 = w === 4 ? s.e : w === 3 ? op("vec", [s.e, c(1)]) : op("vec", [s.e, s.e, s.e, c(1)]);
      return s.srgb ? op("toLinear", [e4]) : e4;
    }
    if (kind === "number") return first(s.e);
    return s.e;
  };

  const spawnT: KExpr = { k: "uniform", slot: U.time, w: 4 };
  const cycle: KExpr = { k: "swz", e: spawnT, i: 3 };
  const life: KExpr = local("t");

  // --- init -------------------------------------------------------------------------------------------
  const init: KStmt[] = [];
  init.push({ s: "set", target: { attr: "lifetime" }, mode: "set", e: c(1) });
  init.push({ s: "set", target: { attr: "size" }, mode: "set", e: c(0.1) });
  init.push({ s: "set", target: { attr: "rotation" }, mode: "set", e: c(0) });
  init.push({ s: "set", target: { attr: "color" }, mode: "set", e: c(1, 1, 1, 1) });
  init.push({ s: "set", target: { attr: "tile" }, mode: "set", e: c(0) });
  let speed: KExpr = c(0);
  let shapeType = "point";
  let shapeMode = "random";
  const zero = c(0);
  let shapeArgs: KExpr[] = Array.from({ length: 10 }, () => zero);
  let offset: KExpr = c(0, 0, 0);
  let rotation: KExpr | null = null;
  const attrSets: KStmt[] = [];
  const on = (b: GraphBlock) => b.enabled !== false;
  const skip = (b: GraphBlock, why: string) => {
    unsupported.push(`${blockDef(b.type)?.label ?? b.type}: ${why}`);
  };

  for (const b of sys.spawn.blocks.filter(on)) if (!KERNEL_BLOCKS.has(b.type)) skip(b, "not a block the kernel knows");
  for (const b of sys.initialize.blocks.filter(on)) {
    if (b.type.startsWith("init.position")) {
      shapeType = b.type.slice("init.position".length).toLowerCase();
      shapeMode = typeof b.inputs.mode === "string" ? b.inputs.mode : "random";
      shapeArgs = ["radius", "angle", "arc", "thickness", "width", "height", "donutRadius", "columns", "rows", "spread"].map((k) =>
        blockDef(b.type)?.inputs.some((x) => x.name === k) ? input(b, k, "number", cycle, false) : zero,
      );
      offset = input(b, "offset", "vector", cycle, false);
      const rotFrom = ix.wires.get(`${sys.id}.${b.id}.rotation`);
      const rot0 = Array.isArray(b.inputs.rotation) ? (b.inputs.rotation as number[]) : [0, 0, 0];
      if (rotFrom && portRate(graph, rotFrom) === "uniform") {
        const ev = compileUniform(graph, rotFrom);
        rotation = uniform("matrix3", ev, 3);
      } else if (rot0.some((x) => x !== 0)) {
        rotation = uniform("matrix3", () => rot0, 3);
      }
      continue;
    }
    switch (b.type) {
      case "init.lifetime":
        init.push({ s: "set", target: { attr: "lifetime" }, mode: "set", e: op("max", [input(b, "lifetime", "number", cycle), c(0.001)]) });
        break;
      case "init.velocity":
        speed = input(b, "speed", "number", cycle);
        break;
      case "init.size":
        init.push({ s: "set", target: { attr: "size" }, mode: "set", e: op("max", [input(b, "size", "number", cycle), c(0)]) });
        break;
      case "init.rotation":
        init.push({ s: "set", target: { attr: "rotation" }, mode: "set", e: op("mul", [input(b, "rotation", "number", cycle), c(Math.PI / 180)]) });
        break;
      case "init.color":
        init.push({ s: "set", target: { attr: "color" }, mode: "set", e: input(b, "color", "color", cycle) });
        break;
      case "update.triggerEvent":
        break;
      default:
        if (b.type.startsWith("attribute.")) attrSets.push(...setAttribute(b, cycle));
        else skip(b, "not a block the kernel knows");
    }
  }
  init.push({ s: "set", target: { attr: "color" }, mode: "mul", e: { k: "uniform", slot: U.tint, w: 4 } });
  init.push({ s: "builtin", b: "shape", args: shapeArgs, shape: { type: shapeType, mode: shapeMode }, rotation: rotation ? (rotation as { slot: number }).slot : undefined });
  init.push({ s: "builtin", b: "place", args: [offset, speed] });
  init.push(...attrSets);

  // --- update -----------------------------------------------------------------------------------------
  const update: KStmt[] = [{ s: "builtin", b: "age", args: [] }];
  const pre: KStmt[] = [];
  const speedMods: KStmt[] = [];
  const post: KStmt[] = [];
  const appearance: KStmt[] = [];
  let gravity: KExpr | null = null;
  let depth = false;
  let noiseIndex = 0;
  for (const b of sys.update.blocks.filter(on)) {
    const n = (name: string) => input(b, name, "number", life);
    switch (b.type) {
      case "update.gravity":
        gravity = input(b, "strength", "number", life);
        break;
      case "update.forceOverLife":
        pre.push({ s: "builtin", b: "force", args: [op("vec", [n("x"), n("y"), n("z")])] });
        break;
      case "update.gravityPoint":
        pre.push({ s: "builtin", b: "gpoint", args: [input(b, "center", "vector", life), n("strength")] });
        break;
      case "update.turbulence":
        pre.push({ s: "builtin", b: "turbulence", args: [input(b, "scale", "vector", life), n("octaves"), input(b, "velocity", "vector", life), input(b, "timeScale", "vector", life)] });
        break;
      case "update.limitSpeed":
        pre.push({ s: "builtin", b: "limit", args: [n("speed"), n("dampen")] });
        break;
      case "update.speedOverLife":
        speedMods.push({ s: "set", target: { local: "speedMod" }, mode: "mul", e: n("speed") });
        break;
      case "update.noise":
        post.push({ s: "builtin", b: "noise", args: [n("frequency"), n("power"), n("positionAmount"), n("rotationAmount")], index: noiseIndex++ });
        break;
      case "update.orbit":
        post.push({ s: "builtin", b: "orbit", args: [n("speed"), input(b, "axis", "vector", life)] });
        break;
      case "update.collision":
        post.push({ s: "builtin", b: "plane", args: [n("height"), n("bounce"), c(b.inputs.kill === true ? 1 : 0)] });
        break;
      case "update.collisionDepth":
        depth = true;
        needs.push("depth collision");
        post.push({ s: "builtin", b: "depth", args: [n("bounce"), c(b.inputs.kill === true ? 1 : 0), n("thickness")] });
        break;
      case "update.rotationOverLife":
        post.push({ s: "builtin", b: "spin", args: [n("speed")] });
        break;
      case "update.colorOverLife":
        appearance.push({ s: "set", target: { local: "oColor" }, mode: "mul", e: input(b, "color", "color", life) });
        break;
      case "update.sizeOverLife":
        appearance.push({ s: "set", target: { local: "oSize" }, mode: "mul", e: n("size") });
        break;
      case "update.frameOverLife":
        appearance.push({ s: "set", target: { local: "oTile" }, mode: "set", e: n("frame") });
        break;
      case "update.colorBySpeed":
      case "update.sizeBySpeed": {
        const lo = num(b.inputs.min, 0);
        const hi = num(b.inputs.max, 1);
        const f = hi > lo ? op("clamp", [op("div", [op("sub", [local("speed"), c(lo)]), c(hi - lo)]), c(0), c(1)]) : c(0);
        if (b.type === "update.colorBySpeed") appearance.push({ s: "set", target: { local: "oColor" }, mode: "mul", e: input(b, "color", "color", f) });
        else appearance.push({ s: "set", target: { local: "oSize" }, mode: "mul", e: input(b, "size", "number", f) });
        break;
      }
      case "update.triggerEvent":
        break;
      case "update.collisionColliders":
        skip(b, "colliders are CPU only");
        report("Collide with colliders runs only on the CPU simulation; kernel backends skip it (use Collide with depth buffer).", `${sys.id}.${b.id}`);
        break;
      default:
        if (b.type.startsWith("attribute.")) {
          const stmts = setAttribute(b, life);
          if (b.type === "attribute.velocity") pre.push(...stmts);
          else post.push(...stmts);
        } else skip(b, "not a block the kernel knows");
    }
  }
  if (gravity) update.push({ s: "builtin", b: "gravity", args: [gravity] });
  update.push(...pre, ...speedMods, { s: "builtin", b: "integrate", args: [] }, ...post);

  // --- outputs ----------------------------------------------------------------------------------------
  const outputs: KernelOutput[] = [];
  let trailPoints = 0;
  const contexts: OutputContext[] = [sys.output, ...(sys.extraOutputs ?? [])];
  if (contexts.length > 1) needs.push("several outputs");
  contexts.forEach((o, k) => {
    const at = `${sys.id}.output${k ? k + 1 : ""}`;
    if (!RENDER_TYPES.includes(o.type)) {
      unsupported.push(`${o.type} output`);
      report(`Kernel backends don't draw ${o.type} outputs yet; this one draws as quads.`, at);
    }
    if (o.settings.material && o.type === "trail") {
      // Other outputs draw material assets (PBR materials and shader graphs, ADR 0126); trails don't yet.
      unsupported.push("material asset on a trail output");
      report(`Kernel trails don't draw material assets yet; this trail draws with its texture.`, at);
    }
    const stmts: KStmt[] = [...speedMods, ...appearance];
    let tiles: [number, number] = [1, 1];
    let blendTiles = false;
    let widthRow: number | null = null;
    if (o.type === "trail") trailPoints = Math.max(trailPoints, Math.min(MAX_TRAIL_POINTS, Math.max(2, Math.round(num(o.settings.trailLength, 20)))));
    for (const b of o.blocks.filter(on)) {
      if (b.type === "output.widthOverLength") {
        // Baked to a look-up row (the width varies along the ribbon, per vertex); a wired value isn't per-vertex.
        if (ix.wires.has(`${sys.id}.${b.id}.width`)) report("Kernel trails take Width over Length's own value (a constant or curve), not a wire.", `${sys.id}.${b.id}`);
        const v = lowerValue(b.inputs.width ?? 1, "number");
        if (v && "curve" in v) widthRow = v.curve[0];
        else {
          const w = v && "e" in v && v.e.k === "const" ? v.e.v[0] : 1;
          widthRow = lutRow({ kind: "curve", linear: false, value: [[0, w], [1, w]] });
        }
        continue;
      }
      if (b.type === "output.flipbook") {
        const t = b.inputs.tiles;
        if (Array.isArray(t)) tiles = [Math.max(1, Math.round(num(t[0], 1))), Math.max(1, Math.round(num(t[1], 1)))];
        blendTiles = b.inputs.blendTiles === true;
        stmts.unshift({ s: "set", target: { local: "oTile" }, mode: "add", e: input(b, "startTile", "number", life, false) });
      } else if (b.type.startsWith("attribute.")) {
        stmts.push(...setAttribute(b, life, true));
      } else {
        unsupported.push(`${blockDef(b.type)?.label ?? b.type} (output)`);
        report(`"${b.type}" isn't an Output block kernel backends know; it's skipped.`, `${sys.id}.${b.id}`);
      }
    }
    const trail = o.type === "trail" ? { widthRow: widthRow ?? lutRow({ kind: "curve", linear: false, value: [[0, 1], [1, 1]] }) } : undefined;
    outputs.push({ type: RENDER_TYPES.includes(o.type) ? o.type : "quad", settings: o.settings, stmts, tiles, blendTiles, ...(trail ? { trail } : {}) });
  });
  const capacity = Math.max(1, Math.round(sys.settings.capacity));
  if (trailPoints * capacity > MAX_TRAIL_HISTORY) {
    const fit = Math.max(2, Math.floor(MAX_TRAIL_HISTORY / capacity));
    report(`Kernel trails keep at most ${MAX_TRAIL_HISTORY} points in all: ${capacity} particles get ${fit} points each, not ${trailPoints}.`, `${sys.id}.output`);
    trailPoints = fit;
  }

  function setAttribute(b: GraphBlock, t: KExpr, output = false): KStmt[] {
    needs.push("a Set Attribute block");
    const kind = b.type.slice("attribute.".length);
    const mode = b.inputs.mode === "add" ? "add" : b.inputs.mode === "multiply" ? "mul" : "set";
    switch (kind) {
      case "position":
      case "velocity":
        return [{ s: "set", target: { attr: kind }, mode, e: input(b, "value", "vector", t) }];
      case "color":
        return [{ s: "set", target: output ? { local: "oColor" } : { attr: "color" }, mode, e: input(b, "value", "color", t) }];
      case "alpha": {
        // Only the alpha channel: (1,1,1,a) multiplies; set/add touch .w through a full vec4.
        const a = input(b, "value", "number", t);
        const target: KTarget = output ? { local: "oColor" } : { attr: "color" };
        const cur: KExpr = "local" in target ? local(target.local) : attr(target.attr);
        if (mode === "mul") return [{ s: "set", target, mode: "mul", e: op("vec", [c(1, 1, 1), a]) }];
        const w = mode === "add" ? op("add", [{ k: "swz", e: cur, i: 3 }, a]) : a;
        return [{ s: "set", target, mode: "set", e: op("vec", [{ k: "swz", e: cur, i: 0 }, { k: "swz", e: cur, i: 1 }, { k: "swz", e: cur, i: 2 }, w]) }];
      }
      case "size":
        return [{ s: "set", target: output ? { local: "oSize" } : { attr: "size" }, mode, e: input(b, "value", "number", t) }];
      case "rotation":
        return [{ s: "set", target: { attr: "rotation" }, mode, e: mode === "mul" ? input(b, "value", "number", t) : op("mul", [input(b, "value", "number", t), c(Math.PI / 180)]) }];
      case "lifetime":
        return [{ s: "set", target: { attr: "lifetime" }, mode, e: input(b, "value", "number", t) }];
      default:
        skip(b, "unknown attribute");
        return [];
    }
  }

  if (sys.settings.capacity >= AUTO_KERNEL_CAPACITY) needs.push(`${sys.settings.capacity} particles`);
  return {
    id: sys.id,
    name: sys.name,
    emitter,
    capacity: Math.max(1, Math.round(sys.settings.capacity)),
    space: sys.settings.space,
    init,
    update,
    outputs,
    uniforms,
    uniformVec4: nextSlot,
    luts,
    event: null,
    depth,
    ...(trailPoints ? { trail: trailPoints } : {}),
    needs: [...new Set(needs)],
    unsupported,
  };
}

/** The first component of a value (operators that take numbers). */
function first(e: KExpr): KExpr {
  return widthOf(e) === 1 ? e : { k: "swz", e, i: 0 };
}

// --- backend choice ----------------------------------------------------------------------------------

export type KernelExecutor = "webgpu" | "webgl2" | "js";
export type SystemBackend = "cpu" | KernelExecutor;

/**
 * The backend a system runs on (ADR 0094): `"cpu"` systems and "auto" systems that don't need a
 * kernel use the CPU; the others the best executor available (`executors` in preference order).
 */
export function chooseBackend(choice: "auto" | "cpu" | "gpu" | undefined, kernel: KernelSystem, executors: readonly KernelExecutor[]): SystemBackend {
  const best = executors[0] ?? "js";
  if (choice === "cpu") return "cpu";
  if (choice === "gpu") return best;
  // auto: a kernel when needed (or big) and everything the system has runs on it.
  if (kernel.needs.length === 0) return "cpu";
  if (kernel.unsupported.length > 0 && !kernel.needs.some((n) => n !== `${kernel.capacity} particles`)) return "cpu";
  return best;
}

/** Re-bake rows whose source is a property, into `lut` (rows × LUT_SAMPLES × 4). */
export function bakeLuts(kernel: KernelSystem, lut: Float32Array, ctx: EvalContext | null): void {
  for (const l of kernel.luts) {
    let value = l.value;
    if (l.source && ctx) {
      try {
        const v = l.source(ctx) as ParticleNumber | ParticleColor;
        if (v && typeof v === "object") {
          if (l.kind === "curve") value = "curve" in v ? v.curve : "randomCurves" in v ? v.randomCurves[l.pick ?? 0] : value;
          else value = "gradient" in v ? v.gradient : "randomGradients" in v ? v.randomGradients[l.pick ?? 0] : value;
        }
      } catch {
        // keep the graph's own value
      }
    }
    bakeLutRow({ kind: l.kind, linear: l.linear, value }, lut, l.row * LUT_SAMPLES * 4);
  }
}

/** Evaluate the kernel's uniform bindings into `out` (vec4s), converting colours to linear. */
export function writeBindings(kernel: KernelSystem, ctx: EvalContext, out: Float32Array): void {
  for (const u of kernel.uniforms) {
    let v: NodeValue;
    try {
      v = u.evaluate(ctx);
    } catch {
      continue;
    }
    const o = u.slot * 4;
    if (u.kind === "matrix3") {
      const m = eulerMatrix(Array.isArray(v) ? v : [0, 0, 0]);
      out.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0], o);
      continue;
    }
    if (typeof v === "number") out[o] = v;
    else if (typeof v === "boolean") out[o] = v ? 1 : 0;
    else if (Array.isArray(v)) {
      const vals = u.kind === "color" ? toLinearRGBA(v) : v;
      for (let i = 0; i < 4; i++) out[o + i] = vals[i] ?? (u.kind === "color" && i === 3 ? 1 : 0);
    }
  }
}

/** For tests and tools: every input value type a block input of `kind` can hold lowered to a constant. */
export type { GraphInputValue };
