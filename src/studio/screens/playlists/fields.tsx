// Small field rows the Playlists screen's views share (the prototype's `.kv` / `.pbf` rows: label | control + unit).
// A number box commits on Enter, blur or an arrow step (Shift ×10); a select and a row frame. Values are reported once
// per commit (`drag` false), so each is one undo step.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

export function FieldRow(props: { readonly label: string; readonly title?: string; readonly children: ComponentChildren; readonly unit?: string }) {
  return (
    <label class="pl-field" title={props.title}>
      <span class="pl-field-label">{props.label}</span>
      <span class="pl-field-control">
        {props.children}
        {props.unit && <span class="pl-unit">{props.unit}</span>}
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

const show = (v: number, digits: number) => String(Number(v.toFixed(digits)));

/** A number box: Enter or blur commits the typed value; ↑/↓ step (Shift ×10); Escape puts it back. */
export function NumberBox(props: NumberBoxProps) {
  const digits = props.digits ?? 2;
  const [text, setText] = useState(show(props.value, digits));
  useEffect(() => setText(show(props.value, digits)), [props.value, digits]);
  const clamp = (v: number) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
  const commit = () => {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v)) return setText(show(props.value, digits));
    const c = clamp(v);
    if (c !== props.value) props.onValue(c);
    else setText(show(props.value, digits));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      class={`pl-num${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      value={text}
      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(show(props.value, digits));
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const step = (props.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
          props.onValue(clamp(Number((props.value + step).toFixed(6))));
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
    <select class="pl-select" aria-label={props.label} title={props.title} disabled={props.disabled} value={props.value} onChange={(e) => props.onValue((e.currentTarget as HTMLSelectElement).value as T)}>
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
    <details class="pl-section" open={props.open ?? true}>
      <summary class="pl-section-head">
        <span class="pl-section-title">{props.title}</span>
        {props.actions && <span class="pl-section-actions" onClick={(e) => e.preventDefault()}>{props.actions}</span>}
      </summary>
      {props.note && <p class="pl-note">{props.note}</p>}
      <div class="pl-section-body">{props.children}</div>
    </details>
  );
}
