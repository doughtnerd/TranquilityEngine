// The Captures panel's view (ADR 0348; spec §4.6.2; the prototype's captures tree): the project's capture files (and
// takes, whose profile the Profiler reads too) by folder in the Studio's run-file tree (`RunFileTree`, shared with
// Takes): search, Open capture file… into the selected folder, New folder, Collapse all, and per row Rename, Duplicate,
// Move to…, Move to top level and Delete (Undo on the toast), drag onto a folder. The empty state says where captures
// come from. A view over props: the panel wires the file actions.
import { RunFileTree, type RunFileTreeProps } from "./RunFileTree";
import { isCapturePath, isTakePath, NO_CAPTURES } from "./captureTree";

export type CaptureListProps = Omit<RunFileTreeProps, "tree" | "noun" | "label" | "accept" | "emptyBody" | "fileIcon">;

/** The tree's id (rename by key). */
export const CAPTURE_TREE = "profiler-captures";

export function CaptureList(props: CaptureListProps) {
  return (
    <RunFileTree
      {...props}
      files={props.files.filter(isCapturePath)}
      tree={CAPTURE_TREE}
      noun="capture"
      label="Captures"
      accept=".mycap,.mycotake"
      emptyBody={NO_CAPTURES}
      fileIcon={(p) => (isTakePath(p) ? "take" : "profiler")}
    />
  );
}
