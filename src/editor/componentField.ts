// The one component-field write (ADR 0257): setting one field of one component, either in a scene document or on a
// node of a live World of the running game. The Inspector's field target (ADR 0243), every plugin Inspector section and
// every viewport gizmo write through it, so they share one set of rules:
// - a document write asks the edit gate first (ADR 0247: no scene, play mode), so during play the scene document is
//   read-only everywhere, with one wording in the status bar;
// - inside a prefab instance it is an override (`SetField` with a target path);
// - a value equal to what is stored is skipped (a drag that moves without changing anything records nothing);
// - a drag is one undo step in a document (opened through the gate), and its writes on a live node are put back when
//   it is cancelled. Live writes change the running World only, as the scene loader would assign the value, and end
//   with the play session (Unity's play-mode rule).
import { untracked } from "@preact/signals";
import { GameObject } from "../engine";
import { listComponents, listNodes, writeField, type FieldValue } from "../engine/editor";
import { SetField, type NodePath } from "./document";
import { editableNow, whyNotEdit } from "./editGate";
import { editorFor, itemEditorFor, toSceneJSON } from "./fieldValues";
import type { OpenScene } from "./state";
import { beginUndoStep } from "./undoStep";

/** A component in a scene document: on the node at `path` (`[id]`, or `[instanceId, innerId…]` inside a prefab instance). */
export interface DocumentComponent {
  readonly scene: OpenScene;
  readonly path: NodePath;
  readonly type: string;
  /** Which component of its type on the node (default 0). */
  readonly index?: number;
}

/** A component on a node of a live World (play only). */
export interface LiveComponent {
  readonly node: GameObject;
  readonly type: string;
  /** Which component of its type on the node (default 0). */
  readonly index?: number;
}

/** Where a component field write lands: a scene document, or a live World. */
export type ComponentPlace = DocumentComponent | LiveComponent;

/** A drag on a component's fields: every write until `end` is one step; `cancel` puts the values back. */
export interface FieldDrag {
  /** Whether it is still open (a document step can be closed from elsewhere, an undo say). */
  readonly open: boolean;
  end(): void;
  cancel(): void;
}

const isLive = (place: ComponentPlace): place is LiveComponent => "node" in place;
const sceneTarget = (place: DocumentComponent) => ({ kind: "scene", scene: place.scene }) as const;
const title = (type: string) => type.replace(/^[^.]*\./, "");

/** A live node's key in reference values: its entity (a destroyed node gets a key no node has). */
const liveKey = (n: GameObject) => (n.isValid ? String(n.entity) : "destroyed");

/** The node of `world` a live reference key names, or null. */
const liveNodeAt = (node: GameObject) => (key: string): GameObject | null => listNodes(node.world).find((n) => n.depth > 0 && String(n.node.entity) === key)?.node ?? null;

/** The live field `field` of the component, or undefined. */
function liveField(place: LiveComponent, field: string): FieldValue | undefined {
  const index = place.index ?? 0;
  return listComponents(place.node).find((c) => c.type === place.type && c.index === index)?.fields.find((f) => f.name === field);
}

/**
 * What `field` holds now, in scene-file form: in a document, what the file stores where a write would land (the
 * instance's override inside a prefab instance, else the node's own value; undefined when unset); on a live node, its
 * current value converted as the scene file would hold it (node references by entity), undefined when it can't be.
 */
export function storedFieldValue(place: ComponentPlace, field: string): unknown {
  const index = place.index ?? 0;
  if (isLive(place)) {
    if (!place.node.isValid) return undefined;
    const f = liveField(place, field);
    if (!f) return undefined;
    const editor = editorFor(f);
    if (editor === "unknown" || f.value === undefined) return undefined;
    try {
      return f.value === null ? null : toSceneJSON(editor, f.value, { field, nodeId: liveKey, itemEditor: editor === "list" ? itemEditorFor(f) : undefined });
    } catch {
      return undefined;
    }
  }
  const { doc } = place.scene;
  const [id, ...target] = place.path;
  if (!doc.has(id)) return undefined;
  return doc.isPrefabInstance(id) ? doc.overrideValue(id, target, place.type, field, index) : doc.fieldValue(id, place.type, field, index);
}

/** Why the document node at `place.path` can't take the write, or null. */
function whyNotOnNode(place: DocumentComponent): string | null {
  const { doc } = place.scene;
  const [id] = place.path;
  if (!doc.has(id)) return "the node isn't in the scene any more";
  if (place.path.length > 1 && !place.scene.sync.nodeFor(place.path)) return "the node isn't in its prefab instance any more";
  return null;
}

/**
 * Set `field` of the component at `place` to `value` (scene-file JSON: numbers, strings, arrays, `asset:` paths, node
 * ids; on a live node, node references are entity keys of its World). Returns null when written or when the value was
 * already stored, else why not. A document write is refused through the edit gate (the reason goes to the status bar
 * too); inside a prefab instance it is an override; it joins the undo step open on the scene's stack (a drag, an
 * `editor.scene.edit`), else it is its own step.
 */
export function writeComponentField(place: ComponentPlace, field: string, value: unknown): string | null {
  const index = place.index ?? 0;
  if (isLive(place)) {
    if (!place.node.isValid) return "the node has been destroyed";
    if (JSON.stringify(storedFieldValue(place, field)) === JSON.stringify(value)) return null;
    return writeField(place.node, place.type, index, field, value, liveNodeAt(place.node)) ? null : `${title(place.type)} has no field ${field}`;
  }
  if (!editableNow(sceneTarget(place))) return untracked(() => whyNotEdit(sceneTarget(place))) ?? "the scene can't be edited now";
  const missing = whyNotOnNode(place);
  if (missing) return missing;
  if (JSON.stringify(storedFieldValue(place, field)) === JSON.stringify(value)) return null;
  const [id, ...target] = place.path;
  place.scene.stack.execute(new SetField(id, place.type, field, value, { index, target }));
  return null;
}

/**
 * Start a drag named `label` on the component at `place`. In a document it is one undo step, opened through the edit
 * gate: null (with the reason in the status bar) when the scene can't be edited now, as during play. On a live node it
 * remembers `fields` as they are now, and `cancel` writes them back.
 */
export function beginFieldDrag(place: ComponentPlace, label: string, fields: readonly string[] = []): FieldDrag | null {
  if (!isLive(place)) {
    const scene = editableNow(sceneTarget(place));
    return scene ? beginUndoStep(scene.stack, label) : null;
  }
  const start = fields.map((f) => [f, storedFieldValue(place, f)] as const);
  let open = true;
  return {
    get open() {
      return open;
    },
    end: () => void (open = false),
    cancel() {
      if (!open) return;
      open = false;
      for (const [f, v] of start) if (v !== undefined) writeComponentField(place, f, v);
    },
  };
}
