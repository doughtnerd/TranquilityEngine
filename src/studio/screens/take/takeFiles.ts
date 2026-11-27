// The Takes panel's files (ADR 0348 "The Take screen"; the prototype's takes file system): the project's take files
// (`*.sporesample`) by folder, through the Run screens' capture tree (`run/captureTree.ts`; a take is a capture file
// with requests), their notes files (`<take>.notes.json`), which move and go with them, and where imported takes go.
// Pure.
import { takeNotesPath } from "../../../engine/audio/take/notes";
import { RECORDINGS_FOLDER, captureTree, isTakePath, searchCaptures, type CaptureNode } from "../run/captureTree";

/** Where the Studio imports takes (and where the editor's Record take saves them). */
export const TAKES_FOLDER = RECORDINGS_FOLDER;

/** The empty state's words. */
/**
 * How to get a take, under "No takes yet" (one sentence, sentence case, UI pass T4). The Studio replays takes but can't
 * record one (no game session yet): takes come from the editor's Play toolbar or a game build.
 */
export const NO_TAKES = "Record one with Record take on the editor's Play toolbar, with F10 in a game build that has audioTake on, or here with Start take once a build is connected.";

/**
 * The Take screen's centre with no take open (spec §1.3: an empty state is one short line saying what to do): the
 * title, and one line that says how a take is recorded (the Studio records only from a connected build, ADR 0403; it
 * can't record its own: owner decision 1).
 */
export function takeEmptyCopy(hasTakes: boolean): { readonly title: string; readonly line: string } {
  return hasTakes
    ? { title: "No take open", line: "Pick one in Takes, or record with Record take on the editor's Play toolbar or a build." }
    : { title: "No takes yet", line: "Use Record take on the editor's Play toolbar, F10 in a game build, or a connected build." };
}

/** The take files of `files`. */
export const takeFiles = (files: readonly string[]): string[] => files.filter(isTakePath);

/** The takes as a tree of the folders that hold them. */
export const takeTree = (files: readonly string[]): CaptureNode[] => captureTree(takeFiles(files));

/** The takes whose path holds every word of `query`. */
export const searchTakes = (files: readonly string[], query: string): string[] => searchCaptures(takeFiles(files), query);

/** Why a chosen file can't be imported as a take, or null. */
export function whyNotTakeFile(name: string): string | null {
  return isTakePath(name) ? null : `${name} isn't a take file (.sporesample).`;
}

/** The files that go with take `path` (the library's companions: they move, copy and delete with it): the take, and its notes when it has some. */
export function takeDeletion(files: readonly string[], path: string): string[] {
  const notes = takeNotesPath(path);
  return files.includes(notes) ? [path, notes] : [path];
}

export { isTakePath };
