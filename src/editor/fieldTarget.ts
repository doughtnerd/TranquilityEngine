// What an Inspector field row edits (ADR 0158): one component field on one or more nodes, either in
// the edited document (as commands: overrides on prefab instances, one undo step across the selected
// nodes) or in a live World of the running game (written as the loader would, play-only, no undo).
// Field rows (`ui/fieldRows.tsx`) hand a target values in the editors' form (numbers, strings,
// `Color`, axis arrays, a node choice's key, plain objects, list items); each adapter converts them to
// scene-file JSON with `toSceneJSON` and writes them its own way.
import { GameObject } from "../engine";
import { writeField, type ComponentInfo, type FieldValue } from "../engine/editor";
import type { NodePath } from "./document";
import { fieldState, revertField, setField, setFieldAxis, withAxis, type FieldState } from "./fieldEdits";
import { editorFor, itemEditorFor, toSceneJSON } from "./fieldValues";
import { liveNodeChoices, setLiveNodeRef } from "./liveEdits";
import type { OpenScene } from "./state";

/** A node a reference field can point to. */
export interface NodeChoice {
  /** What the editor commits for it: a document node id, or a live node's entity. */
  readonly key: string;
  readonly label: string;
  /** Indentation in the list (0 for a flat list). */
  readonly depth: number;
}

/** The nodes a target's reference fields can point to. */
export interface NodeRefs {
  /** The choices, in the order offered (None comes first and isn't listed). */
  choices(): readonly NodeChoice[];
  /** The key of a reference value, or null for None. A key outside `choices()` is a node the target can't offer. */
  keyOf(value: unknown): string | null;
  /** How a referenced node outside the choices is described, e.g. "destroyed". */
  readonly missing: string;
}

/** One component field on one or more nodes, as a field row edits it. */
export interface FieldTarget {
  /** The component on the active (last) node: its type, index and fields. */
  readonly info: ComponentInfo;
  /** What the row shows: each node's value, whether they differ, whether it's a prefab override. */
  state(field: FieldValue): FieldState;
  /** Set the field on every node to `value` (the editor's form). Returns why it couldn't, or null. */
  set(field: FieldValue, value: unknown): string | null;
  /** Set one axis of a vector or of a rotation's Euler degrees, keeping each node's other axes. */
  setAxis(field: FieldValue, axis: number, n: number): string | null;
  /** Remove the field's prefab override from every node that has one (nothing in a live World). */
  revert(field: FieldValue): void;
  /** Start a scrub drag named `label`; its writes are one step. Returns the function that ends it. */
  drag(label: string): () => void;
  readonly nodes: NodeRefs;
}

const once = (end: () => void) => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    end();
  };
};

/**
 * The field of component `infos[i]` on each node `paths[i]` of the open document (the last is the
 * active node). Writes go through `fieldEdits`, so they are overrides on prefab instances and one
 * undo step across the nodes; a scrub drag is one undo group. Reference fields offer the document's
 * nodes by id.
 */
export function documentFieldTarget(scene: OpenScene, paths: readonly NodePath[], infos: readonly ComponentInfo[]): FieldTarget {
  const info = infos[infos.length - 1];
  const valuesOf = (field: FieldValue) => infos.map((i) => i.fields.find((f) => f.name === field.name)?.value);
  return {
    info,
    state: (field) => fieldState(scene, paths, info, field.name, valuesOf(field)),
    set(field, value) {
      setField(scene, paths, info, field, value);
      return null;
    },
    setAxis(field, axis, n) {
      setFieldAxis(scene, paths, info, field, axis, n, valuesOf(field));
      return null;
    },
    revert: (field) => revertField(scene, paths, info, field.name),
    drag(label) {
      scene.stack.beginGroup(label);
      return once(() => scene.stack.endGroup());
    },
    nodes: {
      choices: () => scene.doc.nodes.map((n) => ({ key: n.id, label: n.name ?? n.id, depth: 0 })),
      keyOf: (v) => (v instanceof GameObject ? scene.sync.nodeIdOf(v) : null),
      missing: "not in this scene",
    },
  };
}

/**
 * The field of component `info` on a node of a live World (ADR 0022, 0124). Writes change the running
 * World only, as the scene loader would assign the value; `afterEdit` runs after each (to redraw a
 * paused session). Reference fields offer the nodes of the node's own World (ADR 0032), by entity.
 * Values are never mixed or overridden, and a scrub drag is just its writes.
 */
export function liveFieldTarget(node: GameObject, info: ComponentInfo, afterEdit: () => void = () => {}): FieldTarget {
  const title = info.type.replace(/^[^.]*\./, "");
  const nodeAt = (key: string): GameObject | null => liveNodeChoices(node.world).find((c) => String(c.node.entity) === key)?.node ?? null;
  const write = (field: FieldValue, value: unknown): string | null => {
    if (!node.isValid) return "the node has been destroyed";
    const editor = editorFor(field);
    let reason: string | null;
    if (editor === "node") {
      const target = value === null || value === undefined || value instanceof GameObject ? (value ?? null) : nodeAt(String(value));
      reason = value !== null && value !== undefined && target === null ? `that node isn't in World ${node.world.name}` : setLiveNodeRef(node, info, field.name, target);
    } else {
      const json = toSceneJSON(editor, value, { field: field.name, nodeId: (n) => (n.isValid ? String(n.entity) : "destroyed"), itemEditor: editor === "list" ? itemEditorFor(field) : undefined });
      reason = writeField(node, info.type, info.index, field.name, json, nodeAt) ? null : `${title} has no field ${field.name}`;
    }
    afterEdit();
    return reason;
  };
  const valueOf = (field: FieldValue) => info.fields.find((f) => f.name === field.name)?.value ?? field.value;
  return {
    info,
    state: (field) => ({ values: [valueOf(field)], mixed: false, overridden: false }),
    set: write,
    setAxis: (field, axis, n) => write(field, withAxis(valueOf(field), editorFor(field), axis, n)),
    revert() {},
    drag: () => () => {},
    nodes: {
      choices: () => liveNodeChoices(node.world).map((c) => ({ key: String(c.node.entity), label: c.name, depth: c.depth })),
      // A destroyed node's entity may already name another node, so it gets a key no choice has.
      keyOf: (v) => (v instanceof GameObject ? (v.isValid ? String(v.entity) : "destroyed") : null),
      missing: "destroyed",
    },
  };
}
