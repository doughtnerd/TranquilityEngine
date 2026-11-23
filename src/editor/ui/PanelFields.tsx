// Small field rows for panels (ADR 0349's kit; first the Audio Studio's Playlists and Spatial screens): a labelled row
// (label | control + unit), a number box that commits on Enter, blur or an arrow step (Shift ×10), a select, and a
// collapsible titled section. Values are reported once per commit, so each is one undo step. Theme tokens only
// (`kit.css`).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { InfoTip } from "./InfoTip";
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
  const commit = (typed = text) => {
    const v = numberBoxCommit(typed, props);
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
      onBlur={() => commit()}
      onChange={(e) => {
        // A change while not focused came from a label scrub (the Studio's `installLabelScrub`): commit it once.
        const input = e.currentTarget as HTMLInputElement;
        if (input.ownerDocument.activeElement !== input) commit(input.value);
      }}
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

/**
 * A titled section of a panel (collapsible). Its explanation (`hint`; `note` is the older name) is an ⓘ tooltip in the
 * header, not a paragraph (spec §1.3).
 */
export function Section(props: { readonly title: string; readonly hint?: string; readonly note?: string; readonly children: ComponentChildren; readonly open?: boolean; readonly actions?: ComponentChildren }) {
  const hint = props.hint ?? props.note;
  return (
    <details class="kit-section" open={props.open ?? true}>
      <summary class="kit-section-head">
        <span class="kit-section-title">{props.title}</span>
        {hint && (
          <span class="kit-section-hint" onClick={(e) => e.preventDefault()}>
            <InfoTip text={hint} label={`About ${props.title}`} />
          </span>
        )}
        {props.actions && <span class="kit-section-actions" onClick={(e) => e.preventDefault()}>{props.actions}</span>}
      </summary>
      <div class="kit-section-body">{props.children}</div>
    </details>
  );
}
