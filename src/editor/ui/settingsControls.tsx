// Controls the Project and Worlds panels share, and plugins' sections too (ADR 0133, 0147): a labelled row,
// a list of problems, an editable list of names, and text and number fields that commit on Enter or blur.
import type { ComponentChildren } from "preact";
import type { SettingsProblem } from "../projectSettingsModel";
import { useLayoutEffect, useState } from "preact/hooks";
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

/** Text that commits on Enter or blur and reverts on Escape (an empty value field clears itself after committing). */
export function TextField(props: { value: string; label: string; class?: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useLayoutEffect(() => setDraft(props.value), [props.value]); // in the same commit: a mount effect run after paint would overwrite typing that came first
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
    if (props.value === "") setDraft("");
  };
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (props.value === "") commit(); // keep focus to type the next one
          else (e.currentTarget as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(props.value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** An optional number: empty means the default (shown as the placeholder); text that isn't a number reverts. */
export function NumberField(props: { id: string; value: number | undefined; placeholder: string; label: string; suffix?: string; onCommit: (v: number | undefined) => void }) {
  const shown = props.value === undefined ? "" : String(props.value);
  const [draft, setDraft] = useState(shown);
  useLayoutEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const text = draft.trim();
    if (text === shown) return;
    if (text === "") return props.onCommit(undefined);
    const n = Number(text);
    if (Number.isFinite(n)) props.onCommit(n);
    else setDraft(shown);
  };
  return (
    <span class="worlds-number">
      <input
        id={props.id}
        type="text"
        inputMode="decimal"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={draft}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(shown);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      {props.suffix && <span class="worlds-hint">{props.suffix}</span>}
    </span>
  );
}
