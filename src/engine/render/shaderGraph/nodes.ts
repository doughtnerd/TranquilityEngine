/**
 * The shader graph node library (ADR 0047): each node type's ports, settings and the GLSL or WGSL it
 * emits. Shared by the compiler and the editor's Shader Graph panel, so both agree on every port.
 */
import { Assets, normalizeAssetPath } from "../../scene/Assets";
import type { GraphNode, GraphProperty, GraphPropertyType, InputValue, ShaderGraph } from "../../scene/shaderGraph";
import { OUTPUT_NODE_TYPE, parseShaderGraph } from "../../scene/shaderGraph";
import type { ShaderLevel } from "../../core/graphics";

/** A value's GLSL type; `texture` is a `sampler2D` uniform. */
export type ValueType = "float" | "vec2" | "vec3" | "vec4" | "texture";
/** `dynamic` ports take the widest vector connected to the node's dynamic inputs (Unity's "Dynamic Vector"). */
export type PortType = ValueType | "dynamic";

/** Values an unconnected input can read instead of an inline value. */
export type Builtin = "uv" | "objectPosition" | "worldPosition" | "viewPosition" | "objectNormal" | "worldNormal" | "viewNormal" | "viewDirection";

export interface PortDef {
  id: string;
  label: string;
  type: PortType;
  /** An unconnected input's value when the node has none of its own. */
  default?: InputValue;
  /** An unconnected input reads this built-in value instead (no inline field). */
  bind?: Builtin;
  /** The inline value is a colour, edited with a picker and stored in sRGB (converted to linear in the shader). */
  color?: boolean;
  /** Output node: computed in the vertex shader. */
  vertex?: boolean;
  /** Output node: only for lit (and physical) graphs. */
  litOnly?: boolean;
  /** Output node: only for physical graphs (ADR 0052); compiled in only when connected or away from its default. */
  physicalOnly?: boolean;
  /** Output node: only applied when connected (or, for alpha clip, when above 0). */
  optional?: boolean;
  /** Texture inputs: the texture an unconnected input reads (a Sub Graph's texture property default). */
  texture?: string;
}

export interface SettingDef {
  id: string;
  label: string;
  kind: "select" | "text" | "color" | "texture" | "property" | "subgraph" | "keyword";
  options?: readonly string[];
  default: string;
}

export type ShaderStage = "vertex" | "fragment";

/** What a node's `emit` gets: its inputs as WGSL expressions, already converted to each port's type. */
export interface EmitContext {
  in: Record<string, string>;
  /** A value type's WGSL name: `vec3f`, `f32`. */
  typeName(t: ValueType): string;
  /** Sample a texture uniform at a UV expression (WGSL also needs the uniform's sampler, and a mip level in the vertex stage). */
  sample(texture: string, uv: string): string;
  /** The resolved type of the node's dynamic ports. */
  type: ValueType;
  settings: Record<string, string>;
  stage: ShaderStage;
  /** The shader level the graph is compiled for (ADR 0050). */
  shaderLevel: ShaderLevel;
  /** A built-in value's expression in this stage. */
  builtin(b: Builtin | "time" | "resolution"): string;
  /** Add a helper function (from `HELPERS_WGSL`) to this stage's declarations. */
  helper(name: HelperName): void;
  /** The uniform for an inline texture (an asset path); empty paths read white. */
  texture(path: string): string;
  /** The uniform of a graph property, or null if there's none of that name. */
  property(name: string): { uniform: string; type: ValueType } | null;
  /** A keyword's constant (`bool`, or a `u32` value index for an enum) and its values (null: on/off), or null if the graph has none of that name (ADR 0106). */
  keyword(name: string): { constant: string; values: string[] | null } | null;
  /** A `#rrggbb[aa]` colour (sRGB) as a linear `vec4` literal. */
  color(hex: string): string;
  /** Record how a texture uniform is sampled: as a colour (sRGB-decoded) or linear data (normal maps). */
  sampleMode(uniform: string, linear: boolean): void;
  problem(message: string): void;
}

export interface NodeDef {
  type: string;
  title: string;
  category: "Input" | "Math" | "Vector" | "Color" | "Noise" | "Lighting" | "Output";
  /** More words node search matches. */
  keywords?: string;
  inputs: PortDef[];
  outputs: PortDef[];
  settings?: SettingDef[];
  /** Only runs in the fragment shader (it can't feed the vertex offset). */
  fragmentOnly?: boolean;
  /** Quality Branch: the compiler evaluates only the input for the shader level, so the other branches cost nothing. */
  branch?: boolean;
  /** Ports that depend on the node's settings or the graph, when they do. */
  ports?(node: GraphNode, graph: ShaderGraph): { inputs: PortDef[]; outputs: PortDef[] };
  /** WGSL expressions for the outputs, by port id. */
  emit(c: EmitContext): Record<string, string>;
}

// --- helper functions ------------------------------------------------------------------------------

/** The helpers names a node can ask for (`EmitContext.helper`). */
export type HelperName = "random" | "valueNoise" | "simpleNoise" | "gradientNoise" | "voronoi" | "hsv" | "rotate" | "mainLight" | "tangentFrame";

/**
 * Helper functions in WGSL, hand-written. WGSL has no overloading, so `mod` is spelled out as
 * `x - y * floor(x / y)`, `?:` is `select`, and every function is typed. The light helpers read the
 * scene's main light (`uMycoMainLightDir`, `uMycoMainLightColor`).
 */
export const HELPERS_WGSL: Record<HelperName, string> = {
  random: `fn mycoRandom(uv: vec2f) -> f32 { return fract(sin(dot(uv, vec2f(12.9898, 78.233))) * 43758.5453); }`,
  valueNoise: `fn mycoValueNoise(uv: vec2f) -> f32 {
  let i: vec2f = floor(uv);
  var f: vec2f = fract(uv);
  f = f * f * (3.0 - 2.0 * f);
  let a: f32 = mycoRandom(i);
  let b: f32 = mycoRandom(i + vec2f(1.0, 0.0));
  let c: f32 = mycoRandom(i + vec2f(0.0, 1.0));
  let d: f32 = mycoRandom(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`,
  simpleNoise: `fn mycoSimpleNoise(uv: vec2f, scale: f32) -> f32 {
  var t: f32 = 0.0;
  for (var i: i32 = 0; i < 3; i++) {
    let freq: f32 = pow(2.0, f32(i));
    let amp: f32 = pow(0.5, f32(3 - i));
    t += mycoValueNoise(uv * scale / freq) * amp;
  }
  return t;
}`,
  gradientNoise: `fn mycoMod289(x: f32) -> f32 { return x - 289.0 * floor(x / 289.0); }
fn mycoGradientDir(pIn: vec2f) -> vec2f {
  let p: vec2f = pIn - 289.0 * floor(pIn / 289.0);
  var x: f32 = mycoMod289((34.0 * p.x + 1.0) * p.x) + p.y;
  x = mycoMod289((34.0 * x + 1.0) * x);
  x = fract(x / 41.0) * 2.0 - 1.0;
  return normalize(vec2f(x - floor(x + 0.5), abs(x) - 0.5));
}
fn mycoGradientNoise(uv: vec2f, scale: f32) -> f32 {
  let p: vec2f = uv * scale;
  let ip: vec2f = floor(p);
  var fp: vec2f = fract(p);
  let d00: f32 = dot(mycoGradientDir(ip), fp);
  let d01: f32 = dot(mycoGradientDir(ip + vec2f(0.0, 1.0)), fp - vec2f(0.0, 1.0));
  let d10: f32 = dot(mycoGradientDir(ip + vec2f(1.0, 0.0)), fp - vec2f(1.0, 0.0));
  let d11: f32 = dot(mycoGradientDir(ip + vec2f(1.0, 1.0)), fp - vec2f(1.0, 1.0));
  fp = fp * fp * fp * (fp * (fp * 6.0 - 15.0) + 10.0);
  return mix(mix(d00, d01, fp.y), mix(d10, d11, fp.y), fp.x) + 0.5;
}`,
  voronoi: `fn mycoVoronoiOffset(uvIn: vec2f, offset: f32) -> vec2f {
  let m: mat2x2f = mat2x2f(15.27, 47.63, 99.41, 89.98);
  let uv: vec2f = fract(sin(m * uvIn) * 46839.32);
  return vec2f(sin(uv.y * offset) * 0.5 + 0.5, cos(uv.x * offset) * 0.5 + 0.5);
}
fn mycoVoronoi(uv: vec2f, angleOffset: f32, cellDensity: f32) -> vec2f {
  let g: vec2f = floor(uv * cellDensity);
  let f: vec2f = fract(uv * cellDensity);
  var best: f32 = 8.0;
  var cell: f32 = 0.0;
  for (var y: i32 = -1; y <= 1; y++) {
    for (var x: i32 = -1; x <= 1; x++) {
      let lattice: vec2f = vec2f(f32(x), f32(y));
      let o: vec2f = mycoVoronoiOffset(lattice + g, angleOffset);
      let d: f32 = distance(lattice + o, f);
      if (d < best) { best = d; cell = o.x; }
    }
  }
  return vec2f(best, cell);
}`,
  hsv: `fn mycoRgbToHsv(c: vec3f) -> vec3f {
  let K: vec4f = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p: vec4f = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q: vec4f = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d: f32 = q.x - min(q.w, q.y);
  let e: f32 = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
fn mycoHsvToRgb(c: vec3f) -> vec3f {
  let K: vec4f = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p: vec3f = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, saturate(p - K.xxx), c.y);
}`,
  rotate: `fn mycoRotate(uv: vec2f, center: vec2f, r: f32) -> vec2f {
  let d: vec2f = uv - center;
  let s: f32 = sin(r);
  let c: f32 = cos(r);
  return vec2f(d.x * c - d.y * s, d.x * s + d.y * c) + center;
}`,
  // The Babylon backend binds the main light (three.js's rule: first shadow-casting directional light, else
  // the first directional one) as uniforms; Babylon's own light0 is whatever light the mesh lists first.
  mainLight: `fn mycoMainLightDirection() -> vec3f {
  return normalize(uniforms.uMycoMainLightDir);
}
fn mycoMainLightColor() -> vec3f {
  return uniforms.uMycoMainLightColor;
}`,
  tangentFrame: `fn mycoTangentFrame(eyePos: vec3f, n: vec3f, uv: vec2f) -> mat3x3f {
  let q0: vec3f = dpdx(eyePos);
  let q1: vec3f = dpdy(eyePos);
  let st0: vec2f = dpdx(uv);
  let st1: vec2f = dpdy(uv);
  let q1perp: vec3f = cross(q1, n);
  let q0perp: vec3f = cross(n, q0);
  let T: vec3f = q1perp * st0.x + q0perp * st1.x;
  let B: vec3f = q1perp * st0.y + q0perp * st1.y;
  let det: f32 = max(dot(T, T), dot(B, B));
  let scale: f32 = select(inverseSqrt(det), 0.0, det == 0.0);
  return mat3x3f(T * scale, B * scale, n);
}`,
};

/** Helpers each helper needs first. */
export const HELPER_DEPS: Partial<Record<HelperName, HelperName[]>> = { valueNoise: ["random"], simpleNoise: ["valueNoise"] };

// --- node definitions ------------------------------------------------------------------------------

const dyn = (id: string, label: string, def: InputValue = 0): PortDef => ({ id, label, type: "dynamic", default: def });
const float = (id: string, label: string, def: InputValue = 0): PortDef => ({ id, label, type: "float", default: def });
const vec = (type: "vec2" | "vec3" | "vec4", id: string, label: string, def?: InputValue, extra: Partial<PortDef> = {}): PortDef => ({ id, label, type, default: def, ...extra });
const out = (type: PortType, id = "out", label = "Out"): PortDef => ({ id, label, type });
const uvIn = (): PortDef => ({ id: "uv", label: "UV", type: "vec2", bind: "uv" });
const SPACES = ["object", "world", "view"] as const;

function unary(type: string, title: string, fn: (a: string) => string, keywords?: string): NodeDef {
  return { type, title, category: "Math", keywords, inputs: [dyn("in", "In", 0)], outputs: [out("dynamic")], emit: (c) => ({ out: fn(c.in.in) }) };
}

/** Modulo: GLSL's `mod` (floored, so the result takes the divisor's sign), which WGSL's `%` is not. */
function modulo(): NodeDef {
  const def = binary("modulo", "Modulo", (a, b) => `mod(${a}, ${b})`, 0, 1, "mod remainder");
  return { ...def, emit: (c) => ({ out: `(${c.in.a} - ${c.in.b} * floor(${c.in.a} / ${c.in.b}))` }) };
}

function binary(type: string, title: string, fn: (a: string, b: string) => string, defA: number, defB: number, keywords?: string): NodeDef {
  return { type, title, category: "Math", keywords, inputs: [dyn("a", "A", defA), dyn("b", "B", defB)], outputs: [out("dynamic")], emit: (c) => ({ out: fn(c.in.a, c.in.b) }) };
}

const SWIZZLE = /^[xyzw]{1,4}$|^[rgba]{1,4}$/;
const swizzleType = (mask: string): ValueType => (["float", "vec2", "vec3", "vec4"] as const)[Math.max(0, mask.length - 1)];

export const propertyType = (t: GraphPropertyType): ValueType => (t === "float" ? "float" : t === "vector2" ? "vec2" : t === "vector3" ? "vec3" : t === "texture" ? "texture" : "vec4");

/** A `#rrggbb[aa]` colour as sRGB components `[r, g, b, a]` (0–1). */
const hexComponents = (hex: string): number[] => {
  const h = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex) ? hex : "#ffffff";
  return [1, 3, 5, 7].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) / 255 : 1));
};

/** A sub-graph property as the Sub Graph node's input: its value is the input's default. */
export function propertyPort(p: GraphProperty): PortDef {
  const type = propertyType(p.type);
  const value = p.type === "color" ? hexComponents(String(p.value)) : typeof p.value === "number" || Array.isArray(p.value) ? p.value : undefined;
  return { id: p.name, label: p.name, type, default: value, color: p.type === "color", ...(p.type === "texture" ? { texture: String(p.value) } : {}) };
}

/** A sub-graph file read through `Assets`: the graph, an error, or null when there's no such file. */
export type ResolvedSubGraph = { graph: ShaderGraph; error?: undefined } | { graph?: undefined; error: string } | null;
const parsedSubGraphs = new WeakMap<object, ResolvedSubGraph>();

/** Read a sub-graph (ADR 0048) by asset path; parsed once per version of the file. */
export function resolveSubGraph(path: string): ResolvedSubGraph {
  const p = normalizeAssetPath(path);
  if (!p || !Assets.has(p)) return null;
  let raw: unknown;
  try {
    raw = Assets.json(p);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (typeof raw !== "object" || raw === null) return { error: `${p} isn't a sub-graph` };
  let r = parsedSubGraphs.get(raw);
  if (!r) {
    try {
      const { graph } = parseShaderGraph(raw, p);
      r = graph.subgraph ? { graph } : { error: `${p} is a shader graph, not a sub-graph` };
    } catch (err) {
      r = { error: (err as Error).message };
    }
    parsedSubGraphs.set(raw, r);
  }
  return r;
}

/** The output (master) node's inputs, in the order the panel shows them. */
export const OUTPUT_INPUTS: readonly PortDef[] = [
  vec("vec3", "vertexOffset", "Vertex Offset", [0, 0, 0], { vertex: true, optional: true }),
  vec("vec3", "baseColor", "Base Color", [1, 1, 1], { color: true }),
  float("alpha", "Alpha", 1),
  { ...float("metalness", "Metalness", 0), litOnly: true },
  { ...float("roughness", "Roughness", 0.5), litOnly: true },
  vec("vec3", "emission", "Emission", [0, 0, 0], { color: true, litOnly: true }),
  vec("vec3", "normal", "Normal (Tangent)", [0, 0, 1], { litOnly: true, optional: true }),
  { ...float("clearcoat", "Clearcoat", 0), physicalOnly: true },
  { ...float("clearcoatRoughness", "Clearcoat Roughness", 0), physicalOnly: true },
  vec("vec3", "sheenColor", "Sheen Color", [0, 0, 0], { color: true, physicalOnly: true }),
  { ...float("sheenRoughness", "Sheen Roughness", 1), physicalOnly: true },
  { ...float("transmission", "Transmission", 0), physicalOnly: true },
  { ...float("thickness", "Thickness", 0), physicalOnly: true },
  { ...float("ior", "IOR", 1.5), physicalOnly: true },
  { ...float("iridescence", "Iridescence", 0), physicalOnly: true },
  { ...float("specularIntensity", "Specular Intensity", 1), physicalOnly: true },
  { ...float("alphaClip", "Alpha Clip", 0), optional: true },
];

export const NODES: readonly NodeDef[] = [
  // Output
  {
    type: OUTPUT_NODE_TYPE,
    title: "Output",
    category: "Output",
    inputs: [...OUTPUT_INPUTS],
    outputs: [],
    ports: (_node, graph) => ({
      inputs: graph.subgraph
        ? graph.subgraph.outputs.map((o) => ({ id: o.name, label: o.name, type: o.type, ...(o.type === "texture" ? {} : { default: 0 }) }))
        : OUTPUT_INPUTS.filter((p) => (p.physicalOnly ? graph.target === "physical" : graph.target !== "unlit" || !p.litOnly)),
      outputs: [],
    }),
    emit: () => ({}),
  },

  // Input
  {
    type: "time",
    title: "Time",
    category: "Input",
    keywords: "animate seconds sine cosine",
    inputs: [],
    outputs: [out("float", "time", "Time"), out("float", "sine", "Sine Time"), out("float", "cosine", "Cosine Time")],
    emit: (c) => ({ time: c.builtin("time"), sine: `sin(${c.builtin("time")})`, cosine: `cos(${c.builtin("time")})` }),
  },
  {
    type: "qualityBranch",
    title: "Quality Branch",
    category: "Input",
    keywords: "quality tier level lod branch performance",
    branch: true,
    inputs: [dyn("low", "Low", 0), dyn("medium", "Medium", 0), dyn("high", "High", 0)],
    outputs: [out("dynamic")],
    emit: (c) => ({ out: c.in[c.shaderLevel] }),
  },
  { type: "uv", title: "UV", category: "Input", keywords: "texcoord coordinates", inputs: [], outputs: [out("vec2")], emit: (c) => ({ out: c.builtin("uv") }) },
  {
    type: "position",
    title: "Position",
    category: "Input",
    keywords: "vertex world object",
    inputs: [],
    outputs: [out("vec3")],
    settings: [{ id: "space", label: "Space", kind: "select", options: SPACES, default: "object" }],
    emit: (c) => ({ out: c.builtin(c.settings.space === "world" ? "worldPosition" : c.settings.space === "view" ? "viewPosition" : "objectPosition") }),
  },
  {
    type: "normal",
    title: "Normal Vector",
    category: "Input",
    keywords: "normal vertex",
    inputs: [],
    outputs: [out("vec3")],
    settings: [{ id: "space", label: "Space", kind: "select", options: SPACES, default: "world" }],
    emit: (c) => ({ out: c.builtin(c.settings.space === "object" ? "objectNormal" : c.settings.space === "view" ? "viewNormal" : "worldNormal") }),
  },
  { type: "viewDirection", title: "View Direction", category: "Input", keywords: "camera eye", inputs: [], outputs: [out("vec3")], emit: (c) => ({ out: c.builtin("viewDirection") }) },
  {
    type: "screenPosition",
    title: "Screen Position",
    category: "Input",
    keywords: "fragcoord pixel",
    fragmentOnly: true,
    inputs: [],
    outputs: [out("vec2")],
    emit: (c) => ({ out: `(fragmentInputs.position.xy / ${c.builtin("resolution")})` }),
  },
  { type: "float", title: "Float", category: "Input", keywords: "number constant value vector1", inputs: [float("x", "X", 0)], outputs: [out("float")], emit: (c) => ({ out: c.in.x }) },
  {
    type: "vector2",
    title: "Vector 2",
    category: "Input",
    keywords: "constant",
    inputs: [float("x", "X"), float("y", "Y")],
    outputs: [out("vec2")],
    emit: (c) => ({ out: `${c.typeName("vec2")}(${c.in.x}, ${c.in.y})` }),
  },
  {
    type: "vector3",
    title: "Vector 3",
    category: "Input",
    keywords: "constant",
    inputs: [float("x", "X"), float("y", "Y"), float("z", "Z")],
    outputs: [out("vec3")],
    emit: (c) => ({ out: `${c.typeName("vec3")}(${c.in.x}, ${c.in.y}, ${c.in.z})` }),
  },
  {
    type: "vector4",
    title: "Vector 4",
    category: "Input",
    keywords: "constant",
    inputs: [float("x", "X"), float("y", "Y"), float("z", "Z"), float("w", "W")],
    outputs: [out("vec4")],
    emit: (c) => ({ out: `${c.typeName("vec4")}(${c.in.x}, ${c.in.y}, ${c.in.z}, ${c.in.w})` }),
  },
  {
    type: "color",
    title: "Color",
    category: "Input",
    keywords: "constant rgb rgba",
    inputs: [],
    outputs: [out("vec4")],
    settings: [{ id: "color", label: "Color", kind: "color", default: "#ffffff" }],
    emit: (c) => ({ out: c.color(c.settings.color) }),
  },
  {
    type: "property",
    title: "Property",
    category: "Input",
    keywords: "blackboard exposed parameter",
    inputs: [],
    outputs: [out("float")],
    settings: [{ id: "property", label: "Property", kind: "property", default: "" }],
    ports: (node, graph) => {
      const p = graph.properties.find((q) => q.name === node.settings?.property);
      return { inputs: [], outputs: [{ id: "out", label: p ? p.name : "Out", type: p ? propertyType(p.type) : "float" }] };
    },
    emit: (c) => {
      const p = c.property(c.settings.property ?? "");
      if (!p) {
        c.problem(c.settings.property ? `there's no property "${c.settings.property}"` : "pick a property");
        return { out: "0.0" };
      }
      return { out: p.uniform };
    },
  },
  {
    type: "keyword",
    title: "Keyword",
    category: "Input",
    keywords: "variant define switch feature toggle multi_compile shader_feature ifdef",
    inputs: [dyn("on", "On", 1), dyn("off", "Off", 0)],
    outputs: [out("dynamic")],
    settings: [{ id: "keyword", label: "Keyword", kind: "keyword", default: "" }],
    // An enum keyword has an input per value; a boolean one On and Off (ADR 0106).
    ports: (node, graph) => {
      const k = graph.keywords?.find((q) => q.name === node.settings?.keyword);
      return { inputs: k?.values ? k.values.map((v, i) => dyn(v, v, i)) : [dyn("on", "On", 1), dyn("off", "Off", 0)], outputs: [out("dynamic")] };
    },
    emit: (c) => {
      const k = c.keyword(c.settings.keyword ?? "");
      if (!k) {
        c.problem(c.settings.keyword ? `there's no keyword "${c.settings.keyword}"` : "pick a keyword");
        return { out: c.in.off ?? Object.values(c.in)[0] ?? "0.0" };
      }
      // The constant is fixed per variant, so the shader compiler keeps only the branch taken.
      if (!k.values) return { out: `select(${c.in.off}, ${c.in.on}, ${k.constant})` };
      let e = c.in[k.values[0]];
      k.values.slice(1).forEach((v, i) => (e = `select(${e}, ${c.in[v]}, ${k.constant} == ${i + 1}u)`));
      return { out: e };
    },
  },
  {
    type: "sampleTexture",
    title: "Sample Texture 2D",
    category: "Input",
    keywords: "texture image sampler map",
    inputs: [{ id: "texture", label: "Texture", type: "texture" }, uvIn()],
    outputs: [out("vec4", "rgba", "RGBA"), out("vec3", "rgb", "RGB"), out("float", "r", "R"), out("float", "g", "G"), out("float", "b", "B"), out("float", "a", "A")],
    settings: [
      { id: "texture", label: "Texture", kind: "texture", default: "" },
      { id: "type", label: "Type", kind: "select", options: ["default", "normal"], default: "default" },
    ],
    emit: (c) => {
      const normal = c.settings.type === "normal";
      c.sampleMode(c.in.texture, normal);
      const s = c.sample(c.in.texture, c.in.uv);
      // Normal maps hold tangent-space directions as 0–1 colours: unpack them to -1…1.
      const rgb = normal ? `(${s}.rgb * 2.0 - 1.0)` : `${s}.rgb`;
      return { rgba: normal ? `${c.typeName("vec4")}(${rgb}, ${s}.a)` : s, rgb, r: `${rgb}.r`, g: `${rgb}.g`, b: `${rgb}.b`, a: `${s}.a` };
    },
  },
  {
    type: "textureAsset",
    title: "Texture 2D Asset",
    category: "Input",
    keywords: "texture image asset sampler",
    inputs: [],
    outputs: [out("texture", "out", "Texture")],
    settings: [{ id: "texture", label: "Texture", kind: "texture", default: "" }],
    emit: (c) => ({ out: c.texture(c.settings.texture ?? "") }),
  },
  {
    type: "subgraph",
    title: "Sub Graph",
    category: "Input",
    keywords: "subgraph function reuse",
    inputs: [],
    outputs: [],
    settings: [{ id: "subgraph", label: "Sub Graph", kind: "subgraph", default: "" }],
    ports: (node) => {
      const r = resolveSubGraph(node.settings?.subgraph ?? "");
      if (!r?.graph) return { inputs: [], outputs: [] };
      return { inputs: r.graph.properties.map(propertyPort), outputs: (r.graph.subgraph?.outputs ?? []).map((o) => ({ id: o.name, label: o.name, type: o.type })) };
    },
    emit: () => ({}), // expanded inline by the compiler
  },
  {
    type: "customFunction",
    title: "Custom Function",
    category: "Input",
    keywords: "glsl code custom function",
    inputs: [],
    outputs: [],
    ports: (node) => ({
      inputs: (node.function?.inputs ?? []).map((p) => ({ id: p.name, label: p.name, type: p.type, default: 0 })),
      outputs: (node.function?.outputs ?? []).map((p) => ({ id: p.name, label: p.name, type: p.type })),
    }),
    emit: () => ({}), // emitted as a function by the compiler
  },

  // Math
  binary("add", "Add", (a, b) => `(${a} + ${b})`, 0, 0, "plus sum +"),
  binary("subtract", "Subtract", (a, b) => `(${a} - ${b})`, 0, 0, "minus difference -"),
  binary("multiply", "Multiply", (a, b) => `(${a} * ${b})`, 1, 1, "times product scale *"),
  binary("divide", "Divide", (a, b) => `(${a} / ${b})`, 1, 1, "quotient /"),
  binary("power", "Power", (a, b) => `pow(${a}, ${b})`, 1, 2, "exponent pow"),
  binary("minimum", "Minimum", (a, b) => `min(${a}, ${b})`, 0, 0, "min"),
  binary("maximum", "Maximum", (a, b) => `max(${a}, ${b})`, 0, 0, "max"),
  modulo(),
  binary("step", "Step", (a, b) => `step(${a}, ${b})`, 0.5, 0, "threshold edge"),
  unary("squareRoot", "Square Root", (a) => `sqrt(${a})`, "sqrt"),
  unary("absolute", "Absolute", (a) => `abs(${a})`, "abs"),
  { ...unary("negate", "Negate", (a) => `(-${a})`, "minus invert"), emit: (c) => ({ out: `(-(${c.in.in}))` }) }, // WGSL: a literal like -1.0 must not form "--"
  unary("oneMinus", "One Minus", (a) => `(1.0 - ${a})`, "invert"),
  unary("reciprocal", "Reciprocal", (a) => `(1.0 / ${a})`, "inverse"),
  unary("sine", "Sine", (a) => `sin(${a})`, "sin wave"),
  unary("cosine", "Cosine", (a) => `cos(${a})`, "cos wave"),
  unary("fraction", "Fraction", (a) => `fract(${a})`, "fract"),
  unary("floor", "Floor", (a) => `floor(${a})`),
  unary("ceiling", "Ceiling", (a) => `ceil(${a})`, "ceil"),
  unary("round", "Round", (a) => `floor(${a} + 0.5)`),
  unary("sign", "Sign", (a) => `sign(${a})`),
  { ...unary("saturate", "Saturate", (a) => `clamp(${a}, 0.0, 1.0)`, "clamp01"), emit: (c) => ({ out: `saturate(${c.in.in})` }) }, // WGSL's clamp wants vector bounds for a vector
  {
    type: "clamp",
    title: "Clamp",
    category: "Math",
    keywords: "limit range",
    inputs: [dyn("in", "In", 0), dyn("min", "Min", 0), dyn("max", "Max", 1)],
    outputs: [out("dynamic")],
    emit: (c) => ({ out: `clamp(${c.in.in}, ${c.in.min}, ${c.in.max})` }),
  },
  {
    type: "lerp",
    title: "Lerp",
    category: "Math",
    keywords: "mix blend interpolate",
    inputs: [dyn("a", "A", 0), dyn("b", "B", 1), dyn("t", "T", 0.5)],
    outputs: [out("dynamic")],
    emit: (c) => ({ out: `mix(${c.in.a}, ${c.in.b}, ${c.in.t})` }),
  },
  {
    type: "smoothstep",
    title: "Smoothstep",
    category: "Math",
    keywords: "smooth threshold",
    inputs: [dyn("edge1", "Edge 1", 0), dyn("edge2", "Edge 2", 1), dyn("in", "In", 0)],
    outputs: [out("dynamic")],
    emit: (c) => ({ out: `smoothstep(${c.in.edge1}, ${c.in.edge2}, ${c.in.in})` }),
  },
  {
    type: "remap",
    title: "Remap",
    category: "Math",
    keywords: "range map",
    inputs: [dyn("in", "In", 0), dyn("inMin", "In Min", -1), dyn("inMax", "In Max", 1), dyn("outMin", "Out Min", 0), dyn("outMax", "Out Max", 1)],
    outputs: [out("dynamic")],
    emit: (c) => ({ out: `(${c.in.outMin} + (${c.in.in} - ${c.in.inMin}) * (${c.in.outMax} - ${c.in.outMin}) / (${c.in.inMax} - ${c.in.inMin}))` }),
  },

  // Vector
  {
    type: "split",
    title: "Split",
    category: "Vector",
    keywords: "components channels rgba xyzw",
    inputs: [vec("vec4", "in", "In", [0, 0, 0, 0])],
    outputs: [out("float", "r", "R"), out("float", "g", "G"), out("float", "b", "B"), out("float", "a", "A")],
    emit: (c) => ({ r: `${c.in.in}.x`, g: `${c.in.in}.y`, b: `${c.in.in}.z`, a: `${c.in.in}.w` }),
  },
  {
    type: "combine",
    title: "Combine",
    category: "Vector",
    keywords: "append components channels",
    inputs: [float("r", "R"), float("g", "G"), float("b", "B"), float("a", "A")],
    outputs: [out("vec4", "rgba", "RGBA"), out("vec3", "rgb", "RGB"), out("vec2", "rg", "RG")],
    emit: (c) => ({ rgba: `${c.typeName("vec4")}(${c.in.r}, ${c.in.g}, ${c.in.b}, ${c.in.a})`, rgb: `${c.typeName("vec3")}(${c.in.r}, ${c.in.g}, ${c.in.b})`, rg: `${c.typeName("vec2")}(${c.in.r}, ${c.in.g})` }),
  },
  {
    type: "swizzle",
    title: "Swizzle",
    category: "Vector",
    keywords: "channels mask reorder",
    inputs: [vec("vec4", "in", "In", [0, 0, 0, 0])],
    outputs: [out("vec4")],
    settings: [{ id: "mask", label: "Mask", kind: "text", default: "xyzw" }],
    ports: (node) => {
      const mask = (node.settings?.mask ?? "xyzw").toLowerCase();
      return { inputs: [vec("vec4", "in", "In", [0, 0, 0, 0])], outputs: [out(SWIZZLE.test(mask) ? swizzleType(mask) : "vec4")] };
    },
    emit: (c) => {
      let mask = (c.settings.mask ?? "xyzw").toLowerCase();
      if (!SWIZZLE.test(mask)) {
        c.problem(`"${mask}" isn't a swizzle mask (1–4 of xyzw or rgba); using xyzw`);
        mask = "xyzw";
      }
      return { out: `${c.in.in}.${mask}` };
    },
  },
  {
    type: "dot",
    title: "Dot Product",
    category: "Vector",
    keywords: "dot",
    inputs: [dyn("a", "A", 0), dyn("b", "B", 0)],
    outputs: [out("float")],
    // WGSL's dot takes vectors only; for two numbers it is their product.
    emit: (c) => ({ out: c.type === "float" ? `(${c.in.a} * ${c.in.b})` : `dot(${c.in.a}, ${c.in.b})` }),
  },
  {
    type: "cross",
    title: "Cross Product",
    category: "Vector",
    keywords: "cross",
    inputs: [vec("vec3", "a", "A", [0, 0, 0]), vec("vec3", "b", "B", [0, 0, 0])],
    outputs: [out("vec3")],
    emit: (c) => ({ out: `cross(${c.in.a}, ${c.in.b})` }),
  },
  {
    type: "normalize",
    title: "Normalize",
    category: "Vector",
    keywords: "unit",
    inputs: [dyn("in", "In", 0)],
    outputs: [out("dynamic")],
    // WGSL's normalize takes vectors only; a number normalizes to its sign.
    emit: (c) => ({ out: c.type === "float" ? `sign(${c.in.in})` : `normalize(${c.in.in})` }),
  },
  { type: "length", title: "Length", category: "Vector", keywords: "magnitude", inputs: [dyn("in", "In", 0)], outputs: [out("float")], emit: (c) => ({ out: `length(${c.in.in})` }) },
  { type: "distance", title: "Distance", category: "Vector", inputs: [dyn("a", "A", 0), dyn("b", "B", 0)], outputs: [out("float")], emit: (c) => ({ out: `distance(${c.in.a}, ${c.in.b})` }) },
  {
    type: "reflect",
    title: "Reflection",
    category: "Vector",
    keywords: "reflect mirror",
    inputs: [vec("vec3", "in", "In", [0, 0, 0]), vec("vec3", "normal", "Normal", [0, 1, 0])],
    outputs: [out("vec3")],
    emit: (c) => ({ out: `reflect(${c.in.in}, ${c.in.normal})` }),
  },
  {
    type: "tilingOffset",
    title: "Tiling And Offset",
    category: "Vector",
    keywords: "uv repeat scroll",
    inputs: [uvIn(), vec("vec2", "tiling", "Tiling", [1, 1]), vec("vec2", "offset", "Offset", [0, 0])],
    outputs: [out("vec2")],
    emit: (c) => ({ out: `(${c.in.uv} * ${c.in.tiling} + ${c.in.offset})` }),
  },
  {
    type: "rotate",
    title: "Rotate",
    category: "Vector",
    keywords: "uv spin radians",
    inputs: [uvIn(), vec("vec2", "center", "Center", [0.5, 0.5]), float("rotation", "Rotation", 0)],
    outputs: [out("vec2")],
    emit: (c) => {
      c.helper("rotate");
      return { out: `mycoRotate(${c.in.uv}, ${c.in.center}, ${c.in.rotation})` };
    },
  },

  // Color
  {
    type: "saturation",
    title: "Saturation",
    category: "Color",
    keywords: "desaturate grayscale",
    inputs: [vec("vec3", "in", "In", [1, 1, 1], { color: true }), float("saturation", "Saturation", 1)],
    outputs: [out("vec3")],
    emit: (c) => {
      const v3 = c.typeName("vec3");
      return { out: `mix(${v3}(dot(${c.in.in}, ${v3}(0.2126729, 0.7151522, 0.072175))), ${c.in.in}, ${c.in.saturation})` };
    },
  },
  {
    type: "hue",
    title: "Hue",
    category: "Color",
    keywords: "hsv shift",
    inputs: [vec("vec3", "in", "In", [1, 1, 1], { color: true }), float("offset", "Offset", 0)],
    outputs: [out("vec3")],
    emit: (c) => {
      c.helper("hsv");
      return { out: `mycoHsvToRgb(mycoRgbToHsv(${c.in.in}) + ${c.typeName("vec3")}(${c.in.offset}, 0.0, 0.0))` };
    },
  },
  {
    type: "contrast",
    title: "Contrast",
    category: "Color",
    inputs: [vec("vec3", "in", "In", [1, 1, 1], { color: true }), float("contrast", "Contrast", 1)],
    outputs: [out("vec3")],
    emit: (c) => ({ out: `((${c.in.in} - 0.21763764) * ${c.in.contrast} + 0.21763764)` }),
  },
  { type: "invertColors", title: "Invert Colors", category: "Color", keywords: "negative", inputs: [dyn("in", "In", 0)], outputs: [out("dynamic")], emit: (c) => ({ out: `(1.0 - ${c.in.in})` }) },

  // Noise
  {
    type: "simpleNoise",
    title: "Simple Noise",
    category: "Noise",
    keywords: "value noise random",
    inputs: [uvIn(), float("scale", "Scale", 500)],
    outputs: [out("float")],
    emit: (c) => {
      c.helper("simpleNoise");
      return { out: `mycoSimpleNoise(${c.in.uv}, ${c.in.scale})` };
    },
  },
  {
    type: "gradientNoise",
    title: "Gradient Noise",
    category: "Noise",
    keywords: "perlin",
    inputs: [uvIn(), float("scale", "Scale", 10)],
    outputs: [out("float")],
    emit: (c) => {
      c.helper("gradientNoise");
      return { out: `mycoGradientNoise(${c.in.uv}, ${c.in.scale})` };
    },
  },
  {
    type: "voronoi",
    title: "Voronoi",
    category: "Noise",
    keywords: "cells worley cellular",
    inputs: [uvIn(), float("angleOffset", "Angle Offset", 2), float("cellDensity", "Cell Density", 5)],
    outputs: [out("float", "out", "Out"), out("float", "cells", "Cells")],
    emit: (c) => {
      c.helper("voronoi");
      const v = `mycoVoronoi(${c.in.uv}, ${c.in.angleOffset}, ${c.in.cellDensity})`;
      return { out: `${v}.x`, cells: `${v}.y` };
    },
  },

  // Lighting
  {
    type: "fresnel",
    title: "Fresnel Effect",
    category: "Lighting",
    keywords: "rim edge glow",
    fragmentOnly: true,
    inputs: [vec("vec3", "normal", "Normal", undefined, { bind: "worldNormal" }), vec("vec3", "viewDir", "View Dir", undefined, { bind: "viewDirection" }), float("power", "Power", 1)],
    outputs: [out("float")],
    emit: (c) => ({ out: `pow(1.0 - clamp(dot(normalize(${c.in.normal}), normalize(${c.in.viewDir})), 0.0, 1.0), ${c.in.power})` }),
  },
  {
    type: "mainLightDirection",
    title: "Main Light Direction",
    category: "Lighting",
    keywords: "sun directional light",
    fragmentOnly: true,
    inputs: [],
    outputs: [out("vec3")],
    emit: (c) => {
      c.helper("mainLight");
      return { out: "mycoMainLightDirection()" };
    },
  },
  {
    type: "mainLightColor",
    title: "Main Light Color",
    category: "Lighting",
    keywords: "sun directional light intensity",
    fragmentOnly: true,
    inputs: [],
    outputs: [out("vec3")],
    emit: (c) => {
      c.helper("mainLight");
      return { out: "mycoMainLightColor()" };
    },
  },
  {
    type: "lambert",
    title: "Lambert",
    category: "Lighting",
    keywords: "diffuse ndotl toon lighting",
    fragmentOnly: true,
    inputs: [vec("vec3", "normal", "Normal", undefined, { bind: "worldNormal" })],
    outputs: [out("float")],
    emit: (c) => {
      c.helper("mainLight");
      return { out: `max(dot(normalize(${c.in.normal}), mycoMainLightDirection()), 0.0)` };
    },
  },
];

const BY_TYPE = new Map(NODES.map((n) => [n.type, n]));

/** A node type's definition, or undefined for an unknown type. */
export const nodeDef = (type: string): NodeDef | undefined => BY_TYPE.get(type);

/** A node's ports as they are now (some depend on its settings or the graph). */
export function nodePorts(node: GraphNode, graph: ShaderGraph): { inputs: PortDef[]; outputs: PortDef[] } {
  const def = nodeDef(node.type);
  if (!def) return { inputs: [], outputs: [] };
  return def.ports ? def.ports(node, graph) : { inputs: def.inputs, outputs: def.outputs };
}

/** A setting's value on a node, or its default. */
export function settingValue(node: GraphNode, setting: SettingDef): string {
  return node.settings?.[setting.id] ?? setting.default;
}

export const PORT_SIZE: Record<Exclude<ValueType, "texture">, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

/** True if an output of type `from` may connect to an input of type `to` (textures only to textures). */
export function canConnectTypes(from: PortType, to: PortType): boolean {
  return (from === "texture") === (to === "texture");
}
