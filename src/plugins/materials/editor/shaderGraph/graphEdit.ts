// Shader graph edits (ADR 0046): pure functions from one graph to the next, so the panel's undo
// history is a list of graphs and every rule here is unit-tested. None of them change their input.
// The edits every graph editor shares (properties, groups, notes, copy and paste) come from the
// graph document (ADR 0228) through `shaderGraphEdits`, with what is the Shader Graph's own
// plugged in; the rest (nodes, connections, keywords, sub-graph ports) are here. `shaderWiring`
// hands the connection edits to the graph layer's wiring gesture (ADR 0259).
import { canConnectTypes, nodeDef, nodePorts, type ValueType } from "../../../../engine/render/shaderGraph/nodes";
import {
  OUTPUT_NODE_TYPE,
  defaultPropertyValue,
  portRef,
  splitPortRef,
  isPortName,
  type CustomFunction,
  type FunctionPort,
  type GraphNode,
  type GraphPreviewMesh,
  type GraphProperty,
  type GraphPropertyType,
  type GraphValue,
  type InputValue,
  type NodePreviewShape,
  type ShaderGraph,
  SHADER_GRAPH_FORMAT,
  parseShaderGraph,
} from "../../../../engine/scene/shaderGraph";
import { KEYWORD_NAME, type ShaderKeyword } from "../../../../engine/scene/shaderKeywords";
import { freeId, graphDocument, pasteProperties, type GraphWiringEdits } from "../../../../editor/sdk";
import { uniqueName, type Numbering } from "../../../../engine/core/uniqueName";

const clone = (g: ShaderGraph): ShaderGraph => structuredClone(g);

/** A new node id for `type` that the graph doesn't use: `multiply1`, `multiply2`… */
function newNodeId(graph: ShaderGraph, type: string, taken: ReadonlySet<string> = new Set()): string {
  return freeId(type.replace(/[^A-Za-z0-9_-]/g, "") || "node", (id) => taken.has(id) || graph.nodes.some((n) => n.id === id));
}

/** Add a node of `type` at `position`. */
export function addNode(graph: ShaderGraph, type: string, position: [number, number], settings?: Record<string, string>): { graph: ShaderGraph; id: string } {
  const id = newNodeId(graph, type);
  const g = clone(graph);
  const node: GraphNode = { id, type, position: [Math.round(position[0]), Math.round(position[1])] };
  if (settings && Object.keys(settings).length) node.settings = { ...settings };
  g.nodes.push(node);
  return { graph: g, id };
}

/** Remove nodes and their connections. The output node stays. */
export function removeNodes(graph: ShaderGraph, ids: Iterable<string>): ShaderGraph {
  const gone = new Set([...ids].filter((id) => graph.nodes.find((n) => n.id === id)?.type !== OUTPUT_NODE_TYPE));
  if (gone.size === 0) return graph;
  const g = clone(graph);
  g.nodes = g.nodes.filter((n) => !gone.has(n.id));
  g.edges = g.edges.filter((e) => !gone.has(splitPortRef(e.from).node) && !gone.has(splitPortRef(e.to).node));
  if (g.groups) {
    g.groups = g.groups.map((gr) => ({ ...gr, nodes: gr.nodes.filter((id) => !gone.has(id)) })).filter((gr) => gr.nodes.length > 0);
    if (g.groups.length === 0) delete g.groups;
  }
  return g;
}

/** Move nodes to new positions (rounded to whole pixels). */
export function moveNodes(graph: ShaderGraph, positions: ReadonlyMap<string, [number, number]>): ShaderGraph {
  const g = clone(graph);
  let changed = false;
  for (const n of g.nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const next: [number, number] = [Math.round(p[0]), Math.round(p[1])];
    if (next[0] !== n.position[0] || next[1] !== n.position[1]) {
      n.position = next;
      changed = true;
    }
  }
  return changed ? g : graph;
}

/** True if `downstream` depends on `upstream`'s value (following connections backwards). */
function dependsOn(graph: ShaderGraph, downstream: string, upstream: string): boolean {
  const seen = new Set<string>();
  const stack = [downstream];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === upstream) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) if (splitPortRef(e.to).node === id) stack.push(splitPortRef(e.from).node);
  }
  return false;
}

/** Why `from` (an output, `node.port`) can't connect to `to` (an input), or null if it can. */
export function whyNotConnect(graph: ShaderGraph, from: string, to: string): string | null {
  const f = splitPortRef(from), t = splitPortRef(to);
  const a = graph.nodes.find((n) => n.id === f.node), b = graph.nodes.find((n) => n.id === t.node);
  if (!a || !b) return "that node isn't there";
  if (a.id === b.id) return "a node can't connect to itself";
  const out = nodePorts(a, graph).outputs.find((p) => p.id === f.port);
  const inp = nodePorts(b, graph).inputs.find((p) => p.id === t.port);
  if (!out || !inp) return "that port isn't there";
  if (!canConnectTypes(out.type, inp.type)) return out.type === "texture" ? "only texture inputs take a texture" : "a texture input takes only a texture";
  if (dependsOn(graph, a.id, b.id)) return "that would make a loop";
  return null;
}

/** Connect an output to an input, replacing what the input had. Unchanged if the connection isn't allowed. */
export function connect(graph: ShaderGraph, from: string, to: string): ShaderGraph {
  if (whyNotConnect(graph, from, to)) return graph;
  if (graph.edges.some((e) => e.from === from && e.to === to)) return graph;
  const g = clone(graph);
  g.edges = g.edges.filter((e) => e.to !== to);
  g.edges.push({ from, to });
  return g;
}

/** Remove the connection into an input (`node.port`). */
export function disconnect(graph: ShaderGraph, to: string): ShaderGraph {
  if (!graph.edges.some((e) => e.to === to)) return graph;
  const g = clone(graph);
  g.edges = g.edges.filter((e) => e.to !== to);
  return g;
}

/** The output connected to an input, or null. */
export const sourceOf = (graph: ShaderGraph, to: string): string | null => graph.edges.find((e) => e.to === to)?.from ?? null;

/** The Shader Graph's wire edits, for the graph layer's wiring gesture (ADR 0259). */
export const shaderWiring: GraphWiringEdits<ShaderGraph> = { sourceOf, whyNot: whyNotConnect, connect, disconnect, split: splitPortRef };

/** Set an unconnected input's value (undefined: back to the default). */
export function setInput(graph: ShaderGraph, nodeId: string, port: string, value: InputValue | undefined): ShaderGraph {
  const g = clone(graph);
  const n = g.nodes.find((m) => m.id === nodeId);
  if (!n) return graph;
  const inputs = { ...(n.inputs ?? {}) };
  if (value === undefined) delete inputs[port];
  else inputs[port] = Array.isArray(value) ? [...value] : value;
  if (Object.keys(inputs).length) n.inputs = inputs;
  else delete n.inputs;
  return g;
}

/**
 * Set a node's setting. Connections from outputs the change removes (a swizzle mask's size, a
 * property node's type) are kept: the compiler converts between sizes.
 */
export function setSetting(graph: ShaderGraph, nodeId: string, key: string, value: string): ShaderGraph {
  const g = clone(graph);
  const n = g.nodes.find((m) => m.id === nodeId);
  if (!n) return graph;
  n.settings = { ...(n.settings ?? {}), [key]: value };
  // A connection the new ports can't take (a texture property into a number input) goes.
  return dropInvalidEdges(g);
}

function dropInvalidEdges(g: ShaderGraph): ShaderGraph {
  g.edges = g.edges.filter((e) => {
    const f = splitPortRef(e.from), t = splitPortRef(e.to);
    const a = g.nodes.find((n) => n.id === f.node), b = g.nodes.find((n) => n.id === t.node);
    const out = a && nodePorts(a, g).outputs.find((p) => p.id === f.port);
    const inp = b && nodePorts(b, g).inputs.find((p) => p.id === t.port);
    return !!out && !!inp && canConnectTypes(out.type, inp.type);
  });
  return g;
}

/** Change the graph's settings: target, surface, double-sided. Lit-only inputs lose their connections when the graph turns unlit. */
export function setGraphOptions(graph: ShaderGraph, patch: Partial<Pick<ShaderGraph, "target" | "surface" | "doubleSided">>): ShaderGraph {
  const g = { ...clone(graph), ...patch };
  return dropInvalidEdges(g);
}

const TYPE_LABELS: Record<GraphPropertyType, string> = { float: "Float", vector2: "Vector2", vector3: "Vector3", vector4: "Vector4", color: "Color", texture: "Texture" };

/** Change a property's type (its value goes back to the type's default). */
export function setPropertyType(graph: ShaderGraph, name: string, type: GraphPropertyType): ShaderGraph {
  const g = clone(graph);
  const p: GraphProperty | undefined = g.properties.find((q) => q.name === name);
  if (!p || p.type === type) return graph;
  p.type = type;
  p.value = defaultPropertyValue(type);
  return dropInvalidEdges(g);
}

// --- keywords (ADR 0106) ----------------------------------------------------------------------------

/** A keyword name the graph doesn't use: `KEYWORD`, `KEYWORD_2`… */
/** `KEYWORD`, `KEYWORD_2`…: a keyword stays a GLSL-style identifier. */
const UNDERSCORED: Numbering = { format: (stem, n) => `${stem}_${n}`, first: 2 };
const freeKeywordName = (graph: ShaderGraph, base = "KEYWORD"): string => uniqueName(base, (graph.keywords ?? []).map((k) => k.name), UNDERSCORED);

/** Add an on/off keyword. */
export function addKeyword(graph: ShaderGraph): { graph: ShaderGraph; name: string } {
  const name = freeKeywordName(graph);
  const g = clone(graph);
  g.keywords = [...(g.keywords ?? []), { name }];
  return { graph: g, name };
}

/** Why a keyword can't be renamed to `name`, or null. */
export function whyNotKeywordName(graph: ShaderGraph, from: string, name: string): string | null {
  if (!KEYWORD_NAME.test(name)) return "a keyword name is upper case: letters, digits and _, starting with a letter";
  if (name !== from && (graph.keywords ?? []).some((k) => k.name === name)) return `there's already a keyword named "${name}"`;
  return null;
}

/** Rename a keyword, and the Keyword nodes reading it. */
export function renameKeyword(graph: ShaderGraph, from: string, to: string): ShaderGraph {
  if (from === to || whyNotKeywordName(graph, from, to)) return graph;
  const g = clone(graph);
  const k = g.keywords?.find((q) => q.name === from);
  if (!k) return graph;
  k.name = to;
  for (const n of g.nodes) if (n.type === "keyword" && n.settings?.keyword === from) n.settings = { ...n.settings, keyword: to };
  return g;
}

/** Remove a keyword and the Keyword nodes reading it. */
export function removeKeyword(graph: ShaderGraph, name: string): ShaderGraph {
  const g = clone(graph);
  if (g.keywords) {
    g.keywords = g.keywords.filter((k) => k.name !== name);
    if (g.keywords.length === 0) delete g.keywords;
  }
  return removeNodes(g, g.nodes.filter((n) => n.type === "keyword" && n.settings?.keyword === name).map((n) => n.id));
}

/** Change a keyword's `values` (an enum, two or more; undefined for on/off) or `variants`; connections to ports that vanish go. */
export function setKeyword(graph: ShaderGraph, name: string, patch: { values?: string[] | null; variants?: ShaderKeyword["variants"] }): ShaderGraph {
  const g = clone(graph);
  const k = g.keywords?.find((q) => q.name === name);
  if (!k) return graph;
  if (patch.values !== undefined) {
    if (patch.values === null) delete k.values;
    else if (patch.values.length >= 2 && patch.values.every((v) => KEYWORD_NAME.test(v)) && new Set(patch.values).size === patch.values.length) k.values = [...patch.values];
    else return graph;
  }
  if (patch.variants !== undefined) {
    if (patch.variants === "all") k.variants = "all";
    else delete k.variants;
  }
  return dropInvalidEdges(g);
}

const CATEGORY_ORDER = { Input: 0, Math: 1, Vector: 2, Color: 3, Noise: 4, Lighting: 5, Sprite: 6, Output: 7 } as const;
/** Where a node category sorts in the node search. */
export const categoryRank = (category: keyof typeof CATEGORY_ORDER) => CATEGORY_ORDER[category];

/** The first input of a node type that an output of `type` can connect to, or null. */
export function firstInputFor(nodeType: string, type: ValueType, graph: ShaderGraph, settings?: Record<string, string>): string | null {
  const def = nodeDef(nodeType);
  if (!def) return null;
  const ports = nodePorts({ id: "_", type: nodeType, position: [0, 0], settings, function: nodeType === "customFunction" ? defaultFunction() : undefined }, graph);
  return ports.inputs.find((p) => canConnectTypes(type, p.type))?.id ?? null;
}

/** The first output of a node type that can connect to an input of `type`, or null. */
export function firstOutputFor(nodeType: string, type: ValueType | "dynamic", graph: ShaderGraph, settings?: Record<string, string>): string | null {
  const ports = nodePorts({ id: "_", type: nodeType, position: [0, 0], settings, function: nodeType === "customFunction" ? defaultFunction() : undefined }, graph);
  return ports.outputs.find((p) => canConnectTypes(p.type, type))?.id ?? null;
}

// --- the graph document: properties, groups, notes, copy and paste (ADR 0228, 0048) ---------------------

const CLIPBOARD_FORMAT = "myco.shadergraph.clipboard@1";

/** Nodes copied from a graph: the nodes, the connections between them, and the properties they read. */
export interface GraphClipboard {
  format: typeof CLIPBOARD_FORMAT;
  nodes: GraphNode[];
  edges: { from: string; to: string }[];
  properties: GraphProperty[];
  /** The keywords the copied Keyword nodes read. */
  keywords?: ShaderKeyword[];
}

/**
 * The Shader Graph's graph document edits. Its canvas items are its nodes; the output node can't be
 * removed, copied or duplicated. Groups and notes are left out of the file when there are none. A
 * copy takes the properties and keywords its nodes read, and a paste adds those the graph lacks
 * (`pasteProperties`: a same-named property of another type is added under a free name).
 */
export const shaderGraphEdits = graphDocument<ShaderGraph, GraphNode, GraphProperty, GraphClipboard>({
  items: (g) => g.nodes.map((n) => n.id),
  remove: removeNodes,
  newId: (g, of) => (of === "group" ? freeId("group", (id) => !!g.groups?.some((x) => x.id === id)) : freeId("note", (id) => !!g.notes?.some((x) => x.id === id))),
  groups: {
    get: (g) => (g.groups ?? []).map((gr) => ({ id: gr.id, title: gr.title, members: gr.nodes })),
    set(g, list) {
      if (list.length) g.groups = list.map((gr) => ({ id: gr.id, title: gr.title, nodes: gr.members }));
      else delete g.groups;
    },
  },
  notes: {
    get: (g) => g.notes ?? [],
    set(g, list) {
      if (list.length) g.notes = list;
      else delete g.notes;
    },
  },
  property: {
    label: (type) => TYPE_LABELS[type],
    create: (name, type) => ({ name, type, value: defaultPropertyValue(type) }),
    reads: (n, name) => n.type === "property" && n.settings?.property === name,
    retarget: (n, name) => void (n.settings = { ...n.settings, property: name }),
  },
  clipboard: {
    format: CLIPBOARD_FORMAT,
    copy(graph, ids) {
      const picked = new Set([...ids].filter((id) => graph.nodes.some((n) => n.id === id && n.type !== OUTPUT_NODE_TYPE)));
      if (picked.size === 0) return null;
      const nodes = graph.nodes.filter((n) => picked.has(n.id)).map((n) => structuredClone(n));
      const used = new Set(nodes.filter((n) => n.type === "property").map((n) => n.settings?.property));
      const usedKeywords = new Set(nodes.filter((n) => n.type === "keyword").map((n) => n.settings?.keyword));
      const keywords = (graph.keywords ?? []).filter((k) => usedKeywords.has(k.name)).map((k) => structuredClone(k));
      return {
        ...(keywords.length ? { keywords } : {}),
        nodes,
        edges: graph.edges.filter((e) => picked.has(splitPortRef(e.from).node) && picked.has(splitPortRef(e.to).node)).map((e) => ({ ...e })),
        properties: graph.properties.filter((p) => used.has(p.name)).map((p) => structuredClone(p)),
      };
    },
    // Well formed: read as a graph file's nodes, edges, properties and keywords would be, with no problems.
    read(raw) {
      if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return null;
      const { graph, problems } = parseShaderGraph({ format: SHADER_GRAPH_FORMAT, nodes: raw.nodes, edges: raw.edges ?? [], properties: raw.properties ?? [], keywords: raw.keywords });
      const nodes = graph.nodes.filter((n) => n.type !== OUTPUT_NODE_TYPE);
      if (problems.length || nodes.length !== raw.nodes.length) return null;
      return { format: CLIPBOARD_FORMAT, ...(graph.keywords?.length ? { keywords: graph.keywords } : {}), nodes, edges: graph.edges, properties: graph.properties };
    },
    positions: (clip) => clip.nodes.map((n) => n.position),
    paste(g, clip, by) {
      const renames = pasteProperties(g.properties, clip.properties);
      for (const k of clip.keywords ?? []) if (!g.keywords?.some((q) => q.name === k.name)) g.keywords = [...(g.keywords ?? []), structuredClone(k)];
      const map = new Map<string, string>();
      const taken = new Set<string>();
      for (const n of clip.nodes) {
        if (n.type === OUTPUT_NODE_TYPE) continue;
        const copy = structuredClone(n);
        copy.id = newNodeId(g, n.type, taken);
        taken.add(copy.id);
        copy.position = [Math.round(n.position[0] + by[0]), Math.round(n.position[1] + by[1])];
        const to = copy.type === "property" ? renames.get(String(copy.settings?.property)) : undefined;
        if (to !== undefined) copy.settings = { ...copy.settings, property: to };
        map.set(n.id, copy.id);
        g.nodes.push(copy);
      }
      for (const e of clip.edges) {
        const from = splitPortRef(e.from), to = splitPortRef(e.to);
        if (map.has(from.node) && map.has(to.node)) g.edges.push({ from: portRef(map.get(from.node)!, from.port), to: portRef(map.get(to.node)!, to.port) });
      }
      dropInvalidEdges(g);
      return [...map.values()];
    },
  },
});

// --- sub-graph outputs and custom functions -----------------------------------------------------------

/** A port name not in `names`: `Out`, `Out2`… */
/** `Out`, `Out2`…: a port name stays an identifier. */
const JOINED: Numbering = { format: (stem, n) => `${stem}${n}`, first: 2 };
export const freePortName = (names: readonly string[], base: string): string => uniqueName(base, names, JOINED);

/** Why `name` can't name a port among `others`, or null. */
export function whyNotPortName(name: string, others: readonly string[]): string | null {
  if (!isPortName(name)) return "a port name is letters, digits and _ (not starting with a digit, no __ or gl_)";
  if (others.includes(name)) return `there's already a port named "${name}"`;
  return null;
}

const outputNodeId = (g: ShaderGraph) => g.nodes.find((n) => n.type === OUTPUT_NODE_TYPE)?.id ?? "output";

/** Sub-graphs: add an output. */
export function addSubGraphOutput(graph: ShaderGraph, type: FunctionPort["type"] = "vec4"): ShaderGraph {
  if (!graph.subgraph) return graph;
  const g = clone(graph);
  g.subgraph!.outputs.push({ name: freePortName(g.subgraph!.outputs.map((o) => o.name), "Out"), type });
  return g;
}

/** Sub-graphs: rename an output, keeping what's connected to it. */
export function renameSubGraphOutput(graph: ShaderGraph, from: string, to: string): ShaderGraph {
  const outs = graph.subgraph?.outputs;
  if (!outs || from === to || !outs.some((o) => o.name === from) || whyNotPortName(to, outs.map((o) => o.name).filter((n) => n !== from))) return graph;
  const g = clone(graph);
  g.subgraph!.outputs.find((o) => o.name === from)!.name = to;
  const out = outputNodeId(g);
  for (const e of g.edges) if (e.to === portRef(out, from)) e.to = portRef(out, to);
  return g;
}

export function setSubGraphOutputType(graph: ShaderGraph, name: string, type: FunctionPort["type"]): ShaderGraph {
  const g = clone(graph);
  const o = g.subgraph?.outputs.find((x) => x.name === name);
  if (!o || o.type === type) return graph;
  o.type = type;
  return dropInvalidEdges(g);
}

export function removeSubGraphOutput(graph: ShaderGraph, name: string): ShaderGraph {
  if (!graph.subgraph?.outputs.some((o) => o.name === name)) return graph;
  const g = clone(graph);
  g.subgraph!.outputs = g.subgraph!.outputs.filter((o) => o.name !== name);
  return dropInvalidEdges(g);
}

/** A new Custom Function node's code. */
export const defaultFunction = (): CustomFunction => ({ name: "myFunction", inputs: [{ name: "In", type: "vec3" }], outputs: [{ name: "Out", type: "vec3" }], wgsl: "Out = In;" });

/**
 * Change a Custom Function node's code. `renamed` maps old port names to new ones (inputs and
 * outputs), so connections follow; connections to ports that no longer fit go.
 */
export function setFunction(graph: ShaderGraph, nodeId: string, fn: CustomFunction, renamed: Record<string, string> = {}): ShaderGraph {
  const g = clone(graph);
  const n = g.nodes.find((m) => m.id === nodeId);
  if (!n) return graph;
  n.function = structuredClone(fn);
  if (!n.function.wgsl?.trim()) delete n.function.wgsl; // an empty WGSL body removes the key
  for (const e of g.edges) {
    const from = splitPortRef(e.from), to = splitPortRef(e.to);
    if (from.node === nodeId && renamed[from.port]) e.from = portRef(nodeId, renamed[from.port]);
    if (to.node === nodeId && renamed[to.port]) e.to = portRef(nodeId, renamed[to.port]);
  }
  return dropInvalidEdges(g);
}

/** Show or collapse a node's preview. */
/** Set the shape one node's preview is drawn on, or `null` to follow the graph's default (ADR 0117). */
export function setNodePreviewShape(graph: ShaderGraph, nodeId: string, shape: NodePreviewShape | null): ShaderGraph {
  const g = clone(graph);
  const n = g.nodes.find((m) => m.id === nodeId);
  if (!n || n.previewShape === (shape ?? undefined)) return graph;
  if (shape) n.previewShape = shape;
  else delete n.previewShape;
  return g;
}

/** Set the graph's default node preview shape (quads are the default and aren't stored). */
export function setGraphPreviewShape(graph: ShaderGraph, shape: NodePreviewShape): ShaderGraph {
  if ((graph.previewShape ?? "quad") === shape) return graph;
  const g = clone(graph);
  if (shape === "quad") delete g.previewShape;
  else g.previewShape = shape;
  return g;
}

/** Set the mesh the main preview draws (spheres are the default and aren't stored). */
export function setGraphPreviewMesh(graph: ShaderGraph, mesh: GraphPreviewMesh): ShaderGraph {
  if ((graph.previewMesh ?? "sphere") === mesh) return graph;
  const g = clone(graph);
  if (mesh === "sphere") delete g.previewMesh;
  else g.previewMesh = mesh;
  return g;
}

export function setPreview(graph: ShaderGraph, nodeId: string, shown: boolean): ShaderGraph {
  const g = clone(graph);
  const n = g.nodes.find((m) => m.id === nodeId);
  if (!n || (n.preview !== false) === shown) return graph;
  if (shown) delete n.preview;
  else n.preview = false;
  return g;
}
