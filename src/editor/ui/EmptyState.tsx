// An empty state (ADR 0349): what a panel or screen shows when it has nothing yet, saying what it is for and how to
// get started ("No takes yet · Record one from the editor's Play bar, or open a take file"), with an optional primary
// action and further content (a secondary link, a list of steps).
import type { ComponentChildren } from "preact";
import "./kit.css";

export interface EmptyStateProps {
  readonly title: string;
  /** What it is for and how to start. */
  readonly body?: ComponentChildren;
  /** A small glyph or picture above the title. */
  readonly icon?: ComponentChildren;
  readonly action?: { readonly label: string; readonly title?: string; readonly disabled?: boolean; run(): void };
  readonly children?: ComponentChildren;
  /** Smaller, for a narrow panel. */
  readonly compact?: boolean;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class={`kit-empty${props.compact ? " compact" : ""}`} role="note" aria-label={props.title}>
      {props.icon && (
        <div class="kit-empty-icon" aria-hidden="true">
          {props.icon}
        </div>
      )}
      <h3 class="kit-empty-title">{props.title}</h3>
      {props.body && <div class="kit-empty-body">{props.body}</div>}
      {props.action && (
        <button class="primary" disabled={props.action.disabled} title={props.action.title} onClick={() => props.action!.run()}>
          {props.action.label}
        </button>
      )}
      {props.children}
    </div>
  );
}
