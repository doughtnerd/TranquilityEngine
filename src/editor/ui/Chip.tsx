// A chip (ADR 0335): a small rounded label for a kind, a state or a filter ("WAV", "Not calibrated", "Loop").
// Plain, toggled (a filter: `pressed` and `onToggle`, drawn as a toggle button) or removable (a ×).
import type { ComponentChildren } from "preact";
import "./kit.css";

export type ChipTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface ChipProps {
  readonly children: ComponentChildren;
  readonly tone?: ChipTone;
  readonly title?: string;
  /** A filter chip: on or off. */
  readonly pressed?: boolean;
  onToggle?(pressed: boolean): void;
  /** Removable: the × calls it. `removeLabel` names it for screen readers ("Remove Loop"). */
  onRemove?(): void;
  readonly removeLabel?: string;
}

export function Chip(props: ChipProps) {
  const tone = props.tone ?? "neutral";
  const cls = `kit-chip tone-${tone}${props.pressed ? " on" : ""}`;
  if (props.onToggle) {
    return (
      <button type="button" class={cls} aria-pressed={!!props.pressed} title={props.title} onClick={() => props.onToggle!(!props.pressed)}>
        {props.children}
      </button>
    );
  }
  return (
    <span class={cls} title={props.title}>
      {props.children}
      {props.onRemove && (
        <button type="button" class="kit-chip-remove" aria-label={props.removeLabel ?? "Remove"} title={props.removeLabel ?? "Remove"} onClick={props.onRemove}>
          ×
        </button>
      )}
    </span>
  );
}
