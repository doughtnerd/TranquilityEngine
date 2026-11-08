// Hierarchy search (ADR 0022): which rows match a query and which show. Words match node names
// (case-insensitive, all must match); `t:Type` matches a component type by its short name
// (`t:camera` finds engine.Camera, `t:Bird` a script's game.Bird). Matching rows show with their
// ancestors, so each stays in place in the tree.
import { Assets } from "../engine";
import { resolveScene } from "../engine/scene/resolvedScene";
import { isScenePath } from "../engine/scene/SceneLoader";
import type { NodeEntry, SceneDocument, SceneFile } from "./document";
import { ancestorKeys, hierarchyEntries } from "./selectionModel";

export interface HierarchyQuery {
  /** Lower-case words every name must contain. */
  readonly words: readonly string[];
  /** Lower-case component type fragments every node must have a component matching. */
  readonly types: readonly string[];
}

/** Parse a search box's text; null when it's empty. */
export function parseHierarchyQuery(text: string): HierarchyQuery | null {
  const words: string[] = [], types: string[] = [];
  for (const part of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (part.startsWith("t:")) {
      if (part.length > 2) types.push(part.slice(2));
    } else words.push(part);
  }
  return words.length || types.length ? { words, types } : null;
}

const fileOf = (path: string): SceneFile | null => (Assets.has(path) ? Assets.json<SceneFile>(path) : null);

/** Types of an instance of `prefabPath`: the prefab root's components, nested prefabs and their overrides resolved. */
function instanceTypes(prefabPath: string): string[] {
  if (isScenePath(prefabPath)) return [];
  const root = resolveScene(prefabPath).nodes.find((n) => n.parent === undefined);
  return root ? root.components.map((c) => c.type) : [];
}

/**
 * Component types of the hierarchy row `key` as authored: a plain node's own, a prefab
 * instance's from its prefab (plus `addComponent` overrides), and a node inside an instance's
 * from the prefab file it's written in.
 */
export function componentTypesOf(doc: SceneDocument, key: string): string[] {
  const path = key.split("/");
  if (!doc.has(path[0])) return [];
  const node = doc.node(path[0]);
  const added = (entry: NodeEntry, target: readonly string[]) =>
    (entry.overrides ?? []).filter((o) => o.addComponent && (o.target ?? []).join("/") === target.join("/")).map((o) => o.addComponent!.type);
  if (!node.prefab) return (node.components ?? []).map((c) => c.type);
  if (path.length === 1) return [...instanceTypes(node.prefab), ...added(node, [])];
  // Walk into nested prefabs: each id is a node of the current file, maybe an instance itself.
  let file = fileOf(node.prefab);
  let entry: NodeEntry | null = null;
  for (let i = 1; i < path.length && file; i++) {
    entry = file.nodes.find((n) => n.id === path[i]) ?? null;
    if (!entry) return [];
    if (entry.prefab && i < path.length - 1) file = fileOf(entry.prefab);
  }
  if (!entry) return [];
  const own = entry.prefab ? instanceTypes(entry.prefab) : (entry.components ?? []).map((c) => c.type);
  return [...own, ...added(node, path.slice(1))];
}

const shortName = (type: string) => type.slice(type.lastIndexOf(".") + 1).toLowerCase();

/** True if a row with this name and these component types matches `query`. */
export function rowMatches(query: HierarchyQuery, name: string, types: () => readonly string[]): boolean {
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
  for (const e of hierarchyEntries(doc)) {
    if (!rowMatches(query, e.name, () => componentTypesOf(doc, e.key))) continue;
    matches.add(e.key);
    visible.add(e.key);
    for (const a of ancestorKeys(doc, e.key)) visible.add(a);
  }
  return { matches, visible };
}
