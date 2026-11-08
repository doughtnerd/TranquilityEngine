// Controls the Project panel's categories share, and plugins' sections too (ADR 0133): a labelled row,
// a list of problems, and an editable list of names.
import type { ComponentChildren } from "preact";
import type { SettingsProblem } from "../projectSettingsModel";
import { TextField } from "./WorldsPanel";

export function ProblemList(props: { list: readonly string[]; label: string; warning?: boolean }) {
  return (
    <ul class={`project-settings-problems${props.warning ? " warning" : ""}`} aria-label={props.label}>
      {props.list.map((p, i) => (
        <li key={i}>{p}</li>
      ))}
    </ul>
  );
}

export function Row(props: { label: string; problems: readonly SettingsProblem[]; children: ComponentChildren }) {
  return (
    <div class={`project-settings-row${props.problems.length ? " invalid" : ""}`}>
      <span class="project-settings-label">{props.label}</span>
      <span class="project-settings-value">{props.children}</span>
    </div>
  );
}

/** An editable list of names: rename in place, remove, and (with `onMove`) reorder. */
export function NameList(props: {
  title: string;
  hint?: string;
  names: readonly string[];
  field: string;
  problems: readonly SettingsProblem[];
  item: string;
  /** Indices that can't be removed. */
  fixed?: (i: number) => boolean;
  addDisabled?: boolean;
  onAdd: () => void;
  onRename: (i: number, name: string) => void;
  onRemove: (i: number) => void;
  onMove?: (i: number, by: number) => void;
}) {
  const { names, field, problems, item } = props;
  return (
    <div class="project-settings-list" role="group" aria-label={props.title}>
      <div class="project-settings-list-head">
        <span>{props.title}</span>
        {props.hint && <span class="project-settings-hint">{props.hint}</span>}
      </div>
      {names.map((name, i) => {
        const invalid = problems.some((p) => p.field === `${field}.${i}`);
        return (
          <div key={`${i}:${name}`} class={`project-settings-item${invalid ? " invalid" : ""}`} data-index={i}>
            <TextField value={name} label={`${item} ${i + 1}`} onCommit={(v) => props.onRename(i, v.trim())} />
            {props.onMove && (
              <>
                <button class="icon" aria-label={`Move ${name} up`} title="Move up (further back)" disabled={i === 0} onClick={() => props.onMove!(i, -1)}>
                  ↑
                </button>
                <button class="icon" aria-label={`Move ${name} down`} title="Move down (further front)" disabled={i === names.length - 1} onClick={() => props.onMove!(i, 1)}>
                  ↓
                </button>
              </>
            )}
            <button class="icon" aria-label={`Remove ${item} ${name}`} title={`Remove this ${item}`} disabled={names.length <= 1 || props.fixed?.(i)} onClick={() => props.onRemove(i)}>
              ×
            </button>
          </div>
        );
      })}
      <button disabled={props.addDisabled} onClick={props.onAdd}>
        + {item[0].toUpperCase() + item.slice(1)}
      </button>
    </div>
  );
}

