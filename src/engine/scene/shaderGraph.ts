/**
 * Shader graph assets (ADR 0047): `*.shadergraph.json` files holding a node graph that compiles to
 * a shader extending the built-in lit or unlit material. Materials name one as their `shader`.
 *
 * ```jsonc
 * {
 *   "format": "myco.shadergraph@1",
 *   "target": "lit",                 // "lit" (default) | "unlit"
 *   "surface": "opaque",             // "opaque" (default) | "transparent"
 *   "doubleSided": false,
 *   "properties": [{ "name": "Tint", "type": "color", "value": "#ff8800" }],
 *   "nodes": [{ "id": "output", "type": "output", "position": [300, 0] }],
 *   "edges": [{ "from": "n1.out", "to": "output.baseColor" }]
 * }
 * ```
 *
 * Sub-graphs (ADR 0048) are `*.shadersubgraph.json` files, `"format": "myco.shadersubgraph@1"`:
 * the same shape without `target`, `surface` and `doubleSided`, plus `"outputs"` (the output node's
 * ports). Optional `groups` and `notes` only organise the editor's canvas.
 */
import { keywordsJSON, parseKeywords, type ShaderKeyword } from "./shaderKeywords";

export const SHADER_GRAPH_FORMAT = "myco.shadergraph@1";
export const SHADER_GRAPH_SUFFIX = ".shadergraph.json";
export const SHADER_SUBGRAPH_FORMAT = "myco.shadersubgraph@1";
export const SHADER_SUBGRAPH_SUFFIX = ".shadersubgraph.json";

/** True for a shader graph asset path (with or without `asset:`). */
export const isShaderGraphPath = (path: string): boolean => path.toLowerCase().endsWith(SHADER_GRAPH_SUFFIX);
/** True for a shader sub-graph asset path. */
export const isShaderSubGraphPath = (path: string): boolean => path.toLowerCase().endsWith(SHADER_SUBGRAPH_SUFFIX);

export type ShaderGraphTarget = "lit" | "unlit" | "physical";
export type ShaderGraphSurface = "opaque" | "transparent";
export type GraphPropertyType = "float" | "vector2" | "vector3" | "vector4" | "color" | "texture";
export const GRAPH_PROPERTY_TYPES: readonly GraphPropertyType[] = ["float", "vector2", "vector3", "vector4", "color", "texture"];

/** A property value: a number (float), 2–4 numbers (vectors), `#rrggbb[aa]` (color) or an asset path (texture, may be empty). */
export type GraphValue = number | number[] | string;

/** A property exposed to materials. */
export interface GraphProperty {
  name: string;
  type: GraphPropertyType;
  value: GraphValue;
}

/** An unconnected input's value: a number, or 2–4 numbers. */
export type InputValue = number | number[];

/** A port of a custom function or a sub-graph output: a shader identifier and a value type. */
export interface FunctionPort {
  name: string;
  type: "float" | "vec2" | "vec3" | "vec4" | "texture";
}

/** A Custom Function node's code (ADR 0048, 0075). */
export interface CustomFunction {
  name: string;
  inputs: FunctionPort[];
  outputs: FunctionPort[];
  /** The function in WGSL: the statements of `fn name(inputs) -> outputs`, where each output is a `var` already declared. Without it the node's outputs read their defaults. */
  wgsl?: string;
  /**
   * An `asset:` path to a `.wgsl` file holding the body (the same contract as `wgsl`: the statements
   * of the function, outputs already declared). It wins over `wgsl`, and the renderer rebuilds the
   * material when the file changes.
   */
  file?: string;
  /**
   * The GLSL body older files have (`void name(inputs, out outputs) { body }`). Nothing compiles it
   * since the three.js backend went (ADR 0081); it's kept, so the code isn't lost, until someone
   * ports it to `wgsl`.
   */
  body?: string;
}

/** A titled box around nodes on the canvas. */
export interface GraphGroup {
  id: string;
  title: string;
  nodes: string[];
}

/** A sticky note on the canvas. */
export interface GraphNote {
  id: string;
  position: [number, number];
  size: [number, number];
  text: string;
}

export interface GraphNode {
  /** Unique within the graph; letters, digits, `_` and `-` (no dots: edges use `node.port`). */
  id: string;
  type: string;
  position: [number, number];
  /** Values for unconnected inputs, by port id. */
  inputs?: Record<string, InputValue>;
  /** The node's options (property name, swizzle mask, space, texture, colour…). */
  settings?: Record<string, string>;
  /** Custom Function nodes: their ports and code (WGSL; older files' GLSL `body` is kept but not compiled). */
  function?: CustomFunction;
  /** False: the node's preview is collapsed in the editor. */
  preview?: false;
  /** The shape this node's preview is drawn on; the graph's `previewShape` when unset (ADR 0117). */
  previewShape?: NodePreviewShape;
}

/** The shapes a node's preview can be drawn on: a flat quad (the default), a sphere or a cube (ADR 0117). */
export type NodePreviewShape = "quad" | "sphere" | "cube";
export const NODE_PREVIEW_SHAPES: readonly NodePreviewShape[] = ["quad", "sphere", "cube"];
const isPreviewShape = (v: unknown): v is NodePreviewShape => typeof v === "string" && (NODE_PREVIEW_SHAPES as readonly string[]).includes(v);

/** The meshes the main preview can draw (ADR 0117). */
export type GraphPreviewMesh = "sphere" | "cube" | "capsule" | "plane";
export const GRAPH_PREVIEW_MESHES: readonly GraphPreviewMesh[] = ["sphere", "cube", "capsule", "plane"];
const isPreviewMesh = (v: unknown): v is GraphPreviewMesh => typeof v === "string" && (GRAPH_PREVIEW_MESHES as readonly string[]).includes(v);


/** The shape a node's preview is drawn on: its own, else the graph's default, else a quad. */
export const nodePreviewShape = (graph: ShaderGraph, node: GraphNode): NodePreviewShape => node.previewShape ?? graph.previewShape ?? "quad";

/** A connection from an output port to an input port, each written `nodeId.portId`. */
export interface GraphEdge {
  from: string;
  to: string;
}

export interface ShaderGraph {
  target: ShaderGraphTarget;
  surface: ShaderGraphSurface;
  doubleSided: boolean;
  properties: GraphProperty[];
  /** Keywords Keyword nodes switch on; a material picks their values, each combination its own variant (ADR 0106). */
  keywords?: ShaderKeyword[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Set for a sub-graph: its outputs (the output node's ports). */
  subgraph?: { outputs: FunctionPort[] };
  groups?: GraphGroup[];
  notes?: GraphNote[];
  /** Editor metadata: the default shape for node previews (absent: quads). */
  previewShape?: NodePreviewShape;
  /** Editor metadata: the mesh the main preview draws (absent: sphere), ADR 0117. */
  previewMesh?: GraphPreviewMesh;
}

export const OUTPUT_NODE_TYPE = "output";

/** A new graph: just the output (master) node. */
export const defaultShaderGraph = (): ShaderGraph => ({
  target: "lit",
  surface: "opaque",
  doubleSided: false,
  properties: [],
  nodes: [{ id: "output", type: OUTPUT_NODE_TYPE, position: [0, 0] }],
  edges: [],
});

/** A new sub-graph: an output node with one `vec4` output, `Out`. */
export const defaultShaderSubGraph = (): ShaderGraph => ({ ...defaultShaderGraph(), subgraph: { outputs: [{ name: "Out", type: "vec4" }] } });

const FUNCTION_TYPES = ["float", "vec2", "vec3", "vec4", "texture"] as const;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True for a name usable as a port of a custom function or sub-graph output (a shader identifier, `__`-free). */
export const isPortName = (name: string): boolean => IDENT.test(name) && !name.includes("__") && !name.startsWith("gl_");

function parsePorts(raw: unknown, where: string, problems: string[], allowTexture: boolean): FunctionPort[] {
  const out: FunctionPort[] = [];
  if (!Array.isArray(raw)) return out;
  for (const p of raw) {
    if (!isObject(p) || typeof p.name !== "string" || !isPortName(p.name) || !FUNCTION_TYPES.includes(p.type as FunctionPort["type"]) || (!allowTexture && p.type === "texture")) {
      problems.push(`${where}: skipped a port without a shader name and a type.`);
      continue;
    }
    if (out.some((q) => q.name === p.name)) {
      problems.push(`${where}: skipped a second port named "${p.name}".`);
      continue;
    }
    out.push({ name: p.name, type: p.type as FunctionPort["type"] });
  }
  return out;
}

/** Split `node.port`. */
export function splitPortRef(ref: string): { node: string; port: string } {
  const dot = ref.indexOf("."); // node ids have no dots; port ids (a sub-graph's property names) may
  return dot < 0 ? { node: ref, port: "" } : { node: ref.slice(0, dot), port: ref.slice(dot + 1) };
}

export const portRef = (node: string, port: string) => `${node}.${port}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
const NODE_ID = /^[A-Za-z0-9_-]+$/;

/** The default value of a new property of `type`. */
export function defaultPropertyValue(type: GraphPropertyType): GraphValue {
  switch (type) {
    case "float":
      return 0;
    case "vector2":
      return [0, 0];
    case "vector3":
      return [0, 0, 0];
    case "vector4":
      return [0, 0, 0, 0];
    case "color":
      return "#ffffff";
    case "texture":
      return "";
  }
}

/** The number of components of a vector property type (1 for float). */
export const propertySize = (type: GraphPropertyType): number => (type === "vector2" ? 2 : type === "vector3" ? 3 : type === "vector4" || type === "color" ? 4 : 1);

/** `value` if it suits a property of `type`, else null. */
export function checkPropertyValue(type: GraphPropertyType, value: unknown): GraphValue | null {
  if (type === "float") return isNum(value) ? value : null;
  if (type === "color") return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : null;
  if (type === "texture") return typeof value === "string" ? value : null;
  const n = propertySize(type);
  return Array.isArray(value) && value.length === n && value.every(isNum) ? [...value] : null;
}


/** A `properties` list (graphs, sub-graphs and shader assets, ADR 0047 and 0106), leniently: bad entries are skipped and listed in `problems`. */
export function parseGraphProperties(raw: unknown, where: string, problems: string[]): GraphProperty[] {
  const out: GraphProperty[] = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) {
    problems.push(`${where}: "properties" should be a list.`);
    return out;
  }
  for (const p of raw) {
    if (!isObject(p) || typeof p.name !== "string" || !p.name.trim() || !GRAPH_PROPERTY_TYPES.includes(p.type as GraphPropertyType)) {
      problems.push(`${where}: skipped a property without a name and a type (${GRAPH_PROPERTY_TYPES.join(", ")}).`);
      continue;
    }
    if (out.some((q) => q.name === p.name)) {
      problems.push(`${where}: skipped a second property named "${p.name}".`);
      continue;
    }
    const type = p.type as GraphPropertyType;
    let value = p.value === undefined ? defaultPropertyValue(type) : checkPropertyValue(type, p.value);
    if (value === null) {
      problems.push(`${where}: property "${p.name}" has a bad value for a ${type}; using the default.`);
      value = defaultPropertyValue(type);
    }
    out.push({ name: p.name, type, value });
  }
  return out;
}

/**
 * Read a shader graph file's parsed JSON. Anything malformed is skipped and listed in `problems`;
 * throws only for something that isn't a shader graph of this format. A graph without an output
 * node gets one.
 */
export function parseShaderGraph(raw: unknown, where = "shader graph"): { graph: ShaderGraph; problems: string[] } {
  if (!isObject(raw)) throw new Error(`${where}: expected an object with "format": "${SHADER_GRAPH_FORMAT}".`);
  if (raw.format !== SHADER_GRAPH_FORMAT && raw.format !== SHADER_SUBGRAPH_FORMAT) throw new Error(`${where}: unknown format ${JSON.stringify(raw.format)}; expected "${SHADER_GRAPH_FORMAT}".`);
  const problems: string[] = [];
  const graph: ShaderGraph = { ...defaultShaderGraph(), nodes: [] };
  // Sub-graph outputs may be textures: the compiler passes the texture's uniform through (WGSL can't hold one in a variable).
  if (raw.format === SHADER_SUBGRAPH_FORMAT) graph.subgraph = { outputs: parsePorts(raw.outputs, `${where} outputs`, problems, true) };
  if (raw.target !== undefined) {
    if (raw.target === "lit" || raw.target === "unlit" || raw.target === "physical") graph.target = raw.target;
    else problems.push(`${where}: "target" should be "lit" or "unlit"; using "lit".`);
  }
  if (raw.surface !== undefined) {
    if (raw.surface === "opaque" || raw.surface === "transparent") graph.surface = raw.surface;
    else problems.push(`${where}: "surface" should be "opaque" or "transparent"; using "opaque".`);
  }
  if (raw.doubleSided !== undefined) {
    if (typeof raw.doubleSided === "boolean") graph.doubleSided = raw.doubleSided;
    else problems.push(`${where}: "doubleSided" should be true or false.`);
  }
  graph.properties = parseGraphProperties(raw.properties, where, problems);
  const keywords = parseKeywords(raw.keywords, where, problems);
  if (keywords.length) graph.keywords = keywords;
  if (Array.isArray(raw.nodes)) {
    for (const n of raw.nodes) {
      if (!isObject(n) || typeof n.id !== "string" || !NODE_ID.test(n.id) || typeof n.type !== "string") {
        problems.push(`${where}: skipped a node without an id (letters, digits, _ and -) and a type.`);
        continue;
      }
      if (graph.nodes.some((m) => m.id === n.id)) {
        problems.push(`${where}: skipped a second node with id "${n.id}".`);
        continue;
      }
      const pos = Array.isArray(n.position) && n.position.length === 2 && n.position.every(isNum) ? ([n.position[0], n.position[1]] as [number, number]) : ([0, 0] as [number, number]);
      const node: GraphNode = { id: n.id, type: n.type, position: pos };
      if (isObject(n.inputs)) {
        const inputs: Record<string, InputValue> = {};
        for (const [k, v] of Object.entries(n.inputs)) {
          if (isNum(v)) inputs[k] = v;
          else if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every(isNum)) inputs[k] = [...v];
          else problems.push(`${where}: node "${n.id}" input "${k}" should be a number or 2–4 numbers.`);
        }
        if (Object.keys(inputs).length) node.inputs = inputs;
      }
      if (isObject(n.settings)) {
        const settings: Record<string, string> = {};
        for (const [k, v] of Object.entries(n.settings)) {
          if (typeof v === "string") settings[k] = v;
          else problems.push(`${where}: node "${n.id}" setting "${k}" should be text.`);
        }
        if (Object.keys(settings).length) node.settings = settings;
      }
      if (n.function !== undefined) {
        const f = n.function;
        if (isObject(f) && typeof f.name === "string" && isPortName(f.name)) {
          node.function = {
            name: f.name,
            inputs: parsePorts(f.inputs, `${where}: node "${n.id}" inputs`, problems, true),
            outputs: parsePorts(f.outputs, `${where}: node "${n.id}" outputs`, problems, false),
            ...(typeof f.wgsl === "string" && f.wgsl ? { wgsl: f.wgsl } : {}),
            ...(typeof f.file === "string" && f.file ? { file: f.file } : {}),
            ...(typeof f.body === "string" && f.body ? { body: f.body } : {}),
          };
          if (f.file !== undefined && typeof f.file !== "string") problems.push(`${where}: node "${n.id}" function file isn't a string; ignored.`);
        } else problems.push(`${where}: node "${n.id}" has a function without a valid name.`);
      }
      if (n.preview === false) node.preview = false;
      if (isPreviewShape(n.previewShape)) node.previewShape = n.previewShape;
      graph.nodes.push(node);
    }
  } else if (raw.nodes !== undefined) problems.push(`${where}: "nodes" should be a list.`);
  const outputs = graph.nodes.filter((n) => n.type === OUTPUT_NODE_TYPE);
  if (outputs.length === 0) graph.nodes.unshift({ id: graph.nodes.some((n) => n.id === "output") ? "output-1" : "output", type: OUTPUT_NODE_TYPE, position: [0, 0] });
  else if (outputs.length > 1) {
    problems.push(`${where}: only one output node is used; removed the others.`);
    graph.nodes = graph.nodes.filter((n) => n.type !== OUTPUT_NODE_TYPE || n === outputs[0]);
  }
  if (Array.isArray(raw.edges)) {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of raw.edges) {
      if (!isObject(e) || typeof e.from !== "string" || typeof e.to !== "string") {
        problems.push(`${where}: skipped an edge without "from" and "to".`);
        continue;
      }
      const from = splitPortRef(e.from), to = splitPortRef(e.to);
      if (!ids.has(from.node) || !ids.has(to.node) || !from.port || !to.port) {
        problems.push(`${where}: skipped an edge ${e.from} → ${e.to} to a node that isn't there.`);
        continue;
      }
      if (graph.edges.some((f) => f.to === e.to)) {
        problems.push(`${where}: ${e.to} has more than one connection; kept the first.`);
        continue;
      }
      graph.edges.push({ from: e.from, to: e.to });
    }
  } else if (raw.edges !== undefined) problems.push(`${where}: "edges" should be a list.`);
  if (Array.isArray(raw.groups)) {
    const ids = new Set(graph.nodes.map((n) => n.id));
    const groups: GraphGroup[] = [];
    for (const g of raw.groups) {
      if (!isObject(g) || typeof g.id !== "string" || !Array.isArray(g.nodes)) {
        problems.push(`${where}: skipped a group without an id and nodes.`);
        continue;
      }
      groups.push({ id: g.id, title: typeof g.title === "string" ? g.title : "", nodes: g.nodes.filter((id): id is string => typeof id === "string" && ids.has(id)) });
    }
    if (groups.length) graph.groups = groups;
  }
  if (Array.isArray(raw.notes)) {
    const notes: GraphNote[] = [];
    for (const n of raw.notes) {
      const pair = (v: unknown, d: [number, number]): [number, number] => (Array.isArray(v) && v.length === 2 && v.every(isNum) ? [v[0], v[1]] : d);
      if (!isObject(n) || typeof n.id !== "string") {
        problems.push(`${where}: skipped a note without an id.`);
        continue;
      }
      notes.push({ id: n.id, position: pair(n.position, [0, 0]), size: pair(n.size, [200, 100]), text: typeof n.text === "string" ? n.text : "" });
    }
    if (notes.length) graph.notes = notes;
  }
  if (isPreviewShape(raw.previewShape)) graph.previewShape = raw.previewShape;
  if (isPreviewMesh(raw.previewMesh)) graph.previewMesh = raw.previewMesh;
  return { graph, problems };
}

/** A shader graph file's JSON: the format, the settings that differ from the defaults, then the graph. */
export function shaderGraphJSON(graph: ShaderGraph): Record<string, unknown> {
  const out: Record<string, unknown> = { format: graph.subgraph ? SHADER_SUBGRAPH_FORMAT : SHADER_GRAPH_FORMAT };
  if (graph.subgraph) out.outputs = graph.subgraph.outputs.map((p) => ({ ...p }));
  else {
    if (graph.target !== "lit") out.target = graph.target;
    if (graph.surface !== "opaque") out.surface = graph.surface;
    if (graph.doubleSided) out.doubleSided = true;
  }
  out.properties = graph.properties.map((p) => ({ name: p.name, type: p.type, value: Array.isArray(p.value) ? [...p.value] : p.value }));
  if (graph.keywords?.length) out.keywords = keywordsJSON(graph.keywords);
  out.nodes = graph.nodes.map((n) => {
    const node: Record<string, unknown> = { id: n.id, type: n.type, position: [Math.round(n.position[0]), Math.round(n.position[1])] };
    if (n.inputs && Object.keys(n.inputs).length) node.inputs = { ...n.inputs };
    if (n.settings && Object.keys(n.settings).length) node.settings = { ...n.settings };
    if (n.function) node.function = { name: n.function.name, inputs: n.function.inputs.map((p) => ({ ...p })), outputs: n.function.outputs.map((p) => ({ ...p })), ...(n.function.wgsl ? { wgsl: n.function.wgsl } : {}), ...(n.function.file ? { file: n.function.file } : {}), ...(n.function.body ? { body: n.function.body } : {}) };
    if (n.preview === false) node.preview = false;
    if (n.previewShape) node.previewShape = n.previewShape;
    return node;
  });
  out.edges = graph.edges.map((e) => ({ from: e.from, to: e.to }));
  if (graph.groups?.length) out.groups = graph.groups.map((g) => ({ id: g.id, title: g.title, nodes: [...g.nodes] }));
  if (graph.notes?.length) out.notes = graph.notes.map((n) => ({ id: n.id, position: [Math.round(n.position[0]), Math.round(n.position[1])], size: [Math.round(n.size[0]), Math.round(n.size[1])], text: n.text }));
  if (graph.previewShape && graph.previewShape !== "quad") out.previewShape = graph.previewShape;
  if (graph.previewMesh && graph.previewMesh !== "sphere") out.previewMesh = graph.previewMesh;
  return out;
}

/** Shader graph file text: two-space JSON with number lists and each node, property and edge on one line. */
export function formatShaderGraph(graph: ShaderGraph): string {
  const json = shaderGraphJSON(graph);
  const lines = ["{"];
  const entries = Object.entries(json);
  entries.forEach(([key, value], i) => {
    const comma = i < entries.length - 1 ? "," : "";
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`  ${JSON.stringify(key)}: []${comma}`);
      else {
        lines.push(`  ${JSON.stringify(key)}: [`);
        value.forEach((item, j) => lines.push(`    ${oneLine(item)}${j < value.length - 1 ? "," : ""}`));
        lines.push(`  ]${comma}`);
      }
    } else lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** Compact one-line JSON with a space after colons and commas: `{ "id": "n1", "position": [0, 0] }`. */
function oneLine(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(", ")}]`;
  if (isObject(value)) return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`).join(", ")} }`;
  return JSON.stringify(value);
}
