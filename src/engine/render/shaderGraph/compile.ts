/**
 * The shader graph compiler (ADR 0047): a graph becomes GLSL ES 3.0 chunks that the render
 * backend splices into three.js's built-in lit or unlit material (`threeMaterial.ts`). Pure
 * TypeScript with no three.js, so it runs in tests and in the editor without WebGL.
 *
 * Each node that the output reaches becomes local variables (one per output port), emitted in
 * dependency order, so a value used twice is computed once. Problems never stop a compile: an
 * unknown node, a missing property or a loop is reported, and the input it fed reads its default.
 */
import { Color } from "../../core/math";
import { OUTPUT_NODE_TYPE, portRef, splitPortRef, type GraphNode, type GraphPropertyType, type GraphValue, type InputValue, type ShaderGraph } from "../../scene/shaderGraph";
import { HELPER_DEPS, HELPERS, OUTPUT_INPUTS, PORT_SIZE, canConnectTypes, nodeDef, nodePorts, type Builtin, type EmitContext, type HelperName, type PortDef, type ShaderStage, type ValueType } from "./nodes";

/** Uniforms every compiled graph may read; the backend owns their values. */
export const SHARED_UNIFORMS = { time: "uMycoTime", resolution: "uMycoResolution" } as const;

export interface CompiledUniform {
  name: string;
  type: "float" | "vec2" | "vec3" | "vec4" | "sampler2D";
  /** Set for a graph property: its name and type (a material may override its value). */
  property?: string;
  propertyType?: GraphPropertyType;
  /** The value: the property's default, or an inline texture's path ("" reads white). */
  value: GraphValue;
}

export interface CompiledShaderGraph {
  target: ShaderGraph["target"];
  surface: ShaderGraph["surface"];
  doubleSided: boolean;
  vertex: {
    declarations: string;
    /** Statements computing the vertex offset, run where `transformed` holds the object-space position. */
    body: string;
    /** The object-space offset's expression, or null when Vertex Offset isn't connected. */
    offset: string | null;
    /** Statements that fill the graph's varyings, run once the final position is known. */
    varyings: string;
  };
  fragment: {
    declarations: string;
    /** Statements computing the surface, run at the start of `main`. */
    body: string;
    baseColor: string;
    alpha: string;
    /** Lit only (null for unlit graphs). */
    metalness: string | null;
    roughness: string | null;
    emission: string | null;
    /** The tangent-space normal's expression, or null when Normal isn't connected. */
    normal: string | null;
    /** The alpha clip threshold's expression, or null when clipping is off. */
    alphaClip: string | null;
  };
  uniforms: CompiledUniform[];
  /** Everything wrong, as "Title (id): message". */
  problems: string[];
  /** The same problems by node id, for the editor. */
  nodeProblems: Record<string, string[]>;
  /** Resolved type of each output port (`node.port`), for wire colours and inline fields. */
  portTypes: Record<string, ValueType>;
  /** Resolved type of each node's dynamic ports. */
  dynamicTypes: Record<string, ValueType>;
  /** A hash of the generated code: equal keys mean the same shader program. */
  key: string;
}

const VARYINGS = ["vec2 vMycoUv", "vec3 vMycoObjPos", "vec3 vMycoWorldPos", "vec3 vMycoObjNormal", "vec3 vMycoWorldNormal"];

const BUILTIN_TYPES: Record<Builtin, ValueType> = {
  uv: "vec2",
  objectPosition: "vec3",
  worldPosition: "vec3",
  viewPosition: "vec3",
  objectNormal: "vec3",
  worldNormal: "vec3",
  viewNormal: "vec3",
  viewDirection: "vec3",
};

const BUILTINS: Record<ShaderStage, Record<Builtin, string>> = {
  vertex: {
    uv: "uv",
    objectPosition: "position",
    worldPosition: "(modelMatrix * vec4(position, 1.0)).xyz",
    viewPosition: "(modelViewMatrix * vec4(position, 1.0)).xyz",
    objectNormal: "normalize(normal)",
    worldNormal: "normalize((modelMatrix * vec4(normal, 0.0)).xyz)",
    viewNormal: "normalize(normalMatrix * normal)",
    viewDirection: "normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz)",
  },
  fragment: {
    uv: "vMycoUv",
    objectPosition: "vMycoObjPos",
    worldPosition: "vMycoWorldPos",
    viewPosition: "(viewMatrix * vec4(vMycoWorldPos, 1.0)).xyz",
    objectNormal: "mycoFaceNormal(vMycoObjNormal)",
    worldNormal: "mycoFaceNormal(vMycoWorldNormal)",
    viewNormal: "normalize((viewMatrix * vec4(mycoFaceNormal(vMycoWorldNormal), 0.0)).xyz)",
    viewDirection: "normalize(cameraPosition - vMycoWorldPos)",
  },
};

/** A GLSL float literal: `1` → `1.0`. */
export function glslFloat(n: number): string {
  if (!Number.isFinite(n)) return "0.0";
  const s = String(n);
  return /[.e]/i.test(s) ? s : `${s}.0`;
}

const SIZE_TYPE = ["float", "float", "vec2", "vec3", "vec4"] as const;
const sizeOf = (t: ValueType) => (t === "texture" ? 1 : PORT_SIZE[t]);

/** sRGB component (0–1) to linear. */
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** A `#rrggbb[aa]` colour as linear `[r, g, b, a]`. */
export function linearColor(hex: string): [number, number, number, number] {
  const c = Color.from(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) ? hex : "#ffffff");
  return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b), c.a];
}

/** Convert an expression between value types: floats fill every component, wider vectors are truncated, narrower ones padded (alpha with 1). */
export function convert(expr: string, from: ValueType, to: ValueType): string {
  if (from === to || from === "texture" || to === "texture") return expr;
  if (from === "float") return `${to}(${expr})`;
  const n = PORT_SIZE[from], m = PORT_SIZE[to];
  if (m === 1) return `${expr}.x`;
  if (m < n) return `${expr}.${"xyzw".slice(0, m)}`;
  const pad = m === 4 ? (n === 2 ? ", 0.0, 1.0" : ", 1.0") : ", 0.0";
  return `${to}(${expr}${pad})`;
}

/** An inline value as a literal of `type`; colours are sRGB and become linear. */
function literal(value: InputValue, type: ValueType, color: boolean): string {
  const lin = (v: number, i: number) => (color && i < 3 ? srgbToLinear(v) : v);
  if (type === "texture") return "0.0";
  const size = PORT_SIZE[type];
  if (typeof value === "number") {
    const v = glslFloat(lin(value, 0));
    return size === 1 ? v : `${type}(${color ? [0, 1, 2].slice(0, size).map((i) => glslFloat(lin(value, i))).concat(size === 4 ? ["1.0"] : []).join(", ") : v})`;
  }
  const parts = Array.from({ length: size }, (_, i) => glslFloat(lin(value[i] ?? (i === 3 ? 1 : 0), i)));
  return size === 1 ? parts[0] : `${type}(${parts.join(", ")})`;
}

const inlineType = (v: InputValue | undefined): ValueType => (Array.isArray(v) ? SIZE_TYPE[Math.min(4, Math.max(2, v.length))] : "float");

/** A GLSL-safe identifier fragment. */
const ident = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";

const PROPERTY_GLSL: Record<GraphPropertyType, CompiledUniform["type"]> = { float: "float", vector2: "vec2", vector3: "vec3", vector4: "vec4", color: "vec4", texture: "sampler2D" };
const valueTypeOf = (t: CompiledUniform["type"]): ValueType => (t === "sampler2D" ? "texture" : t);

function hash(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

interface Value {
  expr: string;
  type: ValueType;
}

interface NodeTypes {
  dynamic: ValueType;
  outputs: Record<string, ValueType>;
}

/** Compile a graph. Never throws for a bad graph; see `problems`. */
export function compileShaderGraph(graph: ShaderGraph): CompiledShaderGraph {
  const problems: string[] = [];
  const nodeProblems: Record<string, string[]> = {};
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const problem = (id: string, message: string) => {
    const list = (nodeProblems[id] ??= []);
    if (list.includes(message)) return;
    list.push(message);
    const node = nodes.get(id);
    problems.push(`${(node && nodeDef(node.type)?.title) ?? node?.type ?? id} (${id}): ${message}`);
  };

  // --- types ---------------------------------------------------------------------------------------
  const incoming = new Map<string, { node: string; port: string }>();
  const types = new Map<string, NodeTypes>();
  const typing = new Set<string>();
  const nodeTypes = (id: string): NodeTypes => {
    const known = types.get(id);
    if (known) return known;
    const node = nodes.get(id);
    if (!node || typing.has(id)) return { dynamic: "float", outputs: {} };
    typing.add(id);
    const ports = nodePorts(node, graph);
    let width = 1;
    for (const p of ports.inputs) {
      if (p.type !== "dynamic") continue;
      const src = incoming.get(portRef(id, p.id));
      const t = src ? outputType(src) : inlineType(node.inputs?.[p.id]);
      width = Math.max(width, sizeOf(t));
    }
    const dynamic = SIZE_TYPE[width];
    const outputs: Record<string, ValueType> = {};
    for (const o of ports.outputs) outputs[o.id] = o.type === "dynamic" ? dynamic : o.type;
    typing.delete(id);
    const result = { dynamic, outputs };
    types.set(id, result);
    return result;
  };
  const outputType = (src: { node: string; port: string }): ValueType => nodeTypes(src.node).outputs[src.port] ?? "float";

  for (const e of graph.edges) {
    const from = splitPortRef(e.from), to = splitPortRef(e.to);
    const a = nodes.get(from.node), b = nodes.get(to.node);
    const out = a && nodePorts(a, graph).outputs.find((p) => p.id === from.port);
    const inp = b && nodePorts(b, graph).inputs.find((p) => p.id === to.port);
    if (!out || !inp) {
      problem(b ? to.node : from.node, `the connection ${e.from} → ${e.to} goes to a port that isn't there`);
      continue;
    }
    if (!canConnectTypes(out.type, inp.type)) {
      problem(to.node, `${inp.label} can't take ${out.type === "texture" ? "a texture" : "a number or vector"}`);
      continue;
    }
    if (!incoming.has(e.to)) incoming.set(e.to, from);
  }

  // --- uniforms ------------------------------------------------------------------------------------
  const uniforms: CompiledUniform[] = [];
  const propertyUniform = (name: string): { uniform: string; type: ValueType } | null => {
    const i = graph.properties.findIndex((p) => p.name === name);
    if (i < 0) return null;
    const p = graph.properties[i];
    const uname = `uP${i}_${ident(p.name)}`;
    if (!uniforms.some((u) => u.name === uname)) uniforms.push({ name: uname, type: PROPERTY_GLSL[p.type], property: p.name, propertyType: p.type, value: p.value });
    return { uniform: uname, type: valueTypeOf(PROPERTY_GLSL[p.type]) };
  };
  const textureUniform = (path: string): string => {
    const existing = uniforms.find((u) => u.type === "sampler2D" && u.property === undefined && u.value === path);
    if (existing) return existing.name;
    const name = `uTex${uniforms.filter((u) => u.type === "sampler2D" && u.property === undefined).length}`;
    uniforms.push({ name, type: "sampler2D", value: path });
    return name;
  };

  // --- stages --------------------------------------------------------------------------------------
  class Stage {
    readonly lines: string[] = [];
    readonly helpers = new Set<HelperName>();
    readonly values = new Map<string, Record<string, Value> | null>();
    readonly visiting = new Set<string>();
    constructor(readonly stage: ShaderStage) {}

    builtin(b: Builtin | "time" | "resolution"): string {
      if (b === "time") return SHARED_UNIFORMS.time;
      if (b === "resolution") return SHARED_UNIFORMS.resolution;
      return BUILTINS[this.stage][b];
    }

    helper(name: HelperName): void {
      for (const dep of HELPER_DEPS[name] ?? []) this.helper(dep);
      this.helpers.add(name);
    }

    input(node: GraphNode, port: PortDef, dynamic: ValueType): string {
      const want: ValueType = port.type === "dynamic" ? dynamic : port.type;
      const src = incoming.get(portRef(node.id, port.id));
      if (src) {
        const v = this.node(src.node)?.[src.port];
        if (v) return convert(v.expr, v.type, want);
      }
      if (want === "texture") return textureUniform(node.settings?.[port.id] ?? "");
      if (port.bind) return convert(this.builtin(port.bind), BUILTIN_TYPES[port.bind], want);
      return literal(node.inputs?.[port.id] ?? port.default ?? 0, want, !!port.color);
    }

    node(id: string): Record<string, Value> | null {
      if (this.values.has(id)) return this.values.get(id)!;
      if (this.visiting.has(id)) {
        problem(id, "is part of a loop; the connection that closes it is ignored");
        return null;
      }
      const node = nodes.get(id)!;
      const def = nodeDef(node.type);
      if (!def || def.type === OUTPUT_NODE_TYPE) {
        if (!def) problem(id, `unknown node type "${node.type}"`);
        this.values.set(id, null);
        return null;
      }
      if (def.fragmentOnly && this.stage === "vertex") {
        problem(id, "only works per pixel, so it can't feed Vertex Offset");
        this.values.set(id, null);
        return null;
      }
      this.visiting.add(id);
      const ports = nodePorts(node, graph);
      const { dynamic } = nodeTypes(id);
      const ins: Record<string, string> = {};
      for (const p of ports.inputs) ins[p.id] = this.input(node, p, dynamic);
      const settings: Record<string, string> = {};
      for (const s of def.settings ?? []) settings[s.id] = node.settings?.[s.id] ?? s.default;
      const ctx: EmitContext = {
        in: ins,
        type: dynamic,
        settings,
        stage: this.stage,
        builtin: (b) => this.builtin(b),
        helper: (h) => this.helper(h),
        texture: textureUniform,
        property: propertyUniform,
        color: (hex) => literal(linearColor(hex), "vec4", false),
        problem: (m) => problem(id, m),
      };
      const exprs = def.emit(ctx);
      const result: Record<string, Value> = {};
      for (const o of ports.outputs) {
        const type: ValueType = o.type === "dynamic" ? dynamic : o.type;
        const expr = exprs[o.id];
        if (type === "texture") {
          result[o.id] = { expr: expr ?? textureUniform(""), type };
          continue;
        }
        const name = `m${index.get(id)}_${ident(o.id)}`;
        this.lines.push(`${type} ${name} = ${expr ?? literal(0, type, false)};`);
        result[o.id] = { expr: name, type };
      }
      this.visiting.delete(id);
      this.values.set(id, result);
      return result;
    }

    /** Evaluate an output-node input into a local, returning its name. */
    surface(output: GraphNode, port: PortDef): string {
      const want = port.type as ValueType;
      const expr = this.input(output, port, want);
      const name = `mOut_${port.id}`;
      this.lines.push(`${want} ${name} = ${expr};`);
      return name;
    }
  }

  const vertex = new Stage("vertex");
  const fragment = new Stage("fragment");
  const output = graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE) ?? { id: "output", type: OUTPUT_NODE_TYPE, position: [0, 0] as [number, number] };
  const lit = graph.target === "lit";
  const port = (id: string) => OUTPUT_INPUTS.find((p) => p.id === id)!;
  const connected = (id: string) => incoming.has(portRef(output.id, id));

  const offset = connected("vertexOffset") ? vertex.surface(output, port("vertexOffset")) : null;
  const baseColor = fragment.surface(output, port("baseColor"));
  const alpha = fragment.surface(output, port("alpha"));
  const metalness = lit ? fragment.surface(output, port("metalness")) : null;
  const roughness = lit ? fragment.surface(output, port("roughness")) : null;
  const emission = lit ? fragment.surface(output, port("emission")) : null;
  const normal = lit && connected("normal") ? fragment.surface(output, port("normal")) : null;
  const clipValue = output.inputs?.alphaClip;
  const alphaClip = connected("alphaClip") || (typeof clipValue === "number" && clipValue > 0) ? fragment.surface(output, port("alphaClip")) : null;
  if (normal) fragment.helper("tangentFrame");

  // Types for every node, reached or not (the editor colours all wires).
  const portTypes: Record<string, ValueType> = {};
  const dynamicTypes: Record<string, ValueType> = {};
  for (const n of graph.nodes) {
    const t = nodeTypes(n.id);
    dynamicTypes[n.id] = t.dynamic;
    for (const [p, type] of Object.entries(t.outputs)) portTypes[portRef(n.id, p)] = type;
  }

  const uniformLines = [`uniform float ${SHARED_UNIFORMS.time};`, `uniform vec2 ${SHARED_UNIFORMS.resolution};`, ...uniforms.map((u) => `uniform ${u.type} ${u.name};`)];
  const helperText = (s: Stage) => (Object.keys(HELPERS) as HelperName[]).filter((h) => s.helpers.has(h)).map((h) => HELPERS[h]);
  const vertexDeclarations = ["// Myco shader graph", ...uniformLines, ...VARYINGS.map((v) => `varying ${v};`), ...helperText(vertex)].join("\n");
  const fragmentDeclarations = [
    "// Myco shader graph",
    ...(lit ? ["#define MYCO_LIT"] : []),
    ...uniformLines,
    ...VARYINGS.map((v) => `varying ${v};`),
    "vec3 mycoFaceNormal(vec3 n) { return normalize(gl_FrontFacing ? n : -n); }",
    ...helperText(fragment),
  ].join("\n");
  const varyings = [
    "vMycoUv = uv;",
    "vMycoObjPos = transformed;",
    "vMycoWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
    "vMycoObjNormal = normal;",
    "vMycoWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);",
  ].join("\n");
  const vertexBody = vertex.lines.join("\n");
  const fragmentBody = fragment.lines.join("\n");
  const key = hash([graph.target, graph.surface, graph.doubleSided, vertexDeclarations, vertexBody, offset, fragmentDeclarations, fragmentBody, normal, alphaClip].join("\u0000"));

  return {
    target: graph.target,
    surface: graph.surface,
    doubleSided: graph.doubleSided,
    vertex: { declarations: vertexDeclarations, body: vertexBody, offset, varyings },
    fragment: { declarations: fragmentDeclarations, body: fragmentBody, baseColor, alpha, metalness, roughness, emission, normal, alphaClip },
    uniforms,
    problems,
    nodeProblems,
    portTypes,
    dynamicTypes,
    key,
  };
}

/** The compiled graph as one readable listing (the editor's "GLSL" view). */
export function shaderGraphListing(c: CompiledShaderGraph): string {
  const surface = [
    `diffuseColor = vec4(${c.fragment.baseColor}, ${c.fragment.alpha});`,
    ...(c.fragment.alphaClip ? [`if (diffuseColor.a < ${c.fragment.alphaClip}) discard;`] : []),
    ...(c.fragment.metalness ? [`metalnessFactor = ${c.fragment.metalness};`] : []),
    ...(c.fragment.roughness ? [`roughnessFactor = ${c.fragment.roughness};`] : []),
    ...(c.fragment.normal ? [`normal = normalize(mycoTangentFrame(-vViewPosition, normal, vMycoUv) * ${c.fragment.normal});`] : []),
    ...(c.fragment.emission ? [`totalEmissiveRadiance = ${c.fragment.emission};`] : []),
  ];
  const indent = (s: string) => s.split("\n").filter(Boolean).map((l) => `  ${l}`).join("\n");
  return [
    `// ---- vertex (${c.target === "lit" ? "MeshStandardMaterial" : "MeshBasicMaterial"}) ----`,
    c.vertex.declarations,
    "",
    "void main() {",
    "  // ... three.js computes `transformed` ...",
    indent(c.vertex.body),
    ...(c.vertex.offset ? [`  transformed += ${c.vertex.offset};`] : []),
    "  // ... projection ...",
    indent(c.vertex.varyings),
    "}",
    "",
    "// ---- fragment ----",
    c.fragment.declarations,
    "",
    "void main() {",
    indent(c.fragment.body),
    "  // ... three.js sets up the surface, then the graph overrides it:",
    indent(surface.join("\n")),
    "  // ... lighting, tone mapping, colour space ...",
    "}",
    "",
  ].join("\n");
}
