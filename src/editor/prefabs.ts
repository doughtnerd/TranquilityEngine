// Prefab tools (ADR 0013, 0022, 0026): the structure inside prefab instances, override checks,
// Apply (write an instance's overrides into its prefab file) and Create Prefab (turn a node and
// its children into a prefab file plus an instance).
import { Assets } from "../engine";
import { isDataComponent } from "../engine/editor";
import { isScenePath } from "../engine/scene/SceneLoader";
import {
  AddComponent,
  AddNode,
  RebuildInstances,
  RemoveComponent,
  RemoveNode,
  RevertOverrides,
  SceneDocument,
  SetComponentEnabled,
  SetComponentWorlds,
  SetComponents,
  SetField,
  SetInnerNodeProperty,
  SetOverrides,
  isFieldOverride,
  isInnerPropertyOverride,
  RenameNode,
  SetActive,
  type ComponentEntry,
  type NodeEntry,
  type NodePath,
  type OverrideEntry,
  type SceneFile,
  pathKey,
} from "./document";
import { writeSceneFile } from "./project";
import type { EditorProject } from "./projects";
import type { OpenScene } from "./state";

/** A node inside a prefab instance, from the prefab file (nested prefabs included) and the instance's overrides. */
export interface InnerNode {
  /**
   * Full document path: `[instanceId, innerId]`, with one more id per nested instance on the way
   * (`[instanceId, nestedId, innerId]`), the same shape as an override `target` after the instance id.
   */
  readonly path: NodePath;
  readonly name: string;
  /** The node's own active flag, with overrides (ADR 0122). */
  readonly active: boolean;
  /** Set when this inner node is itself an instance of another prefab. */
  readonly prefab?: string;
  /** True for a node the instance (or a nested instance in a prefab file) added with `addNodes` (ADR 0086). */
  readonly added?: boolean;
  readonly children: readonly InnerNode[];
}

function prefabFile(path: string): SceneFile | null {
  return Assets.has(path) ? Assets.json<SceneFile>(path) : null;
}

/**
 * The children of an instance as its file describes them, with nested instances expanded the
 * same way. A prefab's instance is the prefab's single node, so its children are that node's;
 * a scene's instance is a scene node holding the file's top-level nodes (ADR 0016).
 *
 * `overrides` are the instance's overrides (targets relative to it): names, active flags, added
 * and removed nodes show as the loader would make them (ADR 0122). Nested instances' own
 * overrides in the prefab files count too; the outer ones win.
 */
export function innerNodes(prefabPath: string, path: NodePath, seen: ReadonlySet<string> = new Set(), overrides: readonly OverrideEntry[] = []): InnerNode[] {
  const file = prefabFile(prefabPath);
  if (!file || seen.has(prefabPath)) return []; // missing file, or a prefab that contains itself
  const nested = new Set(seen).add(prefabPath);
  const scene = isScenePath(prefabPath);
  const rootId = scene ? null : (file.nodes.find((n) => !n.parent)?.id ?? null);
  // Overrides aimed at this file's nodes (one-id targets), and the nodes the instance adds or removes.
  const here = overrides.filter((o) => (o.target?.length ?? 0) <= 1);
  const removed = new Set(here.filter((o) => o.removeNode && o.target?.length === 1).map((o) => o.target![0]));
  const entries: (NodeEntry & { added?: boolean })[] = [...file.nodes];
  for (const o of here) {
    if (!o.addNodes) continue;
    // Added nodes with no parent go under the target (the prefab's root, or the scene node, when empty).
    const under = o.target?.[0] ?? rootId;
    for (const n of o.addNodes) entries.push({ ...n, parent: n.parent ?? under, added: true });
  }
  const byParent = new Map<string | null, NodeEntry[]>();
  for (const n of entries) {
    if (removed.has(n.id)) continue;
    const p = n.parent ?? null;
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  const build = (n: NodeEntry & { added?: boolean }): InnerNode => {
    const at = [...path, n.id];
    let name = n.name ?? n.id, active = n.active !== false;
    // A nested instance's root takes the prefab root's name unless its entry sets one, then its own root overrides.
    if (n.prefab && n.name === undefined) name = prefabFile(n.prefab)?.nodes.find((x) => !x.parent)?.name ?? name;
    const own = n.prefab ? (n.overrides ?? []).filter((o) => !o.target?.length) : [];
    for (const o of [...own, ...here.filter((o) => o.target?.[0] === n.id)]) {
      if (o.name !== undefined) name = o.name;
      if (o.active !== undefined) active = o.active;
    }
    // A nested instance: its own overrides, then the outer ones aimed inside it (applied later, so they win).
    const inner = n.prefab ? [...(n.overrides ?? []).filter((o) => o.target?.length), ...overrides.filter((o) => (o.target?.length ?? 0) > 1 && o.target![0] === n.id).map((o) => ({ ...o, target: o.target!.slice(1) }))] : [];
    return {
      path: at,
      name,
      active,
      ...(n.prefab ? { prefab: n.prefab } : {}),
      ...(n.added ? { added: true } : {}),
      children: n.prefab ? innerNodes(n.prefab, at, nested, inner) : (byParent.get(n.id) ?? []).map(build),
    };
  };
  if (scene) return (byParent.get(null) ?? []).map(build);
  if (rootId === null) return [];
  // The instance node stands for the prefab's node, so its children are that node's children.
  return (byParent.get(rootId) ?? []).map(build);
}

/** The inner nodes of instance `id` in the document, with its overrides. */
export function instanceInnerNodes(doc: SceneDocument, id: string, overrides: readonly OverrideEntry[] = doc.overrides(id)): InnerNode[] {
  const entry = doc.node(id);
  return entry.prefab ? innerNodes(entry.prefab, [id], new Set(), overrides) : [];
}

/** The node at `path` in a tree of inner nodes, or null. */
function findIn(level: readonly InnerNode[], key: string): InnerNode | null {
  for (const n of level) {
    if (pathKey(n.path) === key) return n;
    const found = findIn(n.children, key);
    if (found) return found;
  }
  return null;
}

/** The inner node at `path` (length ≥ 2), or null. */
export function findInner(doc: SceneDocument, path: NodePath): InnerNode | null {
  const instance = doc.has(path[0]) ? doc.node(path[0]) : null;
  if (!instance?.prefab || path.length < 2) return null;
  return findIn(instanceInnerNodes(doc, path[0]), pathKey(path));
}

/**
 * What a node inside an instance would show for `key` without the instance's own name or active
 * override for it: the prefab file's value, with nested instances' overrides (ADR 0122).
 */
export function innerBaseValue(doc: SceneDocument, path: NodePath, key: "name" | "active"): string | boolean | undefined {
  const [id, ...target] = path;
  const others = doc.overrides(id).filter((o) => !isInnerPropertyOverride(o, target, key));
  const node = findIn(instanceInnerNodes(doc, id, others), pathKey(path));
  return node ? node[key] : undefined;
}

/** True if the instance has the editor's name (or active) override for the node at `path` (ADR 0122). */
export function isInnerPropertyOverridden(doc: SceneDocument, path: NodePath, key: "name" | "active"): boolean {
  const [id, ...target] = path;
  return target.length > 0 && doc.has(id) && doc.overrides(id).some((o) => isInnerPropertyOverride(o, target, key));
}

/**
 * The command that renames or (de)activates the node at `path`: on a document node its own entry,
 * inside a prefab instance an override, which goes away when the value matches the prefab's (ADR 0122).
 */
export function nodePropertyCommand(doc: SceneDocument, path: NodePath, key: "name" | "active", value: string | boolean) {
  const [id, ...target] = path;
  if (target.length === 0) return key === "name" ? new RenameNode(id, value as string) : new SetActive(id, value as boolean);
  const same = innerBaseValue(doc, path, key) === value;
  return new SetInnerNodeProperty(id, target, key, same ? undefined : value);
}

/** Remove the instance's name (or active) override for the node at `path`. */
export function revertInnerProperty(open: OpenScene, path: NodePath, key: "name" | "active"): void {
  const [id, ...target] = path;
  open.stack.execute(new SetInnerNodeProperty(id, target, key, undefined));
}

/** True if the field at `path` (an instance or a node inside one) is overridden in the scene. */
export function isOverridden(doc: SceneDocument, path: NodePath, type: string, field: string, index = 0): boolean {
  const [id, ...target] = path;
  if (!doc.has(id) || !doc.isPrefabInstance(id)) return false;
  return doc.overrides(id).some((o) => isFieldOverride(o, target, type, field, index));
}

/**
 * A name or active override on a node inside the instance, with nothing else in it (ADR 0122).
 * The instance root's own (empty target) stay on the instance.
 */
const innerProperty = (o: OverrideEntry) =>
  !!o.target?.length && (o.name !== undefined || o.active !== undefined) && Object.keys(o).every((k) => k === "target" || k === "name" || k === "active");

/**
 * Overrides Apply writes into the prefab: field values, added or removed components and nodes,
 * components switched on or off or reordered, and inner nodes' names and active flags.
 */
const applicable = (o: OverrideEntry) =>
  innerProperty(o) ||
  (o.component !== undefined && o.field !== undefined && o.value !== undefined) ||
  (o.component !== undefined && o.field === undefined && (o.enabled !== undefined || o.worlds !== undefined)) ||
  o.addComponent !== undefined ||
  o.removeComponent !== undefined ||
  o.addNodes !== undefined ||
  o.removeNode === true ||
  o.order !== undefined;

/**
 * Write one override into the prefab document, onto its node `nodeId` (with `inner` the path
 * inside that node when it's itself a nested instance, where the override stays an override).
 */
function applyOverride(prefab: SceneDocument, nodeId: string, inner: readonly string[], o: OverrideEntry): void {
  if (o.addNodes || o.removeNode) {
    if (prefab.isPrefabInstance(nodeId)) {
      const { target: _, ...rest } = o;
      new SetOverrides(nodeId, "", [...(prefab.node(nodeId).overrides ?? []), { ...(inner.length > 0 ? { target: [...inner] } : {}), ...rest }]).apply(prefab);
    } else if (o.addNodes) {
      for (const n of o.addNodes) new AddNode(structuredClone(n), { parent: n.parent ?? nodeId }).apply(prefab);
    } else if (prefab.has(nodeId)) new RemoveNode(nodeId).apply(prefab);
    return;
  }
  if (o.field !== undefined) {
    new SetField(nodeId, o.component!, o.field, o.value, { index: o.index, target: inner }).apply(prefab);
    return;
  }
  if (innerProperty(o) && inner.length === 0) {
    // The node itself (a plain node, or a nested instance's own entry): its name and active flag.
    if (o.name !== undefined) new RenameNode(nodeId, o.name).apply(prefab);
    if (o.active !== undefined) new SetActive(nodeId, o.active).apply(prefab);
    return;
  }
  if (prefab.isPrefabInstance(nodeId)) {
    const { target: _, ...rest } = o;
    new SetOverrides(nodeId, "", [...(prefab.node(nodeId).overrides ?? []), { ...(inner.length > 0 ? { target: [...inner] } : {}), ...rest }]).apply(prefab);
    return;
  }
  const positions = (type: string) => (prefab.node(nodeId).components ?? []).flatMap((c, i) => (c.type === type ? [i] : []));
  if (o.addComponent) new AddComponent(nodeId, o.addComponent).apply(prefab);
  if (o.removeComponent) {
    const [first] = positions(o.removeComponent); // a removeComponent override removes the first of its type
    if (first !== undefined) new RemoveComponent(nodeId, first).apply(prefab);
  }
  if (o.component && o.enabled !== undefined) {
    const at = positions(o.component)[o.index ?? 0];
    if (at !== undefined) new SetComponentEnabled(nodeId, at, o.enabled).apply(prefab);
  }
  if (o.component && o.worlds !== undefined) {
    const at = positions(o.component)[o.index ?? 0];
    if (at !== undefined) new SetComponentWorlds(nodeId, at, o.worlds).apply(prefab);
  }
  if (o.order) {
    // Scripts and engine components take the listed order in the slots they fill; Transform and
    // data components keep their places (the override only orders the rest).
    const list = prefab.node(nodeId).components ?? [];
    const slots = list.flatMap((c, i) => (c.type !== "engine.Transform" && !isDataComponent(c.type) ? [i] : []));
    const pool = slots.map((i) => list[i]);
    const ordered: ComponentEntry[] = [];
    for (const type of o.order) {
      const at = pool.findIndex((c) => c.type === type);
      if (at >= 0) ordered.push(...pool.splice(at, 1));
    }
    const next = [...list];
    [...ordered, ...pool].forEach((c, k) => (next[slots[k]] = c));
    new SetComponents(nodeId, next).apply(prefab);
  }
}

/** An id for a node added to an instance, not used by the prefab's nodes or the instance's other added ones. */
function freeInnerId(doc: SceneDocument, instance: string, base: string): string {
  const entry = doc.node(instance);
  const used = new Set<string>();
  const walk = (prefab: string, seen: Set<string>) => {
    const file = prefabFile(prefab);
    if (!file || seen.has(prefab)) return;
    seen.add(prefab);
    for (const n of file.nodes) {
      used.add(n.id);
      if (n.prefab) walk(n.prefab, seen);
    }
  };
  if (entry.prefab) walk(entry.prefab, new Set());
  for (const o of entry.overrides ?? []) for (const n of o.addNodes ?? []) used.add(n.id);
  let id = base, k = 2;
  while (used.has(id)) id = `${base}-${k++}`;
  return id;
}

/**
 * Add a child node to a prefab instance as an `addNodes` override (ADR 0086), under the node at
 * `parentTarget` inside it (empty: the instance root). Returns the new node's path.
 */
export function addInnerNode(open: OpenScene, instance: string, parentTarget: readonly string[], entry: Omit<NodeEntry, "id"> & { id?: string }): NodePath {
  const id = freeInnerId(open.doc, instance, entry.id ?? "node");
  const node: NodeEntry = { ...entry, id };
  const o: OverrideEntry = { ...(parentTarget.length > 0 ? { target: [...parentTarget] } : {}), addNodes: [node] };
  open.stack.execute(new SetOverrides(instance, `Add ${entry.name ?? id}`, [...(open.doc.node(instance).overrides ?? []), o]));
  return [instance, id];
}

/**
 * Remove a node inside a prefab instance: one the instance added is dropped from its `addNodes`
 * override (with overrides aimed at it); one from the prefab gets a `removeNode` override, and
 * overrides aimed at it or under it go.
 */
export function removeInnerNode(open: OpenScene, path: NodePath): void {
  const [instance, ...target] = path;
  if (target.length === 0) throw new Error("Remove the instance itself, not a node inside it.");
  const id = target[target.length - 1];
  const list = open.doc.node(instance).overrides ?? [];
  const addedHere = list.findIndex((o) => o.addNodes?.some((n) => n.id === id));
  const doomed = new Set<string>([id]);
  if (addedHere >= 0) {
    const nodes = list[addedHere].addNodes!;
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) (doomed.add(n.id), (grew = true));
    }
  }
  const next: OverrideEntry[] = [];
  list.forEach((o, i) => {
    if (i === addedHere) {
      const keep = o.addNodes!.filter((n) => !doomed.has(n.id));
      if (keep.length > 0) next.push({ ...o, addNodes: keep });
    } else if (!(o.target ?? []).some((t) => doomed.has(t))) next.push(o);
  });
  if (addedHere < 0) next.push({ target: [...target], removeNode: true });
  open.stack.execute(new SetOverrides(instance, "Remove node", next));
}

/**
 * Where Open Prefab goes from the node at `path` (an instance, or a node inside one; ADR 0122):
 * the instance's prefab file, and the key to select in it. `[instance]` maps to the prefab's root
 * node (nothing, for a sub-scene), `[instance, a, …]` to `a/…` in the file; a node the instance
 * added itself isn't in the file, so nothing is selected. Null for a node that isn't an instance.
 */
export function prefabTarget(doc: SceneDocument, path: NodePath): { prefab: string; select: string | null } | null {
  const [id, ...rest] = path;
  const prefab = doc.has(id) ? doc.node(id).prefab : undefined;
  if (!prefab) return null;
  const file = prefabFile(prefab);
  if (!file) return { prefab, select: null };
  if (rest.length === 0) return { prefab, select: isScenePath(prefab) ? null : (file.nodes.find((n) => !n.parent)?.id ?? null) };
  return { prefab, select: file.nodes.some((n) => n.id === rest[0]) ? pathKey(rest) : null };
}

/** Ids of every instance of `prefab` in the document. */
export function instancesOf(doc: SceneDocument, prefab: string): string[] {
  return doc.nodes.filter((n) => n.prefab === prefab).map((n) => n.id);
}

/**
 * Apply an instance's overrides to its prefab file (field values, added and removed components
 * and nodes, components switched on or off or reordered, and inner nodes' names and active flags,
 * ADR 0122; not the instance root's own name or active flag): write them into the prefab, save it,
 * then remove them from the instance and refresh every instance of that prefab in the scene.
 * The scene change is one undo step; the prefab file itself stays as written. Returns how many
 * overrides were applied.
 */
export async function applyOverrides(open: OpenScene, project: EditorProject, instance: string): Promise<number> {
  const entry = open.doc.node(instance);
  if (!entry.prefab) throw new Error(`"${instance}" is not a prefab instance.`);
  if (!project.canSave) throw new Error(`${project.name} is read-only. Open a project folder to apply overrides.`);
  // A scene instance's own node (empty target) isn't in the scene file, so its overrides (e.g.
  // where the sub-scene is placed) stay on the instance.
  const scene = isScenePath(entry.prefab);
  const fits = (o: OverrideEntry) => applicable(o) && !(scene && !o.target?.length);
  const overrides = (entry.overrides ?? []).filter(fits);
  if (overrides.length === 0) return 0;

  const prefab = new SceneDocument(Assets.json<SceneFile>(entry.prefab), entry.prefab);
  const rootId = prefab.roots()[0];
  for (const o of overrides) {
    // A target names a node in the file, then (for nested instances) a path inside that node's instance.
    const [nodeId = rootId, ...inner] = o.target ?? [];
    applyOverride(prefab, nodeId, inner, o);
  }
  await writeSceneFile(project, entry.prefab, prefab.toJSON());

  const others = instancesOf(open.doc, entry.prefab).filter((id) => id !== instance);
  open.stack.execute(new RevertOverrides(instance, `Apply to ${entry.prefab.split("/").pop()}`, fits, others));
  return overrides.length;
}

/** A file name from a node name: lower-case, dashes, safe characters only. */
export function prefabFileName(name: string): string {
  return name.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prefab";
}

/** `prefabs/<name>.prefab.json`, numbered if that file already exists. */
export function newPrefabPath(project: EditorProject, name: string): string {
  const base = `prefabs/${prefabFileName(name)}`;
  let path = `${base}.prefab.json`;
  for (let n = 2; project.files.includes(path); n++) path = `${base}-${n}.prefab.json`;
  return path;
}

/**
 * Turn a scene node and its children into a prefab file, and the node into an instance of it in
 * the same place (same id, so references to it keep working). Refuses when nodes outside the
 * subtree reference nodes inside it other than its root, since those references would break.
 * The scene change is one undo step; the new file stays on disk. Returns the prefab path.
 */
export async function createPrefab(scene: OpenScene, project: EditorProject, id: string): Promise<string> {
  const { doc, stack } = scene;
  const entry = doc.node(id);
  if (entry.prefab) throw new Error(`"${entry.name ?? id}" is already a prefab instance.`);
  if (!project.canSave) throw new Error(`${project.name} is read-only. Open a project folder to create prefabs.`);

  const subtree = doc.subtree(id);
  const inside = new Set(subtree);
  const broken = doc.references().filter((r) => !inside.has(r.path[0]) && inside.has(r.to) && r.to !== id);
  if (broken.length) {
    const r = broken[0];
    throw new Error(`"${r.path[0]}" references "${r.to}" inside "${entry.name ?? id}"; only the root of a prefab can be referenced from outside it.`);
  }

  const nodes = subtree.map((n) => structuredClone(doc.node(n)));
  delete nodes[0].parent;
  const path = newPrefabPath(project, entry.name ?? id);
  await writeSceneFile(project, path, { format: doc.format, nodes });

  const parent = doc.parentOf(id);
  const index = doc.children(parent).indexOf(id);
  const instance: NodeEntry = { id, ...(entry.name !== undefined ? { name: entry.name } : {}), prefab: path };
  stack.beginGroup(`Create prefab ${path.split("/").pop()}`);
  try {
    stack.execute(new RemoveNode(id));
    stack.execute(new AddNode(instance, { parent, index }));
  } finally {
    stack.endGroup();
  }
  return path;
}

/**
 * Turn several sibling nodes into one prefab (ADR 0087): the file's root is a new "Group" node
 * (just a Transform) holding copies of them, and one instance of it replaces them where the
 * first stood. The nodes must share a parent, and none may be a prefab instance's inner node.
 * With one id this is `createPrefab`. One undo step. Returns the prefab path.
 */
export async function createPrefabFromNodes(scene: OpenScene, project: EditorProject, ids: readonly string[], name = "Group"): Promise<string> {
  if (ids.length === 1) return createPrefab(scene, project, ids[0]);
  const { doc, stack } = scene;
  if (ids.length === 0) throw new Error("Select the nodes to turn into a prefab.");
  if (!project.canSave) throw new Error(`${project.name} is read-only. Open a project folder to create prefabs.`);
  const parent = doc.parentOf(ids[0]);
  if (ids.some((id) => doc.parentOf(id) !== parent)) throw new Error("The nodes must share a parent to become one prefab.");
  // Siblings in hierarchy order; a selected node's ancestor can't also be selected (same parent).
  const order = doc.children(parent);
  const sorted = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const inside = new Set(sorted.flatMap((id) => doc.subtree(id)));
  const broken = doc.references().filter((r) => !inside.has(r.path[0]) && inside.has(r.to));
  if (broken.length) throw new Error(`"${broken[0].path[0]}" references "${broken[0].to}", which would move into the prefab; only the prefab's root can be referenced from outside.`);

  const used = new Set(doc.nodes.map((n) => n.id));
  const fresh = (base: string) => {
    let id = base, k = 2;
    while (used.has(id)) id = `${base}-${k++}`;
    used.add(id);
    return id;
  };
  const rootId = fresh(prefabFileName(name));
  const root: NodeEntry = { id: rootId, name, components: [{ type: "engine.Transform" }] };
  const nodes: NodeEntry[] = [root];
  for (const id of sorted) {
    const sub = doc.subtree(id).map((n) => structuredClone(doc.node(n)));
    sub[0].parent = rootId;
    nodes.push(...sub);
  }
  const path = newPrefabPath(project, name);
  await writeSceneFile(project, path, { format: doc.format, nodes });
  const index = order.indexOf(sorted[0]);
  stack.beginGroup(`Create prefab ${path.split("/").pop()}`);
  try {
    for (const id of sorted) stack.execute(new RemoveNode(id));
    stack.execute(new AddNode({ id: rootId, name, prefab: path }, { parent, index }));
  } finally {
    stack.endGroup();
  }
  return path;
}

/** Apply the overrides of several instances (one undo step each); returns how many overrides were applied in all. */
export async function applyOverridesTo(open: OpenScene, project: EditorProject, instances: readonly string[]): Promise<number> {
  let total = 0;
  for (const id of instances) total += await applyOverrides(open, project, id);
  return total;
}

export { RebuildInstances };

/**
 * True if instancing `file` inside the document at `into` would contain itself: the same file,
 * or a file whose instances (at any depth) include `into`.
 */
export function wouldNest(file: string, into: string, seen: ReadonlySet<string> = new Set()): boolean {
  if (file === into) return true;
  if (seen.has(file) || !Assets.has(file)) return false;
  const next = new Set(seen).add(file);
  return Assets.json<SceneFile>(file).nodes.some((n) => n.prefab !== undefined && wouldNest(n.prefab, into, next));
}
