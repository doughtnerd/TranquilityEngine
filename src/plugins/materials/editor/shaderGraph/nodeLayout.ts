// Where everything sits on a shader graph node (ADR 0046). Fixed rows, so port positions are known
// without measuring the DOM: the panel draws from them and xyflow's core hit-tests with them.
// Rows from the top: the header, each output, each input, then each setting.
import { nodeDef, nodePorts, settingValue, type PortDef, type SettingDef, type ValueType } from "../../../../engine/render/shaderGraph/nodes";
import type { GraphNode, ShaderGraph } from "../../../../engine/scene/shaderGraph";

export const HEADER = 26;
export const ROW = 22;
export const PAD = 6;
export const BASE_WIDTH = 176;
/** A node preview's height (ADR 0048), under the rows. */
export const PREVIEW = 120;
/** Extra width per inline number field beyond the first. */
const FIELD_WIDTH = 40;

export type NodeRow = { kind: "output"; port: PortDef } | { kind: "input"; port: PortDef } | { kind: "setting"; setting: SettingDef };

export interface NodeBox {
  width: number;
  height: number;
  rows: NodeRow[];
  /** The preview's top, relative to the node, or null without one (collapsed, or no number output). */
  previewTop: number | null;
}

/** True if a node can show a preview: it has a number output and isn't the output node or a property (as in Unity). */
export const hasPreview = (node: GraphNode, graph: ShaderGraph) => node.type !== "output" && node.type !== "property" && nodePorts(node, graph).outputs.some((p) => p.type !== "texture");

/** How many number fields an input shows inline (0: none). */
export function inlineFields(port: PortDef, connected: boolean, dynamic: ValueType): number {
  if (connected || port.bind || port.type === "texture" || port.color) return 0;
  const t = port.type === "dynamic" ? dynamic : port.type;
  return t === "float" ? 1 : t === "vec2" ? 2 : t === "vec3" ? 3 : 4;
}

/** A node's size and rows. `connected` says which inputs have a connection; `dynamic` is the node's resolved dynamic type. */
export function nodeBox(node: GraphNode, graph: ShaderGraph, connected: (port: string) => boolean, dynamic: ValueType = "float"): NodeBox {
  const ports = nodePorts(node, graph);
  const settings = nodeDef(node.type)?.settings ?? [];
  const rows: NodeRow[] = [...ports.outputs.map((port) => ({ kind: "output" as const, port })), ...ports.inputs.map((port) => ({ kind: "input" as const, port })), ...settings.map((setting) => ({ kind: "setting" as const, setting }))];
  const fields = Math.max(1, ...ports.inputs.map((p) => inlineFields(p, connected(p.id), dynamic)));
  const width = BASE_WIDTH + (fields - 1) * FIELD_WIDTH + (node.type === "output" ? 24 : 0);
  const rowsBottom = HEADER + rows.length * ROW + PAD;
  const preview = node.preview !== false && hasPreview(node, graph);
  return { width, height: rowsBottom + (preview ? PREVIEW : 0), rows, previewTop: preview ? rowsBottom : null };
}

/** A port's centre relative to the node's top-left, or null if the node has no such port. */
export function portOffset(box: NodeBox, side: "input" | "output", port: string): { x: number; y: number } | null {
  const i = box.rows.findIndex((r) => r.kind === side && r.port.id === port);
  if (i < 0) return null;
  return { x: side === "input" ? 0 : box.width, y: HEADER + i * ROW + ROW / 2 };
}

/** The node's title: a property node shows its property's name. */
export function nodeTitle(node: GraphNode): string {
  const def = nodeDef(node.type);
  if (!def) return node.type;
  if (node.type === "property") return node.settings?.property || "Property";
  if (node.type === "customFunction") return node.function?.name || def.title;
  if (node.type === "subgraph") {
    const path = node.settings?.subgraph ?? "";
    return path ? path.slice(path.lastIndexOf("/") + 1).replace(/\.shadersubgraph\.json$/i, "") : def.title;
  }
  return def.title;
}

export { settingValue };
