/**
 * Value and operator nodes of the particle graph (ADR 0060): their ports, port rates, connection
 * rules and a uniform evaluator the runtime calls once per system per frame.
 *
 * Values at run time (`NodeValue`): numbers, `number[]` for vectors (2, 3) and colours (4: sRGB
 * 0-1 RGBA; the backend converts), booleans, and 0057's `ParticleNumber`/`ParticleColor` objects for
 * curves, gradients and per-particle sources (`{random}`, `{curve}`, `{gradient}`…).
 *
 * Rates: a node's output is *per-particle* if the node is a per-particle source (Random Range,
 * Curve, Gradient, Random Curves/Gradients), or any wired input is per-particle. Everything else is
 * *uniform*: one value per frame. A Curve or Gradient used as an operator's input is just a
 * definition and counts as uniform there (Sample Curve of a Curve node is uniform).
 */
import { evalCurve, evalGradient, parseHexColor, type CurveKey, type ParticleColor, type ParticleGradient, type ParticleNumber } from "./particles";
import type { GraphInputValue, GraphNode, ParticleGraph } from "./particleGraph";

export type PortType = "number" | "vector2" | "vector3" | "color" | "curve" | "gradient" | "bool" | "event";
export type Rate = "uniform" | "particle";

export interface PortDef {
  name: string;
  label: string;
  type: PortType;
  default?: GraphInputValue;
}

export interface NodeSettingDef {
  name: string;
  label: string;
  kind: "number" | "string" | "enum" | "curve" | "gradient" | "color" | "vector";
  default: unknown;
  choices?: readonly string[];
}

export type NodeCategory = "Value" | "Particle" | "Sub-graph" | "Time" | "Math" | "Trigonometry" | "Sampling" | "Vector" | "Colour" | "Property" | "Event";

export interface NodeDef {
  type: string;
  label: string;
  description: string;
  category: NodeCategory;
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
  settings?: readonly NodeSettingDef[];
  /** "particle": a per-particle source. "uniform": one value per frame (operators become per-particle if any wired input is). */
  rate: Rate;
}

/** Runtime value of a port. */
export type NodeValue = number | number[] | boolean | ParticleNumber | ParticleColor;

export interface EvalContext {
  /** Seconds since the effect started playing, scaled by the time scale. */
  time: number;
  deltaTime: number;
  /** Seconds into the current spawn cycle (0 at the start of each loop). */
  playTime: number;
  /** Per-instance property overrides by name. */
  properties: ReadonlyMap<string, GraphInputValue>;
  random: () => number;
}

// --- registry ------------------------------------------------------------------------------------

const DEFAULT_GRADIENT: ParticleGradient = { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 1]] };
const DEFAULT_KEYS: CurveKey[] = [[0, 0], [1, 1]];

const port = (name: string, label: string, type: PortType, def?: GraphInputValue): PortDef => (def === undefined ? { name, label, type } : { name, label, type, default: def });
const numIn = (name: string, label: string, def: number) => port(name, label, "number", def);
const outPort = (type: PortType, name = "out", label = "Out"): PortDef => port(name, label, type);

const defs: NodeDef[] = [];
function add(
  category: NodeCategory,
  type: string,
  label: string,
  description: string,
  rate: Rate,
  inputs: PortDef[],
  outputs: PortDef[],
  settings?: NodeSettingDef[],
): void {
  defs.push(settings ? { type, label, description, category, inputs, outputs, settings, rate } : { type, label, description, category, inputs, outputs, rate });
}

// Value
add("Value", "constant.number", "Number", "A constant number.", "uniform", [], [outPort("number")], [{ name: "value", label: "Value", kind: "number", default: 0 }]);
add("Value", "constant.vector2", "Vector 2", "A constant 2D vector.", "uniform", [], [outPort("vector2")], [{ name: "value", label: "Value", kind: "vector", default: [0, 0] }]);
add("Value", "constant.vector3", "Vector 3", "A constant 3D vector.", "uniform", [], [outPort("vector3")], [{ name: "value", label: "Value", kind: "vector", default: [0, 0, 0] }]);
add("Value", "constant.color", "Colour", "A constant colour (#rrggbb[aa]).", "uniform", [], [outPort("color")], [{ name: "value", label: "Value", kind: "color", default: "#ffffff" }]);
add("Value", "randomRange", "Random Range", "A random number between Min and Max, chosen per particle.", "particle", [numIn("min", "Min", 0), numIn("max", "Max", 1)], [outPort("number")]);
add("Value", "curve", "Curve", "A curve over 0-1. Feeds an over-life input (evaluated per particle) or Sample Curve.", "particle", [], [outPort("curve")], [{ name: "keys", label: "Keys", kind: "curve", default: DEFAULT_KEYS }]);
add("Value", "randomCurves", "Random Between Curves", "A value between two curves, chosen per particle.", "particle", [], [outPort("curve")], [
  { name: "keysA", label: "Curve A", kind: "curve", default: DEFAULT_KEYS },
  { name: "keysB", label: "Curve B", kind: "curve", default: DEFAULT_KEYS },
]);
add("Value", "gradient", "Gradient", "A colour gradient over 0-1. Feeds an over-life input (evaluated per particle) or Sample Gradient.", "particle", [], [outPort("gradient")], [
  { name: "gradient", label: "Gradient", kind: "gradient", default: DEFAULT_GRADIENT },
]);
add("Value", "randomGradients", "Random Between Gradients", "A colour between two gradients, chosen per particle.", "particle", [], [outPort("gradient")], [
  { name: "gradientA", label: "Gradient A", kind: "gradient", default: DEFAULT_GRADIENT },
  { name: "gradientB", label: "Gradient B", kind: "gradient", default: DEFAULT_GRADIENT },
]);

// Particle (ADR 0095): a particle's own attributes, per-particle sources only kernel backends run (ADR 0094).
add("Particle", "particle.age", "Age", "Seconds since the particle was born.", "particle", [], [outPort("number")]);
add("Particle", "particle.lifetime", "Lifetime", "How many seconds the particle lives.", "particle", [], [outPort("number")]);
add("Particle", "particle.ageFraction", "Age over Lifetime", "The particle's age as a fraction of its lifetime: 0 at birth, 1 when it dies.", "particle", [], [outPort("number")]);
add("Particle", "particle.position", "Particle Position", "The particle's position, in the system's space.", "particle", [], [outPort("vector3")]);
add("Particle", "particle.velocity", "Particle Velocity", "The particle's velocity, in the system's space (m/s).", "particle", [], [outPort("vector3")]);
add("Particle", "particle.speed", "Particle Speed", "How fast the particle moves (m/s).", "particle", [], [outPort("number")]);
add("Particle", "particle.size", "Particle Size", "The particle's start size (m).", "particle", [], [outPort("number")]);
add("Particle", "particle.color", "Particle Colour", "The particle's start colour.", "particle", [], [outPort("color")]);
add("Particle", "particle.index", "Particle Index", "The particle's slot in the system, 0 to capacity - 1.", "particle", [], [outPort("number")]);
add("Particle", "particle.random", "Particle Random", "A random number in 0-1 that stays the same for the particle's whole life. Different Seeds give different numbers.", "particle", [], [outPort("number")], [
  { name: "seed", label: "Seed", kind: "number", default: 0 },
]);

// Sub-graph (ADR 0095): a particle sub-graph asset used as one node. Its ports come from the asset;
// it's inlined before compiling (particleSubgraphs.ts), so it has no evaluator of its own.
add("Sub-graph", "subgraph", "Sub-graph", "A reusable group of nodes from a particle sub-graph asset (*.particlesubgraph.json).", "uniform", [], [], [
  { name: "asset", label: "Asset", kind: "string", default: "" },
]);

// Time
add("Time", "time", "Time", "Seconds since the effect started playing (scaled by the time scale).", "uniform", [], [outPort("number")]);
add("Time", "deltaTime", "Delta Time", "Seconds since the last frame (scaled by the time scale).", "uniform", [], [outPort("number")]);
add("Time", "playTime", "Play Time", "Seconds into the current spawn cycle: 0 at the start of each loop, up to the system's duration.", "uniform", [], [outPort("number")]);

// Math (numbers, component-wise on vectors, a number broadcast against a vector)
const mathNodes: [string, string, string, PortDef[]][] = [
  ["add", "Add", "A + B.", [numIn("a", "A", 0), numIn("b", "B", 0)]],
  ["subtract", "Subtract", "A - B.", [numIn("a", "A", 0), numIn("b", "B", 0)]],
  ["multiply", "Multiply", "A x B.", [numIn("a", "A", 1), numIn("b", "B", 1)]],
  ["divide", "Divide", "A / B (0 when B is 0).", [numIn("a", "A", 1), numIn("b", "B", 1)]],
  ["negate", "Negate", "-X.", [numIn("x", "X", 0)]],
  ["abs", "Abs", "The absolute value of X.", [numIn("x", "X", 0)]],
  ["min", "Min", "The smaller of A and B.", [numIn("a", "A", 0), numIn("b", "B", 0)]],
  ["max", "Max", "The larger of A and B.", [numIn("a", "A", 0), numIn("b", "B", 0)]],
  ["clamp", "Clamp", "X limited to Min..Max.", [numIn("x", "X", 0), numIn("min", "Min", 0), numIn("max", "Max", 1)]],
  ["lerp", "Lerp", "A + (B - A) x T.", [numIn("a", "A", 0), numIn("b", "B", 1), numIn("t", "T", 0.5)]],
  ["remap", "Remap", "Maps X from In Min..In Max to Out Min..Out Max (not clamped).", [
    numIn("x", "X", 0), numIn("inMin", "In Min", 0), numIn("inMax", "In Max", 1), numIn("outMin", "Out Min", 0), numIn("outMax", "Out Max", 1),
  ]],
  ["step", "Step", "1 when X >= Edge, else 0.", [numIn("edge", "Edge", 0.5), numIn("x", "X", 0)]],
  ["smoothstep", "Smoothstep", "0 below Edge 0, 1 above Edge 1, a smooth ramp between.", [numIn("edge0", "Edge 0", 0), numIn("edge1", "Edge 1", 1), numIn("x", "X", 0)]],
];
for (const [type, label, description, inputs] of mathNodes) add("Math", type, label, description, "uniform", inputs, [outPort("number")]);

// Trigonometry
add("Trigonometry", "sine", "Sine", "sin(X), X in radians.", "uniform", [numIn("x", "X", 0)], [outPort("number")]);
add("Trigonometry", "cosine", "Cosine", "cos(X), X in radians.", "uniform", [numIn("x", "X", 0)], [outPort("number")]);

// Sampling
add("Sampling", "sampleCurve", "Sample Curve", "A curve's value at T (0-1). The curve is wired in or set inline.", "uniform", [
  port("curve", "Curve", "curve", { curve: DEFAULT_KEYS }), numIn("t", "T", 0),
], [outPort("number")]);
add("Sampling", "sampleGradient", "Sample Gradient", "A gradient's colour at T (0-1). The gradient is wired in or set inline.", "uniform", [
  port("gradient", "Gradient", "gradient", { gradient: DEFAULT_GRADIENT }), numIn("t", "T", 0),
], [outPort("color")]);
add("Sampling", "noise", "Noise", "Smooth 1D value noise of X x Frequency, in -1..1. Deterministic for a given Seed.", "uniform", [
  numIn("x", "X", 0), numIn("frequency", "Frequency", 1),
], [outPort("number")], [{ name: "seed", label: "Seed", kind: "number", default: 0 }]);

// Vector
add("Vector", "compose2", "Compose Vector 2", "Builds a vector from X and Y.", "uniform", [numIn("x", "X", 0), numIn("y", "Y", 0)], [outPort("vector2")]);
add("Vector", "compose3", "Compose Vector 3", "Builds a vector from X, Y and Z.", "uniform", [numIn("x", "X", 0), numIn("y", "Y", 0), numIn("z", "Z", 0)], [outPort("vector3")]);
add("Vector", "split2", "Split Vector 2", "A vector's components.", "uniform", [port("v", "Vector", "vector2", [0, 0])], [outPort("number", "x", "X"), outPort("number", "y", "Y")]);
add("Vector", "split3", "Split Vector 3", "A vector's components.", "uniform", [port("v", "Vector", "vector3", [0, 0, 0])], [outPort("number", "x", "X"), outPort("number", "y", "Y"), outPort("number", "z", "Z")]);
add("Vector", "length", "Length", "A vector's length (2D or 3D).", "uniform", [port("v", "Vector", "vector3", [0, 0, 0])], [outPort("number")]);
add("Vector", "normalize", "Normalize", "A vector scaled to length 1 (zero stays zero). 2D or 3D.", "uniform", [port("v", "Vector", "vector3", [0, 0, 0])], [outPort("vector3")]);

// Colour
add("Colour", "colorFromHSV", "Colour from HSV", "A colour from hue, saturation, value (all 0-1, hue wraps) and alpha.", "uniform", [
  numIn("h", "Hue", 0), numIn("s", "Saturation", 1), numIn("v", "Value", 1), numIn("a", "Alpha", 1),
], [outPort("color")]);
add("Colour", "multiplyColor", "Multiply Colour", "A x B, per channel (alpha included).", "uniform", [
  port("a", "A", "color", "#ffffff"), port("b", "B", "color", "#ffffff"),
], [outPort("color")]);

// Property
add("Property", "property", "Property", "The value of a Blackboard property: the instance's override, else the graph's own value.", "uniform", [], [outPort("number")], [
  { name: "name", label: "Property", kind: "string", default: "" },
]);

// Event
add("Event", "event.play", "On Play", "Fires when the effect starts playing.", "uniform", [], [outPort("event")]);
add("Event", "event.stop", "On Stop", "Fires when the effect is stopped.", "uniform", [], [outPort("event")]);
add("Event", "event.custom", "Custom Event", "Fires when a script sends this event by name (particleSystem.sendEvent).", "uniform", [], [outPort("event")], [
  { name: "name", label: "Name", kind: "string", default: "" },
]);

export const NODES: readonly NodeDef[] = defs;

const byType = new Map(defs.map((d) => [d.type, d]));
export const nodeDef = (type: string): NodeDef | undefined => byType.get(type);

/** Math nodes work on numbers, on vectors component-wise, and broadcast a number against a vector. */
const GENERIC_MATH = new Set(mathNodes.map((m) => m[0]));
/** Length and Normalize take a vector of 2 or 3 components. */
const VECTOR_GENERIC = new Set(["length", "normalize"]);

// --- graph index -----------------------------------------------------------------------------------

/** @internal */
export interface Index {
  graph: ParticleGraph;
  nodes: Map<string, GraphNode>;
  /** Wire target ("node.input") to its source ("node.port"). */
  wires: Map<string, string>;
}

/** @internal The kernel compiler (ADR 0094) shares the graph index. */
export function indexOf(graph: ParticleGraph): Index {
  const nodes = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodes.set(n.id, n);
  const wires = new Map<string, string>();
  for (const e of graph.edges) wires.set(e.to, e.from);
  return { graph, nodes, wires };
}

/** Splits `"<id>.<port>"` at the last dot. */
export function splitRef(ref: string): [string, string] {
  const i = ref.lastIndexOf(".");
  return i < 0 ? [ref, ""] : [ref.slice(0, i), ref.slice(i + 1)];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function setting(node: GraphNode, def: NodeDef, name: string): unknown {
  const v = node.settings?.[name];
  return v !== undefined ? v : def.settings?.find((s) => s.name === name)?.default;
}

export function curveSetting(node: GraphNode, def: NodeDef, name: string): CurveKey[] {
  const v = setting(node, def, name);
  const ok = Array.isArray(v) && v.every((k) => Array.isArray(k) && typeof k[0] === "number" && typeof k[1] === "number");
  return ok ? (v as CurveKey[]) : DEFAULT_KEYS;
}

export function gradientSetting(node: GraphNode, def: NodeDef, name: string): ParticleGradient {
  const v = setting(node, def, name);
  if (isObject(v) && Array.isArray(v.colors)) return { colors: v.colors as ParticleGradient["colors"], alphas: Array.isArray(v.alphas) ? (v.alphas as ParticleGradient["alphas"]) : [] };
  // The ADR's example keeps a gradient's keys flat in the settings.
  const flat = node.settings;
  if (name === "gradient" && flat && Array.isArray(flat.colors)) return { colors: flat.colors as ParticleGradient["colors"], alphas: Array.isArray(flat.alphas) ? (flat.alphas as ParticleGradient["alphas"]) : [] };
  return DEFAULT_GRADIENT;
}

// --- types -----------------------------------------------------------------------------------------

const PROPERTY_PORT_TYPE: Record<string, PortType | null> = { number: "number", vector2: "vector2", vector3: "vector3", color: "color", curve: "curve", gradient: "gradient", texture: null };

function vectorWidthType(width: number): PortType | null {
  return width === 3 ? "vector3" : width === 2 ? "vector2" : null;
}

function outputTypeIn(ix: Index, node: GraphNode, port: string, seen: Set<string>): PortType | null {
  const def = nodeDef(node.type);
  const out = def?.outputs.find((o) => o.name === port);
  if (!def || !out) return null;
  if (node.type === "property") {
    const prop = ix.graph.properties.find((p) => p.name === setting(node, def, "name"));
    return prop ? (PROPERTY_PORT_TYPE[prop.type] ?? null) : null;
  }
  const generic = GENERIC_MATH.has(node.type);
  if (!generic && !VECTOR_GENERIC.has(node.type)) return out.type;
  if (seen.has(node.id)) return out.type;
  seen.add(node.id);
  // The widest vector among the inputs decides; numbers alone stay numbers.
  let width = 0;
  for (const input of def.inputs) {
    const wired = ix.wires.get(`${node.id}.${input.name}`);
    let t: PortType | null = null;
    if (wired) {
      const [id, p] = splitRef(wired);
      const src = ix.nodes.get(id);
      t = src ? outputTypeIn(ix, src, p, seen) : null;
    } else {
      const inline = node.inputs?.[input.name];
      if (Array.isArray(inline)) t = vectorWidthType(inline.length);
    }
    width = Math.max(width, t === "vector3" ? 3 : t === "vector2" ? 2 : 0);
  }
  seen.delete(node.id);
  if (node.type === "length") return "number";
  if (node.type === "normalize") return width === 2 ? "vector2" : "vector3";
  return width ? vectorWidthType(width) : "number";
}

/** Output port type of a node (Property nodes take their property's type; math follows its widest vector input). */
export function outputType(graph: ParticleGraph, node: GraphNode, port: string): PortType | null {
  return outputTypeIn(indexOf(graph), node, port, new Set());
}

/** Does `start` depend (through value wires) on node `target`? */
function dependsOn(ix: Index, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = ix.nodes.get(id);
    const def = node && nodeDef(node.type);
    if (!node || !def) continue;
    for (const input of def.inputs) {
      const from = ix.wires.get(`${id}.${input.name}`);
      if (from) stack.push(splitRef(from)[0]);
    }
  }
  return false;
}

/**
 * Why a wire from `from` ("node.port") to a node input ("node.port") or a block input of `toType`
 * can't be made, or null. Types must match, except a number broadcasts into a vector, a vector
 * feeds a math node's number input (component-wise), and a 2D vector feeds Length/Normalize.
 * Curves and gradients only go to curve and gradient inputs. No cycles; events and values don't mix.
 */
export function whyNotConnect(graph: ParticleGraph, from: string, to: string, toType: PortType): string | null {
  const ix = indexOf(graph);
  const [fromId, fromPort] = splitRef(from);
  const src = ix.nodes.get(fromId);
  if (!src) return `There's no node "${fromId}".`;
  const srcDef = nodeDef(src.type);
  if (!srcDef) return `Unknown node type "${src.type}".`;
  if (!srcDef.outputs.some((o) => o.name === fromPort)) return `${srcDef.label} has no output "${fromPort}".`;
  const fromType = outputTypeIn(ix, src, fromPort, new Set());
  if (!fromType) return `${srcDef.label}'s output has no value type.`;

  const [toId, toPort] = splitRef(to);
  const dst = ix.nodes.get(toId);
  const dstDef = dst && nodeDef(dst.type);
  if (dst && !dstDef) return `Unknown node type "${dst.type}".`;
  if (dst && dstDef && !dstDef.inputs.some((i) => i.name === toPort)) return `${dstDef.label} has no input "${toPort}".`;

  if (fromType === "event" || toType === "event") {
    return fromType === toType ? null : "Events and values can't be connected.";
  }
  if (dst && (dst === src || dependsOn(ix, fromId, toId))) return "That wire would make a loop.";

  if (fromType === toType) return null;
  if (fromType === "number" && (toType === "vector2" || toType === "vector3")) return null;
  if (dst && GENERIC_MATH.has(dst.type) && toType === "number" && (fromType === "vector2" || fromType === "vector3")) return null;
  if (dst && VECTOR_GENERIC.has(dst.type) && toType === "vector3" && fromType === "vector2") return null;
  if (fromType === "curve" || fromType === "gradient") return "A curve or gradient can only be wired into a curve or gradient input.";
  return `Can't connect a ${fromType} to a ${toType} input.`;
}

// --- rates -----------------------------------------------------------------------------------------

/** A curve or gradient definition used as an operator's input is uniform: it's the shape, not a per-particle draw. */
export const isDefinitionNode = (type: string) => type === "curve" || type === "gradient";

function inputRate(ix: Index, node: GraphNode, def: NodeDef, input: PortDef, memo: Map<string, Rate>, visiting: Set<string>): Rate {
  const wired = ix.wires.get(`${node.id}.${input.name}`);
  if (wired) {
    const src = ix.nodes.get(splitRef(wired)[0]);
    if (src && isDefinitionNode(src.type)) return "uniform";
    return rateIn(ix, wired, memo, visiting);
  }
  const inline = node.inputs?.[input.name] ?? input.default;
  return isObject(inline) && input.type !== "curve" && input.type !== "gradient" ? "particle" : "uniform";
}

function rateIn(ix: Index, from: string, memo: Map<string, Rate>, visiting: Set<string>): Rate {
  const cached = memo.get(from);
  if (cached) return cached;
  const [id] = splitRef(from);
  const node = ix.nodes.get(id);
  const def = node && nodeDef(node.type);
  if (!node || !def) return "uniform";
  if (visiting.has(from)) return "uniform";
  visiting.add(from);
  let rate: Rate = def.rate;
  if (rate === "uniform") {
    if (node.type === "property") {
      const prop = ix.graph.properties.find((p) => p.name === setting(node, def, "name"));
      if (prop && (prop.type === "curve" || prop.type === "gradient" || ((prop.type === "number" || prop.type === "color") && isObject(prop.value)))) rate = "particle"; // curves and gradients are per-particle sources, like Curve nodes
    }
    for (const input of def.inputs) {
      if (rate === "particle") break;
      if (inputRate(ix, node, def, input, memo, visiting) === "particle") rate = "particle";
    }
  }
  visiting.delete(from);
  memo.set(from, rate);
  return rate;
}

/** Rate of a node output: per-particle if the node is a per-particle source or any wired input is. */
export function portRate(graph: ParticleGraph, from: string): Rate {
  return rateIn(indexOf(graph), from, new Map(), new Set());
}

// --- evaluation ------------------------------------------------------------------------------------

type Getter = (ctx: EvalContext) => NodeValue;
type Args = NodeValue[];
type Impl = (a: Args, ctx: EvalContext) => NodeValue;
/** Builds a node's evaluator once, at compile time (`port` is the output index). */
type Factory = (node: GraphNode, def: NodeDef, graph: ParticleGraph, port: number) => Impl;

const asNumber = (v: NodeValue, what: string): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`${what} needs a number.`);
};
const asVector = (v: NodeValue, what: string): number[] => {
  if (Array.isArray(v)) return v;
  throw new Error(`${what} needs a vector.`);
};

/** Lifts a scalar function over numbers and vectors: vectors work component-wise, a number broadcasts. */
function lift(fn: (...n: number[]) => number): Impl {
  return (a) => {
    let width = -1;
    for (const v of a) if (Array.isArray(v)) width = width < 0 ? v.length : Math.min(width, v.length);
    if (width < 0) return fn(...(a as number[]));
    const out = new Array<number>(width);
    for (let i = 0; i < width; i++) out[i] = fn(...a.map((v) => (Array.isArray(v) ? v[i] : (v as number))));
    return out;
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function hash(n: number, seed: number): number {
  let x = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth 1D value noise in -1..1: random lattice values blended with a smoothstep. */
function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(i, seed);
  return a + (hash(i + 1, seed) - a) * u;
}

function hsv(h: number, s: number, v: number, a: number): number[] {
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [rgb[0], rgb[1], rgb[2], a];
}

const same = (fn: Impl): Factory => () => fn;

const FACTORIES: Record<string, Factory> = {
  "constant.number": (n, d) => {
    const v = setting(n, d, "value");
    const value = typeof v === "number" && Number.isFinite(v) ? v : 0;
    return () => value;
  },
  "constant.vector2": (n, d) => vectorConstant(n, d, 2),
  "constant.vector3": (n, d) => vectorConstant(n, d, 3),
  "constant.color": (n, d) => {
    const v = setting(n, d, "value");
    const value = typeof v === "string" ? parseHexColor(v) : [1, 1, 1, 1];
    return () => value;
  },
  randomRange: () => (a) => ({ random: [asNumber(a[0], "Random Range"), asNumber(a[1], "Random Range")] }),
  curve: (n, d) => {
    const value: ParticleNumber = { curve: curveSetting(n, d, "keys") };
    return () => value;
  },
  randomCurves: (n, d) => {
    const value: ParticleNumber = { randomCurves: [curveSetting(n, d, "keysA"), curveSetting(n, d, "keysB")] };
    return () => value;
  },
  gradient: (n, d) => {
    const value: ParticleColor = { gradient: gradientSetting(n, d, "gradient") };
    return () => value;
  },
  randomGradients: (n, d) => {
    const value: ParticleColor = { randomGradients: [gradientSetting(n, d, "gradientA"), gradientSetting(n, d, "gradientB")] };
    return () => value;
  },

  time: same((_, ctx) => ctx.time),
  deltaTime: same((_, ctx) => ctx.deltaTime),
  playTime: same((_, ctx) => ctx.playTime),

  add: same(lift((a, b) => a + b)),
  subtract: same(lift((a, b) => a - b)),
  multiply: same(lift((a, b) => a * b)),
  divide: same(lift((a, b) => (b === 0 ? 0 : a / b))),
  negate: same(lift((x) => -x)),
  abs: same(lift((x) => Math.abs(x))),
  min: same(lift((a, b) => Math.min(a, b))),
  max: same(lift((a, b) => Math.max(a, b))),
  clamp: same(lift((x, lo, hi) => Math.min(Math.max(x, lo), hi))),
  lerp: same(lift((a, b, t) => a + (b - a) * t)),
  remap: same(lift((x, inMin, inMax, outMin, outMax) => (inMax === inMin ? outMin : outMin + ((x - inMin) / (inMax - inMin)) * (outMax - outMin)))),
  step: same(lift((edge, x) => (x >= edge ? 1 : 0))),
  smoothstep: same(
    lift((e0, e1, x) => {
      if (e0 === e1) return x >= e0 ? 1 : 0;
      const t = clamp01((x - e0) / (e1 - e0));
      return t * t * (3 - 2 * t);
    }),
  ),

  sine: same((a) => Math.sin(asNumber(a[0], "Sine"))),
  cosine: same((a) => Math.cos(asNumber(a[0], "Cosine"))),

  sampleCurve: same((a) => {
    const c = a[0];
    if (!isObject(c) || !("curve" in c)) throw new Error("Sample Curve needs a single curve.");
    return evalCurve((c as { curve: CurveKey[] }).curve, asNumber(a[1], "Sample Curve"));
  }),
  sampleGradient: same((a) => {
    const g = a[0];
    if (!isObject(g) || !("gradient" in g)) throw new Error("Sample Gradient needs a single gradient.");
    return evalGradient((g as { gradient: ParticleGradient }).gradient, asNumber(a[1], "Sample Gradient"));
  }),
  noise: (n, d) => {
    const s = setting(n, d, "seed");
    const seed = typeof s === "number" && Number.isFinite(s) ? s : 0;
    return (a) => valueNoise(asNumber(a[0], "Noise") * asNumber(a[1], "Noise"), seed);
  },

  compose2: same((a) => [asNumber(a[0], "Compose"), asNumber(a[1], "Compose")]),
  compose3: same((a) => [asNumber(a[0], "Compose"), asNumber(a[1], "Compose"), asNumber(a[2], "Compose")]),
  split2: (_n, _d, _g, port) => (a) => asVector(a[0], "Split")[port] ?? 0,
  split3: (_n, _d, _g, port) => (a) => asVector(a[0], "Split")[port] ?? 0,
  length: same((a) => Math.hypot(...asVector(a[0], "Length"))),
  normalize: same((a) => {
    const v = asVector(a[0], "Normalize");
    const len = Math.hypot(...v);
    return len === 0 ? v.map(() => 0) : v.map((c) => c / len);
  }),

  colorFromHSV: same((a) => hsv(asNumber(a[0], "HSV"), asNumber(a[1], "HSV"), asNumber(a[2], "HSV"), asNumber(a[3], "HSV"))),
  multiplyColor: same((a) => {
    const x = asVector(a[0], "Multiply Colour");
    const y = asVector(a[1], "Multiply Colour");
    return [x[0] * y[0], x[1] * y[1], x[2] * y[2], x[3] * y[3]];
  }),

  ...Object.fromEntries(
    ["age", "lifetime", "ageFraction", "position", "velocity", "speed", "size", "color", "index", "random"].map((a): [string, Factory] => [
      `particle.${a}`,
      (n, d) => {
        throw new Error(`${d.label} node "${n.id}" reads each particle; that needs a kernel (GPU) backend, so the system must use simulation "auto" or "gpu".`);
      },
    ]),
  ),
  property: (n, d, graph) => {
    const name = String(setting(n, d, "name") ?? "");
    const prop = graph.properties.find((p) => p.name === name);
    if (!prop) throw new Error(`Property node "${n.id}" refers to unknown property "${name}".`);
    if (prop.type === "texture") throw new Error(`Property "${name}" is a texture and has no value in the graph.`);
    return (_a, ctx) => propertyValue(ctx.properties.get(name) ?? prop.value, prop.type);
  },
};

function vectorConstant(node: GraphNode, def: NodeDef, width: number): Impl {
  const v = setting(node, def, "value");
  const ok = Array.isArray(v) && v.length >= width && v.every((c) => typeof c === "number");
  const value = ok ? (v as number[]).slice(0, width) : new Array<number>(width).fill(0);
  return () => value;
}

function propertyValue(raw: GraphInputValue, type: string): NodeValue {
  if (type === "color" && typeof raw === "string") return parseHexColor(raw);
  if (Array.isArray(raw)) return raw.slice();
  if (typeof raw === "string") throw new Error(`Property value "${raw}" doesn't match its type ${type}.`);
  return raw;
}

/** The constant a node's unwired input takes: its inline value, else the port default. */
export function inlineValue(node: GraphNode, input: PortDef): NodeValue {
  const raw = node.inputs?.[input.name] ?? input.default;
  if (raw === undefined) throw new Error(`Node "${node.id}" has no value for input "${input.name}".`);
  if (typeof raw === "string") {
    if (input.type === "color") return parseHexColor(raw);
    throw new Error(`Node "${node.id}" input "${input.name}" doesn't take the text "${raw}".`);
  }
  if (Array.isArray(raw)) return raw.slice();
  return raw;
}

/**
 * Compile the uniform expression ending at node output `from` ("node.port") into a closure the
 * runtime calls every frame. A per-particle *source* (Random Range, Curve, Gradient…) compiles to
 * its `ParticleNumber`/`ParticleColor` value; an operator with a per-particle input can't, and
 * throws, as do cycles, unknown nodes or types, and event nodes.
 */
export function compileUniform(graph: ParticleGraph, from: string): (ctx: EvalContext) => NodeValue {
  const ix = indexOf(graph);
  const rates = new Map<string, Rate>();
  const compiled = new Map<string, Getter>();
  const visiting: string[] = [];

  const build = (ref: string): Getter => {
    const cached = compiled.get(ref);
    if (cached) return cached;
    const [id, portName] = splitRef(ref);
    const node = ix.nodes.get(id);
    if (!node) throw new Error(`There's no node "${id}" to evaluate.`);
    const def = nodeDef(node.type);
    if (!def) throw new Error(`Node "${id}" has the unknown type "${node.type}".`);
    const portIndex = def.outputs.findIndex((o) => o.name === portName);
    if (portIndex < 0) throw new Error(`${def.label} node "${id}" has no output "${portName}".`);
    if (def.category === "Event") throw new Error(`${def.label} node "${id}" is an event; it has no value.`);
    if (visiting.includes(ref)) throw new Error(`Nodes form a loop: ${[...visiting, ref].join(" -> ")}.`);
    visiting.push(ref);

    const getters: Getter[] = def.inputs.map((input) => {
      const wired = ix.wires.get(`${id}.${input.name}`);
      if (inputRate(ix, node, def, input, rates, new Set()) === "particle") {
        throw new Error(`${def.label} node "${id}" can't combine per-particle values (input "${input.label}"); that needs the GPU backend.`);
      }
      if (wired) return build(wired);
      const value = inlineValue(node, input);
      return () => value;
    });
    const factory = FACTORIES[node.type];
    if (!factory) throw new Error(`Node type "${node.type}" can't be evaluated.`);
    const impl = factory(node, def, graph, portIndex);
    const getter: Getter = getters.length === 0 ? (ctx) => impl([], ctx) : (ctx) => impl(getters.map((g) => g(ctx)), ctx);
    visiting.pop();
    compiled.set(ref, getter);
    return getter;
  };

  return build(from);
}
