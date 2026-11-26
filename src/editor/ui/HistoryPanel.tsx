import { activeHistory } from "../activeHistory";
import { docVersion } from "../state";
import { Panel } from "./panel/Panel";
import { UndoTree } from "./undoTree/UndoTree";
import "./history.css";
import { EmptyState } from "./EmptyState";

/** What the History panel says that depends on its host: the scene editor's words, or the Audio Studio's (ADR 0341). */
export interface HistoryPanelWording {
  /** Shown when no history is active (default "No scene open"; the Studio: no document focused). */
  readonly none?: string;
}

/**
 * The open scene's edit history as a tree (ADR 0027), drawn by `UndoTree`: newest state at the top,
 * a column per branch, the current state filled, the saved state marked. Click a state to jump to
 * it; nothing is lost when you then edit, since edits start a new branch. It shows the active
 * history's tree (ADR 0145): while an asset editor is focused (Sky, a material, a graph…), that
 * asset document's (ADR 0133). This is the scene editor's; a host with other words draws `HistoryView`.
 */
export function HistoryPanel() {
  return <HistoryView />;
}

/** The History panel with its host's `wording` (the scene editor's when left out): the Audio Studio's (ADR 0341). */
export function HistoryView(props: { readonly wording?: HistoryPanelWording }) {
  docVersion.value; // re-render on every history change
  const active = activeHistory.value;
  const asset = active?.kind === "scene" ? null : active;
  const stack = active?.history.tree;
  stack?.version?.value; // and on every change to an asset's tree
  if (!active)
    return (
      <Panel>
        <EmptyState compact title={props.wording?.none ?? "No scene open"} />
      </Panel>
    );
  if (!stack)
    return (
      <Panel>
        <EmptyState compact title={`${active.history.name ?? "This editor"} keeps a short undo list rather than a tree.`} body="Ctrl+Z / Ctrl+Shift+Z or its Undo and Redo buttons step through it." />
      </Panel>
    );

  /** The file (or editor) whose tree this is, when it isn't the scene's. */
  const what = asset?.path ?? asset?.history.name ?? "";
  return (
    <Panel>
      <div class="history-panel">
        {asset ? (
          <div class="history-hint history-asset" title={what}>
            {what.slice(what.lastIndexOf("/") + 1)} · Click a state to go there
          </div>
        ) : (
          <div class="history-hint" title="Ctrl/Cmd+Alt+Z and Ctrl/Cmd+Alt+Shift+Z step back and forward through states in the order they were made (like Vim's g- / g+)">
            Click a state to go there · Ctrl+Alt+Z / Ctrl+Alt+Shift+Z: step by time
          </div>
        )}
        <UndoTree
          states={stack.states}
          current={stack.current}
          marked={stack.saved}
          markTitle="Matches the file as last saved"
          label={asset ? `Edit history of ${what}` : "Edit history"}
          scrollKey={`${docVersion.value}|${what}`}
          onPick={(seq) => stack.jumpTo(seq)}
        />
      </div>
    </Panel>
  );
}
