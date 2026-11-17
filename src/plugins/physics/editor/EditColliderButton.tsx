// The Inspector's Edit Collider button (ADR 0022, 0142), in the header of each collider's card: shows the
// collider's handles in the scene view (the collider tool becomes active) or hides them again.
import { COLLIDER_TOOL_ID, EDITABLE_COLLIDERS, editingCollider, type EditingCollider } from "./colliderGizmo";
import { type ComponentHeaderActionContribution, type ComponentHeaderActionProps, editor, pathKey } from "../../../editor/sdk";

const isEditing = (props: ComponentHeaderActionProps): boolean => {
  const e = editingCollider.value;
  const key = pathKey(props.paths[props.paths.length - 1]);
  return !!e && e.key === key && e.type === props.info.type && e.index === props.info.index;
};

/** One collider's Edit Collider toggle; nothing while several nodes are selected. */
export function EditColliderButton(props: ComponentHeaderActionProps) {
  const { paths, info } = props;
  if (paths.length !== 1) return null;
  const editing = isEditing(props);
  const key = pathKey(paths[0]);
  return (
    <button
      class={`edit-collider${editing ? " active" : ""}`}
      aria-pressed={editing}
      title={editing ? "Stop editing the collider (handles hide, the transform gizmo returns)" : info.type.endsWith("PolygonCollider2D") || info.type.endsWith("EdgeCollider2D") ? "Show handles in the viewport: drag vertices, press an edge's middle handle to add one, Ctrl+click a vertex to remove it" : "Show handles in the viewport to resize this collider and move its center"}
      onClick={() => (editing ? editor.viewport.leave(COLLIDER_TOOL_ID) : editor.viewport.enter<EditingCollider>(COLLIDER_TOOL_ID, { key, type: info.type as EditingCollider["type"], index: info.index }))}
    >
      Edit Collider
    </button>
  );
}

/** The header action the Physics editor half registers for every editable collider type. */
export const editColliderAction: ComponentHeaderActionContribution = {
  id: "myco.physics.edit-collider",
  types: EDITABLE_COLLIDERS,
  view: EditColliderButton,
  // Removing the collider being edited ends editing.
  onRemove: (props) => {
    if (isEditing(props)) editor.viewport.leave(COLLIDER_TOOL_ID);
  },
};
