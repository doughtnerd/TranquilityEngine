// A slider with its typed field (spec §1.3 "every slider has a typed value field next to it, in the control's own
// unit, kept in sync, clamping out-of-range input"; owner's prototype `.tv`): label | range | number box + unit. A log
// range (frequencies) slides in log scale. The label scrubs (`labelScrub.ts`): one step per 2 px by default, or with
// `scrub: "range"` a share of the range per pixel (D12, log-aware, for wide parameter ranges); Shift ×10, Alt fine,
// Escape puts it back. The box reads "2.4k" as 2400 and clamps.
//
// Values are reported as `onValue(v, drag)` (ADR 0282): drag true while the slider or the label moves, then the last
// value with false on release; a typed value or a key step reports once with false. One undo step per gesture.
import type { ValueReport } from "../../editor/ui/valueControls";
import { useRef } from "preact/hooks";
import { useLabelScrub } from "./labelScrub";
import { NumberField } from "./NumberField";
import { SLIDER_STEPS, formatParam, paramBoxText, paramKey, paramToSlider, parseParam, scrubParam, sliderToParam, type ParamSpec } from "./parameterRowModel";
import { SCRUB_TOOLTIP, scrubNumber } from "./scrubModel";
import "./formControls.css";

export interface SliderFieldProps {
  readonly value: number;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
  readonly scale?: "linear" | "log";
  readonly default?: number;
  /** How the label scrubs: a step per 2 px (default, the prototype's rule) or a share of the range per pixel. */
  readonly scrub?: "step" | "range";
  readonly disabled?: boolean;
  /** Tooltip of the row (why it is disabled, or its value). */
  readonly title?: string;
  /** Shown instead of the box while disabled ("auto · 800 Hz"). */
  readonly note?: string;
  /** The box's accessible name (default "<label> value"). */
  readonly boxLabel?: string;
  readonly id?: string;
  /** Extra classes for the row. */
  readonly class?: string;
  onValue: ValueReport<number>;
}

let sliderSeq = 0;

export function SliderField(props: SliderFieldProps) {
  const { value, disabled, onValue } = props;
  const spec: ParamSpec = { label: props.label, min: props.min, max: props.max, step: props.step, unit: props.unit ?? "", scale: props.scale, default: props.default };
  const idRef = useRef(props.id ?? `studio-slider-${++sliderSeq}`);
  const box = `${idRef.current}-value`;
  const scrub = useLabelScrub({
    begin: () => (disabled ? null : value),
    valueAt: (start, dx, mods) => (props.scrub === "range" ? scrubParam(spec, start, dx, mods) : scrubNumber(start, spec.step, dx, mods, spec)),
    onValue,
  });
  return (
    <div class={`studio-slider${disabled ? " disabled" : ""}${props.class ? ` ${props.class}` : ""}`} title={props.title}>
      <label for={box} class={`studio-field-label${disabled ? " disabled" : " scrub"}`} title={disabled ? props.title : SCRUB_TOOLTIP} {...(disabled ? {} : scrub)}>
        {props.label}
      </label>
      <input
        type="range"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={paramToSlider(spec, value)}
        disabled={disabled}
        aria-label={props.label}
        aria-valuetext={formatParam(spec, value)}
        onInput={(e) => onValue(sliderToParam(spec, Number((e.currentTarget as HTMLInputElement).value)), true)}
        onChange={(e) => onValue(sliderToParam(spec, Number((e.currentTarget as HTMLInputElement).value)), false)}
        onKeyDown={(e) => {
          const next = paramKey(spec, value, e.key, { shift: e.shiftKey, alt: e.altKey });
          if (next === null) return;
          e.preventDefault();
          if (next !== value) onValue(next, false);
        }}
      />
      {disabled && props.note ? (
        <span class="studio-nv">
          <span class="studio-slider-note">{props.note}</span>
        </span>
      ) : (
        <NumberField
          hideLabel
          id={box}
          label={props.label}
          ariaLabel={props.boxLabel ?? `${props.label} value`}
          value={value}
          min={props.min}
          max={props.max}
          step={props.step}
          unit={props.unit}
          disabled={disabled}
          format={(v) => paramBoxText(spec, v)}
          parse={(t) => parseParam(spec, t)}
          stepper={(v, dir, mods) => paramKey(spec, v, dir > 0 ? "ArrowUp" : "ArrowDown", mods) ?? v}
          onValue={onValue}
        />
      )}
    </div>
  );
}
