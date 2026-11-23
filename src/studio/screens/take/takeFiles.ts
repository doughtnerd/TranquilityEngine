// The Takes panel's files (ADR 0348 "The Take screen"; the prototype's takes file system): the project's take files
// (`*.mycotake`) by folder, through the Profiler's capture tree (a take is a capture file with requests), their notes
// files (`<take>.notes.json`), which move and go with them, and where imported takes go. Pure.
import { takeNotesPath } from "../../../engine/audio/take/notes";
import { captureTree, isTakePath, searchCaptures, type CaptureNode } from "../profiler/captureTree";

/** Where the Studio imports takes (and where the editor's Record take saves them). */
export const TAKES_FOLDER = "takes";

/** The empty state's words. */
/**
 * How to get a take, under "No takes yet" (one sentence, sentence case, UI pass T4). The Studio replays takes but can't
 * record one (no game session yet): takes come from the editor's Play toolbar or a game build.
 */
export const NO_TAKES = "Record one with Record take on the editor's Play toolbar, or with F10 in a game build that has audioTake on.";

/** The take files of `files`. */
export const takeFiles = (files: readonly string[]): string[] => files.filter(isTakePath);

/** The takes as a tree of the folders that hold them. */
export const takeTree = (files: readonly string[]): CaptureNode[] => captureTree(takeFiles(files));

/** The takes whose path holds every word of `query`. */
export const searchTakes = (files: readonly string[], query: string): string[] => searchCaptures(takeFiles(files), query);

/** Why a chosen file can't be imported as a take, or null. */
export function whyNotTakeFile(name: string): string | null {
  return isTakePath(name) ? null : `${name} isn't a take file (.mycotake).`;
}

/** The moves that rename or move take `from` to `to`: the take, and its notes when it has some. */
export function takeMoves(files: readonly string[], from: string, to: string): [string, string][] {
  const moves: [string, string][] = [[from, to]];
  const notes = takeNotesPath(from);
  if (files.includes(notes)) moves.push([notes, takeNotesPath(to)]);
  return moves;
}

/** What deleting take `path` deletes: the take, and its notes when it has some. */
export function takeDeletion(files: readonly string[], path: string): string[] {
  const notes = takeNotesPath(path);
  return files.includes(notes) ? [path, notes] : [path];
}

export { isTakePath };
