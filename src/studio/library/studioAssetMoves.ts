// Moving and renaming assets in the Studio (ADR 0341, "One app owns each file; both watch"); the Studio asset library
// (`studioLibrary.ts`, ADR 0433) is its only caller, so every Studio move and rename comes through here. A move changes
// what scenes, prefabs and project.json name, files the editor owns, so who rewrites them depends on whether the
// editor has the project open (its lock, `.myco/locks/editor.json`):
//
// - **No editor holds it:** the Studio rewrites every reference itself, through the engine's asset move machinery
//   (`moveAssets`: files on disk, open documents and their histories, references in scenes, prefabs, project.json and
//   other JSON files).
// - **The editor holds it:** the moves are written to `.myco/locks/pending-moves.json` first (`recordPendingMoves`, so a
//   watcher that sees the files move finds them waiting), then the files move and the Studio rewrites references only
//   in the files it owns (asset JSON other than scenes, prefabs and project.json, its open documents through their whole
//   history, ADR 0302). The editor applies the pending moves to its documents, scenes and prefabs and deletes the file.
//   A stale editor lock (an editor that crashed) only delays those rewrites to the editor's next open (decision log D6).
import { fileName } from "../../editor/assetBrowser";
import { assetDocumentsMoved } from "../../editor/assetDocuments";
import { folderEntry } from "../../editor/assetEntry";
import { moveAssets, whyNotMovable } from "../../editor/assetOps";
import { movedPath } from "../../editor/assetReferences";
import { withMovedAssets } from "../../editor/assetRefValues";
import { errorStatus } from "../../editor/messages";
import { editProjectFiles } from "../../editor/projectFileEdits";
import { otherAppHolds, recordPendingMoves } from "../../editor/projectLocks";
import { isWithin, type EditorProject } from "../../editor/projects";
import { currentProject, docVersion, status } from "../../editor/state";
import { taken } from "../../editor/freePath";

/** A move: a project path (a file or a folder) and its new path. */
export type AssetMove = readonly [from: string, to: string];

/**
 * Rename or move files and folders from the Studio. Checks them all first; resolves to true once they moved (the
 * status bar says what happened, or why not).
 */
export async function moveStudioAssets(moves: readonly AssetMove[], verb = "Moved"): Promise<boolean> {
  const project = currentProject.peek();
  moves = moves.filter(([from, to]) => from !== to);
  if (!project || moves.length === 0) return false;
  const fs = project.fileSystem, root = project.root;
  const editor = fs && root ? await otherAppHolds(fs, root, "studio").catch(() => null) : null;
  if (!editor || !fs || !root) return moveAssets(moves, verb);
  return moveLeavingEditor(project, moves, verb);
}

/** The editor holds the project: leave it the moves, move the files, rewrite only the Studio's own files. */
async function moveLeavingEditor(project: EditorProject, moves: readonly AssetMove[], verb: string): Promise<boolean> {
  const fail = (text: string) => ((status.value = { kind: "info", text }), false);
  const refused = whyNotMovable(project, moves.map(([from]) => (project.folders.includes(from) ? folderEntry(from) : from)));
  if (refused) return fail(`Can't move: ${refused}.`);
  for (const [from, to] of moves) {
    if (isWithin(to, from)) return fail(`Can't move ${fileName(from)} into itself.`);
    if (taken(project, to)) return fail(`Can't move ${fileName(from)}: ${to} already exists.`);
  }
  try {
    await recordPendingMoves(project.fileSystem!, project.root!, moves.map(([from, to]) => ({ from, to })));
  } catch (err) {
    status.value = errorStatus("Couldn't leave the moves for the editor, so nothing moved", err);
    return false;
  }
  const done: [string, string][] = [];
  try {
    for (const [from, to] of moves) {
      await project.move(from, to);
      done.push([from, to]);
    }
  } catch (err) {
    status.value = errorStatus(`Couldn't move ${fileName(moves[done.length]![0])}`, err);
  }
  if (done.length === 0) return false;
  const histories = assetDocumentsMoved(done);
  const updated = await rewriteOwnReferences(project, done);
  docVersion.value++;
  await histories;
  if (done.length < moves.length) return false;
  const label = done.length === 1 ? `${done[0]![0]} to ${done[0]![1]}` : `${done.length} items`;
  status.value = {
    kind: "info",
    text: `${verb} ${label}.${updated.length > 0 ? ` Updated references in ${updated.join(", ")}.` : ""} The editor has the project open and updates its scenes and prefabs.`,
  };
  return true;
}

/** References to the moved paths in the Studio's own files: asset JSON other than scenes, prefabs and project.json. */
function rewriteOwnReferences(project: EditorProject, moves: readonly AssetMove[]): Promise<string[]> {
  const rename = movedPath(moves);
  const froms = moves.map(([from]) => from);
  return editProjectFiles(
    project,
    {
      mentioned: (text) => froms.some((f) => text.includes(f)),
      scene: () => null, // the editor's (pending moves)
      settings: () => null, // project.json: the editor's
      json: (value) => {
        const result = withMovedAssets(value, rename);
        return result.changed ? result.value : null;
      },
    },
    `Update references to ${moves.length === 1 ? fileName(moves[0]![1]) : `${moves.length} moved files`}`,
  );
}
