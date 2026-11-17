// How the audio Inspector sections write a component's field (ADR 0162 E2): as the editor's undoable `SetField`
// command, an override on prefab instances, on the node the section is showing.
import { SetField, editor, type NodePath, type OpenScene, type UndoStep } from "../../../editor/sdk";

/** Where a section writes: the component's node (a path into prefab instances included) and which component of its type. */
export interface FieldTarget {
  scene: OpenScene;
  path: NodePath;
  type: string;
  index: number;
}

/** Write `field` as one undo step. */
export function writeField(target: FieldTarget, field: string, value: unknown): void {
  const [id, ...path] = target.path;
  target.scene.stack.execute(new SetField(id!, target.type, field, value, { index: target.index, target: path }));
}

/** Each scene's open drag step (the controls re-render mid-drag, so the step can't live in a closure). */
const dragging = new WeakMap<OpenScene, UndoStep>();

/**
 * Pointer handlers that make a drag on a control one undo step named `label`: the group opens on the press and closes
 * on release or cancel.
 */
export function dragGroup(scene: OpenScene, label: string): { onPointerDownCapture: () => void; onPointerUp: () => void; onPointerCancel: () => void } {
  const end = () => {
    const step = dragging.get(scene);
    dragging.delete(scene);
    step?.end();
  };
  return {
    onPointerDownCapture: () => {
      if (dragging.has(scene)) return;
      const step = editor.scene.beginEdit(label, scene);
      if (step) dragging.set(scene, step);
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}
