// What the Particle Graph's search offers (ADR 0060), by where it opened: over a context, the
// blocks that fit there; on the canvas, new systems from templates, value and operator nodes by
// category, the Blackboard's properties and event nodes.
import type { ContextKind, ParticleGraph } from "../../../../../engine/scene/particleGraph";
import { blocksFor } from "../../../../../engine/scene/particleBlocks";
import { ASSET_BLOCK, ASSET_INPUT, ASSET_OUTPUT, type AssetMeta } from "../../particleGraph/assetDocs";
import { NODES, type NodeCategory } from "../../../../../engine/scene/particleNodes";
import type { TemplateKind } from "../../particleGraph/graphEdit";
import { CONTEXT_TITLES } from "./layout";
import type { SearchItem } from "../../../../../editor/sdk";

export type SearchPick = { kind: "block"; type: string } | { kind: "node"; type: string; settings?: Record<string, unknown> } | { kind: "system"; template: TemplateKind };

export interface GraphSearchItem extends SearchItem {
  pick: SearchPick;
}

/** Blocks for a context, grouped: positions apart in Initialize, events apart in Update. */
export function blockItems(kind: ContextKind): GraphSearchItem[] {
  const group = (label: string, type: string) => {
    if (label.startsWith("Position:")) return "Position";
    if (type === "update.triggerEvent") return "Events";
    return CONTEXT_TITLES[kind];
  };
  const items = blocksFor(kind).map((d) => ({ key: d.type, label: d.label, category: group(d.label, d.type), keywords: `${d.label} ${d.description} ${d.type}`, pick: { kind: "block", type: d.type } as SearchPick }));
  const order = [CONTEXT_TITLES[kind], "Position", "Events"];
  return items.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

const CATEGORY_ORDER: NodeCategory[] = ["Value", "Particle", "Sub-graph", "Property", "Time", "Math", "Trigonometry", "Sampling", "Vector", "Colour", "Event"];
const TEMPLATES: [TemplateKind, string, string][] = [
  ["empty", "System: Empty", "empty blank new system"],
  ["simpleLoop", "System: Simple Loop", "simple loop new system continuous"],
  ["burst", "System: Burst", "burst explosion new system one shot"],
  ["trail", "System: Trail", "trail ribbon new system"],
  ["gpuFountain", "System: GPU Fountain", "gpu kernel webgpu compute fountain many particles operators outputs new system"],
];

/** Systems, nodes, properties and events for the empty canvas. */
export function canvasItems(graph: ParticleGraph): GraphSearchItem[] {
  const items: GraphSearchItem[] = TEMPLATES.map(([template, label, kw]) => ({ key: `system:${template}`, label, category: "Systems", keywords: `${label} ${kw}`, pick: { kind: "system", template } }));
  for (const category of CATEGORY_ORDER) {
    if (category === "Property") {
      for (const p of graph.properties) items.push({ key: `property:${p.name}`, label: p.name, category: "Properties", keywords: `${p.name} property blackboard ${p.type}`, pick: { kind: "node", type: "property", settings: { name: p.name } } });
      if (graph.properties.length) continue;
    }
    for (const d of NODES.filter((n) => n.category === category)) {
      items.push({ key: d.type, label: d.label, category: category === "Property" ? "Properties" : category, keywords: `${d.label} ${d.category} ${d.description} ${d.type}`, pick: { kind: "node", type: d.type } });
    }
  }
  return items;
}

/**
 * What the canvas of an open sub-graph or custom block asset offers: operator nodes (no systems, properties or
 * events: those belong to an effect), Input and Output nodes (sub-graphs), and the blocks the asset's contexts
 * take (custom blocks).
 */
export function assetCanvasItems(meta: AssetMeta): GraphSearchItem[] {
  const items: GraphSearchItem[] = [];
  items.push({ key: "asset:input", label: "Input", category: "Asset", keywords: "input port parameter asset", pick: { kind: "node", type: ASSET_INPUT } });
  if (meta.kind === "subgraph") items.push({ key: "asset:output", label: "Output", category: "Asset", keywords: "output port result asset", pick: { kind: "node", type: ASSET_OUTPUT } });
  if (meta.kind === "block") {
    const contexts = meta.contexts?.length ? meta.contexts : (["update"] as ContextKind[]);
    for (const d of blocksFor("update").concat(blocksFor("initialize"), blocksFor("spawn"), blocksFor("output")).filter((d, i, all) => all.indexOf(d) === i)) {
      if (d.type === "custom" || d.event || !d.contexts.some((c) => contexts.includes(c))) continue;
      items.push({ key: `block:${d.type}`, label: d.label, category: "Blocks", keywords: `block ${d.label} ${d.description} ${d.type}`, pick: { kind: "node", type: ASSET_BLOCK, settings: { block: d.type } } });
    }
  }
  for (const category of CATEGORY_ORDER) {
    if (category === "Property" || category === "Event") continue;
    for (const d of NODES.filter((n) => n.category === category)) items.push({ key: d.type, label: d.label, category, keywords: `${d.label} ${d.category} ${d.description} ${d.type}`, pick: { kind: "node", type: d.type } });
  }
  return items;
}

/** Nodes only (when a dropped wire asks for something to connect to). */
export const nodeItems = (graph: ParticleGraph): GraphSearchItem[] => canvasItems(graph).filter((i) => i.pick.kind === "node");
