// Find in a graph (ADR 0117, moved into the graph layer by ADR 0259): a pure matcher over a graph's
// items, sticky notes and group titles. Each graph says what its items are called and what else a
// query may match on them (`FindItem`); notes and groups come from the graph document, the same in
// every graph. `useGraphFind` (`./findBox.tsx`) lists the matches and frames the chosen one.
import type { GraphGroupData, GraphNoteData } from "./document";

/** One canvas item as find reads it: the line shown for it, and its searchable text by field. */
export interface FindItem {
  id: string;
  /** The line shown in the results list (the item's title on the canvas). */
  label: string;
  /** What a query matches, in order: `["title", "Multiply"]`, `["type", "multiply Multiply"]`, `["property", "Tint"]`… The first is the label's field. */
  fields: readonly (readonly [string, string])[];
}

export interface GraphMatch {
  kind: "node" | "note" | "group";
  /** The item, note or group id. */
  id: string;
  /** The line shown in the results list. */
  label: string;
  /** What matched: the item field's name, or `text` for a note or a group title. */
  field: string;
  /** The item ids to select and frame: the item itself, or a group's members (a note frames itself). */
  frame: string[];
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Every item, note and group matching `query` (case-insensitive substrings; several words must all
 * match somewhere in the same item). An empty query matches nothing. Results keep the graph's order:
 * items, then notes, then groups.
 */
export function findInGraph(items: readonly FindItem[], notes: readonly GraphNoteData[], groups: readonly GraphGroupData[], query: string): GraphMatch[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const matched = (fields: readonly (readonly [string, string])[]): string | null => {
    const hay = fields.map(([, v]) => norm(v));
    if (!words.every((w) => hay.some((h) => h.includes(w)))) return null;
    // Report the first field that matches the first word.
    const i = hay.findIndex((h) => h.includes(words[0]!));
    return fields[i < 0 ? 0 : i]![0];
  };
  const out: GraphMatch[] = [];
  for (const item of items) {
    const field = matched(item.fields);
    if (field) out.push({ kind: "node", id: item.id, label: item.label, field, frame: [item.id] });
  }
  for (const note of notes) {
    if (!matched([["text", note.text]])) continue;
    const first = note.text.split("\n").find((l) => l.trim()) ?? "Note";
    out.push({ kind: "note", id: note.id, label: first.length > 48 ? `${first.slice(0, 47)}…` : first, field: "text", frame: [] });
  }
  for (const g of groups) {
    if (!matched([["text", g.title]])) continue;
    out.push({ kind: "group", id: g.id, label: g.title, field: "text", frame: [...g.members] });
  }
  return out;
}

/** The index after `from` in a list of `count` results, wrapping; `-1` steps back. */
export function cycleIndex(from: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (from < 0) return step === 1 ? 0 : count - 1;
  return (from + step + count) % count;
}
