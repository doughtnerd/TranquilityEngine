// What an Inspector field row edits (ADR 0243): one component field on one or more nodes, either in
// the edited document (as commands through `fieldEdits.ts`: overrides on prefab instances, one undo
// step across the selected nodes, refused by the edit gate during play) or in a live World of the
// running game (written as the scene loader would assign it, play-only, no undo). Both adapters write
// through the one component field write (`componentField.ts`, ADR 0257). Field rows (`ui/fieldRows.tsx`) hand a target values in the
// editors' form (numbers, strings, `Color`, axis arrays, `Quaternion`s, a node choice's key, plain
// objects, list items); each adapter converts them to scene-file JSON through the field's kind
// (`fields/kinds.ts`, ADR 0273) and writes them its own way.
import { GameObject } from "../engine";
import type { ComponentInfo, FieldValue } from "../engine/editor";
import { beginFieldDrag, writeComponentField, type FieldDrag } from "./componentField";
import type { NodePath } from "./document";
import { fieldState, revertField, rotationViewOf, setField, setFieldAxis, setFieldEach, type FieldState } from "./fieldEdits";
import { fieldKind, type NodeIds } from "./fields/kinds";
import { liveNodeChoices, setLiveNodeRef } from "./liveEdits";
import type { OpenScene } from "./state";

export type { FieldDrag };

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
  /** Set the field on each node to its own value (`values` in the target's node order), as a rotation's axis edit does. */
  setEach(field: FieldValue, values: readonly unknown[]): string | null;
  /** Set one axis of a vector (or of a rotation as its view shows it), keeping each node's other axes. */
  setAxis(field: FieldValue, axis: number, n: number): string | null;
  /** Remove the field's prefab override from every node that has one (nothing in a live World). */
  revert(field: FieldValue): void;
  /** Start a scrub drag named `label` on `field` (already closed when the target can't be edited now, as a document during play). */
  drag(field: FieldValue, label: string): FieldDrag;
  readonly nodes: NodeRefs;
}

/** The drag a refused one gets: already closed. */
const CLOSED: FieldDrag = { open: false, end() {}, cancel() {} };

/**
 * The field of component `infos[i]` on each node `paths[i]` of the open document (the last is the
 * active node). Writes go through `fieldEdits`, so they are overrides on prefab instances and one
 * undo step across the nodes; a scrub drag is one undo step (ADR 0231), cancelled on Escape. Reference
 * fields offer the document's nodes by id.
 */
export function documentFieldTarget(scene: OpenScene, paths: readonly NodePath[], infos: readonly ComponentInfo[]): FieldTarget {
  const info = infos[infos.length - 1];
  const valuesOf = (field: FieldValue) => infos.map((i) => i.fields.find((f) => f.name === field.name)?.value);
  return {
    info,
    state: (field) => fieldState(scene, paths, info, field, valuesOf(field)),
    set: (field, value) => setField(scene, paths, info, field, value),
    setEach: (field, values) => setFieldEach(scene, paths, info, field, (i) => values[i]),
    setAxis: (field, axis, n) => setFieldAxis(scene, paths, info, field, axis, n, valuesOf(field)),
    revert: (field) => revertField(scene, paths, info, field.name),
    drag: (field, label) => beginFieldDrag({ scene, path: paths[paths.length - 1], type: info.type, index: info.index }, label) ?? CLOSED,
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
 * Values are never mixed or overridden; a scrub drag is its writes, and cancelling it writes the value
 * it started from.
 */
export function liveFieldTarget(node: GameObject, info: ComponentInfo, afterEdit: () => void = () => {}): FieldTarget {
  const place = { node, type: info.type, index: info.index };
  // A destroyed node's entity may already name another node, so it gets a key no node has.
  const liveIds: NodeIds = (n) => (n.isValid ? String(n.entity) : "destroyed");
  const nodeAt = (key: string): GameObject | null => liveNodeChoices(node.world).find((c) => String(c.node.entity) === key)?.node ?? null;
  const write = (field: FieldValue, value: unknown): string | null => {
    if (!node.isValid) return "the node has been destroyed";
    const kind = fieldKind(field);
    let reason: string | null;
    if (kind.name === "node") {
      const target = value === null || value === undefined || value instanceof GameObject ? (value ?? null) : nodeAt(String(value));
      reason = value !== null && value !== undefined && target === null ? `that node isn't in World ${node.world.name}` : setLiveNodeRef(node, info, field.name, target);
    } else {
      reason = writeComponentField(place, field.name, kind.toJSON(value, liveIds));
    }
    afterEdit();
    return reason;
  };
  const valueOf = (field: FieldValue) => info.fields.find((f) => f.name === field.name)?.value ?? field.value;
  return {
    info,
    state: (field) => ({ values: [valueOf(field)], mixed: false, overridden: false }),
    set: write,
    setEach: (field, values) => write(field, values[0]),
    setAxis: (field, axis, n) => {
      const axes = fieldKind(field).axes;
      return axes ? write(field, axes.write(valueOf(field), axis, n, rotationViewOf(field))) : `${field.name} has no axes`;
    },
    revert() {},
    drag(field, label) {
      const drag = beginFieldDrag(place, label, [field.name]) ?? CLOSED;
      return {
        get open() {
          return drag.open;
        },
        end: () => drag.end(),
        cancel() {
          if (!drag.open) return;
          drag.cancel();
          afterEdit();
        },
      };
    },
    nodes: {
      choices: () => liveNodeChoices(node.world).map((c) => ({ key: String(c.node.entity), label: c.name, depth: c.depth })),
      keyOf: (v) => (v instanceof GameObject ? liveIds(v) : null),
      missing: "destroyed",
    },
  };
}
