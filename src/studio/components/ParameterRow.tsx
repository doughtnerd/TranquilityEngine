// A parameter row (ADR 0349 `ParameterRow`): label | slider | number and unit, for an effect parameter, a send level, a
// ducking time or a game parameter's test value — a `SliderField` over a catalogue `ParamSpec`. Log parameters
// (frequencies) slide in log scale. Dragging the label scrubs the value (D12: a share of the range per pixel, so wide
// ranges stay quick; Shift ×10, Alt fine; Escape puts it back); the number box takes typed values ("2.4k") and arrow
// keys (Shift ×10, Alt fine).
//
// Values are reported as `onValue(value, drag)` (ADR 0282's rule, which `fieldDrag.ts` follows): `drag` true while the
// slider or the label moves, then the last value with false on release; a typed value or a key step reports once with
// false. The owner makes a drag one undo step (`doc.edit(next, drag ? { coalesce: true } : undefined)`).
import type { ValueReport } from "../../editor/ui/valueControls";
import type { ParamSpec } from "./parameterRowModel";
import { SliderField } from "./SliderField";
import "./audioParts.css";

export interface ParameterRowProps {
  readonly spec: ParamSpec;
  readonly value: number;
  /** Disabled (automated, or read-only), with why as the tooltip. */
  readonly disabled?: boolean;
  readonly title?: string;
  /** Shown instead of the number while disabled ("auto · 800 Hz"). */
  readonly note?: string;
  /** Ids prefix, so the label can name the number box. */
  readonly id?: string;
  onValue: ValueReport<number>;
}

export function ParameterRow(props: ParameterRowProps) {
  const { spec } = props;
  return (
    <SliderField
      class="studio-param"
      id={props.id}
      label={spec.label}
      value={props.value}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      unit={spec.unit}
      scale={spec.scale}
      default={spec.default}
      scrub="range"
      disabled={props.disabled}
      title={props.title}
      note={props.disabled ? props.note : undefined}
      onValue={props.onValue}
    />
  );
}
