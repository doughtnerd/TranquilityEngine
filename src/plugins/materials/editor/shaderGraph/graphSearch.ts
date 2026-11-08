// Find inside a shader graph (ADR 0117): a pure matcher over node titles, types, property names
// and comment text (sticky notes, group titles). The panel lists the matches and frames the chosen one.
import { nodeDef } from "../../../../engine/render/shaderGraph/nodes";
import type { ShaderGraph } from "../../../../engine/scene/shaderGraph";
import { nodeTitle } from "./nodeLayout";

export interface GraphMatch {
  kind: "node" | "note" | "group";
  /** The node, note or group id. */
  id: string;
  /** The line shown in the results list. */
  label: string;
  /** What matched: `title`, `type`, `property`, `setting`, `text`. */
  field: "title" | "type" | "property" | "setting" | "text";
  /** The node ids to frame: the node itself, or a group's members (a note frames itself). */
  frame: string[];
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Every node, note and group of `graph` matching `query` (case-insensitive substring; several words
 * must all match somewhere in the same item). An empty query matches nothing. Results keep the
 * graph's order: nodes, then notes, then groups.
 */
export function searchGraph(graph: ShaderGraph, query: string): GraphMatch[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const all = (fields: [GraphMatch["field"], string][]): GraphMatch["field"] | null => {
    const hay = fields.map(([, v]) => norm(v));
    if (!words.every((w) => hay.some((h) => h.includes(w)))) return null;
    // Report the first field that matches the first word.
    const i = hay.findIndex((h) => h.includes(words[0]!));
    return fields[i < 0 ? 0 : i]![0];
  };
  const out: GraphMatch[] = [];
  for (const n of graph.nodes) {
    const title = nodeTitle(n);
    const fields: [GraphMatch["field"], string][] = [["title", title], ["type", `${n.type} ${nodeDef(n.type)?.title ?? ""}`]];
    if (n.settings?.property) fields.push(["property", n.settings.property]);
    for (const v of Object.values(n.settings ?? {})) if (typeof v === "string" && v) fields.push(["setting", v]);
    if (n.function?.name) fields.push(["title", n.function.name]);
    const field = all(fields);
    if (field) out.push({ kind: "node", id: n.id, label: title, field, frame: [n.id] });
  }
  for (const note of graph.notes ?? []) {
    if (!all([["text", note.text]])) continue;
    const first = note.text.split("\n").find((l) => l.trim()) ?? "Note";
    out.push({ kind: "note", id: note.id, label: first.length > 48 ? `${first.slice(0, 47)}…` : first, field: "text", frame: [] });
  }
  for (const g of graph.groups ?? []) {
    if (!all([["text", g.title]])) continue;
    out.push({ kind: "group", id: g.id, label: g.title, field: "text", frame: [...g.nodes] });
  }
  return out;
}

/** The index after `from` in a list of `count` results, wrapping; `-1` steps back. */
export function cycleIndex(from: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (from < 0) return step === 1 ? 0 : count - 1;
  return (from + step + count) % count;
}
