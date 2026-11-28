// Node edits from the Inspector's header (ADR 0022, 0087, 0122): switching nodes on or off, renaming,
// reverting a name or active override, and the prefab actions (Create Prefab, Apply, Revert All, Open
// Prefab). Works over node paths in the open scene: a top-level node's path is its id; a node inside a
// prefab instance is the instance id followed by its path in the prefab, and edits to it become the
// instance's overrides. Each user action is one undo step across every selected node, and goes through the edit gate
// (ADR 0247, 0257), so none of them changes the scene during play. Each action can
// say why it isn't allowed (`whyNot`), read-only projects included (`readOnly.ts`), and the prefab
// actions report their outcome, or the refusal, in the status bar. Siblings: `fieldEdits.ts` (field
// values), `componentEdits.ts` (components) and `inspectorEdits.ts` (Worlds and tags).
import { RenameNodeId, RevertOverrides, type NodePath, type SceneDocument } from "./document";
import { errorStatus } from "./messages";
import { isOverridden, writeProperty } from "./overrideWriter";
import { applyOverridesTo, createPrefab, createPrefabFromNodes } from "./prefabs";
import { findInner } from "./nodeKey";
import { openPrefabFrom } from "./prefabTabs";
import type { EditorProject } from "./projects";
import { whyReadOnly } from "./readOnly";
import { select } from "./inspectorTarget";
import { selectedKeys, status, type OpenScene } from "./state";
import { editableNow, statusSentence, whyNotEdit } from "./editGate";
import { undoStep } from "./undoStep";

const isInner = (path: NodePath) => path.length > 1;
const NAME = { kind: "name" } as const;
const ACTIVE = { kind: "active" } as const;

/** The node's name as the scene shows it: its entry's name (else its id), or an inner node's name. */
function nameOf(scene: OpenScene, path: NodePath): string {
  if (isInner(path)) return findInner(scene.doc, path)?.name ?? path[path.length - 1];
  return scene.doc.node(path[0]).name ?? path[0];
}

function activeOf(scene: OpenScene, path: NodePath): boolean {
  if (isInner(path)) return findInner(scene.doc, path)?.active ?? true;
  return scene.doc.node(path[0]).active !== false;
}

/** What the Inspector's header shows about the selected nodes. */
export interface NodeHeader {
  /** Each node's name, in `paths` order. */
  readonly names: readonly string[];
  /** On or off; "mixed" when the nodes differ. */
  readonly active: boolean | "mixed";
  /** True when any node is inside a prefab instance (its name and active flag are overrides; it can't be deleted on its own). */
  readonly inner: boolean;
  /** True when any node inside an instance has a name override. */
  readonly nameOverridden: boolean;
  /** True when any node inside an instance has an active override. */
  readonly activeOverridden: boolean;
}

export function nodeHeader(scene: OpenScene, paths: readonly NodePath[]): NodeHeader {
  const actives = paths.map((p) => activeOf(scene, p));
  return {
    names: paths.map((p) => nameOf(scene, p)),
    active: actives.every(Boolean) ? true : actives.some(Boolean) ? "mixed" : false,
    inner: paths.some(isInner),
    nameOverridden: paths.some((p) => isOverridden(scene.doc, p, NAME)),
    activeOverridden: paths.some((p) => isOverridden(scene.doc, p, ACTIVE)),
  };
}

/**
 * Switch every node on or off, as one undo step; nodes already so are left alone. Inside a prefab
 * instance it's an override, which goes away when the value matches the prefab's. Returns how many changed.
 */
export function setNodesActive(scene: OpenScene, paths: readonly NodePath[], on: boolean): number {
  if (!editableNow({ kind: "scene", scene })) return 0;
  const changing = paths.filter((p) => activeOf(scene, p) !== on);
  const write = () => {
    for (const p of changing) {
      const command = writeProperty(scene.doc, p, ACTIVE, on);
      if (command) scene.stack.execute(command);
    }
  };
  if (changing.length === 1) write();
  else if (changing.length > 1) undoStep(scene.stack, `${on ? "Activate" : "Deactivate"} ${changing.length} nodes`, write);
  return changing.length;
}

/**
 * Rename the node, as one undo step (inside a prefab instance, an override that goes away when the
 * name matches the prefab's). Returns false, changing nothing, when the name is already `name`.
 */
export function renameNode(scene: OpenScene, path: NodePath, name: string): boolean {
  if (!editableNow({ kind: "scene", scene })) return false;
  if (name === nameOf(scene, path)) return false;
  const command = writeProperty(scene.doc, path, NAME, name);
  if (!command) return false;
  scene.stack.execute(command);
  return true;
}

/**
 * Why `next` can't be the id of the top-level node `id`, or null when it can: not empty, no "/" (it joins the
 * ids of a path), and not another node's id in the scene. `next` is taken as typed, trimmed.
 */
export function nodeIdProblem(doc: SceneDocument, id: string, next: string): string | null {
  const wanted = next.trim();
  if (wanted === "") return "An id can't be empty.";
  if (wanted.includes("/")) return 'An id can\'t contain "/".';
  if (wanted !== id && doc.has(wanted)) return `Another node already has the id "${wanted}".`;
  return null;
}

/**
 * Change a top-level node's id as one undo step, following the references to it (`{"$node": id}`, children's
 * parents) and the selection. Returns the problem (see `nodeIdProblem`) and changes nothing when the id isn't
 * allowed; null when it changed or was already `next`.
 */
export function renameNodeId(scene: OpenScene, id: string, next: string): string | null {
  const wanted = next.trim();
  const problem = nodeIdProblem(scene.doc, id, wanted);
  if (problem) return problem;
  if (wanted === id || !editableNow({ kind: "scene", scene })) return null;
  scene.stack.execute(new RenameNodeId(id, wanted));
  const moved = (k: string) => (k === id || k.startsWith(`${id}/`) ? wanted + k.slice(id.length) : k);
  const keys = selectedKeys.peek();
  if (keys.some((k) => moved(k) !== k)) select(keys.map(moved), moved(keys[keys.length - 1]));
  return null;
}

/** Remove the name and active overrides of the nodes inside instances, as one undo step. Returns how many were removed. */
export function revertNameAndActive(scene: OpenScene, paths: readonly NodePath[]): number {
  if (!editableNow({ kind: "scene", scene })) return 0;
  const found = paths.flatMap((p) => [NAME, ACTIVE].filter((key) => isOverridden(scene.doc, p, key)).map((key) => ({ p, key })));
  if (found.length > 0) {
    undoStep(scene.stack, "Revert name and active", () => {
      for (const { p, key } of found) {
        const command = writeProperty(scene.doc, p, key, undefined);
        if (command) scene.stack.execute(command);
      }
    });
  }
  return found.length;
}

// --- prefab actions ----------------------------------------------------------------------------

/** An action the Inspector offers for the selection. */
export interface NodeAction {
  /** Why it can't run now (a sentence, for its tooltip), or null when it can. */
  readonly whyNot: string | null;
}

/** The prefab actions offered for the selected nodes; null where an action isn't offered at all. */
export interface PrefabActions {
  /** Save the plain nodes as a prefab and replace them with an instance (several: siblings, under a new Group root). */
  readonly create: NodeAction | null;
  /** Write the instances' overrides into their prefab files. */
  readonly apply: NodeAction | null;
  /** Remove every override of the instance (one instance selected). */
  readonly revertAll: NodeAction | null;
  /** Open the prefab in its own tab (one instance, or one node inside an instance, selected). */
  readonly open: NodeAction | null;
  /** The prefab the one selected node is an instance of, or is inside; else null. */
  readonly prefab: string | null;
  /** How many overrides the selected instances have in all. */
  readonly overrides: number;
}

const NO_OVERRIDES = "This instance has no overrides.";
const NO_PROJECT = "No project is open.";

const overrideCount = (scene: OpenScene, id: string) => scene.doc.node(id).overrides?.length ?? 0;
const can = (whyNot: string | null): NodeAction => ({ whyNot });
/** Why the scene can't take `toDo` now (the edit gate: playing, say), as a tooltip sentence, or null. */
const editable = (scene: OpenScene, toDo: string): string | null => {
  const reason = whyNotEdit({ kind: "scene", scene }, toDo);
  return reason && statusSentence(reason);
};
const writable = (scene: OpenScene, project: EditorProject | null, toDo: string) => editable(scene, toDo) ?? (project ? whyReadOnly(project, toDo) : NO_PROJECT);

export function prefabActions(scene: OpenScene, project: EditorProject | null, paths: readonly NodePath[]): PrefabActions {
  const none: PrefabActions = { create: null, apply: null, revertAll: null, open: null, prefab: null, overrides: 0 };
  if (paths.length === 0) return none;
  if (paths.length === 1) {
    const [id] = paths[0];
    const prefab = scene.doc.node(id).prefab ?? null;
    if (isInner(paths[0])) return { ...none, prefab, open: can(null) };
    if (!prefab) return { ...none, create: can(writable(scene, project, "create prefabs")) };
    const overrides = overrideCount(scene, id);
    return {
      ...none,
      prefab,
      overrides,
      apply: can(writable(scene, project, "apply overrides") ?? (overrides === 0 ? NO_OVERRIDES : null)),
      revertAll: can(editable(scene, "revert overrides") ?? (overrides === 0 ? NO_OVERRIDES : null)),
      open: can(null),
    };
  }
  if (paths.some(isInner)) return none;
  const ids = paths.map((p) => p[0]);
  const plain = ids.every((id) => !scene.doc.node(id).prefab);
  const withOverrides = instancesWithOverrides(scene, paths);
  const parent = scene.doc.parentOf(ids[0]);
  const siblings = ids.every((id) => scene.doc.parentOf(id) === parent);
  return {
    ...none,
    overrides: withOverrides.reduce((n, id) => n + overrideCount(scene, id), 0),
    create: plain ? can(writable(scene, project, "create prefabs") ?? (siblings ? null : "The nodes must share a parent to become one prefab.")) : null,
    apply: withOverrides.length > 0 ? can(writable(scene, project, "apply overrides")) : null,
  };
}

/** The selected prefab instances (top-level paths) that have overrides. */
const instancesWithOverrides = (scene: OpenScene, paths: readonly NodePath[]): string[] =>
  paths.filter((p) => !isInner(p) && scene.doc.node(p[0]).prefab && overrideCount(scene, p[0]) > 0).map((p) => p[0]);

/** Says why in the status bar and returns true when `action` isn't offered or allowed. */
function refused(action: NodeAction | null, what: string): boolean {
  if (action && action.whyNot === null) return false;
  status.value = { kind: "info", text: action?.whyNot ?? `${what} isn't available for this selection.` };
  return true;
}

/**
 * Create Prefab (ADR 0022, 0087): one plain node becomes an instance of a new prefab file (and stays
 * selected); several sibling nodes are saved under a new Group root and replaced by one instance. One undo
 * step; the file stays on disk. Reports the outcome in the status bar. Returns the prefab path, or null when
 * refused or the write failed.
 */
export async function createPrefabFrom(scene: OpenScene, project: EditorProject | null, paths: readonly NodePath[]): Promise<string | null> {
  if (refused(prefabActions(scene, project, paths).create, "Create Prefab") || !project) return null;
  const ids = paths.map((p) => p[0]);
  try {
    const { path, instanceOverrides: n, droppedListItems: d } = ids.length === 1 ? await createPrefab(scene, project, ids[0]) : await createPrefabFromNodes(scene, project, ids);
    if (ids.length === 1) select([ids[0]]);
    // ADR 0401: a prefab file can't reference scene nodes, so those references stay on the instance.
    const kept =
      n === 0 ? "" : ` ${n} reference${n === 1 ? "" : "s"} to nodes outside the prefab became instance override${n === 1 ? "" : "s"}; the prefab file leaves ${n === 1 ? "it" : "them"} empty.`;
    const left =
      d === 0 ? "" : ` ${d} list item${d === 1 ? "" : "s"} naming nodes inside the prefab ${d === 1 ? "was" : "were"} cleared in the instance's override${d === 1 ? "" : "s"} (the prefab file keeps ${d === 1 ? "it" : "them"}).`;
    status.value = { kind: "info", text: `Created ${path}.${kept}${left} Undo turns the node${ids.length === 1 ? "" : "s"} back; the file stays on disk.` };
    return path;
  } catch (err) {
    status.value = errorStatus(null, err);
    return null;
  }
}

/**
 * Apply (ADR 0087): write the selected instances' overrides into their prefab files (updating every instance),
 * one undo step per instance; the files keep the change. Reports the outcome in the status bar. Returns how
 * many overrides were applied, or null when refused or a write failed.
 */
export async function applyPrefabOverrides(scene: OpenScene, project: EditorProject | null, paths: readonly NodePath[]): Promise<number | null> {
  if (refused(prefabActions(scene, project, paths).apply, "Apply") || !project) return null;
  const instances = instancesWithOverrides(scene, paths);
  try {
    const n = await applyOverridesTo(scene, project, instances);
    const s = n === 1 ? "" : "s";
    status.value = {
      kind: "info",
      text:
        instances.length === 1
          ? `Applied ${n} override${s} to ${scene.doc.node(instances[0]).prefab}. Undo restores them here; the prefab file keeps the change.`
          : `Applied ${n} override${s} from ${instances.length} instances.`,
    };
    return n;
  } catch (err) {
    status.value = errorStatus(null, err);
    return null;
  }
}

/** Revert All: remove every override of the selected instance, back to the prefab's values, as one undo step. Returns how many were removed. */
export function revertAllOverrides(scene: OpenScene, paths: readonly NodePath[]): number {
  if (refused(prefabActions(scene, null, paths).revertAll, "Revert All")) return 0;
  const id = paths[0][0];
  const n = overrideCount(scene, id);
  scene.stack.execute(new RevertOverrides(id, "Revert all overrides"));
  return n;
}

/** Open Prefab (ADR 0122): the prefab of the selected instance, or of the instance a selected inner node is in, opens in its own tab with that node selected. */
export async function openPrefabOf(scene: OpenScene, paths: readonly NodePath[]): Promise<void> {
  if (refused(prefabActions(scene, null, paths).open, "Open Prefab")) return;
  await openPrefabFrom(paths[0]);
}
