/**
 * The shader graph node library (ADR 0047): each node type's ports, settings and the GLSL it
 * emits. Shared by the compiler and the editor's Shader Graph panel, so both agree on every port.
 */
import type { GraphNode, GraphPropertyType, InputValue, ShaderGraph } from "../../scene/shaderGraph";
import { OUTPUT_NODE_TYPE } from "../../scene/shaderGraph";

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
  /** Output node: only for lit graphs. */
  litOnly?: boolean;
  /** Output node: only applied when connected (or, for alpha clip, when above 0). */
  optional?: boolean;
}

export interface SettingDef {
  id: string;
  label: string;
  kind: "select" | "text" | "color" | "texture" | "property";
  options?: readonly string[];
  default: string;
}

export type ShaderStage = "vertex" | "fragment";

/** What a node's `emit` gets: its inputs as GLSL expressions, already converted to each port's type. */
export interface EmitContext {
  in: Record<string, string>;
  /** The resolved type of the node's dynamic ports. */
  type: ValueType;
  settings: Record<string, string>;
  stage: ShaderStage;
  /** A built-in value's expression in this stage. */
  builtin(b: Builtin | "time" | "resolution"): string;
  /** Add a helper function (from `HELPERS`) to this stage's declarations. */
  helper(name: HelperName): void;
  /** The uniform for an inline texture (an asset path); empty paths read white. */
  texture(path: string): string;
  /** The uniform of a graph property, or null if there's none of that name. */
  property(name: string): { uniform: string; type: ValueType } | null;
  /** A `#rrggbb[aa]` colour (sRGB) as a linear `vec4` literal. */
  color(hex: string): string;
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
  /** Ports that depend on the node's settings or the graph, when they do. */
  ports?(node: GraphNode, graph: ShaderGraph): { inputs: PortDef[]; outputs: PortDef[] };
  /** GLSL expressions for the outputs, by port id. */
  emit(c: EmitContext): Record<string, string>;
}

// --- helper functions ------------------------------------------------------------------------------

export const HELPERS = {
  random: `float mycoRandom(vec2 uv) { return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453); }`,
  valueNoise: `float mycoValueNoise(vec2 uv) {
  vec2 i = floor(uv); vec2 f = fract(uv); f = f * f * (3.0 - 2.0 * f);
  float a = mycoRandom(i), b = mycoRandom(i + vec2(1.0, 0.0)), c = mycoRandom(i + vec2(0.0, 1.0)), d = mycoRandom(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`,
  simpleNoise: `float mycoSimpleNoise(vec2 uv, float scale) {
  float t = 0.0;
  for (int i = 0; i < 3; i++) { float freq = pow(2.0, float(i)); float amp = pow(0.5, float(3 - i)); t += mycoValueNoise(uv * scale / freq) * amp; }
  return t;
}`,
  gradientNoise: `vec2 mycoGradientDir(vec2 p) {
  p = mod(p, 289.0); float x = mod((34.0 * p.x + 1.0) * p.x, 289.0) + p.y; x = mod((34.0 * x + 1.0) * x, 289.0);
  x = fract(x / 41.0) * 2.0 - 1.0; return normalize(vec2(x - floor(x + 0.5), abs(x) - 0.5));
}
float mycoGradientNoise(vec2 uv, float scale) {
  vec2 p = uv * scale; vec2 ip = floor(p); vec2 fp = fract(p);
  float d00 = dot(mycoGradientDir(ip), fp), d01 = dot(mycoGradientDir(ip + vec2(0.0, 1.0)), fp - vec2(0.0, 1.0));
  float d10 = dot(mycoGradientDir(ip + vec2(1.0, 0.0)), fp - vec2(1.0, 0.0)), d11 = dot(mycoGradientDir(ip + vec2(1.0, 1.0)), fp - vec2(1.0, 1.0));
  fp = fp * fp * fp * (fp * (fp * 6.0 - 15.0) + 10.0);
  return mix(mix(d00, d01, fp.y), mix(d10, d11, fp.y), fp.x) + 0.5;
}`,
  voronoi: `vec2 mycoVoronoiOffset(vec2 uv, float offset) {
  mat2 m = mat2(15.27, 47.63, 99.41, 89.98); uv = fract(sin(m * uv) * 46839.32);
  return vec2(sin(uv.y * offset) * 0.5 + 0.5, cos(uv.x * offset) * 0.5 + 0.5);
}
vec2 mycoVoronoi(vec2 uv, float angleOffset, float cellDensity) {
  vec2 g = floor(uv * cellDensity); vec2 f = fract(uv * cellDensity); float best = 8.0; float cell = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 lattice = vec2(float(x), float(y)); vec2 o = mycoVoronoiOffset(lattice + g, angleOffset); float d = distance(lattice + o, f);
    if (d < best) { best = d; cell = o.x; }
  }
  return vec2(best, cell);
}`,
  hsv: `vec3 mycoRgbToHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y); float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 mycoHsvToRgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}`,
  rotate: `vec2 mycoRotate(vec2 uv, vec2 center, float r) { vec2 d = uv - center; float s = sin(r), c = cos(r); return vec2(d.x * c - d.y * s, d.x * s + d.y * c) + center; }`,
  mainLight: `vec3 mycoMainLightDirection() {
#if defined( MYCO_LIT ) && NUM_DIR_LIGHTS > 0
  return normalize((vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz);
#else
  return normalize(vec3(0.4, 1.0, 0.6));
#endif
}
vec3 mycoMainLightColor() {
#if defined( MYCO_LIT ) && NUM_DIR_LIGHTS > 0
  return directionalLights[0].color;
#else
  return vec3(1.0);
#endif
}`,
  tangentFrame: `mat3 mycoTangentFrame(vec3 eyePos, vec3 n, vec2 uv) {
  vec3 q0 = dFdx(eyePos), q1 = dFdy(eyePos); vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, n), q0perp = cross(n, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x; vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B)); float scale = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, n);
}`,
} as const;
export type HelperName = keyof typeof HELPERS;
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

function binary(type: string, title: string, fn: (a: string, b: string) => string, defA: number, defB: number, keywords?: string): NodeDef {
  return { type, title, category: "Math", keywords, inputs: [dyn("a", "A", defA), dyn("b", "B", defB)], outputs: [out("dynamic")], emit: (c) => ({ out: fn(c.in.a, c.in.b) }) };
}

const SWIZZLE = /^[xyzw]{1,4}$|^[rgba]{1,4}$/;
const swizzleType = (mask: string): ValueType => (["float", "vec2", "vec3", "vec4"] as const)[Math.max(0, mask.length - 1)];

const propertyType = (t: GraphPropertyType): ValueType => (t === "float" ? "float" : t === "vector2" ? "vec2" : t === "vector3" ? "vec3" : t === "texture" ? "texture" : "vec4");

/** The output (master) node's inputs, in the order the panel shows them. */
export const OUTPUT_INPUTS: readonly PortDef[] = [
  vec("vec3", "vertexOffset", "Vertex Offset", [0, 0, 0], { vertex: true, optional: true }),
  vec("vec3", "baseColor", "Base Color", [1, 1, 1], { color: true }),
  float("alpha", "Alpha", 1),
  { ...float("metalness", "Metalness", 0), litOnly: true },
  { ...float("roughness", "Roughness", 0.5), litOnly: true },
  vec("vec3", "emission", "Emission", [0, 0, 0], { color: true, litOnly: true }),
  vec("vec3", "normal", "Normal (Tangent)", [0, 0, 1], { litOnly: true, optional: true }),
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
    ports: (_node, graph) => ({ inputs: OUTPUT_INPUTS.filter((p) => graph.target === "lit" || !p.litOnly), outputs: [] }),
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
    emit: (c) => ({ out: `(gl_FragCoord.xy / ${c.builtin("resolution")})` }),
  },
  { type: "float", title: "Float", category: "Input", keywords: "number constant value vector1", inputs: [float("x", "X", 0)], outputs: [out("float")], emit: (c) => ({ out: c.in.x }) },
  {
    type: "vector2",
    title: "Vector 2",
    category: "Input",
    keywords: "constant",
    inputs: [float("x", "X"), float("y", "Y")],
    outputs: [out("vec2")],
    emit: (c) => ({ out: `vec2(${c.in.x}, ${c.in.y})` }),
  },
  {
    type: "vector3",
    title: "Vector 3",
    category: "Input",
    keywords: "constant",
    inputs: [float("x", "X"), float("y", "Y"), float("z", "Z")],
    outputs: [out("vec3")],
    emit: (c) => ({ out: `vec3(${c.in.x}, ${c.in.y}, ${c.in.z})` }),
  },
  {
    type: "vector4",
    title: "Vector 4",
    category: "Input",
    keywords: "constant",
    inputs: [float("x", "X"), float("y", "Y"), float("z", "Z"), float("w", "W")],
    outputs: [out("vec4")],
    emit: (c) => ({ out: `vec4(${c.in.x}, ${c.in.y}, ${c.in.z}, ${c.in.w})` }),
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
    type: "sampleTexture",
    title: "Sample Texture 2D",
    category: "Input",
    keywords: "texture image sampler map",
    inputs: [{ id: "texture", label: "Texture", type: "texture" }, uvIn()],
    outputs: [out("vec4", "rgba", "RGBA"), out("vec3", "rgb", "RGB"), out("float", "r", "R"), out("float", "g", "G"), out("float", "b", "B"), out("float", "a", "A")],
    settings: [{ id: "texture", label: "Texture", kind: "texture", default: "" }],
    emit: (c) => {
      const s = `texture(${c.in.texture}, ${c.in.uv})`;
      return { rgba: s, rgb: `${s}.rgb`, r: `${s}.r`, g: `${s}.g`, b: `${s}.b`, a: `${s}.a` };
    },
  },

  // Math
  binary("add", "Add", (a, b) => `(${a} + ${b})`, 0, 0, "plus sum +"),
  binary("subtract", "Subtract", (a, b) => `(${a} - ${b})`, 0, 0, "minus difference -"),
  binary("multiply", "Multiply", (a, b) => `(${a} * ${b})`, 1, 1, "times product scale *"),
  binary("divide", "Divide", (a, b) => `(${a} / ${b})`, 1, 1, "quotient /"),
  binary("power", "Power", (a, b) => `pow(${a}, ${b})`, 1, 2, "exponent pow"),
  binary("minimum", "Minimum", (a, b) => `min(${a}, ${b})`, 0, 0, "min"),
  binary("maximum", "Maximum", (a, b) => `max(${a}, ${b})`, 0, 0, "max"),
  binary("modulo", "Modulo", (a, b) => `mod(${a}, ${b})`, 0, 1, "mod remainder"),
  binary("step", "Step", (a, b) => `step(${a}, ${b})`, 0.5, 0, "threshold edge"),
  unary("squareRoot", "Square Root", (a) => `sqrt(${a})`, "sqrt"),
  unary("absolute", "Absolute", (a) => `abs(${a})`, "abs"),
  unary("negate", "Negate", (a) => `(-${a})`, "minus invert"),
  unary("oneMinus", "One Minus", (a) => `(1.0 - ${a})`, "invert"),
  unary("reciprocal", "Reciprocal", (a) => `(1.0 / ${a})`, "inverse"),
  unary("sine", "Sine", (a) => `sin(${a})`, "sin wave"),
  unary("cosine", "Cosine", (a) => `cos(${a})`, "cos wave"),
  unary("fraction", "Fraction", (a) => `fract(${a})`, "fract"),
  unary("floor", "Floor", (a) => `floor(${a})`),
  unary("ceiling", "Ceiling", (a) => `ceil(${a})`, "ceil"),
  unary("round", "Round", (a) => `floor(${a} + 0.5)`),
  unary("sign", "Sign", (a) => `sign(${a})`),
  unary("saturate", "Saturate", (a) => `clamp(${a}, 0.0, 1.0)`, "clamp01"),
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
    emit: (c) => ({ rgba: `vec4(${c.in.r}, ${c.in.g}, ${c.in.b}, ${c.in.a})`, rgb: `vec3(${c.in.r}, ${c.in.g}, ${c.in.b})`, rg: `vec2(${c.in.r}, ${c.in.g})` }),
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
  { type: "dot", title: "Dot Product", category: "Vector", keywords: "dot", inputs: [dyn("a", "A", 0), dyn("b", "B", 0)], outputs: [out("float")], emit: (c) => ({ out: `dot(${c.in.a}, ${c.in.b})` }) },
  {
    type: "cross",
    title: "Cross Product",
    category: "Vector",
    keywords: "cross",
    inputs: [vec("vec3", "a", "A", [0, 0, 0]), vec("vec3", "b", "B", [0, 0, 0])],
    outputs: [out("vec3")],
    emit: (c) => ({ out: `cross(${c.in.a}, ${c.in.b})` }),
  },
  { type: "normalize", title: "Normalize", category: "Vector", keywords: "unit", inputs: [dyn("in", "In", 0)], outputs: [out("dynamic")], emit: (c) => ({ out: `normalize(${c.in.in})` }) },
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
    emit: (c) => ({ out: `mix(vec3(dot(${c.in.in}, vec3(0.2126729, 0.7151522, 0.072175))), ${c.in.in}, ${c.in.saturation})` }),
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
      return { out: `mycoHsvToRgb(mycoRgbToHsv(${c.in.in}) + vec3(${c.in.offset}, 0.0, 0.0))` };
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
