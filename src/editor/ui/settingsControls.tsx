// Controls the Project and Worlds panels share, and plugins' sections too (ADR 0133, 0147): a labelled row,
// a list of problems, an editable list of names, and text and number fields that commit on Enter or blur.
import type { ComponentChildren } from "preact";
import type { SettingsProblem } from "../projectSettingsModel";
import { useDraftText } from "./draftText";
import "./worlds.css"; // NumberField's worlds-number and worlds-hint

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

/** A checkbox column beside a `NameList`'s names (a sorting layer's "Y-sort", ADR 0424). */
export interface NameListCheck {
  /** The column's heading. */
  title: string;
  /** What it means, as the heading's tooltip. */
  description?: string;
  checked: (i: number) => boolean;
  onChange: (i: number, checked: boolean) => void;
}

/** An editable list of names: rename in place, remove, (with `onMove`) reorder, and (with `check`) a checkbox per name. */
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
  check?: NameListCheck;
}) {
  const { names, field, problems, item } = props;
  return (
    <div class="project-settings-list" role="group" aria-label={props.title}>
      <div class="project-settings-list-head">
        <span>{props.title}</span>
        {props.hint && <span class="project-settings-hint">{props.hint}</span>}
        {props.check && (
          <span class="project-settings-list-check-title" title={props.check.description}>
            {props.check.title}
          </span>
        )}
      </div>
      {names.map((name, i) => {
        const invalid = problems.some((p) => p.field === `${field}.${i}`);
        return (
          <div key={`${i}:${name}`} class={`project-settings-item${invalid ? " invalid" : ""}`} data-index={i}>
            <TextField value={name} label={`${item} ${i + 1}`} onCommit={(v) => props.onRename(i, v.trim())} />
            {props.check && (
              <input
                type="checkbox"
                class="project-settings-list-check"
                aria-label={`${props.check.title} ${name}`}
                title={props.check.description}
                checked={props.check.checked(i)}
                onChange={(e) => props.check!.onChange(i, (e.currentTarget as HTMLInputElement).checked)}
              />
            )}
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

/** Text that commits on Enter or blur and reverts on Escape (an empty value field clears itself after committing). */
export function TextField(props: { value: string; label: string; class?: string; placeholder?: string; onCommit: (v: string) => void }) {
  const commit = (draft: string) => {
    if (draft !== props.value) props.onCommit(draft);
    if (props.value === "") setDraft("");
  };
  const { draft, setDraft, input } = useDraftText(props.value, commit);
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
      placeholder={props.placeholder}
      {...input}
      onKeyDown={(e) => {
        if (e.key === "Enter" && props.value === "") commit(draft); // keep focus to type the next one
        else input.onKeyDown(e);
      }}
    />
  );
}

/** An optional number: empty means the default (shown as the placeholder); text that isn't a number reverts. */
export function NumberField(props: { id: string; value: number | undefined; placeholder: string; label: string; suffix?: string; onCommit: (v: number | undefined) => void }) {
  const shown = props.value === undefined ? "" : String(props.value);
  const { setDraft, input } = useDraftText(shown, (draft) => {
    const text = draft.trim();
    if (text === shown) return;
    if (text === "") return props.onCommit(undefined);
    const n = Number(text);
    if (Number.isFinite(n)) props.onCommit(n);
    else setDraft(shown);
  });
  return (
    <span class="worlds-number">
      <input
        id={props.id}
        type="text"
        inputMode="decimal"
        aria-label={props.label}
        placeholder={props.placeholder}
        {...input}
      />
      {props.suffix && <span class="worlds-hint">{props.suffix}</span>}
    </span>
  );
}
