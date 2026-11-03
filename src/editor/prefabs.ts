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
  SetOverrides,
  isFieldOverride,
  type ComponentEntry,
  type NodeEntry,
  type NodePath,
  type OverrideEntry,
  type SceneFile,
} from "./document";
import { writeSceneFile } from "./project";
import type { EditorProject } from "./projects";
import type { OpenScene } from "./state";

/** A node inside a prefab instance, from the prefab file (nested prefabs included). */
export interface InnerNode {
  /** Full document path: `[instanceId, innerId…]`. */
  readonly path: NodePath;
  readonly name: string;
  /** Set when this inner node is itself an instance of another prefab. */
  readonly prefab?: string;
  readonly children: readonly InnerNode[];
}

function prefabFile(path: string): SceneFile | null {
  return Assets.has(path) ? Assets.json<SceneFile>(path) : null;
}

/**
 * The children of an instance as its file describes them, with nested instances expanded the
 * same way. A prefab's instance is the prefab's single node, so its children are that node's;
 * a scene's instance is a scene node holding the file's top-level nodes (ADR 0016).
 */
export function innerNodes(prefabPath: string, path: NodePath, seen: ReadonlySet<string> = new Set()): InnerNode[] {
  const file = prefabFile(prefabPath);
  if (!file || seen.has(prefabPath)) return []; // missing file, or a prefab that contains itself
  const nested = new Set(seen).add(prefabPath);
  const byParent = new Map<string | null, NodeEntry[]>();
  for (const n of file.nodes) {
    const p = n.parent ?? null;
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  const build = (n: NodeEntry, at: NodePath): InnerNode => ({
    path: at,
    name: n.name ?? n.id,
    prefab: n.prefab,
    children: n.prefab ? innerNodes(n.prefab, at, nested) : (byParent.get(n.id) ?? []).map((c) => build(c, [...at, c.id])),
  });
  const top = byParent.get(null) ?? [];
  if (isScenePath(prefabPath)) return top.map((n) => build(n, [...path, n.id]));
  const root = top[0];
  if (!root) return [];
  // The instance node stands for the prefab's node, so its children are that node's children.
  return (byParent.get(root.id) ?? []).map((c) => build(c, [...path, c.id]));
}

/** The inner node at `path` (length ≥ 2), or null. */
export function findInner(doc: SceneDocument, path: NodePath): InnerNode | null {
  const instance = doc.has(path[0]) ? doc.node(path[0]) : null;
  if (!instance?.prefab || path.length < 2) return null;
  let level: readonly InnerNode[] = innerNodes(instance.prefab, [path[0]]);
  let found: InnerNode | null = null;
  for (let i = 1; i < path.length; i++) {
    found = level.find((n) => n.path[i] === path[i]) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
}

/** True if the field at `path` (an instance or a node inside one) is overridden in the scene. */
export function isOverridden(doc: SceneDocument, path: NodePath, type: string, field: string, index = 0): boolean {
  const [id, ...target] = path;
  if (!doc.has(id) || !doc.isPrefabInstance(id)) return false;
  return doc.overrides(id).some((o) => isFieldOverride(o, target, type, field, index));
}

/** Overrides that Apply can write into a prefab file: component field values. */
/** Overrides Apply writes into the prefab: field values, added or removed components, and components switched on or off. */
const applicable = (o: OverrideEntry) =>
  (o.component !== undefined && o.field !== undefined && o.value !== undefined) ||
  (o.component !== undefined && o.field === undefined && (o.enabled !== undefined || o.worlds !== undefined)) ||
  o.addComponent !== undefined ||
  o.removeComponent !== undefined ||
  o.order !== undefined;

/**
 * Write one override into the prefab document, onto its node `nodeId` (with `inner` the path
 * inside that node when it's itself a nested instance, where the override stays an override).
 */
function applyOverride(prefab: SceneDocument, nodeId: string, inner: readonly string[], o: OverrideEntry): void {
  if (o.field !== undefined) {
    new SetField(nodeId, o.component!, o.field, o.value, { index: o.index, target: inner }).apply(prefab);
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

/** Ids of every instance of `prefab` in the document. */
export function instancesOf(doc: SceneDocument, prefab: string): string[] {
  return doc.nodes.filter((n) => n.prefab === prefab).map((n) => n.id);
}

/**
 * Apply an instance's overrides to its prefab file (field values, added and removed components,
 * components switched on or off; not name or active): write them into the prefab, save it,
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
