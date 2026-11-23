// Undo, Redo and the History popover (ADR 0349, 0145, 0027): buttons acting on the active history (the focused
// document's, `activeHistory.ts`, or the one history a document's own toolbar names, `of`) and a popover drawing its tree with `UndoTree` (click a state to go there; editing
// after an undo starts a branch, so nothing is lost). The cluster counts as part of the history UI
// (`KEEPS_HISTORY_FOCUS`: `.history-panel`), so pressing it doesn't move the focus off the document whose history it is.
// The popover floats at the page's floating root (`FloatingPortal`), so a toolbar or header with container queries
// doesn't trap it. An app with its own icon set gives the buttons their glyphs through `HistoryIcons`.
import { createContext, type ComponentChildren } from "preact";
import { useContext, useRef, useState } from "preact/hooks";
import { activeHistory, redo, undo, type ActiveHistory } from "../activeHistory";
import { docVersion } from "../state";
import { FloatingPortal } from "./FloatingPortal";
import { historyPopoverText } from "./historyPopoverModel";
import { isMacPlatform } from "./keyCombo";
import { usePopover } from "./popover";
import { UndoTree } from "./undoTree/UndoTree";
import "./kit.css";

export interface HistoryPopoverProps {
  /** What the heading says with no active history (default "Nothing here to undo"). */
  readonly none?: string;
  /**
   * The history the cluster belongs to, whatever has focus (`assetHistory(doc)`: a document's own toolbar); default the
   * active history (the focused document's).
   */
  readonly of?: ActiveHistory | null;
}

/** The buttons' glyphs (each button keeps its name for assistive tech and its tooltip). */
export interface HistoryIconSet {
  readonly undo: ComponentChildren;
  readonly redo: ComponentChildren;
  readonly history: ComponentChildren;
}

/** The editor's own glyphs: arrows, and the word History. */
const TEXT_ICONS: HistoryIconSet = { undo: "↶", redo: "↷", history: "History" };

/** Provide an app's icons to every Undo/Redo/History cluster below (the Audio Studio's icon set). */
export const HistoryIcons = createContext<HistoryIconSet>(TEXT_ICONS);

export function HistoryPopover(props: HistoryPopoverProps) {
  const icons = useContext(HistoryIcons);
  docVersion.value; // re-render on every history change
  const active = props.of !== undefined ? props.of : activeHistory.value;
  const tree = active?.history.tree;
  tree?.version?.value;
  const text = historyPopoverText(active, isMacPlatform(), props.none);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open, { anchor: button.current, align: "end", inside: [button], onDismiss: () => setOpen(false) });
  return (
    <span class="history-panel kit-history" role="group" aria-label="History">
      <button class="kit-icon-button" aria-label="Undo" title={text.undo.title} disabled={!text.undo.enabled} onClick={() => (props.of ? props.of.history.canUndo && props.of.history.undo() : undo())}>
        {icons.undo}
      </button>
      <button class="kit-icon-button" aria-label="Redo" title={text.redo.title} disabled={!text.redo.enabled} onClick={() => (props.of ? props.of.history.canRedo && props.of.history.redo() : redo())}>
        {icons.redo}
      </button>
      <button ref={button} class="kit-icon-button" aria-haspopup="dialog" aria-expanded={open} aria-label="History" title="History: every step, with branches" onClick={() => setOpen(!open)}>
        {icons.history}
      </button>
      {open && (
        <FloatingPortal>
          <div ref={pop} class="kit-history-popover history-panel" role="dialog" aria-label="History">
            <div class="kit-history-heading" title={active?.path}>
              {text.heading}
            </div>
            {tree ? (
              <UndoTree states={tree.states} current={tree.current} marked={tree.saved} markTitle="Matches the file as last saved" label={`Edit history${active?.path ? ` of ${active.path}` : ""}`} scrollKey={docVersion.value} onPick={(seq) => tree.jumpTo(seq)} />
            ) : (
              <p class="kit-history-none">{active ? "Undo and Redo step through it." : "Click into a document to see its history."}</p>
            )}
            <div class="kit-history-hint">Editing after an undo starts a new branch, so nothing is lost.</div>
          </div>
        </FloatingPortal>
      )}
    </span>
  );
}
