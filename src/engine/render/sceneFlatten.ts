/**
 * @internal Scene and prefab files as one flat list of nodes, for the thumbnail renderer (ADR 0117):
 * prefab instances are expanded in place (nested ones too), field overrides on components are
 * applied, and inactive nodes and their children are left out. No Babylon here, so it is unit-tested.
 *
 * Ids are made unique by prefixing them with the instance's id path (`bg-a/root/child`), which is
 * also how an override's `target` path addresses a node inside an instance.
 */

export interface FlatNode {
  id: string;
  parent?: string;
  components: { type: string; data?: unknown }[];
}

interface RawNode {
  id?: unknown;
  parent?: unknown;
  active?: unknown;
  prefab?: unknown;
  components?: unknown;
  overrides?: unknown;
}

interface RawOverride {
  target?: unknown;
  component?: unknown;
  index?: unknown;
  field?: unknown;
  value?: unknown;
  active?: unknown;
}

const MAX_DEPTH = 8;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The nodes of the scene or prefab at `path`, instances expanded. `read` gives a project file's parsed
 * JSON (undefined when it is missing). A missing prefab leaves its instance out.
 */
export function flattenSceneNodes(path: string, read: (path: string) => unknown): FlatNode[] {
  const nodes: (FlatNode & { rawParent?: string; active: boolean })[] = [];
  /** An instance's id path → the id of the node it is (its prefab's root), for parents and overrides. */
  const alias = new Map<string, string>();

  const expand = (file: unknown, prefix: string, outerParent: string | undefined, depth: number) => {
    const list = isObject(file) && Array.isArray(file.nodes) ? (file.nodes as RawNode[]) : [];
    for (const entry of list) {
      if (!isObject(entry) || typeof entry.id !== "string") continue;
      const id = prefix + entry.id;
      const parent = typeof entry.parent === "string" && entry.parent ? prefix + entry.parent : outerParent;
      const active = entry.active !== false;
      if (typeof entry.prefab === "string") {
        if (depth >= MAX_DEPTH) continue;
        const sub = read(entry.prefab);
        if (!isObject(sub) || !Array.isArray(sub.nodes)) continue;
        const before = nodes.length;
        expand(sub, `${id}/`, parent, depth + 1);
        // The instance is the prefab's top-level node (the first one without a parent).
        const root = nodes.slice(before).find((n) => n.rawParent === parent || (n.rawParent === undefined && parent === undefined));
        if (root) {
          alias.set(id, root.id);
          if (!active) root.active = false;
          for (const o of Array.isArray(entry.overrides) ? entry.overrides : []) applyOverride(nodes, id, alias, o as RawOverride);
        }
        continue;
      }
      const components = Array.isArray(entry.components) ? entry.components.filter((c): c is { type: string; data?: unknown } => isObject(c) && typeof c.type === "string").map((c) => ({ type: c.type, ...(c.data !== undefined ? { data: c.data } : {}) })) : [];
      nodes.push({ id, rawParent: parent, parent, active, components });
    }
  };
  expand(read(path), "", undefined, 0);

  // Resolve parents that name an instance, then drop inactive nodes and everything under them.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) if (n.rawParent !== undefined) n.parent = alias.get(n.rawParent) ?? n.rawParent;
  const live = (n: { id: string; parent?: string; active: boolean }, depth = 0): boolean => {
    if (!n.active) return false;
    const p = n.parent ? byId.get(n.parent) : undefined;
    return !p || depth > 64 || live(p, depth + 1);
  };
  return nodes.filter((n) => live(n)).map(({ id, parent, components }) => ({ id, ...(parent ? { parent } : {}), components }));
}

/** Apply one instance override (component fields, active) to the instance's expanded nodes. */
function applyOverride(nodes: (FlatNode & { active: boolean })[], instance: string, alias: Map<string, string>, o: RawOverride): void {
  if (!isObject(o)) return;
  const target = Array.isArray(o.target) ? o.target.filter((t): t is string => typeof t === "string") : [];
  const id = target.length ? `${instance}/${target.join("/")}` : alias.get(instance);
  const node = id ? nodes.find((n) => n.id === id || n.id === alias.get(id)) : undefined;
  if (!node) return;
  if (o.active === false && o.component === undefined) node.active = false;
  if (typeof o.component !== "string" || typeof o.field !== "string") return;
  const index = typeof o.index === "number" ? o.index : 0;
  const matching = node.components.filter((c) => c.type === o.component);
  const c = matching[index];
  if (c) c.data = { ...(isObject(c.data) ? c.data : {}), [o.field]: o.value };
}
