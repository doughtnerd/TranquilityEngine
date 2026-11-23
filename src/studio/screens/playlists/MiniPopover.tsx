// A small floating panel opened from a toolbar button (the prototype's `.cmenu` dialogs: Variation per trigger, a
// change's fades): placed beside its button and dismissed by `usePopover` (a press outside, Escape), drawn at the
// page's floating root so a container-query toolbar doesn't trap it. Its button toggles it.
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
import { usePopover } from "../../../editor/ui/popover";

export function MiniPopover(props: {
  /** The dialog's accessible name and its caps heading. */
  readonly title: string;
  /** The toggle button's content, class and tooltip. */
  readonly button: ComponentChildren;
  readonly buttonClass?: string;
  readonly buttonTitle?: string;
  readonly buttonLabel?: string;
  readonly disabled?: boolean;
  readonly align?: "start" | "end";
  readonly children: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open, { anchor: button.current, align: props.align ?? "start", inside: [button], onDismiss: () => setOpen(false) });
  return (
    <>
      <button ref={button} type="button" class={props.buttonClass ?? "pl-icon"} aria-haspopup="dialog" aria-expanded={open} aria-label={props.buttonLabel} title={props.buttonTitle} disabled={props.disabled} onClick={() => setOpen(!open)}>
        {props.button}
      </button>
      {open && (
        <FloatingPortal>
          <div ref={pop} class="pl-popover" role="dialog" aria-label={props.title}>
            <span class="pl-cap">{props.title}</span>
            {props.children}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
