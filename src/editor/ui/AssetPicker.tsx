// The asset picker (ADR 0282): the one control for a slot that names a project file, in the Inspector's asset fields
// and every plugin editor. It is given the slot's field kinds (the names asset kinds declare in `referencedAs`, ADR
// 0131, 0143) and lists what fits from the open project, which it follows; `assetChoices` decides the entries, their
// labels, the stored form (`asset:` or the bare path) and how a value that isn't offered shows (missing or not).
import type { AssetFieldKind } from "../../engine/core/registry";
import { assetChoices, type AssetStoredForm } from "../assetFieldKinds";
import { assetRefTarget } from "../assetRefValues";
import { MIXED } from "../fields/NumberInput";
import { currentProject, docVersion } from "../state";

export interface AssetPickerProps {
  /** The stored reference: `asset:<path>`, a bare path, `builtin:<name>`, or "" for none. Any reference form reads. */
  value: string;
  /** The field kinds that fit (`["texture", "rendertexture"]`, `["mesh"]`); empty takes any file. */
  kinds: readonly AssetFieldKind[];
  /** The accessible name. */
  label: string;
  /** How a picked file is stored: `asset:<path>` (default) or the bare project path. */
  stored?: AssetStoredForm;
  /** The empty entry's text (default "None"); null for a slot that must name a file. */
  none?: string | null;
  /** Narrows the files the kinds offer (a tileset's images with slices, not the graph being edited). */
  accepts?: (path: string) => boolean;
  /** The selected nodes' values differ: show a dash until one is picked. */
  mixed?: boolean;
  disabled?: boolean;
  class?: string;
  /** Called with the picked entry's stored value ("" for none). */
  onCommit(value: string): void;
}

const MIXED_VALUE = "\u0000mixed";

/** A select of the files (and built-ins) that fit `kinds`; a value naming a file the project doesn't have shows as "(missing)". */
export function AssetPicker(props: AssetPickerProps) {
  void docVersion.value; // files come and go
  const files = currentProject.value?.files ?? [];
  const { entries, selected, other } = assetChoices(props.kinds, files, props.mixed ? "" : props.value, { stored: props.stored, accepts: props.accepts });
  const none = props.none === undefined ? "None" : props.none;
  const shown = props.mixed ? MIXED_VALUE : selected;
  return (
    <select
      class={props.class}
      aria-label={props.label}
      title={selected && !selected.startsWith("builtin:") ? assetRefTarget(selected) : undefined}
      disabled={props.disabled}
      value={shown}
      onChange={(e) => {
        const picked = (e.currentTarget as HTMLSelectElement).value;
        if (picked !== MIXED_VALUE && picked !== shown) props.onCommit(picked);
      }}
    >
      {props.mixed && (
        <option value={MIXED_VALUE} disabled>
          {MIXED}
        </option>
      )}
      {(none !== null || shown === "") && <option value="">{none ?? ""}</option>}
      {entries.map((e) => (
        <option key={e.value} value={e.value}>
          {e.label}
        </option>
      ))}
      {other && (
        <option value={other.value} disabled>
          {other.label}
        </option>
      )}
    </select>
  );
}
