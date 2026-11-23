// What Trigger plays when the open playlist is nested inside a file (UI pass Q7: "Trigger plays the open playlist"): the
// runtime's `Audio.play` takes a playlist by path, so the open embedded playlist is served under a path of its own in
// the Studio's audition folder through `Assets.addSource` (the engine's public asset seam), as a playlist file with what
// it inherits where it plays: its parents' output bus and the file's local parameters. One audition is served at a time.
import { Assets, type AssetSource } from "../../../engine/scene/Assets";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { PLAYLIST_FORMAT, type PlaylistAsset, type PlaylistBody } from "../../../engine/audio/playlist/types";

/** The folder audition paths live in (never a project folder: a leading dot, and nothing on disk). */
export const AUDITION_FOLDER = ".studio-audition";

/** The audition path of the playlist at `indices` inside `file`: `.studio-audition/<file's path and name>~2.0.playlist.json`. */
export function auditionPathOf(file: string, indices: readonly number[]): string {
  return `${AUDITION_FOLDER}/${file.replace(/\.playlist\.json$/i, "")}~${indices.join(".")}.playlist.json`;
}

/** The nested playlist as a file the runtime plays: its own settings, its parents' output when it has none, the file's parameters. */
export function auditionAsset(body: PlaylistBody, output: string | null, parameters: readonly ParameterDef[]): PlaylistAsset {
  return { format: PLAYLIST_FORMAT, ...structuredClone(body), output: body.output ?? output, parameters: structuredClone([...parameters]) };
}

const served = new Map<string, unknown>();
const source: AssetSource = { has: (p) => served.has(p), get: (p) => served.get(p) };

/** Serve `asset` at `path` (replacing the audition served before), ahead of the project's files. */
export function serveAudition(path: string, asset: PlaylistAsset): void {
  served.clear();
  served.set(path, asset);
  // Re-added each time: opening a project may clear the sources.
  Assets.removeSource(source);
  Assets.addSource(source);
}
