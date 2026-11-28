// The pose-node edits of the animation graph editor (ADR 0373 "Animation graph editor"; D99's source model): add,
// remove, connect, disconnect, move, rename and set a node's typed parameters from the node catalogue's schema (ADR 0372
// "One node catalogue", `graphNodes/`), the output, slots, linked graphs, chooser tables and layers. Each is a pure
// function from one `AnimGraph` to the next, refused-or-next where a user can get it refused (ADR 0307, 0313): a type
// mismatch (a bool parameter bound to a float field, a value outside the schema's range), a cycle, a duplicate name, an
// input past the kind's count. The panel applies them with `applyToDocument` as one labelled undo step each.
//
// Pins: every node has one pose output (`<id>.out`) and the inputs its kind declares (`<id>.in<i>`); inputs are a dense
// list, so a fixed input can be wired once the ones before it are, and a variadic kind (blend-space samples, random
// choices) shows one free pin after its wired ones.
import {
  GRAPH_FAMILIES, GRAPH_LIMITS, LAYER_MODES,
  type AnimGraph, type ChooserTable, type Condition, type GraphFamily, type GraphLayer, type GraphNode, type GraphParamType, type LayerMode, type NodeParamValue, type StateMachine,
} from "../../../../engine/animation/animGraph";
import { NODE_CATALOGUE, nodeKindSchema, type AssetRefKind, type NodeKindSchema, type NodeParamSchema } from "../../../../engine/animation/graphNodes";
import { accept, refuse, type EditResult, assetRefTarget } from "../../../../editor/sdk";
import { uniqueName, type Numbering } from "../../../../engine/core/uniqueName";

/** `walk`, `walk2`, `walk3`…: node ids, slot and linked names (no spaces, so they stay valid names). */
export const JOINED: Numbering = { format: (stem, n) => `${stem}${n}`, first: 2 };

/** A node's output pin. */
export const OUT = "out";
/** Input pin `i`'s id. */
export const inPin = (i: number) => `in${i}`;
/** An input pin's index, or -1. */
export const pinIndex = (pin: string) => (/^in\d+$/.test(pin) ? Number(pin.slice(2)) : -1);

/** What an add made. */
export interface Added {
  readonly graph: AnimGraph;
  readonly id: string;
}

export const nodeById = (graph: AnimGraph, id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);

/** A node's catalogue schema (its family and kind's). */
export const schemaOf = (node: Pick<GraphNode, "family" | "kind">): NodeKindSchema | undefined => nodeKindSchema(node.family, node.kind);

/** A kind's label, from its name ("blendSpace1D" → "Blend Space 1D"). */
export function kindLabel(kind: string): string {
  const spaced = kind.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/(\d)([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A node's title: its debug name, else its kind's label. */
export const nodeTitle = (node: GraphNode): string => node.name || kindLabel(node.kind);

/** The family labels, for the node search's groups. */
export const FAMILY_LABELS: Readonly<Record<GraphFamily, string>> = {
  sources: "Sources", logic: "Logic", mixing: "Mixing", slots: "Slots and linked graphs", sync: "Sync",
  rig: "Rig", retarget: "Retarget", matching: "Matching", physics: "Physics", plugin: "Third-party",
};

/** Every kind the catalogue declares, for the node search: family, kind, label and doc. */
export function catalogueEntries(): { family: GraphFamily; kind: string; label: string; doc: string }[] {
  return NODE_CATALOGUE.flatMap((f) => f.kinds.map((k) => ({ family: f.family, kind: k.kind, label: kindLabel(k.kind), doc: k.doc })));
}

/** The pins a node shows: its inputs' ids and labels (a variadic kind's next free pin included). */
export function inputPins(node: GraphNode): { id: string; label: string; wired: string | null }[] {
  const s = schemaOf(node);
  if (!s) return node.inputs.map((x, i) => ({ id: inPin(i), label: `input ${i + 1}`, wired: x }));
  const { min, max, names } = s.inputs;
  const variadic = max > names.length;
  const count = variadic ? Math.min(max, node.inputs.length + 1) : max;
  void min;
  return Array.from({ length: count }, (_, i) => ({
    id: inPin(i),
    label: variadic ? `${names[0] ?? "input"} ${i + 1}` : (names[i] ?? `input ${i + 1}`),
    wired: node.inputs[i] ?? null,
  }));
}

/** The nodes `id` evaluates directly: its inputs, its machine's state roots and bridges, its chooser's results. */
export function dependencies(node: GraphNode): string[] {
  const out = [...node.inputs];
  if (node.machine) {
    for (const s of node.machine.states) {
      if (s.root) out.push(s.root);
      for (const t of s.transitions) if (t.bridge) out.push(t.bridge);
    }
    for (const t of node.machine.anyState) if (t.bridge) out.push(t.bridge);
  }
  if (node.chooser) {
    for (const r of node.chooser.rows) out.push(r.result);
    if (node.chooser.fallback) out.push(node.chooser.fallback);
  }
  return out;
}

/** Whether `from` evaluates `target` (directly or below), so making `target` evaluate `from` would close a cycle. */
export function reaches(graph: AnimGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodeById(graph, id);
    if (n) stack.push(...dependencies(n));
  }
  return false;
}

/** The nodes evaluated under `root` (it included), in the graph's order: a state's sub-graph. */
export function subGraph(graph: AnimGraph, root: string | null): Set<string> {
  const out = new Set<string>();
  if (!root) return out;
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const n = nodeById(graph, id);
    if (!n) continue;
    out.add(id);
    // A machine's states are its own canvases: its sub-graph stops at it.
    stack.push(...(n.machine ? [] : dependencies(n)));
  }
  return out;
}

const withNodes = (graph: AnimGraph, nodes: GraphNode[]): AnimGraph => ({ ...graph, nodes });
const mapNode = (graph: AnimGraph, id: string, f: (n: GraphNode) => GraphNode): AnimGraph => withNodes(graph, graph.nodes.map((n) => (n.id === id ? f(n) : n)));

const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A new node's side table (a kind that has one). */
function sideTable(graph: AnimGraph, kind: string, id: string): Partial<GraphNode> {
  switch (kind) {
    case "stateMachine": return { machine: { entry: null, states: [], anyState: [] } };
    case "chooser": return { chooser: { rows: [], fallback: null } };
    case "slot": return { slot: { name: uniqueName("Slot", graph.nodes.flatMap((n) => (n.slot ? [n.slot.name] : [])), JOINED), group: null } };
    case "linked": return { linked: { name: uniqueName("Linked", graph.nodes.flatMap((n) => (n.linked ? [n.linked.name] : [])), JOINED), graph: null } };
    default: void id; return {};
  }
}

/** A node id free in `graph`, after the kind (`clipPlayer`, `clipPlayer2`…). */
export const freeNodeId = (graph: AnimGraph, base: string): string => uniqueName(base, graph.nodes.map((n) => n.id), JOINED);

/**
 * Add a node of `family`/`kind` at `position`, with `params` (checked against its schema) and its side table. The first
 * node of an empty graph becomes the output.
 */
export function addNode(graph: AnimGraph, family: GraphFamily, kind: string, position: readonly [number, number], params: Readonly<Record<string, NodeParamValue>> = {}): EditResult<Added> {
  const schema = nodeKindSchema(family, kind);
  if (!schema) return refuse(`"${kind}" isn't a ${family} node`);
  if (graph.nodes.length >= GRAPH_LIMITS.nodes) return refuse(`a graph has at most ${GRAPH_LIMITS.nodes} nodes`);
  const id = freeNodeId(graph, kind);
  let node: GraphNode = { id, family, kind, name: "", position: [Math.round(position[0]), Math.round(position[1])], inputs: [], params: {}, ...sideTable(graph, kind, id) };
  for (const [k, v] of Object.entries(params)) {
    const why = whyNotParam(graph, schema, k, v);
    if (why) return refuse(why);
    node = { ...node, params: { ...node.params, [k]: v } };
  }
  return accept({ graph: { ...withNodes(graph, [...graph.nodes, node]), output: graph.output ?? id }, id });
}

/** `graph` without the nodes `ids` and every reference to them (inputs, state roots, bridges, chooser rows, layers, the output). */
export function removeNodes(graph: AnimGraph, ids: Iterable<string>): AnimGraph {
  const gone = new Set(ids);
  const present = graph.nodes.filter((n) => gone.has(n.id));
  if (present.length === 0) return graph;
  const nodes = graph.nodes.filter((n) => !gone.has(n.id)).map((n) => dropReferences(n, gone));
  return {
    ...graph,
    nodes,
    output: graph.output && gone.has(graph.output) ? null : graph.output,
    layers: graph.layers.filter((l) => !gone.has(l.root)),
  };
}

function dropReferences(n: GraphNode, gone: ReadonlySet<string>): GraphNode {
  let out = n;
  if (n.inputs.some((x) => gone.has(x))) {
    const keep = n.inputs.map((x) => !gone.has(x));
    out = { ...out, inputs: n.inputs.filter((_, i) => keep[i]), params: blendCoordsKept(n, keep) };
  }
  if (n.machine) {
    const m = n.machine;
    const fix = <T extends { bridge: string | null; how: string }>(t: T): T => (t.bridge && gone.has(t.bridge) ? { ...t, bridge: null, how: "crossfade" } : t);
    out = { ...out, machine: { ...m, states: m.states.map((s) => ({ ...s, root: s.root && gone.has(s.root) ? null : s.root, transitions: s.transitions.map(fix) })), anyState: m.anyState.map(fix) } };
  }
  if (n.chooser) {
    const c = n.chooser;
    out = { ...out, chooser: { rows: c.rows.filter((r) => !gone.has(r.result)), fallback: c.fallback && gone.has(c.fallback) ? null : c.fallback } };
  }
  return out;
}

/** Blend-space dims (1 or 2), or 0 for other kinds. */
export const blendDims = (n: Pick<GraphNode, "family" | "kind">): 0 | 1 | 2 => (n.family !== "sources" ? 0 : n.kind === "blendSpace1D" ? 1 : n.kind === "blendSpace2D" ? 2 : 0);

/** A blend space's params with the coordinates of the inputs not kept dropped (others unchanged). */
function blendCoordsKept(n: GraphNode, keep: readonly boolean[]): GraphNode["params"] {
  const dims = blendDims(n);
  const coords = n.params.coords;
  if (!dims || !Array.isArray(coords)) return n.params;
  const next = (coords as readonly number[]).filter((_, k) => keep[Math.floor(k / dims)] !== false);
  return { ...n.params, coords: next };
}

/** Why `from`'s output can't feed input `index` of `to`, or null. */
export function whyNotConnect(graph: AnimGraph, from: string, to: string, index: number): string | null {
  const src = nodeById(graph, from), dst = nodeById(graph, to);
  if (!src || !dst) return "that node isn't in the graph";
  if (from === to) return "a node can't be its own input";
  const s = schemaOf(dst);
  const max = s?.inputs.max ?? GRAPH_LIMITS.inputs;
  if (max === 0) return `a ${kindLabel(dst.kind)} node has no inputs`;
  if (index >= max) return `a ${kindLabel(dst.kind)} node has at most ${max} input${max === 1 ? "" : "s"}`;
  if (index > dst.inputs.length) return `wire ${s?.inputs.names[dst.inputs.length] ?? `input ${dst.inputs.length + 1}`} first (inputs fill in order)`;
  if (reaches(graph, from, to)) return `that would make a cycle: ${nodeTitle(src)} already evaluates ${nodeTitle(dst)}`;
  return null;
}

/** Wire `from`'s output into input `index` of `to` (replacing what it had, or appending the next one). A blend space gets the new sample's coordinates (0). */
export function connect(graph: AnimGraph, from: string, to: string, index: number): EditResult<AnimGraph> {
  const why = whyNotConnect(graph, from, to, index);
  if (why) return refuse(why);
  const dst = nodeById(graph, to)!;
  if (dst.inputs[index] === from) return accept(graph);
  const inputs = [...dst.inputs];
  const appended = index === inputs.length;
  inputs[index] = from;
  let params = dst.params;
  const dims = blendDims(dst);
  if (appended && dims) {
    const coords = Array.isArray(params.coords) ? [...(params.coords as readonly number[])] : [];
    while (coords.length < dims * index) coords.push(0);
    coords.length = dims * index;
    params = { ...params, coords: [...coords, ...Array(dims).fill(0)] };
  }
  return accept(mapNode(graph, to, (n) => ({ ...n, inputs, params })));
}

/** Remove input `index` of `to` (the later ones move up, with a blend space's coordinates). */
export function disconnect(graph: AnimGraph, to: string, index: number): AnimGraph {
  const dst = nodeById(graph, to);
  if (!dst || index >= dst.inputs.length) return graph;
  const keep = dst.inputs.map((_, i) => i !== index);
  return mapNode(graph, to, (n) => ({ ...n, inputs: n.inputs.filter((_, i) => keep[i]), params: blendCoordsKept(n, keep) }));
}

/** Nodes moved to these positions (whole units). Unknown ids are skipped. */
export function moveNodes(graph: AnimGraph, to: ReadonlyMap<string, { x: number; y: number }>): AnimGraph {
  if (![...to.keys()].some((id) => nodeById(graph, id))) return graph;
  return withNodes(graph, graph.nodes.map((n) => {
    const p = to.get(n.id);
    return p ? { ...n, position: [Math.round(p.x), Math.round(p.y)] as const } : n;
  }));
}

/** A node's debug name. */
export function setNodeName(graph: AnimGraph, id: string, name: string): EditResult<AnimGraph> {
  const n = nodeById(graph, id);
  if (!n) return refuse("that node isn't in the graph");
  return accept(n.name === name.trim() ? graph : mapNode(graph, id, (x) => ({ ...x, name: name.trim() })));
}

/** Rename a node's id, and every reference to it. Empty, malformed and taken ids are refused. */
export function renameNode(graph: AnimGraph, from: string, to: string): EditResult<AnimGraph> {
  const id = to.trim();
  if (!nodeById(graph, from)) return refuse("that node isn't in the graph");
  if (id === from) return accept(graph);
  if (!ID.test(id)) return refuse("a node id is letters, digits and _, not starting with a digit");
  if (nodeById(graph, id)) return refuse(`another node is named "${id}"`);
  const r = (x: string) => (x === from ? id : x);
  const rn = (x: string | null) => (x === from ? id : x);
  const nodes = graph.nodes.map((n): GraphNode => {
    let out: GraphNode = { ...n, id: r(n.id), inputs: n.inputs.map(r) };
    if (n.machine) {
      const fix = <T extends { bridge: string | null }>(t: T): T => ({ ...t, bridge: rn(t.bridge) });
      out = { ...out, machine: { ...n.machine, states: n.machine.states.map((s) => ({ ...s, root: rn(s.root), transitions: s.transitions.map(fix) })), anyState: n.machine.anyState.map(fix) } };
    }
    if (n.chooser) out = { ...out, chooser: { rows: n.chooser.rows.map((row) => ({ ...row, result: r(row.result) })), fallback: rn(n.chooser.fallback) } };
    return out;
  });
  return accept({ ...graph, nodes, output: rn(graph.output), layers: graph.layers.map((l) => ({ ...l, root: r(l.root) })) });
}

/** The graph's output node (null: none). */
export function setOutput(graph: AnimGraph, id: string | null): EditResult<AnimGraph> {
  if (id !== null && !nodeById(graph, id)) return refuse("that node isn't in the graph");
  return accept(graph.output === id ? graph : { ...graph, output: id });
}

// --- typed parameters -----------------------------------------------------------------------------------------------

/** The field kinds (ADR 0143) an asset parameter's picker offers. */
export const ASSET_FIELD_KINDS: Readonly<Record<AssetRefKind, readonly string[]>> = {
  clip: ["animclip"], mask: ["avatarmask"], graph: ["animgraph"], posedb: ["posedb"], retargetMap: [], plugin: [],
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const paramType = (graph: AnimGraph, name: string): GraphParamType | undefined => graph.parameters.find((p) => p.name === name)?.type;

/** Why the graph parameter `name` can't be bound where `types` are taken, or null. */
function whyNotBinding(graph: AnimGraph, field: string, name: string, types: readonly GraphParamType[] | undefined): string | null {
  const t = paramType(graph, name);
  if (!t) return `there's no parameter named "${name}"`;
  if (types && !types.includes(t)) return `type mismatch: ${field} takes a ${types.join(" or ")} parameter; ${name} is ${t}`;
  return null;
}

/** Why `value` can't be node parameter `name` of a node of `schema` in `graph`, or null. */
export function whyNotParam(graph: AnimGraph, schema: NodeKindSchema, name: string, value: NodeParamValue): string | null {
  const s = schema.params.find((p) => p.name === name);
  if (!s) return `a ${kindLabel(schema.kind)} node has no parameter "${name}"`;
  return whyNotValue(graph, s, value);
}

function whyNotValue(graph: AnimGraph, s: NodeParamSchema, value: NodeParamValue): string | null {
  const range = (v: number): string | null => {
    if (s.min !== undefined && v < s.min) return `${s.name} is at least ${s.min}`;
    if (s.max !== undefined && v > s.max) return `${s.name} is at most ${s.max}`;
    return null;
  };
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const strings = (v: NodeParamValue): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  switch (s.kind) {
    case "float":
      if (typeof value === "string" && s.animatable) return whyNotBinding(graph, s.name, value, s.parameterTypes);
      if (!num(value)) return `type mismatch: ${s.name} takes a number${s.animatable ? " or a float parameter" : ""}`;
      return range(value);
    case "int":
      if (!num(value) || !Number.isInteger(value)) return `type mismatch: ${s.name} takes a whole number`;
      return range(value);
    case "bool": return typeof value === "boolean" ? null : `type mismatch: ${s.name} is true or false`;
    case "enum": return typeof value === "string" && s.choices!.includes(value) ? null : `${s.name} is one of ${s.choices!.join(", ")}`;
    case "vec2": case "vec3": case "quat": {
      const n = s.kind === "vec2" ? 2 : s.kind === "vec3" ? 3 : 4;
      return Array.isArray(value) && value.length === n && value.every(num) ? null : `type mismatch: ${s.name} takes ${n} numbers`;
    }
    case "parameter": return typeof value === "string" ? whyNotBinding(graph, s.name, value, s.parameterTypes) : `type mismatch: ${s.name} takes a parameter's name`;
    case "asset": return typeof value === "string" && value.startsWith("asset:") ? null : `${s.name} takes an asset`;
    case "name": case "bone": case "target": return typeof value === "string" && value.trim() !== "" ? null : `${s.name} takes a name`;
    case "floatList": case "intList": {
      if (!Array.isArray(value) || !value.every(num)) return `type mismatch: ${s.name} is a list of numbers`;
      if (s.kind === "intList" && !(value as number[]).every(Number.isInteger)) return `type mismatch: ${s.name} is a list of whole numbers`;
      for (const v of value as number[]) { const why = range(v); if (why) return why; }
      return listLength(s, value.length);
    }
    case "parameterList": {
      if (!strings(value)) return `type mismatch: ${s.name} is a list of parameter names`;
      for (const v of value) { const why = whyNotBinding(graph, s.name, v, s.parameterTypes); if (why) return why; }
      return listLength(s, value.length);
    }
    default:
      if (!strings(value) && !(Array.isArray(value) && value.every((x) => typeof x === "string" || num(x)))) return `type mismatch: ${s.name} is a list of names`;
      return listLength(s, (value as readonly unknown[]).length);
  }
}

function listLength(s: NodeParamSchema, n: number): string | null {
  if (s.maxItems !== undefined && n > s.maxItems) return `${s.name} has at most ${s.maxItems} entries`;
  return null;
}

/**
 * Node `id`'s parameter `name` set to `value` (checked against its schema: kind, range, bound parameter's type), or back
 * to its default with `undefined` (a value equal to the default is left out, as the file writes it).
 */
export function setNodeParam(graph: AnimGraph, id: string, name: string, value: NodeParamValue | undefined): EditResult<AnimGraph> {
  const n = nodeById(graph, id);
  if (!n) return refuse("that node isn't in the graph");
  const schema = schemaOf(n);
  if (!schema) return refuse(`"${n.kind}" has no schema`);
  const s = schema.params.find((p) => p.name === name);
  if (!s && value !== undefined) return refuse(`a ${kindLabel(n.kind)} node has no parameter "${name}"`);
  if (value !== undefined && !(s && s.default !== null && sameValue(value, s.default))) {
    const why = whyNotValue(graph, s!, value);
    if (why) return refuse(why);
    if (sameValue(n.params[name], value)) return accept(graph);
    return accept(mapNode(graph, id, (x) => ({ ...x, params: { ...x.params, [name]: value } })));
  }
  if (!(name in n.params)) return accept(graph);
  return accept(mapNode(graph, id, (x) => {
    const params = { ...x.params };
    delete params[name];
    return { ...x, params };
  }));
}

// --- slots, linked graphs and choosers ------------------------------------------------------------------------------

/** A slot node's name (unique among slots) and group. */
export function setSlot(graph: AnimGraph, id: string, patch: { name?: string; group?: string | null }): EditResult<AnimGraph> {
  const n = nodeById(graph, id);
  if (!n?.slot) return refuse("that node isn't a slot");
  const name = patch.name?.trim() ?? n.slot.name;
  if (name === "") return refuse("a slot needs a name");
  if (graph.nodes.some((m) => m.id !== id && m.slot?.name === name)) return refuse(`another slot is named "${name}"`);
  const group = patch.group === undefined ? n.slot.group : patch.group?.trim() || null;
  return accept(mapNode(graph, id, (x) => ({ ...x, slot: { name, group } })));
}

/** A linked-graph node's name (unique among linked nodes) and default graph (not the graph being edited). */
export function setLinked(graph: AnimGraph, id: string, patch: { name?: string; graph?: string | null }, self?: string): EditResult<AnimGraph> {
  const n = nodeById(graph, id);
  if (!n?.linked) return refuse("that node isn't a linked graph");
  const name = patch.name?.trim() ?? n.linked.name;
  if (name === "") return refuse("a linked graph needs a name");
  if (graph.nodes.some((m) => m.id !== id && m.linked?.name === name)) return refuse(`another linked graph is named "${name}"`);
  const ref = patch.graph === undefined ? n.linked.graph : patch.graph || null;
  if (ref && self && assetRefTarget(ref) === self) return refuse("a graph can't link itself (that would be a cycle)");
  return accept(mapNode(graph, id, (x) => ({ ...x, linked: { name, graph: ref } })));
}

const withChooser = (graph: AnimGraph, id: string, f: (c: ChooserTable) => EditResult<ChooserTable>): EditResult<AnimGraph> => {
  const n = nodeById(graph, id);
  if (!n?.chooser) return refuse("that node isn't a chooser");
  const r = f(n.chooser);
  if ("refused" in r) return r;
  return accept(r.next === n.chooser ? graph : mapNode(graph, id, (x) => ({ ...x, chooser: r.next })));
};

const whyNotResult = (graph: AnimGraph, chooser: string, result: string): string | null => {
  if (!nodeById(graph, result)) return "that node isn't in the graph";
  if (result === chooser) return "a chooser can't pick itself";
  if (reaches(graph, result, chooser)) return "that would make a cycle";
  return null;
};

/** A chooser row picking `result` when `condition` holds, appended. */
export function addChooserRow(graph: AnimGraph, id: string, result: string, condition: Condition): EditResult<AnimGraph> {
  const why = whyNotResult(graph, id, result);
  if (why) return refuse(why);
  return withChooser(graph, id, (c) => (c.rows.length >= GRAPH_LIMITS.chooserRows ? refuse(`a chooser has at most ${GRAPH_LIMITS.chooserRows} rows`) : accept({ ...c, rows: [...c.rows, { if: condition, result }] })));
}

export const removeChooserRow = (graph: AnimGraph, id: string, row: number) =>
  withChooser(graph, id, (c) => (c.rows[row] ? accept({ ...c, rows: c.rows.filter((_, i) => i !== row) }) : refuse("there's no such row")));

/** Move chooser row `row` to `to` (rows are tried in order). */
export const moveChooserRow = (graph: AnimGraph, id: string, row: number, to: number) =>
  withChooser(graph, id, (c) => {
    if (!c.rows[row] || to < 0 || to >= c.rows.length) return refuse("there's no such row");
    if (row === to) return accept(c);
    const rows = [...c.rows];
    const [moved] = rows.splice(row, 1);
    rows.splice(to, 0, moved!);
    return accept({ ...c, rows });
  });

export const setChooserResult = (graph: AnimGraph, id: string, row: number, result: string) => {
  const why = whyNotResult(graph, id, result);
  return why ? refuse(why) : withChooser(graph, id, (c) => (c.rows[row] ? accept({ ...c, rows: c.rows.map((r, i) => (i === row ? { ...r, result } : r)) }) : refuse("there's no such row")));
};

/** A row's condition; a row needs one. */
export const setChooserCondition = (graph: AnimGraph, id: string, row: number, condition: Condition | null) =>
  condition === null ? refuse("a chooser row needs a condition") : withChooser(graph, id, (c) => (c.rows[row] ? accept({ ...c, rows: c.rows.map((r, i) => (i === row ? { ...r, if: condition } : r)) }) : refuse("there's no such row")));

export const setChooserFallback = (graph: AnimGraph, id: string, fallback: string | null) => {
  const why = fallback === null ? null : whyNotResult(graph, id, fallback);
  return why ? refuse(why) : withChooser(graph, id, (c) => accept(c.fallback === fallback ? c : { ...c, fallback }));
};

// --- layers and masks -----------------------------------------------------------------------------------------------

/** A layer over `root` (the output by default), named "Layer" (unique). */
export function addLayer(graph: AnimGraph, root: string | null = graph.output ?? graph.nodes[0]?.id ?? null): EditResult<AnimGraph> {
  if (graph.layers.length >= GRAPH_LIMITS.layers) return refuse(`a graph has at most ${GRAPH_LIMITS.layers} layers`);
  if (!root || !nodeById(graph, root)) return refuse("add a node for the layer to play first");
  const name = uniqueName("Layer", graph.layers.map((l) => l.name));
  return accept({ ...graph, layers: [...graph.layers, { name, root, mask: null, mode: "override", weight: 1, weightParameter: null }] });
}

export function removeLayer(graph: AnimGraph, name: string): EditResult<AnimGraph> {
  if (!graph.layers.some((l) => l.name === name)) return refuse(`there's no layer named "${name}"`);
  return accept({ ...graph, layers: graph.layers.filter((l) => l.name !== name) });
}

/** A layer's fields: name (unique), root, mask, mode, weight (0..1) and weight parameter (a float one). */
export function setLayer(graph: AnimGraph, name: string, patch: Partial<Omit<GraphLayer, "name">> & { name?: string }): EditResult<AnimGraph> {
  const layer = graph.layers.find((l) => l.name === name);
  if (!layer) return refuse(`there's no layer named "${name}"`);
  const next: GraphLayer = { ...layer, ...patch, name: patch.name?.trim() ?? layer.name };
  if (next.name === "") return refuse("a layer needs a name");
  if (next.name !== name && graph.layers.some((l) => l.name === next.name)) return refuse(`another layer is named "${next.name}"`);
  if (!nodeById(graph, next.root)) return refuse("that node isn't in the graph");
  if (!(LAYER_MODES as readonly LayerMode[]).includes(next.mode)) return refuse(`a layer's mode is ${LAYER_MODES.join(" or ")}`);
  if (!Number.isFinite(next.weight) || next.weight < 0 || next.weight > 1) return refuse("a layer's weight is 0 to 1");
  if (next.weightParameter !== null) {
    const why = whyNotBinding(graph, "the weight", next.weightParameter, ["float"]);
    if (why) return refuse(why);
  }
  if (next.mask === "") return refuse("a mask is an asset (none: null)");
  return accept({ ...graph, layers: graph.layers.map((l) => (l === layer ? next : l)) });
}

/** Move layer `name` up (-1) or down (1): layers stack in order over the output. */
export function moveLayer(graph: AnimGraph, name: string, by: -1 | 1): EditResult<AnimGraph> {
  const i = graph.layers.findIndex((l) => l.name === name);
  if (i < 0) return refuse(`there's no layer named "${name}"`);
  const j = i + by;
  if (j < 0 || j >= graph.layers.length) return refuse(by < 0 ? "it's the first layer" : "it's the last layer");
  const layers = [...graph.layers];
  [layers[i], layers[j]] = [layers[j]!, layers[i]!];
  return accept({ ...graph, layers });
}

/** Replace node `id`'s state machine (the machine edits' lift). */
export function withMachine(graph: AnimGraph, id: string, f: (m: StateMachine) => EditResult<StateMachine>): EditResult<AnimGraph> {
  const n = nodeById(graph, id);
  if (!n?.machine) return refuse("that node isn't a state machine");
  const r = f(n.machine);
  if ("refused" in r) return r;
  return accept(r.next === n.machine ? graph : mapNode(graph, id, (x) => ({ ...x, machine: r.next })));
}

/** The family ids, in the node search's order. */
export const FAMILIES: readonly GraphFamily[] = GRAPH_FAMILIES;
