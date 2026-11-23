// A segmented control (ADR 0349): one choice of a few, drawn as joined buttons, with the ARIA radio group pattern
// (one tab stop on the chosen option; arrows move and pick, `segmentedModel.ts`).
import { useRef } from "preact/hooks";
import { segmentForKey, type SegmentOption } from "./segmentedModel";
import "./kit.css";

export type { SegmentOption } from "./segmentedModel";

export interface SegmentedControlProps<T extends string> {
  readonly options: readonly SegmentOption<NoInfer<T>>[];
  readonly value: T;
  /** The group's accessible name. */
  readonly label: string;
  readonly size?: "small" | "normal";
  onChange(value: NoInfer<T>): void;
}

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  const { options, value, onChange } = props;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      class={`kit-segmented${props.size === "small" ? " small" : ""}`}
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={(e) => {
        const next = segmentForKey(options, value, e.key);
        if (next === null) return;
        e.preventDefault();
        onChange(next);
        queueMicrotask(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next)}"]`)?.focus());
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} data-value={o.value} class={on ? "on" : undefined} tabIndex={on ? 0 : -1} disabled={o.disabled} title={o.title} onClick={() => !on && onChange(o.value)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
