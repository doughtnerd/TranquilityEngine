// Particle sub-graph and custom block assets in the Particle Graph (ADR 0095, 0126).
//
// The panel edits a `ParticleGraph`, so an asset opens as one: its operator nodes and edges are the
// graph's nodes and edges, and pseudo-nodes stand for the rest, with their own ports:
//
// - `asset.input`:  one per asset input (an output port named by the input, typed);
// - `asset.output`: one per sub-graph output (an input port);
// - `asset.block`:  one per inner block of a custom block (its inputs as ports and inline fields).
//
// `assetToDoc` and `docToAsset` convert both ways (the asset keeps no layout, so the pseudo-nodes'
// positions are kept in the file's `editor.layout`, which the engine ignores). The same module has
// the rules the editor needs around assets: a Sub-graph node's and a custom block's ports from
// their assets, port renames, the new-asset templates and "Save selection as sub-graph".
import { blockDef, defaultBlock, type BlockInputDef } from "../../engine/scene/particleBlocks";
import type { ContextKind, GraphBlock, GraphEdge, GraphInputValue, GraphNode, GraphProblem, ParticleGraph, Vec2 } from "../../engine/scene/particleGraph";
import { newGraphId } from "../../engine/scene/particleGraphFormat";
import { nodeDef, type NodeDef, type PortDef, type PortType } from "../../engine/scene/particleNodes";
import {
  BLOCK_FORMAT,
  CUSTOM_BLOCK_SUFFIX,
  SUBGRAPH_FORMAT,
  SUBGRAPH_SUFFIX,
  customBlockPorts,
  outputTypeResolved,
  parseBlockAsset,
  parseSubgraphAsset,
  subgraphPorts,
  type AssetPort,
  type AssetResolver,
  type PortValueType,
} from "../../engine/scene/particleSubgraphs";

export type AssetDocKind = "subgraph" | "block";

/** Which kind of particle asset a path is, or null. */
export function assetDocKind(path: string): AssetDocKind | null {
  const p = path.toLowerCase();
  return p.endsWith(SUBGRAPH_SUFFIX) ? "subgraph" : p.endsWith(CUSTOM_BLOCK_SUFFIX) ? "block" : null;
}

export const ASSET_INPUT = "asset.input";
export const ASSET_OUTPUT = "asset.output";
export const ASSET_BLOCK = "asset.block";
export const isPseudo = (type: string) => type === ASSET_INPUT || type === ASSET_OUTPUT || type === ASSET_BLOCK;

export const PORT_TYPES: readonly PortValueType[] = ["number", "vector2", "vector3", "color", "curve", "gradient"];
const CONTEXTS: readonly ContextKind[] = ["spawn", "initialize", "update", "output"];
export const BLOCK_CONTEXTS = CONTEXTS;

/** What the panel keeps of an open asset in `graph.editor.asset`. */
export interface AssetMeta {
  kind: AssetDocKind;
  label?: string;
  contexts?: ContextKind[];
}

export const assetMeta = (graph: ParticleGraph): AssetMeta | null => {
  const m = graph.editor?.asset as AssetMeta | undefined;
  return m && (m.kind === "subgraph" || m.kind === "block") ? m : null;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

// --- editor node definitions -----------------------------------------------------------------------

/** A node input as the canvas draws it: a port (unless `noPort`) and the inline field. */
export interface EditorPort extends PortDef {
  /** The block input it stands for (an `asset.block` node): the inline field's range, choices and forms. */
  block?: BlockInputDef;
  /** An input with only an inline field (a block's flags and choices). */
  noPort?: boolean;
}

/** A node definition as the canvas needs it: the engine's, with a Sub-graph node's ports taken from its asset and the pseudo-nodes' own. */
export interface EditorNodeDef extends Omit<NodeDef, "inputs"> {
  inputs: readonly EditorPort[];
  /** A Sub-graph node whose asset isn't there. */
  missing?: boolean;
  pseudo?: boolean;
}

const toPort = (p: AssetPort): EditorPort => ({ name: p.name, label: p.name, type: p.type, ...(p.default !== undefined ? { default: p.default } : {}) });
const SUBGRAPH_CATEGORY = "Sub-graph" as const;

const portTypeOf = (node: GraphNode): PortValueType => (PORT_TYPES.includes(node.settings?.type as PortValueType) ? (node.settings?.type as PortValueType) : "number");
const portNameOf = (node: GraphNode, fallback: string): string => (typeof node.settings?.name === "string" && node.settings.name ? node.settings.name : fallback);

/** A block input as a node port (flags and choices have no port). */
function blockPort(i: BlockInputDef): EditorPort | null {
  if (i.type === "asset") return null;
  const wireable = i.type === "number" || i.type === "color" || i.type === "vector2" || i.type === "vector3";
  return { name: i.name, label: i.label, type: wireable ? (i.type as PortType) : "number", default: i.default, block: i, ...(wireable ? {} : { noPort: true }) };
}

/**
 * A node's definition for the canvas. A `subgraph` node's inputs and outputs are its asset's (with
 * `missing` set when the asset can't be read); `asset.input`, `asset.output` and `asset.block` are the
 * pseudo-nodes of an open asset. Anything else is the engine's definition.
 */
export function editorNodeDef(node: GraphNode, resolve?: AssetResolver): EditorNodeDef | undefined {
  switch (node.type) {
    case "subgraph": {
      const base = nodeDef("subgraph");
      if (!base) return undefined;
      const ports = subgraphPorts(node, resolve);
      return { ...base, inputs: ports.inputs.map(toPort), outputs: ports.outputs.map(toPort), missing: ports.missing };
    }
    case ASSET_INPUT: {
      const type = portTypeOf(node);
      return {
        type: ASSET_INPUT,
        label: "Input",
        description: "An input of this asset: wire it into the nodes that use it. Its name and type are what users of the asset see.",
        category: SUBGRAPH_CATEGORY,
        inputs: [],
        outputs: [{ name: "out", label: portNameOf(node, "In"), type }],
        settings: [
          { name: "name", label: "Name", kind: "string", default: "In" },
          { name: "type", label: "Type", kind: "enum", default: "number", choices: PORT_TYPES },
          ...(type === "number" ? [{ name: "default", label: "Default", kind: "number" as const, default: 0 }] : []),
        ],
        rate: "uniform",
        pseudo: true,
      };
    }
    case ASSET_OUTPUT:
      return {
        type: ASSET_OUTPUT,
        label: "Output",
        description: "An output of this sub-graph: wire the value it should give into it.",
        category: SUBGRAPH_CATEGORY,
        inputs: [{ name: "in", label: portNameOf(node, "Out"), type: portTypeOf(node) }],
        outputs: [],
        settings: [
          { name: "name", label: "Name", kind: "string", default: "Out" },
          { name: "type", label: "Type", kind: "enum", default: "number", choices: PORT_TYPES },
        ],
        rate: "uniform",
        pseudo: true,
      };
    case ASSET_BLOCK: {
      const def = blockDef(String(node.settings?.block ?? ""));
      return {
        type: ASSET_BLOCK,
        label: def?.label ?? `Unknown block ${node.settings?.block ?? ""}`,
        description: def?.description ?? "A block of this custom block.",
        category: SUBGRAPH_CATEGORY,
        inputs: (def?.inputs ?? []).map(blockPort).filter((p): p is EditorPort => !!p),
        outputs: [],
        rate: "uniform",
        pseudo: true,
      };
    }
    default:
      return nodeDef(node.type);
  }
}

/** A custom block's inputs as block inputs: its own (`asset`) and its asset's. */
export function blockInputs(block: GraphBlock, resolve?: AssetResolver): BlockInputDef[] {
  const base = [...(blockDef(block.type)?.inputs ?? [])];
  if (block.type !== "custom") return base;
  for (const p of customBlockPorts(block, resolve).inputs) base.push(portAsBlockInput(p));
  return base;
}

function portAsBlockInput(p: AssetPort): BlockInputDef {
  const d = p.default;
  switch (p.type) {
    case "vector2":
      return { name: p.name, label: p.name, type: "vector2", default: Array.isArray(d) ? d : [0, 0] };
    case "vector3":
      return { name: p.name, label: p.name, type: "vector3", default: Array.isArray(d) ? d : [0, 0, 0] };
    case "color":
      return { name: p.name, label: p.name, type: "color", forms: ["constant"], default: typeof d === "string" ? d : "#ffffffff" };
    case "curve":
      return { name: p.name, label: p.name, type: "number", forms: ["curve"], default: isObj(d) ? (d as GraphInputValue) : ({ curve: [[0, 1], [1, 1]] } as unknown as GraphInputValue) };
    case "gradient":
      return { name: p.name, label: p.name, type: "color", forms: ["gradient"], default: isObj(d) ? (d as GraphInputValue) : ({ gradient: { colors: [[0, "#ffffff"]], alphas: [] } } as unknown as GraphInputValue) };
    default:
      return { name: p.name, label: p.name, type: "number", forms: ["constant"], default: typeof d === "number" ? d : 0 };
  }
}

// --- validating wires in an open asset -------------------------------------------------------------

const CONSTANT_OF: Record<PortValueType, string> = { number: "constant.number", vector2: "constant.vector2", vector3: "constant.vector3", color: "constant.color", curve: "curve", gradient: "gradient" };

/**
 * An open asset's graph as the engine's wire rules can read it: each Input pseudo-node becomes a
 * constant node of its type (same id, same `out` port), and the Output and block pseudo-nodes are left
 * out (a wire into a node that isn't there is checked like a wire into a block input). Any other
 * graph comes back as it is.
 */
export function wireRulesGraph(graph: ParticleGraph): ParticleGraph {
  if (!graph.nodes.some((n) => isPseudo(n.type))) return graph;
  return {
    ...graph,
    nodes: graph.nodes.flatMap((n) => (n.type === ASSET_INPUT ? [{ id: n.id, type: CONSTANT_OF[portTypeOf(n)], position: n.position }] : isPseudo(n.type) ? [] : [n])),
  };
}

// --- asset <-> document ----------------------------------------------------------------------------

const inId = (name: string) => `in_${name}`;
const outId = (name: string) => `out_${name}`;

/** The default spot of the n-th pseudo-node: inputs in a column left of the nodes, outputs and blocks right of them. */
function spot(side: "left" | "right", n: number, nodes: readonly GraphNode[]): Vec2 {
  const xs = nodes.map((p) => p.position[0]);
  return side === "left" ? [Math.min(0, ...xs) - 260, n * 100] : [Math.max(0, ...xs) + 300, n * 140];
}

function emptyDoc(meta: AssetMeta): ParticleGraph {
  return { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [], editor: { asset: meta } };
}

/** An asset's JSON as a graph document for the panel, with what's wrong with it. */
export function assetToDoc(raw: unknown, kind: AssetDocKind): { graph: ParticleGraph; problems: GraphProblem[] } {
  const what = kind === "subgraph" ? "particle sub-graph" : "particle block";
  const asset = kind === "subgraph" ? parseSubgraphAsset(raw) : parseBlockAsset(raw);
  if (!asset) return { graph: emptyDoc({ kind }), problems: [{ severity: "error", message: `This file isn't a ${what} (it should have format ${kind === "subgraph" ? SUBGRAPH_FORMAT : BLOCK_FORMAT}).` }] };
  const rawEditor = isObj((raw as Record<string, unknown>).editor) ? ((raw as Record<string, unknown>).editor as Record<string, unknown>) : {};
  const layout = isObj(rawEditor.layout) ? (rawEditor.layout as Record<string, unknown>) : {};
  const at = (id: string, fallback: Vec2): Vec2 => {
    const p = layout[id];
    return Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" ? [p[0], p[1]] : fallback;
  };
  const nodes: GraphNode[] = clone(asset.nodes);
  const edges: GraphEdge[] = [];
  const inner = asset.nodes;
  asset.inputs.forEach((p, i) =>
    nodes.push({ id: inId(p.name), type: ASSET_INPUT, position: at(inId(p.name), spot("left", i, inner)), settings: { name: p.name, type: p.type, ...(typeof p.default === "number" ? { default: p.default } : {}) } }),
  );
  if (kind === "subgraph") {
    (asset as ReturnType<typeof parseSubgraphAsset> & object).outputs.forEach((p, i) => nodes.push({ id: outId(p.name), type: ASSET_OUTPUT, position: at(outId(p.name), spot("right", i, inner)), settings: { name: p.name, type: p.type } }));
  } else {
    const blockAsset = asset as NonNullable<ReturnType<typeof parseBlockAsset>>;
    blockAsset.blocks.forEach((b, i) => {
      const node: GraphNode = { id: b.id, type: ASSET_BLOCK, position: at(b.id, spot("right", i, inner)), settings: { block: b.type, ...(b.enabled === false ? { enabled: false } : {}) }, inputs: clone(b.inputs) };
      nodes.push(node);
    });
  }
  const names = new Set(asset.inputs.map((p) => p.name));
  for (const e of asset.edges) {
    const from = e.from.startsWith("input.") ? (names.has(e.from.slice(6)) ? `${inId(e.from.slice(6))}.out` : null) : e.from;
    const to = e.to.startsWith("output.") ? `${outId(e.to.slice(7))}.in` : e.to.startsWith("block.") ? e.to.slice(6) : e.to;
    if (from && to) edges.push({ from, to });
  }
  const { layout: _layout, ...restEditor } = rawEditor;
  const meta: AssetMeta = { kind, ...(kind === "block" ? { label: (asset as NonNullable<ReturnType<typeof parseBlockAsset>>).label, contexts: [...(asset as NonNullable<ReturnType<typeof parseBlockAsset>>).contexts] } : {}) };
  return { graph: { ...emptyDoc(meta), nodes, edges, editor: { ...restEditor, asset: meta } }, problems: [] };
}

/** An open asset's document as the asset's JSON (the pseudo-nodes become inputs, outputs and blocks; their positions go to `editor.layout`). */
export function docToAsset(doc: ParticleGraph): Record<string, unknown> {
  const meta = assetMeta(doc) ?? { kind: "subgraph" as const };
  const pseudo = new Map(doc.nodes.filter((n) => isPseudo(n.type)).map((n) => [n.id, n]));
  const uniqueNames = (list: GraphNode[], fallback: string): string[] => {
    const seen = new Set<string>();
    return list.map((n) => {
      const base = portNameOf(n, fallback).replace(/\./g, "") || fallback;
      let name = base;
      for (let k = 2; seen.has(name); k++) name = `${base} ${k}`;
      seen.add(name);
      return name;
    });
  };
  const inputNodes = doc.nodes.filter((n) => n.type === ASSET_INPUT);
  const outputNodes = doc.nodes.filter((n) => n.type === ASSET_OUTPUT);
  const inputNames = uniqueNames(inputNodes, "In");
  const outputNames = uniqueNames(outputNodes, "Out");
  const nameOf = new Map<string, string>([...inputNodes.map((n, i) => [n.id, inputNames[i]] as const), ...outputNodes.map((n, i) => [n.id, outputNames[i]] as const)]);
  const inputs = inputNodes.map((n, i) => {
    const d = n.settings?.default;
    return { name: inputNames[i], type: portTypeOf(n), ...(typeof d === "number" && portTypeOf(n) === "number" && d !== 0 ? { default: d } : {}) };
  });
  const outputs = outputNodes.map((n, i) => ({ name: outputNames[i], type: portTypeOf(n) }));
  const blocks: GraphBlock[] = doc.nodes
    .filter((n) => n.type === ASSET_BLOCK)
    .map((n) => ({ id: n.id, type: String(n.settings?.block ?? ""), ...(n.settings?.enabled === false ? { enabled: false } : {}), inputs: clone(n.inputs ?? {}) }));
  const head = (ref: string) => ref.slice(0, ref.lastIndexOf("."));
  const edges: GraphEdge[] = doc.edges.map((e) => {
    const f = pseudo.get(head(e.from));
    const t = pseudo.get(head(e.to));
    return {
      from: f?.type === ASSET_INPUT ? `input.${nameOf.get(f.id)}` : e.from,
      to: t?.type === ASSET_OUTPUT ? `output.${nameOf.get(t.id)}` : t?.type === ASSET_BLOCK ? `block.${e.to}` : e.to,
    };
  });
  const layout: Record<string, Vec2> = {};
  for (const n of pseudo.values()) layout[n.id] = [n.position[0], n.position[1]];
  const { asset: _asset, ...restEditor } = doc.editor ?? {};
  const editor = { ...restEditor, ...(Object.keys(layout).length ? { layout } : {}) };
  const nodes = doc.nodes.filter((n) => !isPseudo(n.type)).map((n) => clone(n));
  const out: Record<string, unknown> = { format: meta.kind === "block" ? BLOCK_FORMAT : SUBGRAPH_FORMAT };
  if (meta.kind === "block") {
    out.label = meta.label ?? "Custom block";
    out.contexts = meta.contexts?.length ? meta.contexts : ["update"];
  }
  out.inputs = inputs;
  if (meta.kind === "subgraph") out.outputs = outputs;
  out.nodes = nodes;
  if (meta.kind === "block") out.blocks = blocks;
  out.edges = edges;
  if (Object.keys(editor).length) out.editor = editor;
  return out;
}

/** An asset's file text: JSON, with arrays of plain values on one line like the other particle files. */
export function formatAsset(asset: Record<string, unknown>): string {
  const text = JSON.stringify(asset, null, 2).replace(/\[(\s*(?:-?[\d.eE+-]+|"[^"\n]*"|true|false|null)(?:,\s*(?:-?[\d.eE+-]+|"[^"\n]*"|true|false|null))*\s*)\]/g, (_, items: string) => `[${items.trim().replace(/\n\s*/g, " ")}]`);
  return `${text}\n`;
}

// --- editing the pseudo-nodes ----------------------------------------------------------------------

/** Why `name` can't be the name of an Input or Output node `id`, or null (names are unique among their kind, and have no dots). */
export function whyNotPortName(graph: ParticleGraph, id: string, name: string): string | null {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return "That node isn't there.";
  if (name.trim() === "") return "A name can't be empty.";
  if (name.includes(".")) return "A name can't have a dot.";
  if (graph.nodes.some((n) => n.id !== id && n.type === node.type && portNameOf(n, "") === name.trim())) return `There's already an ${node.type === ASSET_INPUT ? "input" : "output"} named "${name.trim()}".`;
  return null;
}

/** A free port name for a new Input or Output node: `base`, else `base 2`… */
export function freePortName(graph: ParticleGraph, type: string, base: string): string {
  const taken = new Set(graph.nodes.filter((n) => n.type === type).map((n) => portNameOf(n, "")));
  let name = base;
  for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
  return name;
}

/** Add an Input, Output or block pseudo-node (`settings.block` names the block type). */
export function addPseudoNode(graph: ParticleGraph, type: string, position: Vec2, settings: Record<string, unknown> = {}): { graph: ParticleGraph; id: string } {
  const g = clone(graph);
  const round = (n: number) => Math.round(n);
  const pos: Vec2 = [round(position[0]), round(position[1])];
  if (type === ASSET_BLOCK) {
    const blockType = String(settings.block ?? "");
    const id = newGraphId(graph, "b");
    g.nodes.push({ id, type, position: pos, settings: { block: blockType }, inputs: defaultBlock(blockType, id).inputs });
    return { graph: g, id };
  }
  const isIn = type === ASSET_INPUT;
  const name = freePortName(graph, type, String(settings.name ?? (isIn ? "In" : "Out")));
  let id = isIn ? inId(name) : outId(name);
  while (g.nodes.some((n) => n.id === id)) id += "_";
  g.nodes.push({ id, type, position: pos, settings: { name, type: PORT_TYPES.includes(settings.type as PortValueType) ? settings.type : "number" } });
  return { graph: g, id };
}

// --- new assets ------------------------------------------------------------------------------------

/** A new sub-graph: one number input `In` wired straight through to the number output `Out`. */
export function subgraphTemplate(): Record<string, unknown> {
  return {
    format: SUBGRAPH_FORMAT,
    inputs: [{ name: "In", type: "number" }],
    outputs: [{ name: "Out", type: "number" }],
    nodes: [],
    edges: [{ from: "input.In", to: "output.Out" }],
  };
}

/** A new custom block: one number input `Value` driving a Set Size block, for the Update context. */
export function blockTemplate(): Record<string, unknown> {
  return {
    format: BLOCK_FORMAT,
    label: "New Block",
    contexts: ["update"],
    inputs: [{ name: "Value", type: "number", default: 1 }],
    nodes: [],
    blocks: [{ id: "b1", type: "attribute.size", inputs: { mode: "set", value: 1 } }],
    edges: [{ from: "input.Value", to: "block.b1.value" }],
  };
}

// --- save selection as sub-graph -------------------------------------------------------------------

/** Node types that can't move into an asset: properties (the Blackboard belongs to the effect), event nodes, pseudo-nodes. */
export const canMoveToAsset = (n: GraphNode): boolean => n.type !== "property" && !n.type.startsWith("event.") && !isPseudo(n.type);

const nodeIdOf = (ref: string) => ref.slice(0, ref.lastIndexOf("."));
const asPortType = (t: PortType | null | undefined, fallback: PortValueType = "number"): PortValueType => (t && PORT_TYPES.includes(t as PortValueType) ? (t as PortValueType) : fallback);

export interface ExtractedSubgraph {
  /** The graph with the selected nodes replaced by a Sub-graph node. */
  graph: ParticleGraph;
  /** The sub-graph asset's JSON (`myco.particlesubgraph@1`). */
  asset: Record<string, unknown>;
  /** The new Sub-graph node's id. */
  node: string;
  inputs: { name: string; type: PortValueType }[];
  outputs: { name: string; type: PortValueType }[];
}

/**
 * Move the selected operator nodes into a new sub-graph asset (`assetRef` is `asset:<path>`): a wire
 * from outside into the selection becomes an input of the asset (one per distinct source, named for
 * the input it feeds), a wire from the selection to a node or block outside becomes an output (one
 * per distinct source port); wires among the selected nodes stay inside. The nodes are replaced by
 * one Sub-graph node at their top-left, wired as they were. Property and event nodes stay where they
 * are. Null when no selected node can move.
 */
export function extractSubgraph(graph: ParticleGraph, ids: Iterable<string>, assetRef: string, resolve?: AssetResolver): ExtractedSubgraph | null {
  const picked = new Set(ids);
  const moving = graph.nodes.filter((n) => picked.has(n.id) && canMoveToAsset(n));
  if (moving.length === 0) return null;
  const inside = new Set(moving.map((n) => n.id));
  const g = clone(graph);
  const nodeId = newGraphId(graph, "n");
  const x0 = Math.min(...moving.map((n) => n.position[0])), y0 = Math.min(...moving.map((n) => n.position[1]));
  const portLabel = (ref: string, side: "inputs" | "outputs"): string => {
    const node = graph.nodes.find((n) => n.id === nodeIdOf(ref));
    const def = node && editorNodeDef(node, resolve);
    const port = ref.slice(ref.lastIndexOf(".") + 1);
    const p = def?.[side].find((q) => q.name === port);
    if (side === "outputs" && def && def.outputs.length > 1) return `${def.label} ${p?.label ?? port}`;
    return (side === "outputs" ? def?.label : p?.label) ?? port;
  };
  const cleanName = (s: string) => s.replace(/\./g, "").trim() || "Value";
  const unique = (base: string, taken: Set<string>) => {
    let name = cleanName(base);
    for (let k = 2; taken.has(name); k++) name = `${cleanName(base)} ${k}`;
    taken.add(name);
    return name;
  };

  const inputs: ExtractedSubgraph["inputs"] = [];
  const inputOf = new Map<string, string>(); // outside source ref -> input name
  const inputNames = new Set<string>();
  const outputs: ExtractedSubgraph["outputs"] = [];
  const outputOf = new Map<string, string>(); // inside source ref -> output name
  const outputNames = new Set<string>();
  const assetEdges: GraphEdge[] = [];
  const outerEdges: GraphEdge[] = [];

  for (const e of graph.edges) {
    const fromIn = inside.has(nodeIdOf(e.from));
    const toIn = inside.has(nodeIdOf(e.to));
    if (fromIn && toIn) assetEdges.push({ from: e.from, to: e.to });
    else if (!fromIn && toIn) {
      let name = inputOf.get(e.from);
      if (!name) {
        name = unique(portLabel(e.to, "inputs"), inputNames);
        inputOf.set(e.from, name);
        const src = graph.nodes.find((n) => n.id === nodeIdOf(e.from));
        const dstDef = editorNodeDef(graph.nodes.find((n) => n.id === nodeIdOf(e.to))!, resolve);
        const dstType = dstDef?.inputs.find((p) => p.name === e.to.slice(e.to.lastIndexOf(".") + 1))?.type;
        const srcType = src ? outputTypeResolved(graph, src, e.from.slice(e.from.lastIndexOf(".") + 1), resolve) : null;
        inputs.push({ name, type: asPortType(srcType, asPortType(dstType)) });
      }
      assetEdges.push({ from: `input.${name}`, to: e.to });
      outerEdges.push({ from: e.from, to: `${nodeId}.${name}` });
    } else if (fromIn && !toIn) {
      let name = outputOf.get(e.from);
      if (!name) {
        name = unique(portLabel(e.from, "outputs"), outputNames);
        outputOf.set(e.from, name);
        const src = graph.nodes.find((n) => n.id === nodeIdOf(e.from))!;
        outputs.push({ name, type: asPortType(outputTypeResolved(graph, src, e.from.slice(e.from.lastIndexOf(".") + 1), resolve)) });
        assetEdges.push({ from: e.from, to: `output.${name}` });
      }
      outerEdges.push({ from: `${nodeId}.${name}`, to: e.to });
    } else outerEdges.push({ from: e.from, to: e.to });
  }

  g.nodes = g.nodes.filter((n) => !inside.has(n.id));
  g.nodes.push({ id: nodeId, type: "subgraph", position: [Math.round(x0), Math.round(y0)], settings: { asset: assetRef } });
  g.edges = outerEdges;
  g.groups = g.groups.map((gr) => ({ ...gr, members: gr.members.filter((m) => !inside.has(m)) })).filter((gr) => gr.members.length > 0);

  const asset: Record<string, unknown> = {
    format: SUBGRAPH_FORMAT,
    inputs: inputs.map((p) => ({ name: p.name, type: p.type })),
    outputs: outputs.map((p) => ({ name: p.name, type: p.type })),
    nodes: moving.map((n) => ({ ...clone(n), position: [Math.round(n.position[0] - x0), Math.round(n.position[1] - y0)] })),
    edges: assetEdges,
  };
  return { graph: g, asset, node: nodeId, inputs, outputs };
}

/** Change an open asset's label or contexts (custom blocks). */
export function setAssetMeta(graph: ParticleGraph, patch: Partial<Omit<AssetMeta, "kind">>): ParticleGraph {
  const meta = assetMeta(graph);
  if (!meta) return graph;
  const next: AssetMeta = { ...meta, ...patch };
  if (JSON.stringify(next) === JSON.stringify(meta)) return graph;
  return { ...clone(graph), editor: { ...graph.editor, asset: next } };
}
