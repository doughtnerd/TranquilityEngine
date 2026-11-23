// A Samples timeline button that opens a popover (the prototype's `.sbtn` + `.snm`): Tempo, Root note, Normalize, the
// Snap split button's caret. The button is compact: an icon, an optional value ("C3", "120"), a caret; on (`pressed`)
// it takes the accent. The popover opens below it with a caps caption, placed and dismissed by the editor's
// `usePopover`. It floats at the page's root (the Sample toolbar has container queries, which would otherwise trap it,
// S-03) and keeps the sample's history active while it's used.
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../../../editor/ui/popover";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
import { SampleIcon, type SampleIconName } from "./sampleIcons";

export interface ToolPopoverProps {
  readonly icon?: SampleIconName;
  /** A value after the icon ("C3"); empty or absent shows the icon alone. */
  readonly label?: ComponentChildren;
  /** The button's accessible name (default: `heading`). */
  readonly name?: string;
  /** The button's tooltip. */
  readonly title: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** The caret half of a split button: a caret alone, joined to the button before it. */
  readonly caretOnly?: boolean;
  /** The popover's caps caption. */
  readonly heading: string;
  readonly children: (close: () => void) => ComponentChildren;
}

export function ToolPopover(props: ToolPopoverProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open, { anchor: button.current, inside: [button], onDismiss: () => setOpen(false) });
  const cls = props.caretOnly ? "smp-sbtn smp-split-caret" : `smp-sbtn${props.pressed ? " on" : ""}`;
  return (
    <>
      <button ref={button} type="button" class={cls} title={props.title} aria-label={props.name ?? props.heading} aria-expanded={open} aria-haspopup="dialog" disabled={props.disabled} onClick={() => setOpen(!open)}>
        {props.icon && <SampleIcon name={props.icon} size={14} />}
        {props.label ? <span class="smp-tabular smp-ellipsis">{props.label}</span> : null}
        <SampleIcon name="caret" size={9} />
      </button>
      {open && (
        <FloatingPortal>
          <div ref={pop} class="smp-popover smp-snm" role="dialog" aria-label={props.name ?? props.heading} data-keeps-history-focus="">
            <div class="smp-cap">{props.heading}</div>
            {props.children(() => setOpen(false))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
