// A number field (owner's prototype `.num` + `.nv`, spec §1.3/§3.4): its label, a 76 px right-aligned box with tabular
// figures and no spin buttons, and its unit. Dragging the label scrubs the value Unity-style (`scrubModel.ts`: 2 px a
// step, Shift ×10, Alt ×0.1, kept in min..max, Escape puts it back; the tooltip says so). The box holds a draft while
// typed and commits on Enter or blur ("2.4k", "−3", "1,5" read as numbers; out-of-range input is clamped); Escape
// reverts the draft; ↑/↓ step (Shift ×10, Alt ×0.1).
//
// It renders the label and the box as siblings (a fragment), so a grid row places them in its columns; `FieldRow`-like
// layouts wrap it in `.studio-fieldrow`. Values are reported as `onValue(v, drag)` (ADR 0282): drag true while the
// label scrubs, then the last value with false on release; a typed value or a key step reports once with false.
import { useRef, useState } from "preact/hooks";
import type { ValueReport } from "../../editor/ui/valueControls";
import { useLabelScrub } from "./labelScrub";
import { numberText, parseNumber, stepNumber } from "./numberFieldModel";
import { SCRUB_TOOLTIP, scrubNumber, type ScrubMods } from "./scrubModel";
import "./formControls.css";

export interface NumberFieldProps {
  readonly value: number;
  /** Its visible label (also the box's accessible name unless `ariaLabel` is given). */
  readonly label: string;
  /** Hide the label: only the box is drawn (it keeps `label` as its accessible name, and doesn't scrub). */
  readonly hideLabel?: boolean;
  /** The box's accessible name when it differs from the label ("Cutoff value"). */
  readonly ariaLabel?: string;
  readonly min?: number;
  readonly max?: number;
  /** One step (arrow keys; 2 px of scrub). Default 1. */
  readonly step?: number;
  /** Decimals shown (default: the step's). */
  readonly digits?: number;
  readonly unit?: string;
  /** 76 px (default) or the prototype's narrow 56 px (`.dvn`). */
  readonly size?: "normal" | "narrow";
  readonly disabled?: boolean;
  /** Tooltip of the box (the label's says how to scrub). */
  readonly title?: string;
  readonly id?: string;
  /** How a scrub moves the value (default: one step per 2 px, `scrubNumber`). */
  scrub?(start: number, dx: number, mods: ScrubMods): number;
  /** How a typed text reads (default `parseNumber`, clamped and snapped by the field). */
  parse?(text: string): number | null;
  /** What ↑/↓ give (default: a step, Shift ×10, Alt ×0.1, `stepNumber`). */
  stepper?(value: number, dir: 1 | -1, mods: ScrubMods): number;
  /** How the value is written in the box (default: `digits` decimals, trailing zeros kept off). */
  format?(value: number): string;
  onValue: ValueReport<number>;
}

let fieldSeq = 0;

export function NumberField(props: NumberFieldProps) {
  const { value, disabled, onValue } = props;
  const step = props.step ?? 1;
  const range = { min: props.min, max: props.max, step, digits: props.digits };
  const format = props.format ?? ((v: number) => numberText(v, range));
  const idRef = useRef(props.id ?? `studio-num-${++fieldSeq}`);
  // The typed draft, and the value it was typed over: a new value from outside (a scrub, an undo) drops it.
  const [typed, setTyped] = useState<{ readonly text: string; readonly over: number } | null>(null);
  const draft = typed && typed.over === value ? typed.text : null;
  const setDraft = (text: string | null) => setTyped(text === null ? null : { text, over: value });
  const scrub = useLabelScrub({
    begin: () => (disabled ? null : value),
    valueAt: (start, dx, mods) => (props.scrub ? props.scrub(start, dx, mods) : scrubNumber(start, step, dx, mods, range)),
    onValue,
  });
  const commit = (text: string) => {
    setDraft(null);
    const read = props.parse ? props.parse(text) : parseNumber(text, range);
    if (read !== null && read !== value) onValue(read, false);
  };
  const box = (
    <span class="studio-nv">
      <input
        id={idRef.current}
        class={`studio-num${props.size === "narrow" ? " narrow" : ""}`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellcheck={false}
        aria-label={props.ariaLabel ?? props.label}
        title={props.title}
        disabled={disabled}
        value={draft ?? format(value)}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={(e) => draft !== null && commit((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          if (e.key === "Enter") {
            e.preventDefault();
            commit(input.value);
          } else if (e.key === "Escape" && draft !== null) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const dir = e.key === "ArrowUp" ? 1 : -1;
            const mods = { shift: e.shiftKey, alt: e.altKey };
            const next = props.stepper ? props.stepper(value, dir, mods) : stepNumber(value, dir, mods, range);
            setDraft(null);
            if (next !== value) onValue(next, false);
          }
        }}
      />
      {props.unit && <span class="studio-nv-unit">{props.unit}</span>}
    </span>
  );
  if (props.hideLabel) return box;
  return (
    <>
      <label for={idRef.current} class={`studio-field-label${disabled ? " disabled" : " scrub"}`} title={disabled ? props.title : SCRUB_TOOLTIP} {...(disabled ? {} : scrub)}>
        {props.label}
      </label>
      {box}
    </>
  );
}
