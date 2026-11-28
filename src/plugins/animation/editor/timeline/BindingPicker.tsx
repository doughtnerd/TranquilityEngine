// A binding picker (ADR 0373): the node a track or a group of tracks animates, as a path relative to the director's node.
// Pick from the scene's nodes under the director, or press "Use the selected node" (the selection stands in for a drop:
// the hierarchy's node drag only drops inside the hierarchy). With no director (a timeline opened from a file) the path
// is typed. A binding that doesn't resolve is flagged with why (`bindingProblem`).
import type { GameObject } from "../../../../engine/scene/GameObject";
import { editor } from "../../../../editor/sdk";
import { nodePathOf } from "../../../../engine/animation/bindingPath";
import { bindingProblem, nodeChoices } from "./timelineModelLogic";

export interface BindingPickerProps {
  /** The bound node's path ("" for the director's node). */
  readonly path: string;
  /** The director's node, or null when the timeline isn't opened on one. */
  readonly root: GameObject | null;
  /** The accessible name ("Binding of Light.intensity"). */
  readonly label: string;
  onPick(path: string): void;
}

export function BindingPicker(props: BindingPickerProps) {
  const { path, root } = props;
  const problem = root ? bindingProblem(root, path) : null;
  const choices = root ? nodeChoices(root) : [];
  const known = choices.some((c) => c.path === path);
  const useSelection = () => {
    const node = editor.scene.selection.node();
    if (!root || !node) return editor.messages.error("Can't bind the track: select a node under the director first");
    const rel = nodePathOf(root, node);
    if (rel === null) return editor.messages.error(`Can't bind the track: ${node.name} is outside ${root.name} (the director's node); a track binds nodes under it`);
    props.onPick(rel);
  };
  return (
    <span class="tw-binding">
      {root ? (
        <select aria-label={props.label} class={problem ? "tw-bad" : ""} value={path} title={problem ?? (path || root.name)} onChange={(e) => props.onPick((e.currentTarget as HTMLSelectElement).value)}>
          {!known && <option value={path}>{path} (missing)</option>}
          {choices.map((c) => (
            <option key={c.path} value={c.path}>
              {`${"  ".repeat(c.depth)}${c.depth === 0 ? `${c.name} (director)` : c.name}`}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" aria-label={props.label} value={path} spellcheck={false} placeholder="node path" onChange={(e) => props.onPick((e.currentTarget as HTMLInputElement).value.trim())} />
      )}
      {root && (
        <button type="button" class="tw-use" aria-label={`Use the selected node for ${props.label}`} title="Bind to the node selected in the hierarchy" onClick={useSelection}>
          ◎
        </button>
      )}
      {problem && (
        <span class="tw-warn" role="img" aria-label={problem} title={problem}>
          !
        </span>
      )}
    </span>
  );
}
