// Inspecting the running game (ADR 0022, 0032): while playing, the Hierarchy and Inspector can show
// a live World of the play Engine instead of the edited scene (`inspectedWorld`). Live edits go to
// that World only. "Keep values" (Unity's copy component values) remembers a component's live values
// and, on Stop, writes them into the edited document as one undoable step: as plain field values on
// scene nodes, as overrides on prefab instances and the nodes inside them. Only nodes that came from
// the scene being edited map back to the document (`docPathFor` says why others don't).
import { signal } from "@preact/signals";
import { Connection, GameObject, Replicated, type Engine } from "../engine";
import type { World } from "../engine/core/World";
import { type ComponentInfo, engineWorld, instantiatedPrefabOf, listComponents, listNodes, sceneSourceOf, viewport, writeField } from "../engine/editor";
import { SetField, pathKey, type NodePath, type SceneDocument } from "./document";
import { editorFor, toSceneJSON } from "./fieldValues";
import { findInner } from "./prefabs";
import { playState, type OpenScene } from "./state";

/** The World the Hierarchy and Inspector show while playing: a live World's name, or null for the edited scene. */
export const inspectedWorld = signal<string | null>(null);

/** The node selected in the inspected live World (its handle), or null. */
export const liveSelection = signal<GameObject | null>(null);

/** True while the panels show a live World (playing, with one picked). */
export const liveInspecting = (): boolean => playState.value === "playing" && inspectedWorld.value !== null;

/** Pick what the Hierarchy and Inspector show: a live World by name, or null for the edited scene. Clears the live selection. */
export function inspectWorld(name: string | null): void {
  if (name === inspectedWorld.peek()) return;
  highlightLive(null, null, null); // the previous World's outline goes
  liveSelection.value = null;
  inspectedWorld.value = name;
}

/** Back to the edited scene, forgetting the live selection (play stopped). */
export function endLiveInspection(): void {
  inspectedWorld.value = null;
  liveSelection.value = null;
  highlighted = null;
}

// --- the live tree ------------------------------------------------------------------------------

/** One row of the live tree. */
export interface LiveRow {
  readonly node: GameObject;
  /** Depth below the World root's children (0 for them). */
  readonly depth: number;
  readonly name: string;
  readonly children: number;
  readonly inactive: boolean;
  /** What the node is, for its badge: a loaded scene, a prefab instantiated at runtime, a ghost, a connection, or nothing special. */
  readonly kind: "scene" | "instance" | "ghost" | "connection" | null;
  /** Badge text: the scene or prefab file's name, or the ghost's mode. */
  readonly badge: string | null;
  /** Badge tooltip. */
  readonly detail: string | null;
}

const fileName = (path: string) => path.split("/").pop()!.replace(/\.(prefab|scene)\.json$|\.json$/, "");

/** Every node of `world` below its root, parents first, with what it is. Nodes inside a collapsed node (by entity) are left out. */
export function liveRows(world: World, collapsed: ReadonlySet<number> = new Set()): LiveRow[] {
  const rows: LiveRow[] = [];
  let skipBelow = Infinity;
  for (const info of listNodes(world)) {
    if (info.depth === 0) continue; // the World root
    const depth = info.depth - 1;
    if (depth > skipBelow) continue;
    skipBelow = Infinity;
    const node = info.node;
    let kind: LiveRow["kind"] = null;
    let badge: string | null = null;
    let detail: string | null = null;
    const source = sceneSourceOf(node);
    const prefab = instantiatedPrefabOf(node);
    const rep = node.getBehavior(Replicated);
    if (rep && (rep.isGhost || rep.ghostId)) {
      kind = "ghost";
      badge = rep.isGhost ? `ghost · ${rep.mode}${rep.isOwnedLocally ? " · mine" : ""}` : "ghost (server)";
      detail = `Ghost ${rep.ghostId}${rep.ownerId ? `, owned by connection ${rep.ownerId}` : ""}${prefab ? ` · ${prefab}` : ""}`;
    } else if (node.hasData(Connection)) {
      kind = "connection";
      badge = "connection";
    } else if (source && node.parent === world.root) {
      kind = "scene";
      badge = fileName(source);
      detail = source;
    } else if (prefab) {
      kind = "instance";
      badge = fileName(prefab);
      detail = `Instantiated at runtime from ${prefab}`;
    }
    rows.push({ node, depth, name: info.name, children: info.children.length, inactive: !info.activeInHierarchy, kind, badge, detail });
    if (collapsed.has(info.entity)) skipBelow = depth;
  }
  return rows;
}

// --- mapping live nodes to the document -----------------------------------------------------------

/** Where a live node is in the edited document, or why it isn't there. */
export type DocMapping = { readonly path: NodePath } | { readonly reason: string };

/**
 * The document path of a live node that came from the scene being edited (`scenePath`): `[id]` for
 * a node of the scene file, `[instanceId, innerId…]` for one inside a prefab instance placed in it.
 * Nodes made or instantiated at runtime, nodes of other scenes, and nodes deleted from the document
 * since Play don't map; the reason says which.
 */
export function docPathFor(node: GameObject, scenePath: string, doc: SceneDocument): DocMapping {
  if (!node.isValid) return { reason: "the node has been destroyed." };
  const world = node.world;
  const ids: string[] = [];
  for (let n: GameObject | null = node; ; n = n.parent) {
    if (!n || n === world.root) return { reason: "it isn't part of a loaded scene." };
    if (n.parent === world.root) {
      const source = sceneSourceOf(n);
      if (!source) return { reason: "it was made at runtime, outside any scene, so the scene file has nothing to keep it in." };
      if (source !== scenePath) return { reason: `it's from ${source}, not the scene being edited (${scenePath}).` };
      if (n === node) return { reason: "it's the scene itself; pick a node inside it." };
      break;
    }
    const prefab = instantiatedPrefabOf(n);
    if (prefab !== undefined) return { reason: `it ${n === node ? "was" : "is inside an instance"} instantiated at runtime from ${prefab}, so it isn't in the scene file.` };
    if (!n.id) return { reason: "it was made at runtime (it has no scene id), so it isn't in the scene file." };
    ids.unshift(n.id);
  }
  // The outermost prefab instance on the way down owns the rest as inner nodes.
  const at = ids.findIndex((id) => doc.has(id) && !!doc.node(id).prefab);
  const path = at >= 0 ? ids.slice(at) : [ids[ids.length - 1]];
  if (!doc.has(path[0]) || (path.length > 1 && !findInner(doc, path))) return { reason: "it's no longer in the scene being edited (deleted or changed since Play)." };
  return { path };
}

// --- live values and edits ------------------------------------------------------------------------

/**
 * A component's live values as scene-file JSON, the form `SetField` stores. Fields that can't be
 * written to a scene (unknown types, references to nodes that aren't in the document) are left out.
 */
export function liveValuesJSON(info: ComponentInfo, nodeId: (node: GameObject) => string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of info.fields) {
    const editor = editorFor(f);
    if (editor === "unknown") continue;
    if (editor === "node" && f.value instanceof GameObject && nodeId(f.value) === null) continue;
    if ((editor === "vector2" || editor === "vector3") && (f.value === null || f.value === undefined)) continue;
    try {
      out[f.name] = toSceneJSON(editor, f.value, { field: f.name, nodeId });
    } catch {
      // a value the scene format can't hold: leave it out
    }
  }
  return out;
}

/** Write one field of a live component (scene-file JSON, as the loader would). False if it isn't there. */
export function writeLive(node: GameObject, info: ComponentInfo, field: string, json: unknown): boolean {
  return writeField(node, info.type, info.index, field, json);
}

/** The World an Inspector selection is outlined in, so a new selection can clear it. */
let highlighted: World | null = null;

/** Outline `node` in its World's view (if it draws), clearing the previous live outline. */
export function highlightLive(engine: Engine | null, worldName: string | null, node: GameObject | null): void {
  const world = engine && worldName ? engineWorld(engine, worldName) : null;
  try {
    if (highlighted && highlighted !== world) viewport(highlighted).setSelection([]);
    if (world) viewport(world).setSelection(node?.isValid ? [node] : []);
  } catch (err) {
    console.warn("[myco] Couldn't outline the live selection:", err); // a World torn down meanwhile
  }
  highlighted = world;
}

// --- keeping changes ---------------------------------------------------------------------------------

/** A component's live values kept to write into the document on Stop. */
export interface KeptValues {
  /** Document path of the node. */
  readonly path: NodePath;
  readonly type: string;
  readonly index: number;
  /** For messages: the node's and component's names. */
  readonly nodeName: string;
  readonly title: string;
  /** Field values as scene-file JSON, as they were when kept. */
  readonly values: Readonly<Record<string, unknown>>;
}

/** Values kept in this play session, by `keptKey`. Keeping a component again replaces its entry. */
export const kept = signal<ReadonlyMap<string, KeptValues>>(new Map());

export const keptKey = (path: NodePath, type: string, index: number) => `${pathKey(path)}|${type}#${index}`;

const componentTitle = (type: string) => type.replace(/^(engine|game|editor)\./, "");

/** A node reference's document id (for kept values): only nodes that are top-level scene-file nodes can be referenced. */
function docNodeId(scenePath: string, doc: SceneDocument) {
  return (n: GameObject): string | null => {
    const m = docPathFor(n, scenePath, doc);
    return "path" in m && m.path.length === 1 ? m.path[0] : null;
  };
}

/** Remember `info`'s live values on `node` to write on Stop. Returns the entry, or why the node can't keep values. */
export function keepComponent(scene: OpenScene, node: GameObject, info: ComponentInfo): KeptValues | string {
  const mapping = docPathFor(node, scene.path, scene.doc);
  if ("reason" in mapping) return mapping.reason;
  const entry: KeptValues = {
    path: mapping.path,
    type: info.type,
    index: info.index,
    nodeName: node.name,
    title: componentTitle(info.type),
    values: liveValuesJSON(info, docNodeId(scene.path, scene.doc)),
  };
  const next = new Map(kept.peek());
  next.set(keptKey(entry.path, entry.type, entry.index), entry);
  kept.value = next;
  return entry;
}

/** Keep every component of `node` (its Transform included). Returns how many, or why it can't. */
export function keepNode(scene: OpenScene, node: GameObject): number | string {
  let n = 0;
  for (const info of listComponents(node)) {
    const r = keepComponent(scene, node, info);
    if (typeof r === "string") return r;
    n++;
  }
  return n;
}

/** Forget kept values: one entry by key, or all. */
export function forgetKept(key?: string): void {
  if (key === undefined) {
    kept.value = new Map();
    return;
  }
  const next = new Map(kept.peek());
  next.delete(key);
  kept.value = next;
}

/** Take the kept values (on Stop), leaving none. */
export function takeKept(): KeptValues[] {
  const list = [...kept.peek().values()];
  kept.value = new Map();
  return list;
}

/** What `applyKept` did: fields written, and entries it couldn't apply with why. */
export interface KeptResult {
  readonly written: number;
  readonly skipped: readonly string[];
}

/**
 * Write kept values into the open document as one undo step ("Keep play-mode changes"): each field
 * whose kept value differs from what the scene has now, through `SetField` (an override on prefab
 * instances and nodes inside them). Entries whose node or component is gone are skipped.
 */
export function applyKept(scene: OpenScene, list: readonly KeptValues[]): KeptResult {
  const { doc } = scene;
  const commands: SetField[] = [];
  const skipped: string[] = [];
  for (const k of list) {
    const label = `${k.nodeName} › ${k.title}`;
    const [id, ...target] = k.path;
    if (!doc.has(id) || (target.length > 0 && !findInner(doc, k.path))) {
      skipped.push(`${label}: the node isn't in the scene any more.`);
      continue;
    }
    const node = scene.sync.nodeFor(k.path);
    const info = node ? listComponents(node).find((c) => c.type === k.type && c.index === k.index) : undefined;
    if (!info) {
      skipped.push(`${label}: the node in the scene has no ${k.title}${k.index ? ` #${k.index + 1}` : ""}.`);
      continue;
    }
    const nodeId = (n: GameObject) => scene.sync.nodeIdOf(n);
    for (const f of info.fields) {
      if (!Object.hasOwn(k.values, f.name)) continue;
      const editor = editorFor(f);
      const previous = doc.isPrefabInstance(id) ? doc.overrideValue(id, target, k.type, f.name, k.index) : doc.fieldValue(id, k.type, f.name, k.index);
      const value = k.values[f.name];
      let current: unknown;
      try {
        current = f.value === null || f.value === undefined ? null : toSceneJSON(editor, f.value, { field: f.name, previous, nodeId });
      } catch {
        current = undefined;
      }
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      commands.push(new SetField(id, k.type, f.name, value, { index: k.index, target }));
    }
  }
  if (commands.length > 0) {
    scene.stack.beginGroup("Keep play-mode changes");
    try {
      for (const c of commands) scene.stack.execute(c);
    } finally {
      scene.stack.endGroup();
    }
  }
  return { written: commands.length, skipped };
}
