// Field-value edits from the Inspector (ADR 0026, 0042): setting a component field on one or several
// nodes, setting one axis of a vector or rotation, reverting prefab overrides, and telling whether the
// selected nodes' values differ or are overridden. On a plain node an edit writes the scene file's
// entry; on a prefab instance, or a node inside one, it becomes a field override. Each user action is
// one undo step across every selected node; every write goes through the component field write (ADR 0257), so the
// edit gate refuses them during play. Siblings: `componentEdits.ts` (components) and
// `inspectorEdits.ts` (Worlds and tags).
import { listComponents, type ComponentInfo, type FieldValue } from "../engine/editor";
import { untracked } from "@preact/signals";
import { writeComponentField } from "./componentField";
import type { NodePath, SceneDocument } from "./document";
import { editStep, whyNotEdit } from "./editGate";
import { fieldKind, type NodeIds } from "./fields/kinds";
import type { RotationView } from "./fields/rotationCodec";
import { rotationAngles } from "./preferences";
import { isOverridden, writeProperty } from "./overrideWriter";
import type { OpenScene } from "./state";

/** Which component a field belongs to: its type and its index among the node's components of that type. */
export type ComponentRef = Pick<ComponentInfo, "type" | "index">;

/**
 * How the Inspector shows a rotation field (ADR 0165): the field's own `view` option, else the Settings >
 * Inspector > Rotation angles preference.
 */
export const rotationViewOf = (field: Pick<FieldValue, "options">): RotationView => field.options?.view ?? preferredRotationView();

/** The Rotation angles preference (anything unreadable: radians). */
const preferredRotationView = (): RotationView => (rotationAngles.value === "degrees" ? "degrees" : "radians");

/** Node references in the open document: by document id. */
const documentNodeIds = (scene: OpenScene): NodeIds => (n) => scene.sync.nodeIdOf(n);

/** True when the nodes' values (one per node) differ, by the field's kind (the same rotation is the same value). */
function isMixed(scene: OpenScene, field: FieldValue, values: readonly unknown[]): boolean {
  const kind = fieldKind(field);
  const nodeIds = documentNodeIds(scene);
  return values.some((v) => !kind.same(values[0], v, nodeIds));
}

/** True when the field is an override on any of the nodes (prefab instances and nodes inside them). */
const isFieldOverridden = (doc: SceneDocument, paths: readonly NodePath[], component: ComponentRef, field: string): boolean =>
  paths.some((p) => isOverridden(doc, p, { kind: "field", type: component.type, index: component.index, field }));

/** Each node's live value of the field (undefined where the node or component is gone). */
export function fieldValues(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: string): unknown[] {
  return paths.map((path) => {
    const node = scene.sync.nodeFor(path);
    const info = node ? listComponents(node).find((c) => c.type === component.type && c.index === component.index) : undefined;
    return info?.fields.find((f) => f.name === field)?.value;
  });
}

/** What the Inspector shows about a field on the selected nodes. */
export interface FieldState {
  /** Each node's value, in `paths` order. */
  readonly values: readonly unknown[];
  readonly mixed: boolean;
  readonly overridden: boolean;
}

export function fieldState(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: FieldValue, values = fieldValues(scene, paths, component, field.name)): FieldState {
  return { values, mixed: isMixed(scene, field, values), overridden: isFieldOverridden(scene.doc, paths, component, field.name) };
}

/** The edit gate's reason the scene can't be edited now, or null. */
const whyNotEditScene = (scene: OpenScene): string | null => untracked(() => whyNotEdit({ kind: "scene", scene }));

/**
 * Set the field on each node to `valueFor(i)` (i: the node's index in `paths`), as one undo step, through the
 * component field write (ADR 0257: the edit gate, overrides on prefab instances, unchanged values skipped). The value
 * is converted to its scene-file form by the field's kind (ADR 0273). Returns why it couldn't (play mode, say), or null.
 */
export function setFieldEach(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: FieldValue, valueFor: (i: number) => unknown): string | null {
  const kind = fieldKind(field);
  const nodeIds = documentNodeIds(scene);
  const write = (): string | null => {
    let reason: string | null = null;
    paths.forEach((path, i) => {
      const place = { scene, path, type: component.type, index: component.index };
      reason ??= writeComponentField(place, field.name, kind.toJSON(valueFor(i), nodeIds));
    });
    return reason;
  };
  if (paths.length === 1) return write();
  return editStep({ kind: "scene", scene }, `Set ${field.name} on ${paths.length} nodes`, write) ?? whyNotEditScene(scene);
}

/** Set the field to `value` on every node, as one undo step. */
export const setField = (scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: FieldValue, value: unknown): string | null =>
  setFieldEach(scene, paths, component, field, () => value);

/**
 * Set one axis of a vector (or of a rotation as its view shows it: Euler radians or degrees, or x, y, z, w;
 * ADR 0165) on every node, keeping each node's other axes, as one undo step. `values` holds each node's
 * current value (read from the live nodes when absent).
 */
export function setFieldAxis(
  scene: OpenScene,
  paths: readonly NodePath[],
  component: ComponentRef,
  field: FieldValue,
  axis: number,
  n: number,
  values: readonly unknown[] = fieldValues(scene, paths, component, field.name),
  view: RotationView = rotationViewOf(field),
): string | null {
  const axes = fieldKind(field).axes;
  if (!axes) return `${field.name} has no axes`;
  return setFieldEach(scene, paths, component, field, (i) => axes.write(values[i], axis, n, view));
}

/** Remove the field's override from every node that has one, as one undo step (through the edit gate). Plain nodes are skipped. */
export function revertField(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: string): void {
  const label = `Revert ${field}`;
  editStep({ kind: "scene", scene }, label, () => {
    for (const path of paths) {
      if (!scene.doc.isPrefabInstance(path[0])) continue;
      const command = writeProperty(scene.doc, path, { kind: "field", type: component.type, index: component.index, field }, undefined, label);
      if (command) scene.stack.execute(command);
    }
  });
}
