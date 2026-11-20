// The Edit toggle of a viewport tool that edits components (ADR 0266): the component header action (ADR 0142) the
// plugin context registers beside a tool with `editsComponents`, such as the Physics plugin's Edit Collider and the
// Audio plugin's Edit Zone. It owns the "editing this card" rule: the tool's mode names the card's node, Component
// type and index. Entering and leaving go through `editor.viewport` (ADR 0231), so play mode ignores it.
import { pathKey } from "./document";
import type { ComponentEditMode, ComponentHeaderActionContribution, ComponentHeaderActionProps, ViewportToolContribution } from "./sdk/contributions";
import { viewport } from "./sdk/viewport";

/** The header action for `tool`'s `editsComponents`; the tool must have it. */
export function componentEditToggle(tool: ViewportToolContribution): ComponentHeaderActionContribution {
  const spec = tool.editsComponents;
  if (!spec) throw new Error(`Viewport tool ${tool.id} edits no components.`);
  const mode = viewport.mode<ComponentEditMode>(tool.id);
  /** The card's component as a mode: on the active node (the last path). */
  const cardMode = ({ paths, info }: ComponentHeaderActionProps): ComponentEditMode => ({ key: pathKey(paths[paths.length - 1]!), type: info.type, index: info.index });
  const isEditing = (props: ComponentHeaderActionProps): boolean => {
    const m = mode.value;
    const card = cardMode(props);
    return !!m && m.key === card.key && m.type === card.type && m.index === card.index;
  };
  return {
    id: `${tool.id}:edit`,
    types: spec.types,
    view: (props) => {
      if (props.paths.length !== 1) return null; // one component's handles at a time
      const editing = isEditing(props);
      return (
        <button
          class={`edit-handles${editing ? " active" : ""}`}
          aria-pressed={editing}
          title={editing ? spec.stopHint : typeof spec.hint === "function" ? spec.hint(props.info.type) : spec.hint}
          onClick={() => (editing ? viewport.leave(tool.id) : viewport.enter<ComponentEditMode>(tool.id, cardMode(props)))}
        >
          {spec.label}
        </button>
      );
    },
    // Removing the component being edited ends editing.
    onRemove: (props) => {
      if (isEditing(props)) viewport.leave(tool.id);
    },
  };
}
