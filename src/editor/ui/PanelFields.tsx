// Small field rows for panels (ADR 0349's kit; first the Audio Studio's Playlists and Spatial screens): a labelled row
// (label | control + unit), a number box that commits on Enter, blur or an arrow step (Shift ×10), a select, and a
// collapsible titled section. Values are reported once per commit, so each is one undo step. Theme tokens only
// (`kit.css`).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { numberBoxCommit, numberBoxStep, numberBoxText } from "./panelFieldsModel";
import "./kit.css";

export function FieldRow(props: { readonly label: string; readonly title?: string; readonly children: ComponentChildren; readonly unit?: string }) {
  return (
    <label class="kit-field" title={props.title}>
      <span class="kit-field-label">{props.label}</span>
      <span class="kit-field-control">
        {props.children}
        {props.unit && <span class="kit-unit">{props.unit}</span>}
      </span>
    </label>
  );
}

export interface NumberBoxProps {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Decimals shown. */
  readonly digits?: number;
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly class?: string;
  onValue(v: number): void;
}

/** A number box: Enter or blur commits the typed value; ↑/↓ step (Shift ×10); Escape puts it back. */
export function NumberBox(props: NumberBoxProps) {
  const digits = props.digits ?? 2;
  const [text, setText] = useState(numberBoxText(props.value, digits));
  useEffect(() => setText(numberBoxText(props.value, digits)), [props.value, digits]);
  const commit = () => {
    const v = numberBoxCommit(text, props);
    if (v === null) setText(numberBoxText(props.value, digits));
    else props.onValue(v);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      class={`kit-num${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      value={text}
      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(numberBoxText(props.value, digits));
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          props.onValue(numberBoxStep(props, e.key === "ArrowUp" ? 1 : -1, e.shiftKey));
        }
      }}
    />
  );
}

export interface SelectBoxProps<T extends string> {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string; readonly disabled?: boolean }[];
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
  onValue(v: T): void;
}

export function SelectBox<T extends string>(props: SelectBoxProps<T>) {
  return (
    <select class="kit-select" aria-label={props.label} title={props.title} disabled={props.disabled} value={props.value} onChange={(e) => props.onValue((e.currentTarget as HTMLSelectElement).value as T)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A titled section of a panel (collapsible). */
export function Section(props: { readonly title: string; readonly note?: string; readonly children: ComponentChildren; readonly open?: boolean; readonly actions?: ComponentChildren }) {
  return (
    <details class="kit-section" open={props.open ?? true}>
      <summary class="kit-section-head">
        <span class="kit-section-title">{props.title}</span>
        {props.actions && <span class="kit-section-actions" onClick={(e) => e.preventDefault()}>{props.actions}</span>}
      </summary>
      {props.note && <p class="kit-note">{props.note}</p>}
      <div class="kit-section-body">{props.children}</div>
    </details>
  );
}
