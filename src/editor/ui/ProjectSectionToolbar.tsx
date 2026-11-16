// The toolbar a project section's panel shows (ADR 0151): its own buttons, Undo and Redo (off while the project is
// read-only or there's nothing to step), and the marker saying where the section's edits stand (its `status`).
// The Project Settings and Worlds panels both draw it, so they word the same state the same way.
import type { ComponentChildren } from "preact";
import { PROJECT_FILE } from "../projectFile";
import type { ProjectSectionSession, ProjectSectionStatus } from "../projectSection";
import "./sectionToolbar.css";

/** What the toolbar reads from the section's session. */
export type ToolbarSession = Pick<ProjectSectionSession<unknown>, "status" | "canUndo" | "canRedo" | "undoLabel" | "redoLabel" | "undo" | "redo">;

export interface ProjectSectionToolbarProps {
  session: ToolbarSession;
  /** What the section edits, in the marker's tooltips ("settings", "Worlds"). */
  noun: string;
  /** The toolbar's class in its panel. */
  class: string;
  /** The `saved` marker's words and tooltip, when not "Saved" / "Matches project.json". */
  saved?: { label: string; title: string };
  /** Why problems the file already holds matter, after the marker's tooltip ("play mode won't start until they're fixed"). */
  problemsNote?: string;
  /** The panel's own buttons, before Undo. */
  children?: ComponentChildren;
}

export function ProjectSectionToolbar(props: ProjectSectionToolbarProps) {
  const s = props.session;
  return (
    <div class={`section-toolbar ${props.class}`}>
      {props.children}
      <button disabled={!s.canUndo} title={s.canUndo && s.undoLabel ? `Undo ${s.undoLabel} (Ctrl+Z)` : "Nothing to undo"} onClick={() => void s.undo()}>
        Undo
      </button>
      <button disabled={!s.canRedo} title={s.canRedo && s.redoLabel ? `Redo ${s.redoLabel} (Ctrl+Shift+Z)` : "Nothing to redo"} onClick={() => void s.redo()}>
        Redo
      </button>
      <StatusMarker status={s.status} noun={props.noun} saved={props.saved} problemsNote={props.problemsNote} />
    </div>
  );
}

function StatusMarker(props: { status: ProjectSectionStatus; noun: string; saved?: { label: string; title: string }; problemsNote?: string }) {
  const { status, noun } = props;
  switch (status.kind) {
    case "read-only":
      return <span class="section-status readonly" title={`This project is read-only. Open a project folder to edit its ${noun}.`}>Read-only</span>;
    case "problems": {
      const plural = status.count === 1 ? "" : "s";
      if (status.unsaved) {
        return (
          <span class="section-status unsaved" title={`${PROJECT_FILE} keeps the last valid ${noun}. Fix the problem${plural} to save, or undo.`}>
            ● Not saved: {status.count} problem{plural}
          </span>
        );
      }
      const note = props.problemsNote ? `; ${props.problemsNote}` : "";
      return (
        <span class="section-status unsaved" title={`${PROJECT_FILE}'s ${noun} have ${status.count} problem${plural}${note}.`}>
          {status.count} problem{plural} in {PROJECT_FILE}
        </span>
      );
    }
    case "saving":
      return <span class="section-status">Saving…</span>;
    case "failed":
      return <span class="section-status unsaved" title={status.error}>● Not saved</span>;
    case "saved":
      return (
        <span class="section-status saved" title={props.saved?.title ?? `Matches ${PROJECT_FILE}`}>
          {props.saved?.label ?? "Saved"}
        </span>
      );
  }
}
