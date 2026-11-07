// Particle graph edits (ADR 0060): pure functions from one graph to the next, so the panel's undo
// history is a list of graphs and every rule here is unit-tested. None of them change their input;
// an edit that does nothing returns the graph it was given.
//
// Wire references (see particleGraph.ts):
// - value wires go from a node output (`n1.out`) to a node input (`n2.a`) or a block input
//   (`s1.b4.color`);
// - event wires go from an event node (`n3`) or a Trigger Event block (`s1.b7`) to a system's
//   spawn start or stop (`s2.start`, `s2.stop`). The canvas names an event node's port
//   (`n3.out`); `connectWire` stores it as the node id.
import { blockDef, defaultBlock, type BlockInputDef } from "../../engine/scene/particleBlocks";
import type {
  BlockContext,
  ContextKind,
  GraphBlock,
  GraphEdge,
  GraphEvent,
  GraphInputValue,
  GraphNode,
  GraphNote,
  GraphProperty,
  GraphPropertyType,
  OutputContext,
  OutputSettings,
  OutputSort,
  OutputType,
  ParticleGraph,
  ParticleGraphSystem,
  SimulationChoice,
  SpawnSettings,
  SystemSettings,
  Vec2,
} from "../../engine/scene/particleGraph";
import { newGraphId, systemTemplate } from "../../engine/scene/particleGraphFormat";
import { nodeDef, type PortType } from "../../engine/scene/particleNodes";
import { outputTypeResolved, whyNotConnectResolved, type AssetResolver } from "../../engine/scene/particleSubgraphs";
import { blockInputs, editorNodeDef, wireRulesGraph } from "./assetDocs";
import { parseGraphClipboard } from "../graph/clipboard";

const clone = <T>(v: T): T => structuredClone(v);
const round = (p: Vec2 | readonly number[]): Vec2 => [Math.round(p[0]), Math.round(p[1])];

export type TemplateKind = Parameters<typeof systemTemplate>[1];

// --- view state ---------------------------------------------------------------------------------------

/** The ids of the systems whose frames are collapsed (`graph.editor.collapsed`), skipping systems that are gone. */
export function collapsedSystems(graph: ParticleGraph): Set<string> {
  const raw = graph.editor?.collapsed;
  const ids = new Set(graph.systems.map((s) => s.id));
  return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && ids.has(id)) : []);
}

/** Collapses or expands a system's frame; stored in the graph's editor-only data so it saves with the asset. */
export function setSystemCollapsed(graph: ParticleGraph, systemId: string, collapsed: boolean): ParticleGraph {
  if (!graph.systems.some((s) => s.id === systemId)) return graph;
  const before = collapsedSystems(graph);
  if (before.has(systemId) === collapsed) return graph;
  if (collapsed) before.add(systemId);
  else before.delete(systemId);
  const next = clone(graph);
  const editor = { ...next.editor };
  if (before.size) editor.collapsed = [...before];
  else delete editor.collapsed;
  if (Object.keys(editor).length) next.editor = editor;
  else delete next.editor;
  return next;
}

// --- references --------------------------------------------------------------------------------------

/** Splits `"<id>.<port>"` at the last dot. */
export function splitRef(ref: string): [string, string] {
  const i = ref.lastIndexOf(".");
  return i < 0 ? [ref, ""] : [ref.slice(0, i), ref.slice(i + 1)];
}

/**
 * A system's context by kind. A system can have several outputs: `output` picks one (0 is the main
 * `output`, 1 and up are `extraOutputs[output - 1]`); it only matters for the "output" kind.
 */
export const contextOf = (sys: ParticleGraphSystem, kind: ContextKind, output = 0): BlockContext | null =>
  kind === "output" ? (output === 0 ? sys.output : (sys.extraOutputs?.[output - 1] ?? null)) : sys[kind];

/** How many outputs a system has (the main one and the extra ones). */
export const outputCount = (sys: ParticleGraphSystem): number => 1 + (sys.extraOutputs?.length ?? 0);

function outputContext(sys: ParticleGraphSystem, output: number): OutputContext | null {
  return (contextOf(sys, "output", output) as OutputContext | null) ?? null;
}

export interface BlockAt {
  system: ParticleGraphSystem;
  kind: ContextKind;
  /** The output the block is in (0 = the main one; always 0 outside the Output context). */
  output: number;
  index: number;
  block: GraphBlock;
}

const KINDS: readonly ContextKind[] = ["spawn", "initialize", "update", "output"];

/** Where a block is: its system, context and index. */
export function findBlock(graph: ParticleGraph, systemId: string, blockId: string): BlockAt | null {
  const system = graph.systems.find((s) => s.id === systemId);
  if (!system) return null;
  for (const kind of KINDS) {
    for (let output = 0; output < (kind === "output" ? outputCount(system) : 1); output++) {
      const blocks = contextOf(system, kind, output)!.blocks;
      const index = blocks.findIndex((b) => b.id === blockId);
      if (index >= 0) return { system, kind, output, index, block: blocks[index] };
    }
  }
  return null;
}

/** What a wire's `to` names. */
export type WireTarget =
  | { kind: "event"; system: string; end: "start" | "stop" }
  | { kind: "block"; system: string; block: string; input: string }
  | { kind: "node"; node: string; input: string }
  | { kind: "none" };

export function wireTarget(graph: ParticleGraph, to: string): WireTarget {
  const parts = to.split(".");
  if (parts.length === 2 && graph.systems.some((s) => s.id === parts[0])) {
    return parts[1] === "start" || parts[1] === "stop" ? { kind: "event", system: parts[0], end: parts[1] } : { kind: "none" };
  }
  if (parts.length === 3) return { kind: "block", system: parts[0], block: parts[1], input: parts[2] };
  if (parts.length === 2 && graph.nodes.some((n) => n.id === parts[0])) return { kind: "node", node: parts[0], input: parts[1] };
  return { kind: "none" };
}

/** Block inputs a node can be wired into: numbers, colours and vectors. */
export const isWireableInput = (input: BlockInputDef) => input.type === "number" || input.type === "color" || input.type === "vector2" || input.type === "vector3";

/**
 * The port type a value from `from` needs to match to wire into a block input: a curve or gradient
 * feeds an input that takes curves (numbers) or gradients (colours); otherwise the input's type.
 */
export function blockInputType(graph: ParticleGraph, from: string, input: BlockInputDef, resolve?: AssetResolver): PortType {
  const [id, port] = splitRef(from);
  const node = graph.nodes.find((n) => n.id === id);
  const src = node ? outputTypeResolved(graph, node, port, resolve) : null;
  const forms = (input.forms ?? []) as readonly string[];
  if (src === "curve" && input.type === "number" && (forms.includes("curve") || forms.includes("randomCurves"))) return "curve";
  if (src === "gradient" && input.type === "color" && (forms.includes("gradient") || forms.includes("randomGradients"))) return "gradient";
  return input.type as PortType;
}

/** An event source as stored: an event node's id, or `system.block` for a Trigger Event block. */
function eventSource(graph: ParticleGraph, from: string): string | null {
  const [id, port] = splitRef(from);
  const node = graph.nodes.find((n) => n.id === id) ?? graph.nodes.find((n) => n.id === from);
  if (node) {
    const def = nodeDef(node.type);
    return def?.outputs.some((o) => o.type === "event") ? node.id : null;
  }
  const at = findBlock(graph, id, port);
  return at && blockDef(at.block.type)?.event ? `${id}.${port}` : null;
}

/**
 * Why a wire from `from` (a node output, or a Trigger Event block `system.block`) to `to` can't be
 * made, or null. Value wires follow the node rules (`whyNotConnect`); events go only to a system's
 * Start or Stop, and a system can't trigger its own spawn.
 */
export function whyNotWire(graph: ParticleGraph, from: string, to: string, resolve?: AssetResolver): string | null {
  const target = wireTarget(graph, to);
  const [fromId, fromPort] = splitRef(from);
  const fromSystem = graph.systems.find((s) => s.id === fromId);
  if (target.kind === "none") return "There's nothing to connect to there.";
  if (target.kind === "event") {
    const src = eventSource(graph, from);
    if (!src) return "Only events (event nodes and Trigger Event blocks) can be wired to Start and Stop.";
    if (fromSystem && fromSystem.id === target.system) return "A system can't trigger its own spawn.";
    if (fromSystem && target.end === "stop") return "A Trigger Event spawns particles; wire it to a system's Start.";
    return null;
  }
  if (fromSystem) return "An event can only go to a system's Start or Stop.";
  if (!fromPort) return "Wires start at a node's output.";
  if (target.kind === "block") {
    const at = findBlock(graph, target.system, target.block);
    if (!at) return "That block isn't there.";
    const def = blockDef(at.block.type);
    if (!def) return `Unknown block type "${at.block.type}".`;
    const input = blockInputs(at.block, resolve).find((i) => i.name === target.input);
    if (!input) return `${def.label} has no input "${target.input}".`;
    if (!isWireableInput(input)) return `${input.label} can't be wired; set it on the block.`;
    const rules = wireRulesGraph(graph);
    return whyNotConnectResolved(rules, from, to, blockInputType(rules, from, input, resolve), resolve);
  }
  const node = graph.nodes.find((n) => n.id === target.node);
  const def = node && editorNodeDef(node, resolve);
  if (def?.missing) return "That Sub-graph's asset is missing.";
  const port = def?.inputs.find((i) => i.name === target.input);
  if (!port) return `There's no input "${to}".`;
  if (port.noPort) return `${port.label} can't be wired; set it on the node.`;
  return whyNotConnectResolved(wireRulesGraph(graph), from, to, port.type, resolve);
}

/** Make a wire (replacing the one into a value input). Returns the graph unchanged if it can't be made. */
export function connectWire(graph: ParticleGraph, from: string, to: string, resolve?: AssetResolver): ParticleGraph {
  if (whyNotWire(graph, from, to, resolve)) return graph;
  const target = wireTarget(graph, to);
  const g = clone(graph);
  if (target.kind === "event") {
    const src = eventSource(graph, from)!;
    if (g.events.some((e) => e.from === src && e.to === to)) return graph;
    g.events.push({ from: src, to });
    return g;
  }
  if (g.edges.some((e) => e.from === from && e.to === to)) return graph;
  g.edges = g.edges.filter((e) => e.to !== to);
  g.edges.push({ from, to });
  return g;
}

/** Remove the value wire into `to`. */
export function disconnect(graph: ParticleGraph, to: string): ParticleGraph {
  if (!graph.edges.some((e) => e.to === to)) return graph;
  return { ...clone(graph), edges: graph.edges.filter((e) => e.to !== to).map(clone) };
}

/** Remove an event wire. */
export function disconnectEvent(graph: ParticleGraph, from: string, to: string): ParticleGraph {
  if (!graph.events.some((e) => e.from === from && e.to === to)) return graph;
  return { ...clone(graph), events: graph.events.filter((e) => !(e.from === from && e.to === to)).map(clone) };
}

/** The node output wired into `to`, if any. */
export const sourceOf = (graph: ParticleGraph, to: string): string | undefined => graph.edges.find((e) => e.to === to)?.from;

// --- systems -----------------------------------------------------------------------------------------

/** Add a system from a template at `position`. */
export function addSystem(graph: ParticleGraph, kind: TemplateKind, position: Vec2, name?: string): { graph: ParticleGraph; id: string } {
  const g = clone(graph);
  const sys = systemTemplate(g, kind, round(position), name); // some templates add nodes and wires to the graph
  g.systems.push(sys);
  return { graph: g, id: sys.id };
}

function editSystem(graph: ParticleGraph, id: string, edit: (s: ParticleGraphSystem) => void): ParticleGraph {
  const i = graph.systems.findIndex((s) => s.id === id);
  if (i < 0) return graph;
  const g = clone(graph);
  edit(g.systems[i]);
  return JSON.stringify(g.systems[i]) === JSON.stringify(graph.systems[i]) ? graph : g;
}

export const renameSystem = (graph: ParticleGraph, id: string, name: string): ParticleGraph => (name.trim() ? editSystem(graph, id, (s) => (s.name = name.trim())) : graph);

export const setSystemEnabled = (graph: ParticleGraph, id: string, enabled: boolean): ParticleGraph =>
  editSystem(graph, id, (s) => {
    if (enabled) delete s.enabled;
    else s.enabled = false;
  });

export const setSystemSettings = (graph: ParticleGraph, id: string, patch: Partial<SystemSettings>): ParticleGraph => editSystem(graph, id, (s) => Object.assign(s.settings, patch));
export const setSpawnSettings = (graph: ParticleGraph, id: string, patch: Partial<SpawnSettings>): ParticleGraph => editSystem(graph, id, (s) => Object.assign(s.spawn.settings, patch));
/** The output index (0 = main, 1 and up = extra outputs) is optional on every output edit. */
export const setOutputType = (graph: ParticleGraph, id: string, type: OutputType, output = 0): ParticleGraph =>
  editSystem(graph, id, (s) => {
    const o = outputContext(s, output);
    if (o) o.type = type;
  });
export const setOutputSettings = (graph: ParticleGraph, id: string, patch: Partial<OutputSettings>, output = 0): ParticleGraph =>
  editSystem(graph, id, (s) => {
    const o = outputContext(s, output);
    if (o) Object.assign(o.settings, patch);
  });

/** Set the simulation choice: undefined (auto) is not written. */
export const setSimulation = (graph: ParticleGraph, id: string, simulation: SimulationChoice | undefined): ParticleGraph =>
  editSystem(graph, id, (s) => {
    if (simulation === undefined || simulation === "auto") delete s.settings.simulation;
    else s.settings.simulation = simulation;
  });

/** Set the system's own seed: null or undefined uses the component's (not written); otherwise an integer. */
export const setSeed = (graph: ParticleGraph, id: string, seed: number | null | undefined): ParticleGraph =>
  editSystem(graph, id, (s) => {
    if (seed === null || seed === undefined || !Number.isFinite(seed)) delete s.settings.seed;
    else s.settings.seed = Math.trunc(seed);
  });

/** Set the output's soft-particle distance in metres (0 or less turns it off: not written). */
export const setOutputSoftness = (graph: ParticleGraph, id: string, softness: number, output = 0): ParticleGraph =>
  editSystem(graph, id, (s) => {
    const o = outputContext(s, output);
    if (!o) return;
    if (softness > 0 && Number.isFinite(softness)) o.settings.softness = softness;
    else delete o.settings.softness;
  });

/** Set the output's sort: "auto" (the default) is not written. */
export const setOutputSort = (graph: ParticleGraph, id: string, sort: OutputSort, output = 0): ParticleGraph =>
  editSystem(graph, id, (s) => {
    const o = outputContext(s, output);
    if (!o) return;
    if (sort === "on" || sort === "off") o.settings.sort = sort;
    else delete o.settings.sort;
  });

/** Add another output to a system: the main output's type and settings, no blocks. `index` is the new output's index (null if the system isn't found). */
export function addOutput(graph: ParticleGraph, id: string): { graph: ParticleGraph; index: number | null } {
  const sys = graph.systems.find((s) => s.id === id);
  if (!sys) return { graph, index: null };
  const g = editSystem(graph, id, (s) => {
    (s.extraOutputs ??= []).push({ type: s.output.type, settings: clone(s.output.settings), blocks: [] });
  });
  return { graph: g, index: outputCount(sys) };
}

/** Remove an extra output (index 1 and up) with its blocks, the wires into them and the events from them. */
export function removeOutput(graph: ParticleGraph, id: string, output: number): ParticleGraph {
  const sys = graph.systems.find((s) => s.id === id);
  const doomed = sys?.extraOutputs?.[output - 1];
  if (!sys || !doomed || output < 1) return graph;
  const g = clone(graph);
  const s = g.systems.find((x) => x.id === id)!;
  s.extraOutputs!.splice(output - 1, 1);
  if (s.extraOutputs!.length === 0) delete s.extraOutputs;
  for (const b of doomed.blocks) {
    const prefix = `${id}.${b.id}`;
    g.edges = g.edges.filter((e) => !e.to.startsWith(`${prefix}.`));
    g.events = g.events.filter((e) => e.from !== prefix);
  }
  return g;
}

// --- blocks ------------------------------------------------------------------------------------------

/** Add a block of `type` to a context, at `index` (the end by default). Null id if it doesn't fit there. */
export function addBlock(graph: ParticleGraph, systemId: string, kind: ContextKind, type: string, index?: number, output = 0): { graph: ParticleGraph; id: string | null } {
  const def = blockDef(type);
  const system = graph.systems.find((s) => s.id === systemId);
  if (!def || !def.contexts.includes(kind) || !system || !contextOf(system, kind, output)) return { graph, id: null };
  const id = newGraphId(graph, "b");
  const g = editSystem(graph, systemId, (s) => {
    const blocks = contextOf(s, kind, output)!.blocks;
    blocks.splice(index === undefined ? blocks.length : Math.max(0, Math.min(blocks.length, index)), 0, defaultBlock(type, id));
  });
  return { graph: g, id };
}

/** Remove a block, the wires into its inputs and the events from it. */
export function removeBlock(graph: ParticleGraph, systemId: string, blockId: string): ParticleGraph {
  const at = findBlock(graph, systemId, blockId);
  if (!at) return graph;
  const g = clone(graph);
  const sys = g.systems.find((s) => s.id === systemId)!;
  contextOf(sys, at.kind, at.output)!.blocks.splice(at.index, 1);
  const prefix = `${systemId}.${blockId}`;
  g.edges = g.edges.filter((e) => !e.to.startsWith(`${prefix}.`));
  g.events = g.events.filter((e) => e.from !== prefix);
  return g;
}

/** Can a block go into a context of `kind` (in `systemId`)? Unknown blocks stay in their own context. */
export function canMoveBlock(graph: ParticleGraph, systemId: string, blockId: string, toSystem: string, toKind: ContextKind, toOutput = 0): boolean {
  const at = findBlock(graph, systemId, blockId);
  const target = graph.systems.find((s) => s.id === toSystem);
  if (!at || !target || !contextOf(target, toKind, toOutput)) return false;
  const def = blockDef(at.block.type);
  return def ? def.contexts.includes(toKind) : systemId === toSystem && at.kind === toKind && at.output === toOutput;
}

/**
 * Move a block to slot `index` of a context (slots as the context shows them now, the moved block
 * included), in the same system or another. Wires into it and events from it move with it; an
 * event that would now trigger its own system is dropped.
 */
export function moveBlock(graph: ParticleGraph, systemId: string, blockId: string, toSystem: string, toKind: ContextKind, index: number, toOutput = 0): ParticleGraph {
  if (!canMoveBlock(graph, systemId, blockId, toSystem, toKind, toOutput)) return graph;
  const at = findBlock(graph, systemId, blockId)!;
  let slot = index;
  if (systemId === toSystem && at.kind === toKind && at.output === toOutput) {
    if (slot > at.index) slot--;
    if (slot === at.index) return graph;
  }
  const g = clone(graph);
  const from = g.systems.find((s) => s.id === systemId)!;
  const to = g.systems.find((s) => s.id === toSystem)!;
  const [block] = contextOf(from, at.kind, at.output)!.blocks.splice(at.index, 1);
  const list = contextOf(to, toKind, toOutput)!.blocks;
  list.splice(Math.max(0, Math.min(list.length, slot)), 0, block);
  if (systemId !== toSystem) {
    const oldRef = `${systemId}.${blockId}`, newRef = `${toSystem}.${blockId}`;
    for (const e of g.edges) if (e.to.startsWith(`${oldRef}.`)) e.to = newRef + e.to.slice(oldRef.length);
    for (const e of g.events) if (e.from === oldRef) e.from = newRef;
    g.events = g.events.filter((e) => !(e.from === newRef && e.to.startsWith(`${toSystem}.`)));
  }
  return g;
}

function editBlock(graph: ParticleGraph, systemId: string, blockId: string, edit: (b: GraphBlock) => void): ParticleGraph {
  const at = findBlock(graph, systemId, blockId);
  if (!at) return graph;
  return editSystem(graph, systemId, (s) => edit(contextOf(s, at.kind, at.output)!.blocks[at.index]));
}

export const setBlockEnabled = (graph: ParticleGraph, systemId: string, blockId: string, enabled: boolean): ParticleGraph =>
  editBlock(graph, systemId, blockId, (b) => {
    if (enabled) delete b.enabled;
    else b.enabled = false;
  });

export const setBlockInput = (graph: ParticleGraph, systemId: string, blockId: string, name: string, value: GraphInputValue): ParticleGraph =>
  editBlock(graph, systemId, blockId, (b) => (b.inputs[name] = clone(value)));

// --- nodes -------------------------------------------------------------------------------------------

/** Add a node of `type` at `position`; its settings start at their defaults, then `settings`. */
export function addNode(graph: ParticleGraph, type: string, position: Vec2, settings?: Record<string, unknown>): { graph: ParticleGraph; id: string } {
  const id = newGraphId(graph, "n");
  const node: GraphNode = { id, type, position: round(position) };
  const defaults: Record<string, unknown> = {};
  for (const s of nodeDef(type)?.settings ?? []) defaults[s.name] = clone(s.default);
  const all = { ...defaults, ...(settings ? clone(settings) : {}) };
  if (Object.keys(all).length) node.settings = all;
  const g = clone(graph);
  g.nodes.push(node);
  return { graph: g, id };
}

function editNode(graph: ParticleGraph, id: string, edit: (n: GraphNode) => void): ParticleGraph {
  const i = graph.nodes.findIndex((n) => n.id === id);
  if (i < 0) return graph;
  const g = clone(graph);
  edit(g.nodes[i]);
  return g;
}

export const setNodeSetting = (graph: ParticleGraph, id: string, name: string, value: unknown): ParticleGraph => editNode(graph, id, (n) => (n.settings = { ...n.settings, [name]: clone(value) }));
export const setNodeInput = (graph: ParticleGraph, id: string, name: string, value: GraphInputValue): ParticleGraph => editNode(graph, id, (n) => (n.inputs = { ...n.inputs, [name]: clone(value) }));

// --- removing and moving -----------------------------------------------------------------------------

/** Remove systems, nodes and notes, with every wire and event to or from them and their group memberships. */
export function removeItems(graph: ParticleGraph, ids: Iterable<string>): ParticleGraph {
  const gone = new Set(ids);
  const systems = new Set(graph.systems.filter((s) => gone.has(s.id)).map((s) => s.id));
  const nodes = new Set(graph.nodes.filter((n) => gone.has(n.id)).map((n) => n.id));
  const notes = new Set(graph.notes.filter((n) => gone.has(n.id)).map((n) => n.id));
  if (systems.size + nodes.size + notes.size === 0) return graph;
  const head = (ref: string) => ref.split(".")[0];
  const g = clone(graph);
  g.systems = g.systems.filter((s) => !systems.has(s.id));
  g.nodes = g.nodes.filter((n) => !nodes.has(n.id));
  g.notes = g.notes.filter((n) => !notes.has(n.id));
  g.edges = g.edges.filter((e) => !nodes.has(head(e.from)) && !nodes.has(head(e.to)) && !systems.has(head(e.to)));
  g.events = g.events.filter((e) => !nodes.has(e.from) && !systems.has(head(e.from)) && !systems.has(head(e.to)));
  g.groups = g.groups.map((gr) => ({ ...gr, members: gr.members.filter((m) => !gone.has(m)) })).filter((gr) => gr.members.length > 0);
  return g;
}

/** Move systems, nodes and notes to new positions. */
export function moveItems(graph: ParticleGraph, positions: ReadonlyMap<string, Vec2>): ParticleGraph {
  if (positions.size === 0) return graph;
  const g = clone(graph);
  let moved = false;
  for (const item of [...g.systems, ...g.nodes, ...g.notes]) {
    const p = positions.get(item.id);
    if (!p) continue;
    const r = round(p);
    if (r[0] === item.position[0] && r[1] === item.position[1]) continue;
    item.position = r;
    moved = true;
  }
  return moved ? g : graph;
}

// --- properties --------------------------------------------------------------------------------------

export const PROPERTY_LABELS: Record<GraphPropertyType, string> = { number: "Number", vector2: "Vector 2", vector3: "Vector 3", color: "Colour", curve: "Curve", gradient: "Gradient", texture: "Texture" };

export function defaultPropertyValue(type: GraphPropertyType): GraphInputValue {
  switch (type) {
    case "number":
      return 0;
    case "vector2":
      return [0, 0];
    case "vector3":
      return [0, 0, 0];
    case "color":
      return "#ffffff";
    case "curve":
      return { curve: [[0, 1], [1, 1]] };
    case "gradient":
      return { gradient: { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 1]] } };
    case "texture":
      return "";
  }
}

/** Why `name` can't be the new name of property `old`, or null. */
export function whyNotPropertyName(graph: ParticleGraph, old: string | null, name: string): string | null {
  if (!name.trim()) return "a property needs a name";
  if (name !== name.trim()) return "a name can't start or end with a space";
  if (name !== old && graph.properties.some((p) => p.name === name)) return `there's already a property called ${name}`;
  return null;
}

/** Add a property of `type`, named after its type (`Number`, `Number 2`…), exposed. */
export function addProperty(graph: ParticleGraph, type: GraphPropertyType): { graph: ParticleGraph; name: string } {
  const base = PROPERTY_LABELS[type];
  let name = base;
  for (let i = 2; graph.properties.some((p) => p.name === name); i++) name = `${base} ${i}`;
  const g = clone(graph);
  g.properties.push({ name, type, value: defaultPropertyValue(type), exposed: true });
  return { graph: g, name };
}

function editProperty(graph: ParticleGraph, name: string, edit: (p: GraphProperty) => void): ParticleGraph {
  const i = graph.properties.findIndex((p) => p.name === name);
  if (i < 0) return graph;
  const g = clone(graph);
  edit(g.properties[i]);
  return g;
}

/** Rename a property and the Property nodes that read it. */
export function renameProperty(graph: ParticleGraph, old: string, name: string): ParticleGraph {
  if (old === name || whyNotPropertyName(graph, old, name)) return graph;
  const g = editProperty(graph, old, (p) => (p.name = name));
  for (const n of g.nodes) if (n.type === "property" && n.settings?.name === old) n.settings = { ...n.settings, name };
  return g;
}

export const setPropertyValue = (graph: ParticleGraph, name: string, value: GraphInputValue): ParticleGraph => editProperty(graph, name, (p) => (p.value = clone(value)));
export const setPropertyExposed = (graph: ParticleGraph, name: string, exposed: boolean): ParticleGraph => editProperty(graph, name, (p) => (p.exposed = exposed));

/** Remove a property and the Property nodes that read it (with their wires). */
export function removeProperty(graph: ParticleGraph, name: string): ParticleGraph {
  if (!graph.properties.some((p) => p.name === name)) return graph;
  const readers = graph.nodes.filter((n) => n.type === "property" && n.settings?.name === name).map((n) => n.id);
  const g = removeItems(graph, readers);
  return { ...clone(g), properties: g.properties.filter((p) => p.name !== name).map(clone) };
}

/** Move a property up (-1) or down (1) the Blackboard. */
export function moveProperty(graph: ParticleGraph, name: string, by: -1 | 1): ParticleGraph {
  const i = graph.properties.findIndex((p) => p.name === name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= graph.properties.length) return graph;
  const g = clone(graph);
  [g.properties[i], g.properties[j]] = [g.properties[j], g.properties[i]];
  return g;
}

// --- copy, paste, duplicate --------------------------------------------------------------------------

export const CLIPBOARD_FORMAT = "myco.particles.clipboard@1";

/** Systems and nodes copied with Ctrl+C, with the wires and events among them. Pastes into any effect. */
export interface ParticleClipboard {
  format: typeof CLIPBOARD_FORMAT;
  systems: ParticleGraphSystem[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  events: GraphEvent[];
}

/** Copy the selected systems and nodes, keeping only the wires and events between them. Null if nothing is selected. */
export function copyItems(graph: ParticleGraph, ids: Iterable<string>): ParticleClipboard | null {
  const set = new Set(ids);
  const systems = graph.systems.filter((s) => set.has(s.id));
  const nodes = graph.nodes.filter((n) => set.has(n.id));
  if (systems.length + nodes.length === 0) return null;
  const inside = (ref: string) => set.has(ref.split(".")[0]);
  return {
    format: CLIPBOARD_FORMAT,
    systems: clone(systems),
    nodes: clone(nodes),
    edges: clone(graph.edges.filter((e) => inside(e.from) && inside(e.to))),
    events: clone(graph.events.filter((e) => inside(e.from) && inside(e.to))),
  };
}

/** Read a clipboard payload from text (null for anything else). */
export const parseParticleClipboard = (text: string): ParticleClipboard | null =>
  parseGraphClipboard<ParticleClipboard>(text, CLIPBOARD_FORMAT, (v) => Array.isArray(v.systems) && Array.isArray(v.nodes) && Array.isArray(v.edges) && Array.isArray(v.events));

/** Ids for a paste: unused in the graph (systems, blocks, nodes, notes and groups share one id space), counting up per prefix. */
function allocator(graph: ParticleGraph) {
  const used = new Set<string>([...graph.nodes, ...graph.notes, ...graph.groups].map((i) => i.id));
  for (const s of graph.systems) {
    used.add(s.id);
    for (const c of [s.spawn, s.initialize, s.update, s.output, ...(s.extraOutputs ?? [])]) for (const b of c.blocks) used.add(b.id);
  }
  const next = new Map<string, number>();
  return (prefix: "s" | "b" | "n") => {
    let n = next.get(prefix) ?? Math.max(0, ...[...used].map((id) => new RegExp(`^${prefix}(\\d+)$`).exec(id)).map((m) => (m ? Number(m[1]) : 0)));
    let id: string;
    do id = `${prefix}${++n}`;
    while (used.has(id));
    next.set(prefix, n);
    used.add(id);
    return id;
  };
}

/** Paste a clipboard with its top-left at `at`: every id is new, and the wires and events among the pasted items are kept. */
export function pasteItems(graph: ParticleGraph, clip: ParticleClipboard, at: Vec2): { graph: ParticleGraph; ids: string[] } {
  const items = [...clip.systems, ...clip.nodes];
  if (items.length === 0) return { graph, ids: [] };
  const x0 = Math.min(...items.map((i) => i.position[0])), y0 = Math.min(...items.map((i) => i.position[1]));
  const dx = at[0] - x0, dy = at[1] - y0;
  const take = allocator(graph);
  const ids = new Map<string, string>();
  const blockIds = new Map<string, string>(); // "oldSystem.oldBlock" → new block id
  const g = clone(graph);
  const out: string[] = [];
  for (const s of clone(clip.systems)) {
    const id = take("s");
    ids.set(s.id, id);
    for (const kind of KINDS) {
      for (const b of s[kind].blocks) {
        const nb = take("b");
        blockIds.set(`${s.id}.${b.id}`, nb);
        b.id = nb;
      }
    }
    for (const o of s.extraOutputs ?? []) {
      for (const b of o.blocks) {
        const nb = take("b");
        blockIds.set(`${s.id}.${b.id}`, nb);
        b.id = nb;
      }
    }
    g.systems.push({ ...s, id, position: round([s.position[0] + dx, s.position[1] + dy]) });
    out.push(id);
  }
  for (const n of clone(clip.nodes)) {
    const id = take("n");
    ids.set(n.id, id);
    g.nodes.push({ ...n, id, position: round([n.position[0] + dx, n.position[1] + dy]) });
    out.push(id);
  }
  /** Remap `system.block.rest` or `node.rest`. */
  const remap = (ref: string): string | null => {
    const parts = ref.split(".");
    const head = ids.get(parts[0]);
    if (!head) return null;
    if (clip.systems.some((s) => s.id === parts[0]) && parts.length >= 2 && parts[1] !== "start" && parts[1] !== "stop") {
      const block = blockIds.get(`${parts[0]}.${parts[1]}`);
      return block ? [head, block, ...parts.slice(2)].join(".") : null;
    }
    return [head, ...parts.slice(1)].join(".");
  };
  for (const e of clip.edges) {
    const from = remap(e.from), to = remap(e.to);
    if (from && to) g.edges.push({ from, to });
  }
  for (const e of clip.events) {
    const from = remap(e.from), to = remap(e.to);
    if (from && to) g.events.push({ from, to });
  }
  return { graph: g, ids: out };
}

/** Copies of the selected systems and nodes, `offset` away. */
export function duplicateItems(graph: ParticleGraph, ids: Iterable<string>, offset: Vec2 = [40, 40]): { graph: ParticleGraph; ids: string[] } {
  const clip = copyItems(graph, ids);
  if (!clip) return { graph, ids: [] };
  const items = [...clip.systems, ...clip.nodes];
  const x0 = Math.min(...items.map((i) => i.position[0])), y0 = Math.min(...items.map((i) => i.position[1]));
  return pasteItems(graph, clip, [x0 + offset[0], y0 + offset[1]]);
}

// --- groups and notes --------------------------------------------------------------------------------

/** Put systems and nodes in a new group (taking them out of any other). */
export function groupItems(graph: ParticleGraph, ids: Iterable<string>, title = "Group"): { graph: ParticleGraph; id: string | null } {
  const members = [...new Set(ids)].filter((id) => graph.systems.some((s) => s.id === id) || graph.nodes.some((n) => n.id === id));
  if (members.length === 0) return { graph, id: null };
  const id = newGraphId(graph, "g");
  const g = clone(graph);
  g.groups = g.groups.map((gr) => ({ ...gr, members: gr.members.filter((m) => !members.includes(m)) })).filter((gr) => gr.members.length > 0);
  g.groups.push({ id, title, members });
  return { graph: g, id };
}

export function ungroup(graph: ParticleGraph, id: string): ParticleGraph {
  if (!graph.groups.some((g) => g.id === id)) return graph;
  return { ...clone(graph), groups: graph.groups.filter((g) => g.id !== id).map(clone) };
}

export function setGroupTitle(graph: ParticleGraph, id: string, title: string): ParticleGraph {
  const i = graph.groups.findIndex((g) => g.id === id);
  if (i < 0 || graph.groups[i].title === title) return graph;
  const g = clone(graph);
  g.groups[i].title = title;
  return g;
}

export function addNote(graph: ParticleGraph, position: Vec2, text = ""): { graph: ParticleGraph; id: string } {
  const id = newGraphId(graph, "note");
  const g = clone(graph);
  g.notes.push({ id, position: round(position), size: [200, 100], text });
  return { graph: g, id };
}

export function updateNote(graph: ParticleGraph, id: string, patch: Partial<Omit<GraphNote, "id">>): ParticleGraph {
  const i = graph.notes.findIndex((n) => n.id === id);
  if (i < 0) return graph;
  const g = clone(graph);
  const n = g.notes[i];
  if (patch.position) n.position = round(patch.position);
  if (patch.size) n.size = [Math.max(80, Math.round(patch.size[0])), Math.max(40, Math.round(patch.size[1]))];
  if (patch.text !== undefined) n.text = patch.text;
  return g;
}

export const removeNote = (graph: ParticleGraph, id: string): ParticleGraph => removeItems(graph, [id]);
