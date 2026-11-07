// Shader graph edits (ADR 0046): pure functions from one graph to the next, so the panel's undo
// history is a list of graphs and every rule here is unit-tested. None of them change their input.
import { canConnectTypes, nodeDef, nodePorts, type ValueType } from "../../engine/render/shaderGraph/nodes";
import { parseGraphClipboard } from "../graph/clipboard";
import {
  OUTPUT_NODE_TYPE,
  defaultPropertyValue,
  portRef,
  splitPortRef,
  isPortName,
  type CustomFunction,
  type FunctionPort,
  type GraphNode,
  type GraphNote,
  type GraphProperty,
  type GraphPropertyType,
  type GraphValue,
  type InputValue,
  type NodePreviewShape,
  type ShaderGraph,
} from "../../engine/scene/shaderGraph";
import { KEYWORD_NAME, type ShaderKeyword } from "../../engine/scene/shaderKeywords";

const clone = (g: ShaderGraph): ShaderGraph => structuredClone(g);

/** A new node id for `type` that the graph doesn't use: `multiply1`, `multiply2`… */
export function newNodeId(graph: ShaderGraph, type: string, taken: ReadonlySet<string> = new Set()): string {
  const base = type.replace(/[^A-Za-z0-9_-]/g, "") || "node";
  for (let i = 1; ; i++) {
    const id = `${base}${i}`;
    if (!taken.has(id) && !graph.nodes.some((n) => n.id === id)) return id;
  }
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

/** Copies of nodes (not the output node), `offset` away, keeping the connections between them. */
export function duplicateNodes(graph: ShaderGraph, ids: Iterable<string>, offset: [number, number] = [30, 30]): { graph: ShaderGraph; ids: string[] } {
  const g = clone(graph);
  const map = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of ids) {
    const n = graph.nodes.find((m) => m.id === id);
    if (!n || n.type === OUTPUT_NODE_TYPE) continue;
    const copy: GraphNode = structuredClone(n);
    copy.id = newNodeId(graph, n.type, taken);
    taken.add(copy.id);
    copy.position = [n.position[0] + offset[0], n.position[1] + offset[1]];
    map.set(id, copy.id);
    g.nodes.push(copy);
  }
  for (const e of graph.edges) {
    const from = splitPortRef(e.from), to = splitPortRef(e.to);
    if (map.has(from.node) && map.has(to.node)) g.edges.push({ from: portRef(map.get(from.node)!, from.port), to: portRef(map.get(to.node)!, to.port) });
  }
  return { graph: g, ids: [...map.values()] };
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

/** A property name the graph doesn't use: `Color`, `Color 2`… */
export function freePropertyName(graph: ShaderGraph, base: string): string {
  if (!graph.properties.some((p) => p.name === base)) return base;
  for (let i = 2; ; i++) if (!graph.properties.some((p) => p.name === `${base} ${i}`)) return `${base} ${i}`;
}

/** Add a property of `type` with its default value. */
export function addProperty(graph: ShaderGraph, type: GraphPropertyType): { graph: ShaderGraph; name: string } {
  const name = freePropertyName(graph, TYPE_LABELS[type]);
  const g = clone(graph);
  g.properties.push({ name, type, value: defaultPropertyValue(type) });
  return { graph: g, name };
}

/** Why a property can't be renamed to `name`, or null. */
export function whyNotPropertyName(graph: ShaderGraph, from: string, name: string): string | null {
  if (!name.trim()) return "a property needs a name";
  if (name !== name.trim()) return "a name can't start or end with a space";
  if (name !== from && graph.properties.some((p) => p.name === name)) return `there's already a property named "${name}"`;
  return null;
}

/** Rename a property, and the property nodes reading it. */
export function renameProperty(graph: ShaderGraph, from: string, to: string): ShaderGraph {
  if (from === to || whyNotPropertyName(graph, from, to)) return graph;
  const g = clone(graph);
  const p = g.properties.find((q) => q.name === from);
  if (!p) return graph;
  p.name = to;
  for (const n of g.nodes) if (n.type === "property" && n.settings?.property === from) n.settings = { ...n.settings, property: to };
  return g;
}

/** Remove a property and the property nodes reading it. */
export function removeProperty(graph: ShaderGraph, name: string): ShaderGraph {
  const g = clone(graph);
  g.properties = g.properties.filter((p) => p.name !== name);
  return removeNodes(g, g.nodes.filter((n) => n.type === "property" && n.settings?.property === name).map((n) => n.id));
}

/** Set a property's default value. */
export function setPropertyValue(graph: ShaderGraph, name: string, value: GraphValue): ShaderGraph {
  const g = clone(graph);
  const p = g.properties.find((q) => q.name === name);
  if (!p) return graph;
  p.value = Array.isArray(value) ? [...value] : value;
  return g;
}

/** Change a property's type (its value goes back to the type's default). */
export function setPropertyType(graph: ShaderGraph, name: string, type: GraphPropertyType): ShaderGraph {
  const g = clone(graph);
  const p: GraphProperty | undefined = g.properties.find((q) => q.name === name);
  if (!p || p.type === type) return graph;
  p.type = type;
  p.value = defaultPropertyValue(type);
  return dropInvalidEdges(g);
}

/** Move a property up or down the Blackboard. */
export function moveProperty(graph: ShaderGraph, name: string, delta: -1 | 1): ShaderGraph {
  const i = graph.properties.findIndex((p) => p.name === name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= graph.properties.length) return graph;
  const g = clone(graph);
  [g.properties[i], g.properties[j]] = [g.properties[j], g.properties[i]];
  return g;
}

// --- keywords (ADR 0106) ----------------------------------------------------------------------------

/** A keyword name the graph doesn't use: `KEYWORD`, `KEYWORD_2`… */
export function freeKeywordName(graph: ShaderGraph, base = "KEYWORD"): string {
  const taken = (n: string) => (graph.keywords ?? []).some((k) => k.name === n);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
}

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

const CATEGORY_ORDER = { Input: 0, Math: 1, Vector: 2, Color: 3, Noise: 4, Lighting: 5, Output: 6 } as const;
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

// --- copy and paste (ADR 0048) ----------------------------------------------------------------------

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

/** Copy nodes (not the output node) with the connections between them and the properties they read. */
export function copyNodes(graph: ShaderGraph, ids: Iterable<string>): GraphClipboard | null {
  const picked = new Set([...ids].filter((id) => graph.nodes.some((n) => n.id === id && n.type !== OUTPUT_NODE_TYPE)));
  if (picked.size === 0) return null;
  const nodes = graph.nodes.filter((n) => picked.has(n.id)).map((n) => structuredClone(n));
  const used = new Set(nodes.filter((n) => n.type === "property").map((n) => n.settings?.property));
  const usedKeywords = new Set(nodes.filter((n) => n.type === "keyword").map((n) => n.settings?.keyword));
  const keywords = (graph.keywords ?? []).filter((k) => usedKeywords.has(k.name)).map((k) => structuredClone(k));
  return {
    format: CLIPBOARD_FORMAT,
    ...(keywords.length ? { keywords } : {}),
    nodes,
    edges: graph.edges.filter((e) => picked.has(splitPortRef(e.from).node) && picked.has(splitPortRef(e.to).node)).map((e) => ({ ...e })),
    properties: graph.properties.filter((p) => used.has(p.name)).map((p) => structuredClone(p)),
  };
}

/** Read a clipboard from text (the system clipboard), or null if it isn't one. */
export function parseClipboard(text: string): GraphClipboard | null {
  return parseGraphClipboard<GraphClipboard>(text, CLIPBOARD_FORMAT, (v) => Array.isArray(v.nodes) && Array.isArray(v.edges));
}

/**
 * Paste copied nodes with new ids, their top-left corner at `at`, keeping their connections;
 * properties they read that the graph lacks are added.
 */
export function pasteNodes(graph: ShaderGraph, clip: GraphClipboard, at: [number, number]): { graph: ShaderGraph; ids: string[] } {
  const g = clone(graph);
  for (const p of clip.properties ?? []) if (!g.properties.some((q) => q.name === p.name)) g.properties.push(structuredClone(p));
  for (const k of clip.keywords ?? []) if (!g.keywords?.some((q) => q.name === k.name)) g.keywords = [...(g.keywords ?? []), structuredClone(k)];
  const x0 = Math.min(...clip.nodes.map((n) => n.position[0])), y0 = Math.min(...clip.nodes.map((n) => n.position[1]));
  const map = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of clip.nodes) {
    if (n.type === OUTPUT_NODE_TYPE) continue;
    const copy = structuredClone(n);
    copy.id = newNodeId(g, n.type, taken);
    taken.add(copy.id);
    copy.position = [Math.round(at[0] + n.position[0] - x0), Math.round(at[1] + n.position[1] - y0)];
    map.set(n.id, copy.id);
    g.nodes.push(copy);
  }
  for (const e of clip.edges) {
    const from = splitPortRef(e.from), to = splitPortRef(e.to);
    if (map.has(from.node) && map.has(to.node)) g.edges.push({ from: portRef(map.get(from.node)!, from.port), to: portRef(map.get(to.node)!, to.port) });
  }
  return { graph: dropInvalidEdges(g), ids: [...map.values()] };
}

// --- groups and notes -------------------------------------------------------------------------------

const newId = (prefix: string, taken: readonly { id: string }[]) => {
  for (let i = 1; ; i++) if (!taken.some((t) => t.id === `${prefix}${i}`)) return `${prefix}${i}`;
};

/** Put nodes in a new group (taking them out of any other). */
export function groupNodes(graph: ShaderGraph, ids: Iterable<string>, title = "Group"): { graph: ShaderGraph; id: string | null } {
  const members = [...ids].filter((id) => graph.nodes.some((n) => n.id === id));
  if (members.length === 0) return { graph, id: null };
  const g = clone(graph);
  const groups = (g.groups ?? []).map((gr) => ({ ...gr, nodes: gr.nodes.filter((id) => !members.includes(id)) })).filter((gr) => gr.nodes.length > 0);
  const id = newId("group", graph.groups ?? []);
  groups.push({ id, title, nodes: members });
  g.groups = groups;
  return { graph: g, id };
}

/** Remove a group (its nodes stay). */
export function ungroup(graph: ShaderGraph, id: string): ShaderGraph {
  if (!graph.groups?.some((gr) => gr.id === id)) return graph;
  const g = clone(graph);
  g.groups = g.groups!.filter((gr) => gr.id !== id);
  if (g.groups.length === 0) delete g.groups;
  return g;
}

export function setGroupTitle(graph: ShaderGraph, id: string, title: string): ShaderGraph {
  const g = clone(graph);
  const gr = g.groups?.find((x) => x.id === id);
  if (!gr || gr.title === title) return graph;
  gr.title = title;
  return g;
}

/** Add a sticky note at `position`. */
export function addNote(graph: ShaderGraph, position: [number, number], text = ""): { graph: ShaderGraph; id: string } {
  const g = clone(graph);
  const id = newId("note", graph.notes ?? []);
  (g.notes ??= []).push({ id, position: [Math.round(position[0]), Math.round(position[1])], size: [200, 100], text });
  return { graph: g, id };
}

/** Change a note's text, position or size. */
export function updateNote(graph: ShaderGraph, id: string, patch: Partial<Omit<GraphNote, "id">>): ShaderGraph {
  const g = clone(graph);
  const n = g.notes?.find((x) => x.id === id);
  if (!n) return graph;
  if (patch.text !== undefined) n.text = patch.text;
  if (patch.position) n.position = [Math.round(patch.position[0]), Math.round(patch.position[1])];
  if (patch.size) n.size = [Math.max(80, Math.round(patch.size[0])), Math.max(40, Math.round(patch.size[1]))];
  return JSON.stringify(n) === JSON.stringify(graph.notes!.find((x) => x.id === id)) ? graph : g;
}

export function removeNote(graph: ShaderGraph, id: string): ShaderGraph {
  if (!graph.notes?.some((n) => n.id === id)) return graph;
  const g = clone(graph);
  g.notes = g.notes!.filter((n) => n.id !== id);
  if (g.notes.length === 0) delete g.notes;
  return g;
}

// --- sub-graph outputs and custom functions -----------------------------------------------------------

/** A port name not in `names`: `Out`, `Out2`… */
export function freePortName(names: readonly string[], base: string): string {
  if (!names.includes(base)) return base;
  for (let i = 2; ; i++) if (!names.includes(`${base}${i}`)) return `${base}${i}`;
}

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
  if (!outs || from === to || whyNotPortName(to, outs.map((o) => o.name).filter((n) => n !== from))) return graph;
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

export function setPreview(graph: ShaderGraph, nodeId: string, shown: boolean): ShaderGraph {
  const g = clone(graph);
  const n = g.nodes.find((m) => m.id === nodeId);
  if (!n || (n.preview !== false) === shown) return graph;
  if (shown) delete n.preview;
  else n.preview = false;
  return g;
}
