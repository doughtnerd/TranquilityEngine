// A dialog frame (ADR 0349 kit; owner's prototype `.dlg`, spec §3.11): a header band with the title and × close
// ("Close (Esc)"), the body, and a footer with an optional summary on the left and the buttons on the right (Cancel
// before the primary, as the caller orders them). Modal: a backdrop, `aria-modal`, Escape and a press outside close it
// (`onClose`). Its title is never caught by `.panel h2`'s caps, whatever it is drawn inside.
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import "./kit.css";

export interface KitDialogProps {
  readonly title: ComponentChildren;
  /** Beside the title (a badge naming the folder on disk). */
  readonly titleExtra?: ComponentChildren;
  readonly children: ComponentChildren;
  /** The footer's buttons (Cancel, then the primary). */
  readonly buttons?: ComponentChildren;
  /** The footer's left side: what the primary will do ("3 files · 12.4 MB"), or why it can't. */
  readonly summary?: ComponentChildren;
  /** `alertdialog` for a question that needs an answer (a confirm). */
  readonly role?: "dialog" | "alertdialog";
  /** Its width in px (default 460; the prototype's big dialogs use 620). */
  readonly width?: number;
  /** Extra classes on the dialog. */
  readonly class?: string;
  /** Keys inside it (Enter to confirm); Escape is handled. */
  onKeyDown?(e: KeyboardEvent): void;
  onClose(): void;
}

export function KitDialog(props: KitDialogProps) {
  const titleId = useId();
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        class={`dialog kit-dialog${props.class ? ` ${props.class}` : ""}`}
        role={props.role ?? "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        style={props.width ? { width: `min(${props.width}px, calc(100vw - 40px))` } : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
            return;
          }
          props.onKeyDown?.(e);
        }}
      >
        <header class="kit-dialog-head">
          <h2 id={titleId} class="kit-dialog-title">
            {props.title}
          </h2>
          {props.titleExtra}
          <button type="button" class="kit-dialog-close" aria-label="Close" title="Close (Esc)" onClick={props.onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="kit-dialog-body">{props.children}</div>
        {(props.buttons || props.summary) && (
          <footer class="kit-dialog-foot dialog-buttons">
            <span class="kit-dialog-summary">{props.summary}</span>
            {props.buttons}
          </footer>
        )}
      </div>
    </div>
  );
}
