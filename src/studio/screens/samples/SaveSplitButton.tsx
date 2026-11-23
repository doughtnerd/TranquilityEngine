// The Sample toolbar's Save split button (owner decision 3, 2026-11-23; spec §4.1.5): the icon-only main half saves the
// project data (the sample's sidecar or derived-sample file, ADR 0342; Ctrl+S), and the caret's menu (the kit's
// ContextMenu) offers Save, Write to file… (the WAV's chunks, after the review dialog) and Fork as new sample…
// (Ctrl+Shift+S). Pure view over its props.
import { useRef, useState } from "preact/hooks";
import { ContextMenu } from "../../../editor/ui/ContextMenu";
import { Icon } from "../../components/Icon";
import { SampleIcon } from "./sampleIcons";

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
  return (
    <span class="smp-split" role="group" aria-label="Saving">
      <button type="button" class="smp-sbtn smp-split-main smp-strong" aria-label="Save" disabled={!props.canSave} title={`Save the sample's edits now (${props.saveKeys}); they also save on their own. The audio file isn't changed: Write to file… writes the WAV.`} aria-keyshortcuts="Control+S" onClick={props.onSave}>
        <Icon name="save" size={14} />
      </button>
      <button ref={caret} type="button" class="smp-sbtn smp-split-caret" aria-label="More ways to save" title="More ways to save" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SampleIcon name="caret" size={10} />
      </button>
      {open && (
        <ContextMenu
          at={caret.current!}
          label="Save"
          onClose={() => setOpen(false)}
          entries={[
            { id: "save", label: "Save", hint: props.saveKeys, disabled: !props.canSave, title: "Save the sample's edits (its project data) now", run: props.onSave },
            { id: "write", label: "Write to file…", disabled: props.whyNoWrite !== null, title: props.whyNoWrite ?? "See exactly which chunks will be written into the WAV (markers, loops, tempo, root note); a backup is kept", run: props.onWrite },
            { id: "fork", label: "Fork as new sample…", hint: props.forkKeys, disabled: !props.canFork, title: "Fork: a new sample that references this one's source and edits; no audio is copied", run: props.onFork },
          ]}
        />
      )}
    </span>
  );
}
