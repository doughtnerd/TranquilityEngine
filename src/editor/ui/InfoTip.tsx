// An explanation that lives in a tooltip (owner spec §1.3: "No inline helper text. Explanations live in tooltips";
// ADR 0349 kit). A small ⓘ button beside a heading, a label or an empty state: hovering shows its text as the native
// tooltip, and pressing it (click, tap, Enter or Space) opens the same text in a bubble below it, so touch and keyboard
// users can read it too (spec §3.10: tooltips can't be seen on touch). The bubble closes on a press outside, Escape, or
// a second press. Screen readers get the text as the button's description.
//
//   <InfoTip text="Runs on everything routed here, before the fader." />                 beside anything
//   <Section title="Playback" hint="When a trigger plays, and what happens at the limit">  a section header
//   <EmptyState compact title="No takes yet" body="Record one with Record session…" />        an empty state's body
import { useId, useRef, useState } from "preact/hooks";
import { FloatingPortal } from "./FloatingPortal";
import { usePopover } from "./popover";
import "./kit.css";

export interface InfoTipProps {
  /** The explanation. */
  readonly text: string;
  /** The button's accessible name (default "More about this"). */
  readonly label?: string;
  readonly class?: string;
}

export function InfoTip(props: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <>
      <button
        ref={button}
        type="button"
        class={`kit-info${open ? " open" : ""}${props.class ? ` ${props.class}` : ""}`}
        aria-label={props.label ?? "More about this"}
        aria-describedby={id}
        aria-expanded={open}
        title={props.text}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" stroke-width="1.1" />
          <path d="M6 5.3v3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          <circle cx="6" cy="3.5" r="0.75" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <FloatingPortal>
          <InfoBubble id={id} text={props.text} anchor={button.current} onClose={() => setOpen(false)} />
        </FloatingPortal>
      ) : (
        <span id={id} class="kit-sr-only">
          {props.text}
        </span>
      )}
    </>
  );
}

function InfoBubble(props: { id: string; text: string; anchor: HTMLButtonElement | null; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, true, { anchor: props.anchor, onDismiss: props.onClose, inside: [props.anchor] });
  return (
    <div ref={ref} id={props.id} class="kit-info-bubble" role="tooltip">
      {props.text}
    </div>
  );
}
