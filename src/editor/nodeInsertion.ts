// The node insertion (ADR 0246): the one module that puts nodes into a scene document. New nodes of a kind (the
// Create menus), pasted and duplicated copies, added assets and the shell's own templates all go through
// `insertNodes(scene, source, place)`, which mints the ids (one scheme), makes the roots' names unique among their
// siblings, re-points parents and references, resolves the place (after a row, into a node, beside a prefab
// instance, or inside one as an `addNodes` override, ADR 0086), refuses with one reason, and inserts as one undo
// step. `whyNotInsert` is the same check without the edit, for menus and drags.
import { Assets } from "../engine";
import { BRACKETED, DASHED, uniqueName } from "../engine/core/uniqueName";
import { fileName } from "./projectPath";
import { isFolderEntry, isSliceEntry, splitSliceEntry } from "./assetEntry";
import { assetKind, registeredKind, sceneNodesAt } from "./assetKindLookup";
import { writeAddNodes } from "./overrideWriter";
import { AddNode, type NodeEntry, type SceneDocument, type SceneFile } from "./document";
import { copyNodes, subtreeRoots, whyNotCopyable, type NodeClipboard } from "./nodeClipboard";
import { kindTemplate, type NodeKind } from "./nodeKinds";
import { wouldNest } from "./prefabs";
import { findInner, instanceInnerNodes, parseKey } from "./nodeKey";
import type { NodeTemplate } from "./sdk/contributions";
import { whyNotEdit } from "./editGate";
import type { OpenScene } from "./state";
import { undoStep } from "./undoStep";
import { mapEntryNodeRefs } from "../engine/scene/nodeReferences";

type Vec3 = readonly [number, number, number];

/** What to insert. */
export type InsertSource =
  /** A new node of a built-in or contributed kind (ADR 0146). `position` is where it goes when it lands at the top level (a node under a parent starts at its origin); `asset` the `asset:<path>` it uses. */
  | { readonly kind: "new"; readonly node: NodeKind; readonly position?: Vec3; readonly asset?: string }
  /** Copied nodes (a paste, ADR 0022, 0226). */
  | { readonly kind: "copies"; readonly clipboard: NodeClipboard | null }
  /** Project files, each as its kind's `addToScene.nodes` describes it (ADR 0149), at `position` in the parent's space; prefab and scene instances keep their own position unless `placeInstances`. */
  | { readonly kind: "assets"; readonly paths: readonly string[]; readonly position?: Vec3; readonly placeInstances?: boolean }
  /** The shell's own nodes (Create Prefab's group instance), as one undo step named `label`. */
  | { readonly kind: "template"; readonly nodes: readonly NodeTemplate[]; readonly label: string };

/** Copies of the nodes at `keys` (with their children), each right after its original. */
export interface DuplicateSource {
  readonly kind: "duplicate";
  readonly keys: readonly string[];
}

/** Where to insert. */
export type InsertPlace =
  /** Under the node `key` (null: the top level) at `index` among its children (absent: last). A node inside a prefab instance gets an `addNodes` override, where `index` doesn't apply. */
  | { readonly kind: "into"; readonly key: string | null; readonly index?: number }
  /** Right after the row `key` among its siblings (after its instance for a row inside one); null: the end of the scene. */
  | { readonly kind: "after"; readonly key: string | null }
  /** Into the node `key`, or right after it when it is a prefab instance or inside one (its contents come from the prefab file); null: the end of the scene. */
  | { readonly kind: "near"; readonly key: string | null };

/** What an insertion did, or why it didn't. */
export type InsertResult =
  /** `keys`: the new roots' selection keys (`instance/id` inside an instance), in order. `entries`: each root's subtree as inserted. */
  | { readonly ok: true; readonly keys: readonly string[]; readonly entries: readonly (readonly NodeEntry[])[] }
  | { readonly ok: false; readonly reason: string };

/** A resolved place: a document parent and index, or an instance's inner node (`target` inside it, empty: its root). */
type Spot = { readonly parent: string | null; readonly index?: number } | { readonly instance: string; readonly target: readonly string[] };

/** One subtree to insert, before ids are minted: entries keyed by local ids, the root first. */
interface Draft {
  readonly entries: readonly NodeEntry[];
  /** The id each local id starts from: a copy's old id; a template root's from its name or asset; a descendant's from its root's. */
  readonly base: (localId: string, rootId: string | undefined) => string;
  /** A name for a root that has none (an added asset's), unless it's an instance. */
  readonly defaultName?: string;
}

const isInside = (spot: Spot): spot is Extract<Spot, { instance: string }> => "instance" in spot;

/** A node id from text: `flappyBird` → `flappy-bird`, `My Sprite!` → `my-sprite`. */
function idFrom(text: string): string {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node"
  );
}

/** An asset's own name: a slice's name, else the file name less its kind's extension (`smoke-puff.particles.json` → `smoke-puff`). */
function assetStem(path: string): string {
  if (isSliceEntry(path)) return splitSliceEntry(path).slice;
  const name = fileName(path);
  const lower = name.toLowerCase();
  const ext = (registeredKind(assetKind(path))?.extensions ?? []).filter((e) => lower.endsWith(e.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return ext ? name.slice(0, name.length - ext.length) : name.replace(/\.[^.]+$/, "");
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where `place` puts nodes in `doc`, or why it can't. */
function resolvePlace(doc: SceneDocument, place: InsertPlace): Spot | string {
  if (place.key === null) return place.kind === "into" ? { parent: null, index: place.index } : { parent: null };
  const [id, ...target] = parseKey(place.key);
  if (!doc.has(id)) return "that node is gone";
  const after = (): Spot => {
    const parent = doc.parentOf(id);
    return { parent, index: doc.children(parent).indexOf(id) + 1 };
  };
  switch (place.kind) {
    case "after":
      return after();
    case "near":
      return target.length > 0 || doc.isPrefabInstance(id) ? after() : { parent: id };
    case "into":
      if (target.length === 0) return { parent: id, index: place.index };
      return findInner(doc, [id, ...target]) ? { instance: id, target } : "that node is gone";
  }
}

/** The names `spot`'s children have. */
function siblingNames(doc: SceneDocument, spot: Spot): string[] {
  if (isInside(spot)) {
    const level = spot.target.length === 0 ? instanceInnerNodes(doc, spot.instance) : (findInner(doc, [spot.instance, ...spot.target])?.children ?? []);
    return level.map((n) => n.name);
  }
  return doc.children(spot.parent).map((id) => doc.node(id).name ?? id);
}

/** A test for ids in use at `spot`: the document's, or inside an instance its prefab files' and its other added nodes'. */
function idsInUse(doc: SceneDocument, spot: Spot): (id: string) => boolean {
  if (!isInside(spot)) return (id) => doc.has(id);
  const used = new Set<string>();
  const walk = (prefab: string, seen: Set<string>) => {
    if (seen.has(prefab) || !Assets.has(prefab)) return;
    seen.add(prefab);
    for (const n of Assets.json<SceneFile>(prefab).nodes) {
      used.add(n.id);
      if (n.prefab) walk(n.prefab, seen);
    }
  };
  const entry = doc.node(spot.instance);
  if (entry.prefab) walk(entry.prefab, new Set());
  for (const o of entry.overrides ?? []) for (const n of o.addNodes ?? []) used.add(n.id);
  return (id) => used.has(id);
}

/** Templates as a draft: local ids `#0`, `#1`…, parents by index. */
function templateDraft(templates: readonly NodeTemplate[], asset?: string): Draft {
  const entries = templates.map((t, i): NodeEntry => {
    const { parent, ...rest } = t;
    return { ...structuredClone(rest), id: `#${i}`, ...(i > 0 && parent !== undefined ? { parent: `#${parent}` } : {}) };
  });
  const root = templates[0];
  const rootBase = root?.name !== undefined ? idFrom(root.name) : asset !== undefined ? idFrom(assetStem(asset)) : "node";
  return {
    entries,
    base: (local, rootId) => (local === "#0" ? rootBase : `${rootId ?? rootBase}-${idFrom(templates[Number(local.slice(1))]?.name ?? "node")}`),
    defaultName: asset !== undefined ? capitalised(assetStem(asset)) : undefined,
  };
}

/** The clipboard's subtrees as drafts: their ids are the bases. */
const copyDrafts = (clip: NodeClipboard): Draft[] => clip.subtrees.map((s) => ({ entries: s, base: (local) => local }));

/** The prefabs the nodes instance, nested ones their overrides add included. */
function prefabsUsed(entries: readonly NodeEntry[], out = new Set<string>()): Set<string> {
  for (const e of entries) {
    if (e.prefab) out.add(e.prefab);
    for (const o of e.overrides ?? []) if (o.addNodes) prefabsUsed(o.addNodes, out);
  }
  return out;
}

/** Why instancing the nodes' prefabs in `doc` would make a file contain itself, or null. */
function whyNested(doc: SceneDocument, entries: readonly NodeEntry[]): string | null {
  for (const e of entries) if (e.prefab && wouldNest(e.prefab, doc.path)) return `${e.prefab} would end up inside itself`;
  return null;
}

/** Why the source can't be inserted into `doc` (the place aside), or null. */
function whyNotSource(doc: SceneDocument, source: InsertSource | DuplicateSource): string | null {
  switch (source.kind) {
    case "new":
      return kindTemplate(source.node, [0, 0, 0], true) ? null : `there is no "${source.node}" node kind (is its plugin disabled?)`;
    case "duplicate":
      return whyNotCopyable(doc, source.keys);
    case "template":
      return source.nodes.length === 0 ? "nothing to add" : whyNested(doc, source.nodes.map((t, i) => ({ ...t, id: `#${i}`, parent: undefined })));
    case "copies": {
      const clip = source.clipboard;
      if (!clip || clip.subtrees.length === 0) return "nothing copied";
      const nested = whyNested(doc, clip.subtrees.flat());
      if (nested) return nested;
      // The clipboard holds an instance's overrides, not its prefab (ADR 0226): one the project lacks is refused.
      const missing = [...prefabsUsed(clip.subtrees.flat())].filter((p) => !Assets.has(p));
      if (missing.length === 0) return null;
      return missing.length === 1 ? `the prefab ${missing[0]} isn't in this project` : `the prefabs ${missing.join(", ")} aren't in this project`;
    }
    case "assets": {
      const { paths } = source;
      if (paths.length === 0) return "nothing to add";
      if (paths.some(isFolderEntry)) return "folders can't be added to a scene";
      for (const path of paths) {
        const add = sceneNodesAt(path);
        const reason = add ? (add.whyNot?.(doc, path) ?? null) : "no kind of scene node fits this file";
        if (reason) return paths.length === 1 ? reason : `${fileName(path)}: ${reason}`;
      }
      return null;
    }
  }
}

/**
 * Why `source` can't be inserted into `scene` at `place` now, or null if it can: the edit gate's (no scene, play mode), a place
 * that's gone, or what the source refuses (nothing copied, an unknown kind, folders, an asset kind's refusal, a
 * prefab inside itself, a pasted instance of a prefab the project lacks). Reads the gate's signals, so a
 * component calling it re-renders when play starts or stops.
 */
export function whyNotInsert(scene: OpenScene | null, source: DuplicateSource): string | null;
export function whyNotInsert(scene: OpenScene | null, source: InsertSource, place: InsertPlace): string | null;
export function whyNotInsert(scene: OpenScene | null, source: InsertSource | DuplicateSource, place?: InsertPlace): string | null {
  const gate = whyNotEdit({ kind: "scene", scene }); // no scene, play mode (ADR 0247)
  if (gate || !scene) return gate ?? "open a scene first";
  if (place) {
    const spot = resolvePlace(scene.doc, place);
    if (typeof spot === "string") return spot;
  }
  return whyNotSource(scene.doc, source);
}

/** The drafts a source makes at `spot`. */
function draftsOf(source: InsertSource, spot: Spot): Draft[] {
  switch (source.kind) {
    case "new": {
      const topLevel = !isInside(spot) && spot.parent === null;
      return [templateDraft([kindTemplate(source.node, topLevel ? (source.position ?? [0, 0, 0]) : [0, 0, 0], topLevel, source.asset)!])];
    }
    case "copies":
      return copyDrafts(source.clipboard!);
    case "template":
      return [templateDraft(source.nodes)];
    case "assets":
      return source.paths.map((path) => {
        const add = sceneNodesAt(path)!;
        return templateDraft(add.nodes(path, add.keepsOwnPosition && !source.placeInstances ? undefined : source.position), path);
      });
  }
}

/**
 * The drafts ready to insert at `spot`: ids minted, parents and references re-pointed (other references kept
 * only for copies pasted back into their own scene, never inside an instance), each root named uniquely among
 * its new siblings.
 */
function finish(doc: SceneDocument, drafts: readonly Draft[], spot: Spot, sameScene: boolean): NodeEntry[][] {
  const inUse = idsInUse(doc, spot);
  const taken = new Set<string>();
  const ids = drafts.map((d) => {
    const map = new Map<string, string>();
    for (const e of d.entries) {
      const id = uniqueName(d.base(e.id, map.get(d.entries[0].id)), (x) => inUse(x) || taken.has(x), DASHED);
      taken.add(id);
      map.set(e.id, id);
    }
    return map;
  });
  const names = siblingNames(doc, spot);
  return drafts.map((d, k) => {
    const map = ids[k];
    const refer = (id: string) => map.get(id) ?? (sameScene && !isInside(spot) && doc.has(id) ? id : null);
    return d.entries.map((e, i) => {
      const entry = structuredClone(e) as NodeEntry;
      entry.id = map.get(e.id)!;
      if (i === 0) {
        delete entry.parent;
        if (entry.name === undefined && !entry.prefab && d.defaultName !== undefined) entry.name = d.defaultName;
        if (entry.name !== undefined) {
          entry.name = uniqueName(entry.name, names, BRACKETED);
          names.push(entry.name);
        }
      } else if (entry.parent != null) {
        entry.parent = map.get(entry.parent) ?? entry.parent;
      }
      return mapEntryNodeRefs(entry, refer);
    });
  });
}

/** "Paste Bird", "Paste 3 nodes". */
const describe = (verb: string, subtrees: readonly (readonly NodeEntry[])[]) => (subtrees.length === 1 ? `${verb} ${subtrees[0][0].name ?? subtrees[0][0].id}` : `${verb} ${subtrees.length} nodes`);

/** The undo step's name for inserting `source`. */
function labelOf(source: InsertSource, subtrees: readonly (readonly NodeEntry[])[]): string {
  switch (source.kind) {
    case "new":
      return describe("Create", subtrees);
    case "copies":
      return describe("Paste", subtrees);
    case "template":
      return source.label;
    case "assets":
      return `Add ${source.paths.length === 1 ? fileName(source.paths[0]) : `${source.paths.length} assets`}`;
  }
}

/** Execute the insertion of finished subtrees at `spot`; returns the roots' keys. */
function execute(scene: OpenScene, subtrees: readonly NodeEntry[][], spot: Spot, label: string): string[] {
  const { doc, stack } = scene;
  if (isInside(spot)) {
    // Inside a prefab instance: the nodes are an `addNodes` override of the instance (ADR 0086).
    undoStep(stack, label, () => stack.execute(writeAddNodes(doc, [spot.instance, ...spot.target], subtrees.flat(), label)));
    return subtrees.map((s) => `${spot.instance}/${s[0].id}`);
  }
  undoStep(stack, label, () => {
    subtrees.forEach((s, i) => stack.execute(new AddNode(s, { parent: spot.parent, index: spot.index === undefined ? undefined : spot.index + i })));
  });
  return subtrees.map((s) => s[0].id);
}

/**
 * Insert `source` into `scene` at `place` as one undo step (duplicates: each right after its original). Returns the
 * new roots' keys and entries, or the reason it can't (`whyNotInsert`).
 */
export function insertNodes(scene: OpenScene | null, source: DuplicateSource): InsertResult;
export function insertNodes(scene: OpenScene | null, source: InsertSource, place: InsertPlace): InsertResult;
export function insertNodes(scene: OpenScene | null, source: InsertSource | DuplicateSource, place?: InsertPlace): InsertResult {
  const reason = place ? whyNotInsert(scene, source as InsertSource, place) : whyNotInsert(scene, source as DuplicateSource);
  if (reason || !scene) return { ok: false, reason: reason ?? "open a scene first" };
  const { doc, stack } = scene;
  if (source.kind === "duplicate") {
    const roots = subtreeRoots(doc, source.keys);
    const keys: string[] = [];
    const entries: NodeEntry[][] = [];
    const label = roots.length === 1 ? `Duplicate ${doc.node(roots[0]).name ?? roots[0]}` : `Duplicate ${roots.length} nodes`;
    undoStep(stack, label, () => {
      for (const id of roots) {
        // Not a paste: an instance of a missing prefab duplicates as it is (the scene already has one).
        const spot = resolvePlace(doc, { kind: "after", key: id }) as Spot;
        const subtrees = finish(doc, copyDrafts(copyNodes(doc, [id])), spot, true);
        keys.push(...execute(scene, subtrees, spot, label));
        entries.push(...subtrees);
      }
    });
    return { ok: true, keys, entries };
  }
  const spot = resolvePlace(doc, place!) as Spot;
  const subtrees = finish(doc, draftsOf(source, spot), spot, source.kind === "copies" && source.clipboard!.source === doc.path);
  if (subtrees.some((s) => s.length === 0)) return { ok: false, reason: "nothing to add" };
  const keys = execute(scene, subtrees, spot, labelOf(source, subtrees));
  return { ok: true, keys, entries: subtrees };
}
