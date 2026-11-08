/**
 * Particle sub-graphs and custom blocks (ADR 0095). Both are assets that a particle graph uses by
 * reference and that are expanded (inlined) before compiling, so the CPU compiler and the kernel
 * compiler (ADR 0094) see one flat graph:
 *
 * - a **sub-graph** (`*.particlesubgraph.json`, `myco.particlesubgraph@1`) is a group of operator
 *   nodes with named inputs and outputs, used as one `subgraph` node (its `settings.asset`);
 * - a **custom block** (`*.particleblock.json`, `myco.particleblock@1`) is a stack of blocks (Set
 *   Attribute and any other) with the nodes that feed them and named inputs, used as one `custom`
 *   block (its `inputs.asset`) in the contexts it lists.
 *
 * Inside an asset, an edge from `input.<name>` reads one of its inputs; in a sub-graph an edge to
 * `output.<name>` defines an output; in a custom block an edge to `block.<blockId>.<input>` drives an
 * inner block's input. Expansion prefixes inner ids with `<outer id>~` and turns unwired inputs into
 * constant nodes. Nesting works up to `MAX_DEPTH` levels.
 */
import { Assets } from "./Assets";
import type { ContextKind, GraphBlock, GraphEdge, GraphInputValue, GraphNode, GraphProblem, ParticleGraph } from "./particleGraph";
import { outputType, portRate, splitRef, whyNotConnect, type PortType, type Rate } from "./particleNodes";

export const SUBGRAPH_FORMAT = "myco.particlesubgraph@1";
export const BLOCK_FORMAT = "myco.particleblock@1";
export const SUBGRAPH_SUFFIX = ".particlesubgraph.json";
export const CUSTOM_BLOCK_SUFFIX = ".particleblock.json";
const MAX_DEPTH = 8;

export type PortValueType = "number" | "vector2" | "vector3" | "color" | "curve" | "gradient";

export interface AssetPort {
  name: string;
  type: PortValueType;
  /** Unwired value (inputs). */
  default?: GraphInputValue;
}

export interface ParticleSubgraphAsset {
  inputs: AssetPort[];
  outputs: AssetPort[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ParticleBlockAsset {
  label: string;
  contexts: ContextKind[];
  inputs: AssetPort[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  blocks: GraphBlock[];
}

/** Reads an asset's JSON by reference (`asset:…`), or undefined when it isn't there. */
export type AssetResolver = (ref: string) => unknown;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const TYPES: readonly PortValueType[] = ["number", "vector2", "vector3", "color", "curve", "gradient"];

function ports(raw: unknown): AssetPort[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).flatMap((p) => {
    if (typeof p.name !== "string" || !p.name) return [];
    const type = TYPES.includes(p.type as PortValueType) ? (p.type as PortValueType) : "number";
    return [p.default === undefined ? { name: p.name, type } : { name: p.name, type, default: p.default as GraphInputValue }];
  });
}
const nodes = (raw: unknown): GraphNode[] => (Array.isArray(raw) ? raw.filter((n): n is GraphNode => isObj(n) && typeof n.id === "string" && typeof n.type === "string").map((n) => ({ ...n, position: Array.isArray(n.position) ? n.position : [0, 0] })) : []);
const edges = (raw: unknown): GraphEdge[] => (Array.isArray(raw) ? raw.filter((e): e is GraphEdge => isObj(e) && typeof e.from === "string" && typeof e.to === "string") : []);

/** A sub-graph asset's JSON, leniently (null when it isn't one). */
export function parseSubgraphAsset(raw: unknown): ParticleSubgraphAsset | null {
  if (!isObj(raw) || raw.format !== SUBGRAPH_FORMAT) return null;
  return { inputs: ports(raw.inputs), outputs: ports(raw.outputs), nodes: nodes(raw.nodes), edges: edges(raw.edges) };
}

/** A custom block asset's JSON, leniently (null when it isn't one). */
export function parseBlockAsset(raw: unknown): ParticleBlockAsset | null {
  if (!isObj(raw) || raw.format !== BLOCK_FORMAT) return null;
  const contexts = (Array.isArray(raw.contexts) ? raw.contexts : ["update"]).filter((c): c is ContextKind => c === "spawn" || c === "initialize" || c === "update" || c === "output");
  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.filter((b): b is GraphBlock => isObj(b) && typeof b.id === "string" && typeof b.type === "string").map((b) => ({ ...b, inputs: isObj(b.inputs) ? (b.inputs as Record<string, GraphInputValue>) : {} }))
    : [];
  return { label: typeof raw.label === "string" ? raw.label : "Custom block", contexts, inputs: ports(raw.inputs), nodes: nodes(raw.nodes), edges: edges(raw.edges), blocks };
}

/** The asset a `subgraph` node or `custom` block refers to. */
export const subgraphRef = (n: GraphNode): string => String(n.settings?.asset ?? "");
export const customBlockRef = (b: GraphBlock): string => String(b.inputs.asset ?? "");

/** Every asset a graph refers to through sub-graphs and custom blocks (one level; nested ones are found while expanding). */
export function referencedAssets(graph: ParticleGraph): string[] {
  const out = new Set<string>();
  for (const n of graph.nodes) if (n.type === "subgraph" && subgraphRef(n)) out.add(subgraphRef(n));
  for (const s of graph.systems)
    for (const c of [s.spawn, s.initialize, s.update, s.output, ...(s.extraOutputs ?? [])]) for (const b of c.blocks) if (b.type === "custom" && customBlockRef(b)) out.add(customBlockRef(b));
  return [...out];
}

/** A constant node holding `value` (an unwired input), typed by the port. */
function constantNode(id: string, type: PortValueType, value: GraphInputValue | undefined): GraphNode {
  switch (type) {
    case "vector2":
      return { id, type: "constant.vector2", position: [0, 0], settings: { value: Array.isArray(value) ? value : [0, 0] } };
    case "vector3":
      return { id, type: "constant.vector3", position: [0, 0], settings: { value: Array.isArray(value) ? value : [0, 0, 0] } };
    case "color":
      return { id, type: "constant.color", position: [0, 0], settings: { value: typeof value === "string" ? value : "#ffffffff" } };
    case "curve":
      return { id, type: "curve", position: [0, 0], settings: { keys: isObj(value) && Array.isArray((value as { curve?: unknown }).curve) ? (value as { curve: unknown }).curve : [[0, 1], [1, 1]] } };
    case "gradient":
      return { id, type: "gradient", position: [0, 0], settings: { gradient: isObj(value) && isObj((value as { gradient?: unknown }).gradient) ? (value as { gradient: unknown }).gradient : { colors: [[0, "#ffffff"]], alphas: [] } } };
    default:
      return { id, type: "constant.number", position: [0, 0], settings: { value: typeof value === "number" ? value : 0 } };
  }
}

/**
 * Inline every sub-graph node and custom block of `graph`. Returns a new graph (the input isn't
 * changed) and the problems found (missing assets, unknown ports, nesting too deep). Unresolvable
 * nodes are dropped with their wires; unresolvable blocks are dropped.
 */
export function expandParticleGraph(graph: ParticleGraph, resolve: AssetResolver): { graph: ParticleGraph; problems: GraphProblem[] } {
  const problems: GraphProblem[] = [];
  let g: ParticleGraph = { ...graph, nodes: [...graph.nodes], edges: [...graph.edges], systems: graph.systems.map((s) => ({ ...s })) };
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const hasSub = g.nodes.some((n) => n.type === "subgraph");
    const hasCustom = g.systems.some((s) => [s.spawn, s.initialize, s.update, s.output, ...(s.extraOutputs ?? [])].some((c) => c.blocks.some((b) => b.type === "custom")));
    if (!hasSub && !hasCustom) return { graph: g, problems };
    g = expandOnce(g, resolve, problems);
  }
  problems.push({ severity: "error", message: `Sub-graphs or custom blocks nest more than ${MAX_DEPTH} levels deep (or refer to themselves); the deepest are left out.` });
  g = { ...g, nodes: g.nodes.filter((n) => n.type !== "subgraph") };
  for (const s of g.systems) for (const c of contextsOf(s)) c.blocks = c.blocks.filter((b) => b.type !== "custom");
  return { graph: g, problems };
}

type Sys = ParticleGraph["systems"][number];
const contextsOf = (s: Sys) => [s.spawn, s.initialize, s.update, s.output, ...(s.extraOutputs ?? [])];

function expandOnce(graph: ParticleGraph, resolve: AssetResolver, problems: GraphProblem[]): ParticleGraph {
  let nodesOut: GraphNode[] = [];
  let edgesOut = [...graph.edges];
  /** Replace every wire *into* a port: returns the source feeding `to`, removing that wire. */
  const takeSource = (to: string): string | undefined => {
    const i = edgesOut.findIndex((e) => e.to === to);
    if (i < 0) return undefined;
    const from = edgesOut[i].from;
    edgesOut.splice(i, 1);
    return from;
  };

  for (const n of graph.nodes) {
    if (n.type !== "subgraph") {
      nodesOut.push(n);
      continue;
    }
    const ref = subgraphRef(n);
    const asset = ref ? parseSubgraphAsset(resolve(ref)) : null;
    if (!asset) {
      problems.push({ severity: "warning", message: ref ? `Sub-graph "${ref.replace(/^asset:/, "")}" isn't in the project (or isn't a particle sub-graph); its node is left out.` : `A Sub-graph node has no asset.`, at: n.id });
      edgesOut = edgesOut.filter((e) => !e.from.startsWith(`${n.id}.`) && !e.to.startsWith(`${n.id}.`));
      continue;
    }
    const p = `${n.id}~`;
    // Inputs: what feeds the node's input port, else a constant of its inline value.
    const inputSource = new Map<string, string>();
    for (const port of asset.inputs) {
      const from = takeSource(`${n.id}.${port.name}`);
      if (from) inputSource.set(port.name, from);
      else {
        const c = constantNode(`${p}in~${port.name}`, port.type, (n.inputs?.[port.name] as GraphInputValue | undefined) ?? port.default);
        nodesOut.push(c);
        inputSource.set(port.name, `${c.id}.out`);
      }
    }
    for (const inner of asset.nodes) nodesOut.push({ ...inner, id: p + inner.id });
    const outputSource = new Map<string, string>();
    for (const e of asset.edges) {
      const from = e.from.startsWith("input.") ? inputSource.get(e.from.slice(6)) : p + e.from;
      if (!from) {
        problems.push({ severity: "warning", message: `Sub-graph "${ref}" reads an input it doesn't declare (${e.from}).`, at: n.id });
        continue;
      }
      if (e.to.startsWith("output.")) outputSource.set(e.to.slice(7), from);
      else edgesOut.push({ from, to: p + e.to });
    }
    // Wires out of the node's outputs now leave the inner node that defines each output.
    edgesOut = edgesOut.flatMap((e) => {
      if (!e.from.startsWith(`${n.id}.`)) return [e];
      const port = e.from.slice(n.id.length + 1);
      const src = outputSource.get(port);
      if (!src) {
        problems.push({ severity: "warning", message: `Sub-graph "${ref}" has no output "${port}".`, at: n.id });
        return [];
      }
      return [{ from: src, to: e.to }];
    });
  }

  const systems = graph.systems.map((s) => {
    const copy: Sys = { ...s, spawn: { ...s.spawn }, initialize: { ...s.initialize }, update: { ...s.update }, output: { ...s.output }, extraOutputs: s.extraOutputs?.map((o) => ({ ...o })) };
    const kinds: ContextKind[] = ["spawn", "initialize", "update", "output", ...(s.extraOutputs ?? []).map(() => "output" as const)];
    contextsOf(copy).forEach((ctx, ci) => {
      const kind = kinds[ci];
      const blocks: GraphBlock[] = [];
      for (const b of ctx.blocks) {
        if (b.type !== "custom") {
          blocks.push(b);
          continue;
        }
        const ref = customBlockRef(b);
        const asset = ref ? parseBlockAsset(resolve(ref)) : null;
        if (!asset) {
          problems.push({ severity: "warning", message: ref ? `Custom block "${ref.replace(/^asset:/, "")}" isn't in the project (or isn't a particle block); it's left out.` : "A Custom block has no asset.", at: `${s.id}.${b.id}` });
          edgesOut = edgesOut.filter((e) => !e.to.startsWith(`${s.id}.${b.id}.`));
          continue;
        }
        if (!asset.contexts.includes(kind)) problems.push({ severity: "warning", message: `Custom block "${asset.label}" isn't made for the ${kind} context.`, at: `${s.id}.${b.id}` });
        if (b.enabled === false) continue;
        const p = `${b.id}~`;
        const inputSource = new Map<string, string>();
        for (const port of asset.inputs) {
          const from = takeSource(`${s.id}.${b.id}.${port.name}`);
          if (from) inputSource.set(port.name, from);
          else {
            const c = constantNode(`${p}in~${port.name}`, port.type, (b.inputs[port.name] as GraphInputValue | undefined) ?? port.default);
            nodesOut.push(c);
            inputSource.set(port.name, `${c.id}.out`);
          }
        }
        for (const inner of asset.nodes) nodesOut.push({ ...inner, id: p + inner.id });
        for (const inner of asset.blocks) blocks.push({ ...inner, id: p + inner.id, inputs: { ...inner.inputs } });
        for (const e of asset.edges) {
          const from = e.from.startsWith("input.") ? inputSource.get(e.from.slice(6)) : p + e.from;
          if (!from) continue;
          if (e.to.startsWith("block.")) {
            const rest = e.to.slice(6);
            const dot = rest.indexOf(".");
            edgesOut.push({ from, to: `${s.id}.${p}${rest.slice(0, dot)}${rest.slice(dot)}` });
          } else edgesOut.push({ from, to: p + e.to });
        }
      }
      ctx.blocks = blocks;
    });
    return copy;
  });
  nodesOut = nodesOut.filter((n, i, all) => all.findIndex((m) => m.id === n.id) === i);
  return { ...graph, nodes: nodesOut, edges: edgesOut, systems };
}

/** Resolves references through the project's loaded assets. */
export const projectAssets: AssetResolver = (ref) => {
  try {
    return Assets.has(ref) ? Assets.json(ref) : undefined;
  } catch {
    return undefined;
  }
};

/** Every asset reference the expansion of `graph` reads, nested ones included (to rebuild when one changes). */
export function expansionDependencies(graph: ParticleGraph, resolve: AssetResolver): string[] {
  const out = new Set<string>();
  const visit = (refs: string[], depth: number) => {
    for (const ref of refs) {
      if (out.has(ref) || depth > MAX_DEPTH) continue;
      out.add(ref);
      const raw = resolve(ref);
      const sub = parseSubgraphAsset(raw);
      const blk = parseBlockAsset(raw);
      const inner = [...(sub?.nodes ?? []), ...(blk?.nodes ?? [])].filter((n) => n.type === "subgraph").map(subgraphRef);
      const innerBlocks = (blk?.blocks ?? []).filter((b) => b.type === "custom").map(customBlockRef);
      visit([...inner, ...innerBlocks].filter(Boolean), depth + 1);
    }
  };
  visit(referencedAssets(graph), 0);
  return [...out];
}

// --- ports of a sub-graph node and a custom block, for the editor (ADR 0126) ---------------------------

/** The ports an asset gives a node or block; `missing` when the asset isn't in the project (or isn't the right kind). */
export interface ResolvedPorts {
  missing: boolean;
  inputs: AssetPort[];
  outputs: AssetPort[];
}

const MISSING: ResolvedPorts = { missing: true, inputs: [], outputs: [] };

function read(resolve: AssetResolver | undefined, ref: string): unknown {
  if (!resolve || !ref) return undefined;
  try {
    return resolve(ref);
  } catch {
    return undefined;
  }
}

/** A `subgraph` node's ports: its asset's inputs and outputs, with their types. */
export function subgraphPorts(node: GraphNode, resolve: AssetResolver | undefined): ResolvedPorts {
  const asset = parseSubgraphAsset(read(resolve, subgraphRef(node)));
  return asset ? { missing: false, inputs: asset.inputs, outputs: asset.outputs } : MISSING;
}

/** A `custom` block's extra inputs: its asset's inputs (a block has no outputs). */
export function customBlockPorts(block: GraphBlock, resolve: AssetResolver | undefined): ResolvedPorts {
  const asset = parseBlockAsset(read(resolve, customBlockRef(block)));
  return asset ? { missing: false, inputs: asset.inputs, outputs: [] } : MISSING;
}

const edgeLoops = (graph: ParticleGraph, fromId: string, toId: string): boolean => {
  if (fromId === toId) return true;
  const seen = new Set<string>();
  const stack = [fromId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === toId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) if (e.to.startsWith(`${id}.`)) stack.push(splitRef(e.from)[0]);
  }
  return false;
};

/**
 * `whyNotConnect` aware of sub-graph nodes. A node's ports come from its asset, so a wire from or
 * into a Sub-graph node checks the asset's types by the same rules (equal types, or a number into a
 * vector; a curve or gradient only into a curve or gradient); every other wire is checked on the
 * graph with its sub-graphs inlined, so types and loops through a sub-graph count too.
 */
export function whyNotConnectResolved(graph: ParticleGraph, from: string, to: string, toType: PortType, resolve: AssetResolver | undefined): string | null {
  const [fromId, fromPort] = splitRef(from);
  const [toId, toPort] = splitRef(to);
  const src = graph.nodes.find((n) => n.id === fromId);
  const dst = graph.nodes.find((n) => n.id === toId);
  const subSrc = src?.type === "subgraph", subDst = dst?.type === "subgraph";
  if (!subSrc && !subDst) {
    if (!graph.nodes.some((n) => n.type === "subgraph")) return whyNotConnect(graph, from, to, toType);
    return whyNotConnect(expandParticleGraph(graph, resolve ?? (() => undefined)).graph, from, to, toType);
  }
  let fromType: PortType | null;
  if (subSrc) {
    const ports = subgraphPorts(src, resolve);
    if (ports.missing) return "That Sub-graph's asset is missing.";
    const out = ports.outputs.find((p) => p.name === fromPort);
    if (!out) return `The Sub-graph has no output "${fromPort}".`;
    fromType = out.type;
  } else {
    if (!src) return `There's no node "${fromId}".`;
    fromType = outputType(expandParticleGraph(graph, resolve ?? (() => undefined)).graph, src, fromPort);
    if (!fromType) return `That output has no value type.`;
  }
  let target: PortType = toType;
  if (subDst) {
    const ports = subgraphPorts(dst, resolve);
    if (ports.missing) return "That Sub-graph's asset is missing.";
    const input = ports.inputs.find((p) => p.name === toPort);
    if (!input) return `The Sub-graph has no input "${toPort}".`;
    target = input.type;
  }
  if (fromType === "event" || target === "event") return fromType === target ? null : "Events and values can't be connected.";
  if (dst && edgeLoops(graph, fromId, toId)) return "That wire would make a loop.";
  if (fromType === target) return null;
  if (fromType === "number" && (target === "vector2" || target === "vector3")) return null;
  if (fromType === "curve" || fromType === "gradient") return "A curve or gradient can only be wired into a curve or gradient input.";
  return `Can't connect a ${fromType} to a ${target} input.`;
}

/** A wire source's value type, with sub-graph outputs read from their assets and sub-graphs inlined for the rest. */
export function outputTypeResolved(graph: ParticleGraph, node: GraphNode, port: string, resolve: AssetResolver | undefined, expanded?: ParticleGraph): PortType | null {
  if (node.type === "subgraph") return subgraphPorts(node, resolve).outputs.find((p) => p.name === port)?.type ?? null;
  const g = expanded ?? (graph.nodes.some((n) => n.type === "subgraph") ? expandParticleGraph(graph, resolve ?? (() => undefined)).graph : graph);
  return outputType(g, g.nodes.find((n) => n.id === node.id) ?? node, port);
}

/**
 * The rate of a wire source. A Sub-graph output is per-particle when the nodes between its input
 * and itself include a per-particle source (Random Range, Curve, Particle nodes...), or when any
 * wired input of the node is per-particle (a deliberate simplification: one wired per-particle
 * input makes every output per-particle); otherwise uniform. Other nodes are rated on the graph
 * with its sub-graphs inlined, so a per-particle value passing through one stays per-particle.
 */
export function portRateResolved(graph: ParticleGraph, from: string, resolve: AssetResolver | undefined, expanded?: ParticleGraph, depth = 0): Rate {
  const [id, port] = splitRef(from);
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.type === "subgraph") {
    if (depth > MAX_DEPTH) return "uniform";
    const asset = parseSubgraphAsset(read(resolve, subgraphRef(node)));
    if (!asset) return "uniform";
    for (const e of graph.edges) if (e.to.startsWith(`${id}.`) && portRateResolved(graph, e.from, resolve, expanded, depth + 1) === "particle") return "particle";
    const wire = asset.edges.find((e) => e.to === `output.${port}`);
    if (!wire || wire.from.startsWith("input.")) return "uniform";
    const inner: ParticleGraph = { properties: [], systems: [], nodes: asset.nodes, edges: asset.edges.filter((e) => !e.to.startsWith("output.")), events: [], notes: [], groups: [] };
    const g = inner.nodes.some((n) => n.type === "subgraph") ? expandParticleGraph(inner, resolve ?? (() => undefined)).graph : inner;
    return portRate(g, wire.from);
  }
  const g = expanded ?? (graph.nodes.some((n) => n.type === "subgraph") ? expandParticleGraph(graph, resolve ?? (() => undefined)).graph : graph);
  return portRate(g, from);
}
