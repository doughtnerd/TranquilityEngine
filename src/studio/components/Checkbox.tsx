// A checkbox with its label (owner's prototype `.cbx`: 16 px, a ✓ on the accent when on, a dash when mixed). Every
// native checkbox in the Studio already has this look (formControls.css); this adds the label row and the mixed state
// ("some of the selection"), which HTML can only set from script.
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import "./formControls.css";

export interface CheckboxProps {
  /** On, off, or "mixed" (some of a selection). */
  readonly checked: boolean | "mixed";
  /** The visible label; without one, `ariaLabel` names it. */
  readonly label?: ComponentChildren;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  /** The new state: a mixed box turns on. */
  onChange(checked: boolean): void;
}

export function Checkbox(props: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  const mixed = props.checked === "mixed";
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label class={`studio-check${props.disabled ? " disabled" : ""}`} title={props.title}>
      <input
        ref={ref}
        type="checkbox"
        checked={props.checked === true}
        aria-checked={mixed ? "mixed" : props.checked}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onChange={(e) => props.onChange(mixed ? true : (e.currentTarget as HTMLInputElement).checked)}
      />
      {props.label && <span class="studio-check-label">{props.label}</span>}
    </label>
  );
}
