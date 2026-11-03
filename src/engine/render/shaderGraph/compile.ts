/**
 * The shader graph compiler (ADR 0047): a graph becomes GLSL ES 3.0 chunks that the render
 * backend splices into three.js's built-in lit or unlit material (`threeMaterial.ts`). Pure
 * TypeScript with no three.js, so it runs in tests and in the editor without WebGL.
 *
 * Each node that the output reaches becomes local variables (one per output port), emitted in
 * dependency order, so a value used twice is computed once. Problems never stop a compile: an
 * unknown node, a missing property or a loop is reported, and the input it fed reads its default.
 */
import type { ShaderLevel } from "../../core/graphics";
import { Color } from "../../core/math";
import { normalizeAssetPath } from "../../scene/Assets";
import { OUTPUT_NODE_TYPE, portRef, splitPortRef, type GraphNode, type GraphPropertyType, type GraphValue, type InputValue, type ShaderGraph } from "../../scene/shaderGraph";
import { HELPER_DEPS, HELPERS, OUTPUT_INPUTS, PORT_SIZE, canConnectTypes, nodeDef, nodePorts, resolveSubGraph, type Builtin, type EmitContext, type HelperName, type PortDef, type ShaderStage, type ValueType } from "./nodes";

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
  /** Textures: sampled as linear data (normal maps), not sRGB colour (ADR 0048). */
  linear?: boolean;
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
    /**
     * Physical graphs (ADR 0052): the features compiled in, each value's expression. A feature
     * is present only when its input is connected or away from its default.
     */
    physical: Partial<Record<PhysicalInput, string>> | null;
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
  /** Sub-graph files the graph uses (asset paths without `asset:`): a change to one changes the shader. */
  dependencies: string[];
  /** The graph has a Quality Branch, so the shader depends on the shader level (it is part of `key`). */
  usesShaderLevel: boolean;
  /** A hash of the generated code: equal keys mean the same shader program. */
  key: string;
}

/** The physical target's output inputs (ADR 0052). */
export type PhysicalInput = "clearcoat" | "clearcoatRoughness" | "sheenColor" | "sheenRoughness" | "transmission" | "thickness" | "ior" | "iridescence" | "specularIntensity";

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

type Source = { node: string; port: string };

/** One graph being compiled: the root graph, or a sub-graph expanded inside it (ADR 0048). */
interface Scope {
  graph: ShaderGraph;
  nodes: Map<string, GraphNode>;
  index: Map<string, number>;
  incoming: Map<string, Source>;
  types: Map<string, NodeTypes>;
  typing: Set<string>;
  /** Prefix for the locals of this scope's nodes, so two uses of a sub-graph don't collide. */
  prefix: string;
  /** A sub-graph's property values, from its Sub Graph node's inputs; null for the root graph (uniforms). */
  bindings: Map<string, Value> | null;
  /** Report a problem about one of this scope's nodes. */
  problem(id: string, message: string): void;
  /** Sub-graph files this scope sits inside, to refuse one that contains itself. */
  stack: string[];
}

const titleOf = (node: GraphNode | undefined, id: string) => (node && nodeDef(node.type)?.title) ?? node?.type ?? id;

function makeScope(graph: ShaderGraph, prefix: string, bindings: Map<string, Value> | null, problem: Scope["problem"], stack: string[]): Scope {
  const scope: Scope = {
    graph,
    nodes: new Map(graph.nodes.map((n) => [n.id, n])),
    index: new Map(graph.nodes.map((n, i) => [n.id, i])),
    incoming: new Map(),
    types: new Map(),
    typing: new Set(),
    prefix,
    bindings,
    problem,
    stack,
  };
  for (const e of graph.edges) {
    const from = splitPortRef(e.from), to = splitPortRef(e.to);
    const a = scope.nodes.get(from.node), b = scope.nodes.get(to.node);
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
    if (!scope.incoming.has(e.to)) scope.incoming.set(e.to, from);
  }
  return scope;
}

function nodeTypes(scope: Scope, id: string): NodeTypes {
  const known = scope.types.get(id);
  if (known) return known;
  const node = scope.nodes.get(id);
  if (!node || scope.typing.has(id)) return { dynamic: "float", outputs: {} };
  scope.typing.add(id);
  const ports = nodePorts(node, scope.graph);
  let width = 1;
  for (const p of ports.inputs) {
    if (p.type !== "dynamic") continue;
    const src = scope.incoming.get(portRef(id, p.id));
    const t = src ? (nodeTypes(scope, src.node).outputs[src.port] ?? "float") : inlineType(node.inputs?.[p.id]);
    width = Math.max(width, sizeOf(t));
  }
  const dynamic = SIZE_TYPE[width];
  const outputs: Record<string, ValueType> = {};
  for (const o of ports.outputs) outputs[o.id] = o.type === "dynamic" ? dynamic : o.type;
  scope.typing.delete(id);
  const result = { dynamic, outputs };
  scope.types.set(id, result);
  return result;
}

const GLSL_TYPE = (t: ValueType) => (t === "texture" ? "sampler2D" : t);

/** Compile a graph (or a sub-graph, drawn as its first output). Never throws for a bad graph; see `problems`. */
export function compileShaderGraph(graph: ShaderGraph, options: { shaderLevel?: ShaderLevel } = {}): CompiledShaderGraph {
  const shaderLevel = options.shaderLevel ?? "high";
  let usesShaderLevel = false;
  const problems: string[] = [];
  const nodeProblems: Record<string, string[]> = {};
  const dependencies = new Set<string>();
  const root = makeScope(
    graph,
    "",
    null,
    (id, message) => {
      const list = (nodeProblems[id] ??= []);
      if (list.includes(message)) return;
      list.push(message);
      problems.push(`${titleOf(graph.nodes.find((n) => n.id === id), id)} (${id}): ${message}`);
    },
    [],
  );

  // --- uniforms ------------------------------------------------------------------------------------
  const uniforms: CompiledUniform[] = [];
  const propertyUniform = (name: string): Value | null => {
    const i = graph.properties.findIndex((p) => p.name === name);
    if (i < 0) return null;
    const p = graph.properties[i];
    const uname = `uP${i}_${ident(p.name)}`;
    if (!uniforms.some((u) => u.name === uname)) uniforms.push({ name: uname, type: PROPERTY_GLSL[p.type], property: p.name, propertyType: p.type, value: p.value });
    return { expr: uname, type: valueTypeOf(PROPERTY_GLSL[p.type]) };
  };
  const textureUniform = (path: string, linear = false): string => {
    const existing = uniforms.find((u) => u.type === "sampler2D" && u.property === undefined && u.value === path && !!u.linear === linear);
    if (existing) return existing.name;
    const name = `uTex${uniforms.filter((u) => u.type === "sampler2D" && u.property === undefined).length}`;
    uniforms.push({ name, type: "sampler2D", value: path, ...(linear ? { linear: true } : {}) });
    return name;
  };
  /** How each texture uniform is sampled; a property sampled both ways reads as colour. */
  const modes = new Map<string, Set<boolean>>();
  const sampleMode = (name: string, linear: boolean, problem: (m: string) => void) => {
    const u = uniforms.find((v) => v.name === name);
    if (!u) return;
    const set = modes.get(name) ?? new Set<boolean>();
    set.add(linear);
    modes.set(name, set);
    if (set.size > 1) {
      problem(`texture property "${u.property ?? u.value}" is sampled both as a colour and as a normal map; it reads as a colour`);
      delete u.linear;
    } else if (linear) u.linear = true;
  };

  // --- stages --------------------------------------------------------------------------------------
  class Stage {
    readonly lines: string[] = [];
    readonly helpers = new Set<HelperName>();
    readonly functions = new Map<string, string>();
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

    input(scope: Scope, node: GraphNode, port: PortDef, dynamic: ValueType): string {
      const want: ValueType = port.type === "dynamic" ? dynamic : port.type;
      const src = scope.incoming.get(portRef(node.id, port.id));
      if (src) {
        const v = this.node(scope, src.node)?.[src.port];
        if (v) return convert(v.expr, v.type, want);
      }
      if (want === "texture") return textureUniform(node.settings?.[port.id] ?? port.texture ?? "", node.type === "sampleTexture" && node.settings?.type === "normal");
      if (port.bind) return convert(this.builtin(port.bind), BUILTIN_TYPES[port.bind], want);
      return literal(node.inputs?.[port.id] ?? port.default ?? 0, want, !!port.color);
    }

    local(scope: Scope, id: string, port: string): string {
      return `m${scope.prefix}${scope.index.get(id)}_${ident(port)}`;
    }

    node(scope: Scope, id: string): Record<string, Value> | null {
      const key = `${scope.prefix}|${id}`;
      if (this.values.has(key)) return this.values.get(key)!;
      if (this.visiting.has(key)) {
        scope.problem(id, "is part of a loop; the connection that closes it is ignored");
        return null;
      }
      const node = scope.nodes.get(id)!;
      const def = nodeDef(node.type);
      if (!def || def.type === OUTPUT_NODE_TYPE) {
        if (!def) scope.problem(id, `unknown node type "${node.type}"`);
        this.values.set(key, null);
        return null;
      }
      if (def.fragmentOnly && this.stage === "vertex") {
        scope.problem(id, "only works per pixel, so it can't feed Vertex Offset");
        this.values.set(key, null);
        return null;
      }
      this.visiting.add(key);
      const result = node.type === "subgraph" ? this.subgraph(scope, node) : node.type === "customFunction" ? this.customFunction(scope, node) : this.builtinNode(scope, node);
      this.visiting.delete(key);
      this.values.set(key, result);
      return result;
    }

    builtinNode(scope: Scope, node: GraphNode): Record<string, Value> {
      const def = nodeDef(node.type)!;
      const id = node.id;
      const ports = nodePorts(node, scope.graph);
      const { dynamic } = nodeTypes(scope, id);
      const ins: Record<string, string> = {};
      if (def.branch) usesShaderLevel = true;
      // A branch node evaluates only the input for the shader level; the others are never reached.
      for (const p of ports.inputs) ins[p.id] = def.branch && p.id !== shaderLevel ? literal(0, dynamic, false) : this.input(scope, node, p, dynamic);
      const settings: Record<string, string> = {};
      for (const s of def.settings ?? []) settings[s.id] = node.settings?.[s.id] ?? s.default;
      const problem = (m: string) => scope.problem(id, m);
      const ctx: EmitContext = {
        in: ins,
        type: dynamic,
        settings,
        stage: this.stage,
        shaderLevel,
        builtin: (b) => this.builtin(b),
        helper: (h) => this.helper(h),
        texture: (path) => textureUniform(path),
        property: (name) => {
          const v = scope.bindings ? (scope.bindings.get(name) ?? null) : propertyUniform(name);
          return v && { uniform: v.expr, type: v.type };
        },
        color: (hex) => literal(linearColor(hex), "vec4", false),
        sampleMode: (u, linear) => sampleMode(u, linear, problem),
        problem,
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
        const name = this.local(scope, id, o.id);
        this.lines.push(`${type} ${name} = ${expr ?? literal(0, type, false)};`);
        result[o.id] = { expr: name, type };
      }
      return result;
    }

    /** A Sub Graph node: the sub-graph's nodes, expanded inline with its properties bound to the node's inputs. */
    subgraph(scope: Scope, node: GraphNode): Record<string, Value> | null {
      const path = normalizeAssetPath(node.settings?.subgraph ?? "");
      if (!path) {
        scope.problem(node.id, "pick a sub-graph");
        return null;
      }
      dependencies.add(path);
      const r = resolveSubGraph(path);
      if (!r) {
        scope.problem(node.id, `the sub-graph "${path}" isn't in the project`);
        return null;
      }
      if (r.error !== undefined) {
        scope.problem(node.id, r.error);
        return null;
      }
      if (scope.stack.includes(path)) {
        scope.problem(node.id, `the sub-graph "${path}" contains itself`);
        return null;
      }
      const sub = r.graph;
      const ports = nodePorts(node, scope.graph);
      const bindings = new Map<string, Value>();
      for (const p of ports.inputs) bindings.set(p.id, { expr: this.input(scope, node, p, p.type as ValueType), type: p.type as ValueType });
      const name = path.slice(path.lastIndexOf("/") + 1);
      const inner = makeScope(sub, `${scope.prefix}${scope.index.get(node.id)}s`, bindings, (id, m) => scope.problem(node.id, `in ${name}, ${titleOf(sub.nodes.find((n) => n.id === id), id)}: ${m}`), [...scope.stack, path]);
      const output = sub.nodes.find((n) => n.type === OUTPUT_NODE_TYPE)!;
      const result: Record<string, Value> = {};
      for (const o of ports.outputs) {
        const type = o.type as ValueType;
        const expr = this.input(inner, output, { id: o.id, label: o.label, type, default: 0 }, type);
        if (type === "texture") {
          // A sampler can't be a local: the output stands for the uniform it leads back to.
          result[o.id] = { expr, type };
          continue;
        }
        const local = this.local(scope, node.id, o.id);
        this.lines.push(`${type} ${local} = ${expr};`);
        result[o.id] = { expr: local, type };
      }
      return result;
    }

    /** A Custom Function node: its GLSL as a function, called with the node's inputs. */
    customFunction(scope: Scope, node: GraphNode): Record<string, Value> | null {
      const f = node.function;
      if (!f) {
        scope.problem(node.id, "has no function");
        return null;
      }
      const fn = `${ident(f.name)}_${scope.prefix}${scope.index.get(node.id)}`;
      const params = [...f.inputs.map((p) => `${GLSL_TYPE(p.type)} ${p.name}`), ...f.outputs.map((p) => `out ${GLSL_TYPE(p.type)} ${p.name}`)];
      this.functions.set(fn, `void ${fn}(${params.join(", ")}) {\n${f.body}\n}`);
      const ports = nodePorts(node, scope.graph);
      const args = ports.inputs.map((p) => this.input(scope, node, p, p.type as ValueType));
      const result: Record<string, Value> = {};
      const outs: string[] = [];
      for (const o of ports.outputs) {
        const type = o.type as ValueType;
        const local = this.local(scope, node.id, o.id);
        this.lines.push(`${type} ${local} = ${literal(0, type, false)};`);
        outs.push(local);
        result[o.id] = { expr: local, type };
      }
      this.lines.push(`${fn}(${[...args, ...outs].join(", ")});`);
      return result;
    }

    /** Evaluate an output-node input into a local, returning its name. */
    surface(output: GraphNode, port: PortDef): string {
      const want = port.type as ValueType;
      const expr = this.input(root, output, port, want);
      const name = `mOut_${ident(port.id)}`;
      this.lines.push(`${want} ${name} = ${expr};`);
      return name;
    }
  }

  const vertex = new Stage("vertex");
  const fragment = new Stage("fragment");
  const output = graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE) ?? { id: "output", type: OUTPUT_NODE_TYPE, position: [0, 0] as [number, number] };
  const sub = graph.subgraph;
  const lit = graph.target !== "unlit" && !sub;
  const physicalTarget = graph.target === "physical" && !sub;
  const port = (id: string) => OUTPUT_INPUTS.find((p) => p.id === id)!;
  const connected = (id: string) => root.incoming.has(portRef(output.id, id));

  let offset: string | null = null, baseColor: string, alpha: string;
  let metalness: string | null = null, roughness: string | null = null, emission: string | null = null, normal: string | null = null, alphaClip: string | null = null;
  let physical: Partial<Record<PhysicalInput, string>> | null = null;
  if (sub) {
    // A sub-graph draws its first output, unlit (its preview).
    const first = sub.outputs[0];
    if (first?.type === "texture") {
      // A texture output previews as the texture across the mesh's UVs.
      const uniform = fragment.input(root, output, { id: first.name, label: first.name, type: "texture" }, "texture");
      baseColor = `mOut_base`;
      fragment.lines.push(`vec3 mOut_base = texture(${uniform}, vMycoUv).rgb;`);
    } else if (first) {
      const value = fragment.surface(output, { id: first.name, label: first.name, type: first.type, default: 0 });
      baseColor = `mOut_base`;
      fragment.lines.push(`vec3 mOut_base = ${convert(value, first.type, "vec3")};`);
    } else baseColor = "vec3(1.0)";
    alpha = "1.0";
  } else {
    offset = connected("vertexOffset") ? vertex.surface(output, port("vertexOffset")) : null;
    baseColor = fragment.surface(output, port("baseColor"));
    alpha = fragment.surface(output, port("alpha"));
    metalness = lit ? fragment.surface(output, port("metalness")) : null;
    roughness = lit ? fragment.surface(output, port("roughness")) : null;
    emission = lit ? fragment.surface(output, port("emission")) : null;
    normal = lit && connected("normal") ? fragment.surface(output, port("normal")) : null;
    const clipValue = output.inputs?.alphaClip;
    alphaClip = connected("alphaClip") || (typeof clipValue === "number" && clipValue > 0) ? fragment.surface(output, port("alphaClip")) : null;
    if (physicalTarget) {
      // Each feature compiles in only when it's used: connected, or its inline value away from the default.
      const used = (id: PhysicalInput) => {
        if (connected(id)) return true;
        const v = output.inputs?.[id], d = port(id).default;
        return v !== undefined && JSON.stringify(v) !== JSON.stringify(d) && (Array.isArray(v) ? v.some((x) => x !== 0) || id !== "sheenColor" : true);
      };
      physical = {};
      const add = (id: PhysicalInput) => (physical![id] = fragment.surface(output, port(id)));
      if (used("clearcoat")) {
        add("clearcoat");
        add("clearcoatRoughness");
      }
      if (used("sheenColor")) {
        add("sheenColor");
        add("sheenRoughness");
      }
      if (used("transmission")) {
        add("transmission");
        add("thickness");
      }
      for (const id of ["iridescence", "ior", "specularIntensity"] as const) if (used(id)) add(id);
    }
  }
  if (normal) fragment.helper("tangentFrame");

  // Types for every node, reached or not (the editor colours all wires).
  const portTypes: Record<string, ValueType> = {};
  const dynamicTypes: Record<string, ValueType> = {};
  for (const n of graph.nodes) {
    const t = nodeTypes(root, n.id);
    dynamicTypes[n.id] = t.dynamic;
    for (const [p, type] of Object.entries(t.outputs)) portTypes[portRef(n.id, p)] = type;
  }

  const uniformLines = [`uniform float ${SHARED_UNIFORMS.time};`, `uniform vec2 ${SHARED_UNIFORMS.resolution};`, ...uniforms.map((u) => `uniform ${u.type} ${u.name};`)];
  const helperText = (s: Stage) => [...(Object.keys(HELPERS) as HelperName[]).filter((h) => s.helpers.has(h)).map((h) => HELPERS[h]), ...s.functions.values()];
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
  const target = sub ? "unlit" : graph.target;
  const surface = sub ? "opaque" : graph.surface;
  const linearKey = uniforms.filter((u) => u.linear).map((u) => u.name).join(",");
  const key = hash([target, surface, graph.doubleSided, vertexDeclarations, vertexBody, offset, fragmentDeclarations, fragmentBody, normal, alphaClip, linearKey, JSON.stringify(physical), usesShaderLevel ? shaderLevel : ""].join("\u0000"));

  return {
    target,
    surface,
    doubleSided: !sub && graph.doubleSided,
    vertex: { declarations: vertexDeclarations, body: vertexBody, offset, varyings },
    fragment: { declarations: fragmentDeclarations, body: fragmentBody, baseColor, alpha, metalness, roughness, emission, normal, physical, alphaClip },
    uniforms,
    problems,
    nodeProblems,
    portTypes,
    dynamicTypes,
    dependencies: [...dependencies],
    usesShaderLevel,
    key,
  };
}

/**
 * The graph that previews one node (ADR 0048): unlit, with the node's first number output in
 * Base Color and nothing else connected to the output. Null for nodes without a number output.
 */
export function nodePreviewGraph(graph: ShaderGraph, nodeId: string): ShaderGraph | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type === OUTPUT_NODE_TYPE) return null;
  const out = nodePorts(node, graph).outputs.find((p) => p.type !== "texture");
  if (!out) return null;
  const output = graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
  const outputId = output?.id ?? "output";
  const nodes = graph.nodes.map((n) => (n.type === OUTPUT_NODE_TYPE ? { id: n.id, type: n.type, position: n.position } : n));
  if (!output) nodes.push({ id: outputId, type: OUTPUT_NODE_TYPE, position: [0, 0] });
  return {
    target: "unlit",
    surface: "opaque",
    doubleSided: false,
    properties: graph.properties,
    nodes,
    edges: [...graph.edges.filter((e) => splitPortRef(e.to).node !== outputId), { from: portRef(nodeId, out.id), to: portRef(outputId, "baseColor") }],
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
    ...Object.entries(c.fragment.physical ?? {}).map(([k, v]) => `material.${k} = ${v}; // physical`),
  ];
  const indent = (s: string) => s.split("\n").filter(Boolean).map((l) => `  ${l}`).join("\n");
  return [
    `// ---- vertex (${c.target === "physical" ? "MeshPhysicalMaterial" : c.target === "lit" ? "MeshStandardMaterial" : "MeshBasicMaterial"}) ----`,
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
