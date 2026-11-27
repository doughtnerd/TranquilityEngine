// An empty state (ADR 0349; owner spec §1.3 and §3.9: "empty states are one short line saying what to do"). Two looks,
// as the owner's prototype draws them:
//
// - compact (side panels, inspectors): one muted line at the top of the panel — the `title` — with the action under
//   it. Its `body` is the explanation, so it lives in an ⓘ tooltip (`InfoTip`), not a paragraph.
// - full (a screen's main area, nothing open): a bold title, one short line of `body`, the actions.
//
// Copy rules: the title is a sentence that says what is missing and, where it fits, what to do ("No takes yet. Record
// one with Record session."); keep `body` to one sentence; one primary action (drawn as the positive button).
import type { ComponentChildren } from "preact";
import { InfoTip } from "./InfoTip";
import "./kit.css";

export interface EmptyStateProps {
  readonly title: string;
  /** What it is for and how to start: a tooltip on a compact one, one short line on a full one. */
  readonly body?: ComponentChildren;
  /** A small glyph or picture above the title (full look only). */
  readonly icon?: ComponentChildren;
  /** The one primary action; `autoFocus` puts focus on it when the state appears (a screen with nothing else to do). */
  readonly action?: { readonly label: string; readonly title?: string; readonly disabled?: boolean; readonly autoFocus?: boolean; run(): void };
  readonly children?: ComponentChildren;
  /** The one-line look, for a side panel or an inspector. */
  readonly compact?: boolean;
}

/** A body's text, for the tooltip (a string, or the text of simple markup). */
function textOf(node: ComponentChildren): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const props = (node as { props?: { children?: ComponentChildren } }).props;
  return props ? textOf(props.children) : "";
}

export function EmptyState(props: EmptyStateProps) {
  const action = props.action && (
    <button class="primary kit-empty-action" autoFocus={props.action.autoFocus} disabled={props.action.disabled} title={props.action.title} onClick={() => props.action!.run()}>
      {props.action.label}
    </button>
  );
  if (props.compact) {
    const tip = textOf(props.body).trim();
    return (
      <div class="kit-empty compact" role="note" aria-label={props.title}>
        <p class="kit-empty-line">
          {props.title}
          {tip && <InfoTip text={tip} label={`About: ${props.title}`} />}
        </p>
        {(action || props.children) && (
          <div class="kit-empty-actions">
            {action}
            {props.children}
          </div>
        )}
      </div>
    );
  }
  return (
    <div class="kit-empty" role="note" aria-label={props.title}>
      {props.icon && (
        <div class="kit-empty-icon" aria-hidden="true">
          {props.icon}
        </div>
      )}
      <h3 class="kit-empty-title">{props.title}</h3>
      {props.body && <div class="kit-empty-body">{props.body}</div>}
      {(action || props.children) && (
        <div class="kit-empty-actions">
          {action}
          {props.children}
        </div>
      )}
    </div>
  );
}
