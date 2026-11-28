// The SDK's slider and colour controls (ADR 0282), for the Inspector and every plugin editor. They share one commit
// rule, so a gesture makes one undo step wherever it is used:
//
// - A value is reported as `onValue(value, drag)`.
// - While a pointer gesture is under way (the slider's or the colour picker's `input`), `drag` is true.
// - The gesture's end (`change`: the release, or a key step) reports the last value again with `drag` false; a typed
//   number or opacity is one report with `drag` false.
//
// An asset document editor merges drag writes and closes the step at the release with
// `doc.edit(next, drag ? { coalesce: true } : undefined)` (ADR 0027); the Inspector opens its field drag on the first
// drag report and ends it on the closing one (ADR 0257), as its scrub labels do from press to release.
import { Color } from "../../engine";
import { parseHex } from "../../engine/core/colorSpace";
import { hexWithAlpha } from "../colorMath";
import { MIXED } from "../fields/NumberInput";
import "./valueControls.css";

/** How a control reports a value: `drag` while a gesture is under way, false for the value that closes it (see the file comment). */
export type ValueReport<T> = (value: T, drag: boolean) => void;

const formatNumber = (n: number) => String(+n.toFixed(4));

/** A typed number from an input's text, or null when it doesn't read as one. */
function typedNumber(e: Event): number | null {
  const text = (e.currentTarget as HTMLInputElement).value;
  const n = text.trim() === "" ? NaN : Number(text);
  return Number.isFinite(n) ? n : null;
}

export interface SliderFieldProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** The slider's accessible name; the number box is "<label> value". */
  label: string;
  /** Hold typed values to the slider's range too (the slider always is). */
  clamp?: boolean;
  disabled?: boolean;
  title?: string;
  /** Classes on the control's wrapper (a graph node's `nodrag`). */
  class?: string;
  onValue: ValueReport<number>;
}

/** A range slider and a number box; dragging the slider reports with `drag`, its release and a typed number close the step. */
export function SliderField(props: SliderFieldProps) {
  const { value, min, max, step, label, disabled } = props;
  const slid = (drag: boolean) => (e: Event) => {
    const n = typedNumber(e);
    if (n !== null) props.onValue(n, drag);
  };
  return (
    <span class={props.class ? `slider-field ${props.class}` : "slider-field"} title={props.title}>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled} onInput={slid(true)} onChange={slid(false)} />
      <input
        type="number"
        aria-label={`${label} value`}
        step={step}
        min={props.clamp ? min : undefined}
        max={props.clamp ? max : undefined}
        value={formatNumber(value)}
        disabled={disabled}
        onChange={(e) => {
          const n = typedNumber(e);
          if (n === null) {
            (e.currentTarget as HTMLInputElement).value = formatNumber(value);
            return;
          }
          props.onValue(props.clamp ? Math.min(max, Math.max(min, n)) : n, false);
        }}
      />
    </span>
  );
}

export interface ColorFieldProps {
  /** `#rrggbb`, or `#rrggbbaa` with opacity below 1 (`#rgb` reads too). */
  value: string;
  /** The picker's accessible name; the opacity box is "<label> alpha". */
  label: string;
  /** Show an opacity box (0–1); without it the value's opacity is kept as it is. */
  alpha?: boolean;
  /** Show the value as text beside the picker. */
  showHex?: boolean;
  /** The selected nodes' values differ (the picker shows the active one's). */
  mixed?: boolean;
  disabled?: boolean;
  title?: string;
  /** Classes on the control's wrapper (a graph node's `nodrag`). */
  class?: string;
  /** Called with `#rrggbb[aa]`: alpha written only when below 1. */
  onValue: ValueReport<string>;
}

/** A colour picker, and with `alpha` an opacity box, over a `#rrggbb[aa]` value. */
export function ColorField(props: ColorFieldProps) {
  const { label, disabled } = props;
  const color = parseHex(props.value) ? Color.from(props.value) : Color.white;
  const opaque = color.toHex();
  const a = color.a;
  const picked = (drag: boolean) => (e: Event) => props.onValue(hexWithAlpha((e.currentTarget as HTMLInputElement).value, a), drag);
  return (
    <span class={props.class ? `color-field ${props.class}` : "color-field"} title={props.title}>
      <input type="color" aria-label={label} value={opaque} disabled={disabled} onInput={picked(true)} onChange={picked(false)} />
      {props.showHex && <code class="color-field-hex">{props.mixed ? MIXED : hexWithAlpha(opaque, a)}</code>}
      {props.alpha && (
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          aria-label={`${label} alpha`}
          title="Opacity: below 1 is see-through"
          value={props.mixed ? "" : formatNumber(+a.toFixed(3))}
          disabled={disabled}
          onChange={(e) => {
            const n = typedNumber(e);
            if (n === null) {
              (e.currentTarget as HTMLInputElement).value = formatNumber(+a.toFixed(3));
              return;
            }
            props.onValue(hexWithAlpha(opaque, Math.min(1, Math.max(0, n))), false);
          }}
        />
      )}
    </span>
  );
}
