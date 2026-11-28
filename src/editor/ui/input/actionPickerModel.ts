// The action picker's model (ADR 0433): a mapping's action chosen from a searchable list grouped by set. Sets are
// sorted by id and actions by name, A to Z; a set folds (its fold is remembered, and the engine's sets start folded).
// Search matches action names and set ids (so "vehicle" lists that whole set) and opens every set with a match. Under
// the matches come the rows that make a missing action where it's needed: Create "name" in each asset set without an
// action of that name, then New set…. One highlight walks every row (↑ ↓ across sections); Enter picks it.
import type { ActionKind } from "../../../engine/input/actions";

/** A set the picker lists. */
export interface PickerSet {
  readonly id: string;
  /** An asset set: actions can be created in it. */
  readonly editable: boolean;
  readonly actions: readonly { readonly name: string; readonly kind: ActionKind }[];
}

/** A stretch of text that matches the search: before, the match, after. */
export interface Highlight {
  readonly pre: string;
  readonly mid: string;
  readonly post: string;
}

export type PickerRow =
  | { readonly kind: "action"; readonly set: string; readonly name: string; readonly type: ActionKind; readonly label: Highlight }
  | { readonly kind: "create"; readonly set: string; readonly name: string }
  | { readonly kind: "newSet"; readonly name: string };

export interface PickerSection {
  readonly id: string;
  /** Shown folded: its rows aren't listed (searching unfolds every set with a match). */
  readonly folded: boolean;
  /** Its actions listed (all, or the matches), and how many it has. */
  readonly shown: number;
  readonly total: number;
  readonly rows: readonly PickerRow[];
}

export interface PickerModel {
  readonly sections: readonly PickerSection[];
  /** The Create and New set rows, after every section. */
  readonly create: readonly PickerRow[];
  /** Every row the highlight can land on, in order. */
  readonly rows: readonly PickerRow[];
  /** The search is a name no set has, and no set matches it. */
  readonly noMatch: boolean;
  /** Why the search can't be an action's name (shown instead of Create), or null. */
  readonly badName: string | null;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function highlight(text: string, query: string): Highlight {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return i < 0 ? { pre: text, mid: "", post: "" } : { pre: text.slice(0, i), mid: text.slice(i, i + query.length), post: text.slice(i + query.length) };
}

/** The sets the picker starts with folded when it has never been opened: the engine's own. */
export const foldedByDefault = (id: string): boolean => id.startsWith("engine.");

/**
 * The picker's sections and rows for `query`. `folded` says which sets the user folded or unfolded (by id: true
 * folded); a set it doesn't name follows `foldedByDefault`.
 */
export function pickerModel(sets: readonly PickerSet[], query: string, folded: ReadonlyMap<string, boolean>): PickerModel {
  const q = query.trim();
  const lower = q.toLowerCase();
  const sorted = [...sets].sort((a, b) => a.id.localeCompare(b.id));
  const sections: PickerSection[] = [];
  for (const s of sorted) {
    const actions = [...s.actions].sort((a, b) => a.name.localeCompare(b.name));
    const setMatches = !!lower && s.id.toLowerCase().includes(lower);
    const listed = !lower || setMatches ? actions : actions.filter((a) => a.name.toLowerCase().includes(lower));
    if (lower && listed.length === 0) continue;
    const isFolded = lower ? false : (folded.get(s.id) ?? foldedByDefault(s.id));
    sections.push({
      id: s.id,
      folded: isFolded,
      shown: listed.length,
      total: actions.length,
      rows: isFolded ? [] : listed.map((a) => ({ kind: "action", set: s.id, name: a.name, type: a.kind, label: highlight(a.name, setMatches ? "" : q) })),
    });
  }
  const badName = q && !NAME.test(q) ? "An action's name is letters, digits and underscores, starting with a letter." : null;
  const create: PickerRow[] = [];
  if (q && !badName) {
    for (const s of sorted) if (s.editable && !s.actions.some((a) => a.name === q)) create.push({ kind: "create", set: s.id, name: q });
    create.push({ kind: "newSet", name: q });
  }
  const noMatch = !!q && sections.length === 0;
  return { sections, create, rows: [...sections.flatMap((s) => s.rows), ...create], noMatch, badName };
}

/** The row the highlight starts on: the current action if listed, else an exact match, else the first row. */
export function initialHighlight(model: PickerModel, current: { set: string; name: string } | null, query: string): number {
  const rows = model.rows;
  if (!query && current) {
    const i = rows.findIndex((r) => r.kind === "action" && r.set === current.set && r.name === current.name);
    if (i >= 0) return i;
  }
  const q = query.trim();
  const exact = rows.findIndex((r) => r.kind === "action" && r.name === q);
  if (exact >= 0) return exact;
  return rows.length ? 0 : -1;
}

/** The highlight moved by `by` rows (↑ −1, ↓ +1), wrapping round. */
export function moveHighlight(model: PickerModel, at: number, by: number): number {
  const n = model.rows.length;
  if (n === 0) return -1;
  if (at < 0) return by > 0 ? 0 : n - 1;
  return (((at + by) % n) + n) % n;
}
