// The Sample toolbar's Save split button (owner decision 3, 2026-11-23; spec §4.1.5): the main half saves the project
// data (the sample's sidecar or derived-sample file, ADR 0342; Ctrl+S), and the caret's menu offers Write to file… (the
// WAV's chunks, after the review dialog) and Fork as new sample… (Ctrl+Shift+S). Pure view over its props.
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../../../editor/ui/popover";
import { Icon } from "../../components/Icon";

export interface SaveSplitButtonProps {
  /** Save is offered (a writable project with a sample open). */
  readonly canSave: boolean;
  /** Why Write to file… is off, or null when it's offered (only a WAV in a writable project). */
  readonly whyNoWrite: string | null;
  readonly canFork: boolean;
  /** The Save shortcut as the platform writes it ("Ctrl+S", "⌘S"). */
  readonly saveKeys: string;
  readonly forkKeys: string;
  onSave(): void;
  onWrite(): void;
  onFork(): void;
}

export function SaveSplitButton(props: SaveSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open, { anchor: caret.current, inside: [caret], focusFirst: true, onDismiss: () => setOpen(false) });
  const run = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  return (
    <span class="smp-split" role="group" aria-label="Save">
      <button class="smp-tool smp-tool-icon smp-split-main" disabled={!props.canSave} title={`Save the sample's edits now (${props.saveKeys}); they also save on their own. The audio file isn't changed.`} aria-keyshortcuts="Control+S" onClick={props.onSave}>
        <Icon name="check" />
        <span class="smp-hide-narrow">Save</span>
      </button>
      <button ref={caret} class="smp-tool smp-icon-button smp-split-caret" aria-label="More ways to save" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div ref={pop} class="context-menu kit-menu smp-menu" role="menu" aria-label="Save">
          <button role="menuitem" disabled={!props.canSave} onClick={run(props.onSave)}>
            <span class="smp-menu-label">Save</span>
            <span class="smp-menu-note">{props.saveKeys}</span>
          </button>
          <button role="menuitem" disabled={props.whyNoWrite !== null} title={props.whyNoWrite ?? "Write markers, loops, tempo and root into the WAV after a review (a backup is kept)"} onClick={run(props.onWrite)}>
            <span class="smp-menu-label">Write to file…</span>
          </button>
          <button role="menuitem" disabled={!props.canFork} onClick={run(props.onFork)}>
            <span class="smp-menu-label">Fork as new sample…</span>
            <span class="smp-menu-note">{props.forkKeys}</span>
          </button>
        </div>
      )}
    </span>
  );
}
