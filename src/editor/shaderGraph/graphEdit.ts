// Shader graph edits (ADR 0046): pure functions from one graph to the next, so the panel's undo
// history is a list of graphs and every rule here is unit-tested. None of them change their input.
import { canConnectTypes, nodeDef, nodePorts, type ValueType } from "../../engine/render/shaderGraph/nodes";
import {
  OUTPUT_NODE_TYPE,
  defaultPropertyValue,
  portRef,
  splitPortRef,
  type GraphNode,
  type GraphProperty,
  type GraphPropertyType,
  type GraphValue,
  type InputValue,
  type ShaderGraph,
} from "../../engine/scene/shaderGraph";

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

const CATEGORY_ORDER = { Input: 0, Math: 1, Vector: 2, Color: 3, Noise: 4, Lighting: 5, Output: 6 } as const;
/** Where a node category sorts in the node search. */
export const categoryRank = (category: keyof typeof CATEGORY_ORDER) => CATEGORY_ORDER[category];

/** The first input of a node type that an output of `type` can connect to, or null. */
export function firstInputFor(nodeType: string, type: ValueType, graph: ShaderGraph): string | null {
  const def = nodeDef(nodeType);
  if (!def) return null;
  const ports = nodePorts({ id: "_", type: nodeType, position: [0, 0] }, graph);
  return ports.inputs.find((p) => canConnectTypes(type, p.type))?.id ?? null;
}

/** The first output of a node type that can connect to an input of `type`, or null. */
export function firstOutputFor(nodeType: string, type: ValueType | "dynamic", graph: ShaderGraph, settings?: Record<string, string>): string | null {
  const ports = nodePorts({ id: "_", type: nodeType, position: [0, 0], settings }, graph);
  return ports.outputs.find((p) => canConnectTypes(p.type, type))?.id ?? null;
}
