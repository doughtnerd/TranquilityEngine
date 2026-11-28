// Prefab tools (ADR 0013, 0022, 0026): the structure inside prefab instances, Apply (write an instance's overrides into its prefab file) and Create Prefab (turn a node and
// its children into a prefab file plus an instance).
import { Assets } from "../engine";
import { isScenePath } from "../engine/scene/scenePath";
import { foldNodes, type FoldAdapter, type NodeStep, type OverrideHome } from "../engine/scene/overrideFold";
import { mapEntryNodeRefs, nodeRefId } from "../engine/scene/nodeReferences";
import {
  AddComponent,
  AddNode,
  RemoveComponent,
  RemoveNode,
  RevertOverrides,
  SceneDocument,
  SetComponentEnabled,
  SetComponentWorlds,
  SetComponents,
  SetField,
  SetOverrides,
  SetTags,
  RenameNode,
  SetActive,
  type ComponentEntry,
  type NodeEntry,
  type NodePath,
  type NodeReference,
  type OverrideEntry,
  type SceneFile,
  pathKey,
} from "./document";
import { writeSceneFile } from "./project";
import type { EditorProject } from "./projects";
import type { OpenScene } from "./state";
import { readOnlyMessage } from "./readOnly";
import { insertNodes } from "./nodeInsertion";
import { findInner, instanceInnerNodes, type InnerNode } from "./nodeKey";
import { DASHED, uniqueName } from "../engine/core/uniqueName";
import { undoStep } from "./undoStep";

function prefabFile(path: string): SceneFile | null {
  return Assets.has(path) ? Assets.json<SceneFile>(path) : null;
}

/** Keys of an override that sets only a node's own properties. */
const NODE_PROPERTIES = new Set(["target", "name", "active", "tags"]);
const nodeProperty = (o: OverrideEntry) => (o.name !== undefined || o.active !== undefined || o.tags !== undefined) && Object.keys(o).every((k) => NODE_PROPERTIES.has(k));

/**
 * A name, active or tags override on a node inside the instance, with nothing else in it (ADR
 * 0042, 0122). The instance root's own (empty target) stay on the instance.
 */
const innerProperty = (o: OverrideEntry) => !!o.target?.length && nodeProperty(o);

/**
 * Overrides Apply writes into the prefab: field values, added or removed components and nodes,
 * components switched on or off or reordered, and inner nodes' names, active flags and tags.
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

/** Apply's stand-in for a sub-scene's own node, which isn't in the scene file (overrides on it stay on the instance). */
const SCENE_NODE = "\0scene";

/**
 * Apply as an adapter of the prefab-override fold (ADR 0280): the fold folds the instance's
 * overrides over its prefab file and this turns each step into a command on the prefab document.
 * The prefab's nodes already exist (nodes the overrides add are added); nested instances in the
 * prefab stay instances, and overrides aimed into them become theirs.
 */
class ApplyToPrefab implements FoldAdapter<string, symbol> {
  /** One token per component entry of each node, in the document's order (the fold's handles). */
  private readonly tokens = new Map<string, symbol[]>();
  constructor(private readonly prefab: SceneDocument) {}

  load(path: string): SceneFile | undefined {
    return path === this.prefab.path ? this.prefab.toJSON() : undefined;
  }
  expand(step: NodeStep<string>): boolean {
    return step.at.length === 1; // the instance being applied; nested instances stay folded
  }
  sceneNode(): string {
    return SCENE_NODE;
  }
  node(step: NodeStep<string>): string {
    if (step.added) new AddNode(structuredClone(step.entry), { parent: step.parent ?? null }).apply(this.prefab);
    this.tokens.set(step.entry.id, []);
    return step.entry.id;
  }
  folded(step: NodeStep<string>): string {
    return this.node(step);
  }
  component(node: string, entry: ComponentEntry, _worlds: unknown, _scope: unknown, _source: string, _at: unknown, home?: OverrideHome): symbol {
    if (home) new AddComponent(node, entry).apply(this.prefab);
    const token = Symbol(entry.type);
    this.tokens.get(node)?.push(token);
    return token;
  }
  private position(node: string, c: symbol): number {
    return this.tokens.get(node)?.indexOf(c) ?? -1;
  }
  name(node: string, name: string): void {
    if (node !== SCENE_NODE) new RenameNode(node, name).apply(this.prefab);
  }
  active(node: string, active: boolean): void {
    if (node !== SCENE_NODE) new SetActive(node, active).apply(this.prefab);
  }
  tags(node: string, tags: string[]): void {
    if (node !== SCENE_NODE) new SetTags(node, tags).apply(this.prefab);
  }
  removeNode(node: string): void {
    if (this.prefab.has(node)) new RemoveNode(node).apply(this.prefab);
  }
  removeComponent(node: string, c: symbol): void {
    const at = this.position(node, c);
    if (at < 0) return;
    new RemoveComponent(node, at).apply(this.prefab);
    this.tokens.get(node)!.splice(at, 1);
  }
  order(node: string, ordered: readonly symbol[]): void {
    const current = this.tokens.get(node) ?? [];
    if (ordered.every((t, i) => t === current[i])) return;
    const list = this.prefab.node(node).components ?? [];
    new SetComponents(node, ordered.map((t) => list[current.indexOf(t)])).apply(this.prefab);
    this.tokens.set(node, [...ordered]);
  }
  enabled(node: string, c: symbol, enabled: boolean): void {
    const at = this.position(node, c);
    if (at >= 0) new SetComponentEnabled(node, at, enabled).apply(this.prefab);
  }
  worlds(node: string, c: symbol, worlds: string[]): void {
    const at = this.position(node, c);
    if (at >= 0) new SetComponentWorlds(node, at, worlds).apply(this.prefab);
  }
  field(node: string, _c: symbol | undefined, type: string, index: number, field: string, value: unknown): void {
    if (node !== SCENE_NODE) new SetField(node, type, field, value, { index }).apply(this.prefab);
  }
  /** An override aimed at or into a nested instance in the prefab: written onto that instance entry. */
  deferred(node: string, o: OverrideEntry): void {
    const { target = [], ...rest } = o;
    if (o.field !== undefined) {
      new SetField(node, o.component!, o.field, o.value, { index: o.index, target }).apply(this.prefab);
    } else if (target.length === 0 && nodeProperty(o)) {
      // The nested instance's own name, active flag and tags are its entry's.
      if (o.name !== undefined) new RenameNode(node, o.name).apply(this.prefab);
      if (o.active !== undefined) new SetActive(node, o.active).apply(this.prefab);
      if (o.tags !== undefined) new SetTags(node, o.tags).apply(this.prefab);
    } else {
      new SetOverrides(node, "", [...(this.prefab.node(node).overrides ?? []), { ...(target.length > 0 ? { target: [...target] } : {}), ...rest }]).apply(this.prefab);
    }
  }
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
 * and nodes, components switched on or off or reordered, and inner nodes' names, active flags and
 * tags, ADR 0122; not the instance root's own name, active flag or tags): write them into the prefab, save it,
 * then remove them from the instance and refresh every instance of that prefab in the scene.
 * The scene change is one undo step; the prefab file itself stays as written. Returns how many
 * overrides were applied.
 */
async function applyOverrides(open: OpenScene, project: EditorProject, instance: string): Promise<number> {
  const entry = open.doc.node(instance);
  if (!entry.prefab) throw new Error(`"${instance}" is not a prefab instance.`);
  if (!project.canSave) throw new Error(readOnlyMessage(project, "apply overrides"));
  // A scene instance's own node (empty target) isn't in the scene file, so its overrides (e.g.
  // where the sub-scene is placed) stay on the instance.
  const scene = isScenePath(entry.prefab);
  const fits = (o: OverrideEntry) => applicable(o) && !(scene && !o.target?.length);
  const overrides = (entry.overrides ?? []).filter(fits);
  if (overrides.length === 0) return 0;

  const prefab = new SceneDocument(Assets.json<SceneFile>(entry.prefab), entry.prefab);
  foldNodes(new ApplyToPrefab(prefab), [{ id: instance, prefab: entry.prefab, overrides }], undefined, open.doc.path);
  await writeSceneFile(project, entry.prefab, prefab.toJSON());

  const others = instancesOf(open.doc, entry.prefab).filter((id) => id !== instance);
  open.stack.execute(new RevertOverrides(instance, `Apply to ${entry.prefab.split("/").pop()}`, fits, others));
  return overrides.length;
}

/** A file name from a node name: lower-case, dashes, safe characters only. */
function prefabFileName(name: string): string {
  return name.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prefab";
}

/** `prefabs/<name>.prefab.json`, numbered if that file already exists. */
function newPrefabPath(project: EditorProject, name: string): string {
  const base = `prefabs/${prefabFileName(name)}`;
  let path = `${base}.prefab.json`;
  for (let n = 2; project.files.includes(path); n++) path = `${base}-${n}.prefab.json`;
  return path;
}

/** What Create Prefab made: the prefab file, and how many references out of it became overrides on the new instance. */
export interface CreatedPrefab {
  readonly path: string;
  /** References from inside the new prefab to scene nodes outside it, kept as overrides on the instance (ADR 0401). */
  readonly instanceOverrides: number;
  /** List items naming nodes inside the prefab that those overrides had to clear (a list mixing inside and outside references). */
  readonly droppedListItems: number;
}

/**
 * References from the nodes `inside` to scene nodes outside them, treated the way Unity treats
 * scene references in a new prefab (ADR 0401): the prefab file can't name scene nodes, so it holds
 * null for them, and the instance that replaces the nodes keeps each field's original value as an
 * override. Returns `copies` (the subtree entries as the file gets them) with those references
 * nulled, and the overrides. `root` is the file's root id (the instance root's own fields have an
 * empty target); `kept` is an inside id that still names the same node in the scene afterwards
 * (the instance keeps the root's id), so a list may hold it beside outside references. A list that
 * holds outside references beside other inside ones keeps the inside ones in the file, but the
 * override (read in the scene, where those inside nodes no longer are) clears them to null; `dropped`
 * counts those list items.
 */
function outsideReferences(doc: SceneDocument, inside: ReadonlySet<string>, copies: NodeEntry[], root: string, kept: string | null): { nodes: NodeEntry[]; overrides: OverrideEntry[]; dropped: number } {
  const fields = new Map<string, NodeReference[]>();
  for (const r of doc.references()) {
    if (!inside.has(r.path[0])) continue;
    const key = JSON.stringify([r.path, r.type, r.index, r.field]);
    fields.set(key, [...(fields.get(key) ?? []), r]);
  }
  const overrides: OverrideEntry[] = [];
  let dropped = 0;
  const lost = (id: string | null) => id !== null && inside.has(id) && id !== kept;
  for (const refs of fields.values()) {
    if (refs.every((r) => inside.has(r.to))) continue;
    const r = refs[0];
    let value = structuredClone(r.value);
    // Owner decision (ADR 0401): in a list mixing outside references with inside ones, the instance's override clears
    // the inside items (null, as a cleared reference); the prefab file still holds them.
    if (Array.isArray(value) && value.some((item) => lost(nodeRefId(item)))) {
      const cleared: unknown[] = value.map((item) => (lost(nodeRefId(item)) ? null : item));
      dropped += value.filter((item) => lost(nodeRefId(item))).length;
      value = cleared;
    }
    const target = r.path[0] === root ? r.path.slice(1) : [...r.path];
    overrides.push({ ...(target.length ? { target } : {}), component: r.type, index: r.index, field: r.field, value });
  }
  const nodes = overrides.length ? copies.map((n) => mapEntryNodeRefs(n, (id) => (inside.has(id) ? id : null))) : copies;
  return { nodes, overrides, dropped };
}

/**
 * Turn a scene node and its children into a prefab file, and the node into an instance of it in
 * the same place (same id, so references to it keep working). Refuses when nodes outside the
 * subtree reference nodes inside it other than its root, since those references would break.
 * References from inside to nodes outside are left empty in the file and kept as overrides on the
 * instance (ADR 0401), so the scene behaves as before. The scene change is one undo step; the new
 * file stays on disk.
 */
export async function createPrefab(scene: OpenScene, project: EditorProject, id: string): Promise<CreatedPrefab> {
  const { doc, stack } = scene;
  const entry = doc.node(id);
  if (entry.prefab) throw new Error(`"${entry.name ?? id}" is already a prefab instance.`);
  if (!project.canSave) throw new Error(readOnlyMessage(project, "create prefabs"));

  const subtree = doc.subtree(id);
  const inside = new Set(subtree);
  const broken = doc.references().filter((r) => !inside.has(r.path[0]) && inside.has(r.to) && r.to !== id);
  if (broken.length) {
    const r = broken[0];
    throw new Error(`"${r.path[0]}" references "${r.to}" inside "${entry.name ?? id}"; only the root of a prefab can be referenced from outside it.`);
  }

  const copies = subtree.map((n) => structuredClone(doc.node(n)));
  delete copies[0].parent;
  const { nodes, overrides, dropped } = outsideReferences(doc, inside, copies, id, id);
  const path = newPrefabPath(project, entry.name ?? id);
  await writeSceneFile(project, path, { format: doc.format, nodes });

  const parent = doc.parentOf(id);
  const index = doc.children(parent).indexOf(id);
  const instance: NodeEntry = { id, ...(entry.name !== undefined ? { name: entry.name } : {}), prefab: path, ...(overrides.length ? { overrides } : {}) };
  undoStep(stack, `Create prefab ${path.split("/").pop()}`, () => {
    stack.execute(new RemoveNode(id));
    stack.execute(new AddNode(instance, { parent, index }));
  });
  return { path, instanceOverrides: overrides.length, droppedListItems: dropped };
}

/**
 * Turn several sibling nodes into one prefab (ADR 0087): the file's root is a new "Group" node
 * (just a Transform) holding copies of them, and one instance of it replaces them where the
 * first stood. The nodes must share a parent, and none may be a prefab instance's inner node.
 * With one id this is `createPrefab`. References from the nodes to scene nodes outside them become
 * overrides on the instance, as there (ADR 0401). One undo step.
 */
export async function createPrefabFromNodes(scene: OpenScene, project: EditorProject, ids: readonly string[], name = "Group"): Promise<CreatedPrefab> {
  if (ids.length === 1) return createPrefab(scene, project, ids[0]);
  const { doc, stack } = scene;
  if (ids.length === 0) throw new Error("Select the nodes to turn into a prefab.");
  if (!project.canSave) throw new Error(readOnlyMessage(project, "create prefabs"));
  const parent = doc.parentOf(ids[0]);
  if (ids.some((id) => doc.parentOf(id) !== parent)) throw new Error("The nodes must share a parent to become one prefab.");
  // Siblings in hierarchy order; a selected node's ancestor can't also be selected (same parent).
  const order = doc.children(parent);
  const sorted = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const inside = new Set(sorted.flatMap((id) => doc.subtree(id)));
  const broken = doc.references().filter((r) => !inside.has(r.path[0]) && inside.has(r.to));
  if (broken.length) throw new Error(`"${broken[0].path[0]}" references "${broken[0].to}", which would move into the prefab; only the prefab's root can be referenced from outside.`);

  const rootId = uniqueName(prefabFileName(name), (id) => inside.has(id), DASHED); // the file's own root, beside the copies
  const root: NodeEntry = { id: rootId, name, components: [{ type: "engine.Transform" }] };
  const copies: NodeEntry[] = [root];
  for (const id of sorted) {
    const sub = doc.subtree(id).map((n) => structuredClone(doc.node(n)));
    sub[0].parent = rootId;
    copies.push(...sub);
  }
  const { nodes, overrides, dropped } = outsideReferences(doc, inside, copies, rootId, null);
  const path = newPrefabPath(project, name);
  await writeSceneFile(project, path, { format: doc.format, nodes });
  const index = order.indexOf(sorted[0]);
  const label = `Create prefab ${path.split("/").pop()}`;
  undoStep(stack, label, () => {
    for (const id of sorted) stack.execute(new RemoveNode(id));
    // The instance takes the first node's place; the node insertion gives it its id (ADR 0246).
    const made = insertNodes(scene, { kind: "template", nodes: [{ name, prefab: path }], label }, { kind: "into", key: parent, index });
    if (!made.ok) throw new Error(made.reason);
    // Set after the insertion, which re-points a template's references among its own nodes; these name scene nodes.
    if (overrides.length) stack.execute(new SetOverrides(made.keys[0]!, label, overrides));
  });
  return { path, instanceOverrides: overrides.length, droppedListItems: dropped };
}

/** Apply the overrides of several instances (one undo step each); returns how many overrides were applied in all. */
export async function applyOverridesTo(open: OpenScene, project: EditorProject, instances: readonly string[]): Promise<number> {
  let total = 0;
  for (const id of instances) total += await applyOverrides(open, project, id);
  return total;
}


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
