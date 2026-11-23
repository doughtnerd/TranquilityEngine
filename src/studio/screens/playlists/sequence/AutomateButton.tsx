// The Automate (A) button beside an Inspector control (proto A9b/A9c `.ibtn` "A", spec §2.7.3): plain when the control
// isn't automated, on when it is, red while Write is armed. Click opens the curve editor on that property (it is made a
// curve first when it has none); right-click (or the context-menu key) opens the automate menu: Edit curves…, Copy
// curves, Paste curves [from X], Turn automation off / on, Clear all automation.
import { useState } from "preact/hooks";
import type { Automation } from "../../../../engine/audio/playlist/types";
import { ContextMenu, SEPARATOR } from "../../../../editor/ui/ContextMenu";
import type { PopoverPoint } from "../../../../editor/ui/popover";
import { seqCurveClipboard, seqWrite } from "./sequenceState";

export interface AutomateButtonProps {
  /** The property's name ("Volume", "Low-pass"), for the menu's title and the tooltips. */
  readonly name: string;
  /** Its curves (one, or an effect's lanes), empty when not automated. */
  readonly lanes: readonly Automation[];
  /** Whose they are, for "Paste curves from Skid". */
  readonly owner: string;
  readonly writable: boolean;
  /** Open the curve editor on it. */
  onEdit(): void;
  onPaste(lanes: readonly Automation[]): void;
  onBypass(bypass: boolean): void;
  onClear(): void;
}

export function AutomateButton(props: AutomateButtonProps) {
  const [menu, setMenu] = useState<PopoverPoint | Element | null>(null);
  const on = props.lanes.length > 0;
  const live = props.lanes.some((a) => !a.bypass);
  const write = seqWrite.value;
  const clip = seqCurveClipboard.value;
  const title = write
    ? `Write armed: move ${props.name.toLowerCase()} while playing to write its curve · click for the curve editor`
    : on
      ? `${props.name} is automated${live ? "" : " (off)"} · click to edit its curves · right-click for more`
      : `Automate ${props.name.toLowerCase()} · click to draw its curve · right-click for more`;
  return (
    <>
      <button
        type="button"
        class={`sq-abtn${on ? " on" : ""}${write ? " rec" : ""}${on && !live ? " off" : ""}`}
        aria-label={`Automate ${props.name}`}
        aria-pressed={on}
        title={title}
        onClick={props.onEdit}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            setMenu(e.currentTarget);
          }
        }}
      >
        A
      </button>
      {menu && (
        <ContextMenu
          at={menu}
          label={`${props.name} automation`}
          onClose={() => setMenu(null)}
          entries={[
            { kind: "group", label: props.name.startsWith("fx") ? `${props.name} automation` : `${props.name} curve` },
            { id: "edit", label: "Edit curves…", hint: "Click", run: props.onEdit },
            SEPARATOR,
            { id: "copy", label: "Copy curves", disabled: !on, run: () => (seqCurveClipboard.value = { from: props.owner, lanes: props.lanes }) },
            { id: "paste", label: clip ? `Paste curves from ${clip.from}` : "Paste curves", disabled: !props.writable || !clip, run: () => clip && props.onPaste(clip.lanes) },
            { id: "bypass", label: live || !on ? "Turn automation off" : "Turn automation on", disabled: !props.writable || !on, run: () => props.onBypass(live) },
            { id: "clear", label: "Clear all automation", danger: true, disabled: !props.writable || !on, run: props.onClear },
          ]}
        />
      )}
    </>
  );
}
