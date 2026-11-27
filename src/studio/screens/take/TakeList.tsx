// The Takes panel's view (ADR 0348; spec §4.5.2; the prototype's takes tree): the project's takes by folder in the
// Studio's run-file tree (`RunFileTree`, shared with Captures): search, Open take file… into the selected folder, New
// folder, Collapse all, and per row Rename, Duplicate, Move to…, Move to top level and Delete (Undo on the toast), drag
// onto a folder. The empty state says how takes are recorded. A view over props: the panel wires the file actions.
import { RunFileTree, type RunFileTreeProps } from "../run/RunFileTree";
import { NO_TAKES, takeFiles } from "./takeFiles";

export type TakeListProps = Omit<RunFileTreeProps, "tree" | "noun" | "label" | "accept" | "emptyBody" | "fileIcon">;

/** The tree's id (rename by key). */
export const TAKE_TREE = "take-list";

export function TakeList(props: TakeListProps) {
  return <RunFileTree {...props} files={takeFiles(props.files)} tree={TAKE_TREE} noun="take" label="Takes" accept=".sporesample" emptyBody={NO_TAKES} fileIcon={() => "take"} />;
}
