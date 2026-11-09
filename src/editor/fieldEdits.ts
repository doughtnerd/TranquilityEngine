// Field-value edits from the Inspector (ADR 0026, 0042): setting a component field on one or several
// nodes, setting one axis of a vector or rotation, reverting prefab overrides, and telling whether the
// selected nodes' values differ or are overridden. On a plain node an edit writes the scene file's
// entry; on a prefab instance, or a node inside one, it becomes a field override. Each user action is
// one undo step across every selected node. Siblings: `componentEdits.ts` (components) and
// `inspectorEdits.ts` (Worlds and tags).
import { Color, GameObject, Quaternion } from "../engine";
import { listComponents, type ComponentInfo, type FieldValue } from "../engine/editor";
import { RevertOverrides, SetField, isFieldOverride, type NodePath, type SceneDocument } from "./document";
import { editorFor, itemEditorFor, toSceneJSON, type FieldEditor } from "./fieldValues";
import { isOverridden } from "./prefabs";
import type { OpenScene } from "./state";

/** Which component a field belongs to: its type and its index among the node's components of that type. */
export type ComponentRef = Pick<ComponentInfo, "type" | "index">;

/** Euler angles (degrees) of a quaternion, rounded so a typed 30 doesn't read back as 29.999999. */
export const eulerAnglesOf = (q: Quaternion): number[] => roundAngles(q.toEuler().toArray());

const roundAngles = (a: number[]) => a.map((n) => Math.round(n * 1e4) / 1e4 + 0); // + 0: no -0

/** A vector's (or a quaternion's Euler angles') axes, or a default when it's unset. */
export function axesBase(value: unknown, editor: FieldEditor): number[] {
  if (value instanceof Quaternion) return eulerAnglesOf(value);
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object" && "toArray" in value) return (value as { toArray(): number[] }).toArray();
  return editor === "vector2" ? [1, 1] : [0, 0, 0];
}

/** `value` with axis `axis` set to `n`, its other axes kept (a quaternion becomes Euler degrees). */
export const withAxis = (value: unknown, editor: FieldEditor, axis: number, n: number): number[] => axesBase(value, editor).map((old, j) => (j === axis ? n : old));

/** A comparable form of a field value, to tell whether several nodes' values differ. */
export function valueKey(v: unknown, scene: OpenScene): string {
  if (Array.isArray(v)) return `[${v.map((x) => valueKey(x, scene)).join(",")}]`;
  if (v instanceof Quaternion) return `quat:${JSON.stringify(eulerAnglesOf(v))}`;
  if (v instanceof Color) return `color:${v.toHex()}:${v.a}`;
  if (v instanceof GameObject) return `node:${scene.sync.nodeIdOf(v)}`;
  if (v && typeof v === "object" && "toArray" in v) return JSON.stringify((v as { toArray(): number[] }).toArray());
  return JSON.stringify(v ?? null);
}

/** True when the nodes' values (one per node) differ. */
export const isMixed = (scene: OpenScene, values: readonly unknown[]): boolean => new Set(values.map((v) => valueKey(v, scene))).size > 1;

/** True when the field is an override on any of the nodes (prefab instances and nodes inside them). */
export const isFieldOverridden = (doc: SceneDocument, paths: readonly NodePath[], component: ComponentRef, field: string): boolean =>
  paths.some((p) => isOverridden(doc, p, component.type, field, component.index));

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

export function fieldState(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: string, values = fieldValues(scene, paths, component, field)): FieldState {
  return { values, mixed: isMixed(scene, values), overridden: isFieldOverridden(scene.doc, paths, component, field) };
}

function inGroup(scene: OpenScene, label: string, body: () => void): void {
  scene.stack.beginGroup(label);
  try {
    body();
  } finally {
    scene.stack.endGroup();
  }
}

/**
 * Set the field on each node to `valueFor(i)` (i: the node's index in `paths`), as one undo step. The
 * value is converted to its scene-file form against what the file holds now: the instance's override
 * on a prefab instance (or a node inside one), else the node's own field.
 */
export function setFieldEach(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: FieldValue, valueFor: (i: number) => unknown): void {
  const editor = editorFor(field);
  const write = () =>
    paths.forEach(([id, ...target], i) => {
      const previous = scene.doc.isPrefabInstance(id)
        ? scene.doc.overrideValue(id, target, component.type, field.name, component.index)
        : scene.doc.fieldValue(id, component.type, field.name, component.index);
      const json = toSceneJSON(editor, valueFor(i), {
        field: field.name,
        previous,
        nodeId: (n) => scene.sync.nodeIdOf(n),
        itemEditor: editor === "list" ? itemEditorFor(field) : undefined,
      });
      scene.stack.execute(new SetField(id, component.type, field.name, json, { index: component.index, target }));
    });
  if (paths.length === 1) write();
  else inGroup(scene, `Set ${field.name} on ${paths.length} nodes`, write);
}

/** Set the field to `value` on every node, as one undo step. */
export const setField = (scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: FieldValue, value: unknown): void =>
  setFieldEach(scene, paths, component, field, () => value);

/**
 * Set one axis of a vector (or of a rotation's Euler angles) on every node, keeping each node's other
 * axes, as one undo step. `values` holds each node's current value (read from the live nodes when absent).
 */
export function setFieldAxis(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: FieldValue, axis: number, n: number, values: readonly unknown[] = fieldValues(scene, paths, component, field.name)): void {
  const editor = editorFor(field);
  setFieldEach(scene, paths, component, field, (i) => withAxis(values[i], editor, axis, n));
}

/** Remove the field's override from every node that has one, as one undo step. Plain nodes are skipped. */
export function revertField(scene: OpenScene, paths: readonly NodePath[], component: ComponentRef, field: string): void {
  const label = `Revert ${field}`;
  inGroup(scene, label, () => {
    for (const [id, ...target] of paths) {
      if (!scene.doc.isPrefabInstance(id)) continue;
      scene.stack.execute(new RevertOverrides(id, label, (o) => isFieldOverride(o, target, component.type, field, component.index)));
    }
  });
}
