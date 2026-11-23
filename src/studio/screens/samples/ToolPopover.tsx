// A toolbar button that opens a popover of fields (the Tempo, Root note, Normalize, Snap and Time display popovers),
// placed and dismissed by the editor's `usePopover`. It floats at the page's root (the Sample toolbar has container
// queries, which would otherwise trap it, S-03) and keeps the sample's history active while it's used.
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../../../editor/ui/popover";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
import { Icon } from "../../components/Icon";

export interface ToolPopoverProps {
  readonly label: ComponentChildren;
  /** The button's accessible name and tooltip. */
  readonly title: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** The popover's heading. */
  readonly heading: string;
  readonly children: (close: () => void) => ComponentChildren;
}

export function ToolPopover(props: ToolPopoverProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open, { anchor: button.current, inside: [button], onDismiss: () => setOpen(false) });
  return (
    <>
      <button ref={button} class={`smp-tool smp-tool-icon${props.pressed ? " on" : ""}`} title={props.title} aria-label={props.title} aria-expanded={open} aria-haspopup="dialog" disabled={props.disabled} onClick={() => setOpen(!open)}>
        <span class="smp-ellipsis">{props.label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <FloatingPortal>
          <div ref={pop} class="smp-popover" role="dialog" aria-label={props.heading} data-keeps-history-focus="">
            <div class="smp-popover-title">{props.heading}</div>
            {props.children(() => setOpen(false))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
