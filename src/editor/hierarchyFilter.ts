// Hierarchy search (ADR 0022): which rows match a query and which show. Words match node names
// (case-insensitive, all must match); `t:Type` matches a component type by its short name
// (`t:camera` finds engine.Camera, `t:Bird` a script's game.Bird). Matching rows show with their
// ancestors, so each stays in place in the tree.
import type { SceneDocument } from "./document";
import { ancestorKeys, hierarchyEntries } from "./selectionModel";

export interface HierarchyQuery {
  /** Lower-case words every name must contain. */
  readonly words: readonly string[];
  /** Lower-case component type fragments every node must have a component matching. */
  readonly types: readonly string[];
}

/** Parse a search box's text; null when it's empty. */
function parseHierarchyQuery(text: string): HierarchyQuery | null {
  const words: string[] = [], types: string[] = [];
  for (const part of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (part.startsWith("t:")) {
      if (part.length > 2) types.push(part.slice(2));
    } else words.push(part);
  }
  return words.length || types.length ? { words, types } : null;
}

/**
 * Component types of every hierarchy row, by row key, as the game makes them: the document's
 * resolved view (ADR 0280), so a prefab instance's and its inner nodes' types come from their
 * files with every override applied (added and removed components, added nodes).
 */
function componentTypes(doc: SceneDocument): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of doc.resolve().nodes) out.set(n.path.join("/"), n.components.map((c) => c.type));
  return out;
}

const shortName = (type: string) => type.slice(type.lastIndexOf(".") + 1).toLowerCase();

/** True if a row with this name and these component types matches `query`. */
function rowMatches(query: HierarchyQuery, name: string, types: () => readonly string[]): boolean {
  const lower = name.toLowerCase();
  if (!query.words.every((w) => lower.includes(w))) return false;
  if (query.types.length === 0) return true;
  const have = types().map((t) => [t.toLowerCase(), shortName(t)]);
  return query.types.every((q) => have.some(([full, short]) => short.includes(q) || full === q));
}

export interface HierarchyFilter {
  /** Rows that match. */
  readonly matches: ReadonlySet<string>;
  /** Rows to show: the matches and their ancestors. */
  readonly visible: ReadonlySet<string>;
}

/** Which rows match `text` and which show; null when the query is empty (show everything). */
export function filterHierarchy(doc: SceneDocument, text: string): HierarchyFilter | null {
  const query = parseHierarchyQuery(text);
  if (!query) return null;
  const matches = new Set<string>();
  const visible = new Set<string>();
  let types: Map<string, string[]> | null = null;
  for (const e of hierarchyEntries(doc)) {
    if (!rowMatches(query, e.name, () => (types ??= componentTypes(doc)).get(e.key) ?? [])) continue;
    matches.add(e.key);
    visible.add(e.key);
    for (const a of ancestorKeys(doc, e.key)) visible.add(a);
  }
  return { matches, visible };
}
