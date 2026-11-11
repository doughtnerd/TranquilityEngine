// The Inspector's Edit Zone button (ADR 0162 E1), in the header of each AudioReverbZone's card: shows the zone's
// handles in the scene view (the zone tool becomes active) or hides them again.
import { ZONE_TYPE, editingZone } from "./AudioReverbZoneGizmo";
import { type ComponentHeaderActionContribution, type ComponentHeaderActionProps, pathKey } from "../../../editor/sdk";

const isEditing = (props: ComponentHeaderActionProps): boolean => {
  const e = editingZone.value;
  const key = pathKey(props.paths[props.paths.length - 1]!);
  return !!e && e.key === key && e.index === props.info.index;
};

/** One zone's Edit Zone toggle; nothing while several nodes are selected. */
export function EditZoneButton(props: ComponentHeaderActionProps) {
  const { paths, info } = props;
  if (paths.length !== 1) return null;
  const editing = isEditing(props);
  const key = pathKey(paths[0]!);
  return (
    <button
      class={`edit-collider edit-zone${editing ? " active" : ""}`}
      aria-pressed={editing}
      title={editing ? "Stop editing the zone (handles hide, the transform gizmo returns)" : "Show handles in the viewport: drag a face to resize a box zone, a rim handle to set a sphere's radius, the outer handle to set the blend distance"}
      onClick={() => (editingZone.value = editing ? null : { key, index: info.index })}
    >
      Edit Zone
    </button>
  );
}

/** The header action the Audio editor half registers for `AudioReverbZone`. */
export const editZoneAction: ComponentHeaderActionContribution = {
  id: "myco.audio.edit-zone",
  types: [ZONE_TYPE],
  view: EditZoneButton,
  // Removing the zone being edited ends editing.
  onRemove: (props) => {
    if (isEditing(props)) editingZone.value = null;
  },
};
