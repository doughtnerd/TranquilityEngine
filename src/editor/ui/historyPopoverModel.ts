// What the History popover and its Undo and Redo buttons say (ADR 0349, 0145): for the active history (the focused
// document's), whether each button works, its tooltip naming the step and the keys, and the popover's heading.
import { fileName } from "../projectPath";
import type { ActiveHistory } from "../activeHistory";
import { formatKeys } from "./keyCombo";

export interface HistoryButton {
  readonly enabled: boolean;
  readonly title: string;
}

export interface HistoryPopoverText {
  readonly undo: HistoryButton;
  readonly redo: HistoryButton;
  /** The popover's heading: whose history it is, or why there is none. */
  readonly heading: string;
  /** The active history has a tree to draw. */
  readonly tree: boolean;
}


/** The buttons' and heading's words for `active` (null: nothing focused has a history; `none` says so). */
export function historyPopoverText(active: Pick<ActiveHistory, "history" | "path"> | null, mac: boolean, none = "Nothing here to undo"): HistoryPopoverText {
  const undoKeys = formatKeys("Mod+Z", mac);
  const redoKeys = formatKeys("Mod+Shift+Z", mac);
  if (!active) return { undo: { enabled: false, title: `Undo (${undoKeys})` }, redo: { enabled: false, title: `Redo (${redoKeys})` }, heading: none, tree: false };
  const h = active.history;
  const step = (verb: string, label: string | null | undefined, keys: string) => (label ? `${verb} ${label} (${keys})` : `${verb} (${keys})`);
  const what = active.path ? fileName(active.path) : (h.name ?? "This editor");
  return {
    undo: { enabled: h.canUndo, title: h.canUndo ? step("Undo", h.undoLabel, undoKeys) : `Nothing to undo (${undoKeys})` },
    redo: { enabled: h.canRedo, title: h.canRedo ? step("Redo", h.redoLabel, redoKeys) : `Nothing to redo (${redoKeys})` },
    heading: h.tree ? `${what} · every step, with branches` : `${what} keeps a short undo list`,
    tree: !!h.tree,
  };
}
