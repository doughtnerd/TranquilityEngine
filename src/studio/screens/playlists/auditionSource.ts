// What Trigger plays when the open playlist is nested inside a file (UI pass Q7: "Trigger plays the open playlist"): the
// runtime's `Audio.play` takes a playlist by path, so the open embedded playlist is served under a path of its own in
// the Studio's audition folder through `Assets.addSource` (the engine's public asset seam), as a playlist file with what
// it inherits where it plays: its parents' output bus and the file's local parameters. One audition is served at a time.
import { Assets, type AssetSource } from "../../../engine/scene/Assets";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { defaultEntryUse, emptyPlaylistBody } from "../../../engine/audio/playlist/format";
import { PLAYLIST_FORMAT, type Entry, type PlaylistAsset, type PlaylistBody } from "../../../engine/audio/playlist/types";

/** The folder audition paths live in (never a project folder: a leading dot, and nothing on disk). */
export const AUDITION_FOLDER = ".studio-audition";

/** The audition path of the playlist at `indices` inside `file`: `.studio-audition/<file's path and name>~2.0.playlist.json`. */
export function auditionPathOf(file: string, indices: readonly number[]): string {
  return `${AUDITION_FOLDER}/${file.replace(/\.playlist\.json$/i, "")}~${indices.join(".")}.playlist.json`;
}

/** The playlists above the one at `indices` in `root`, outermost first (the root itself, then each embedded parent). */
export function ancestorsOf(root: PlaylistBody, indices: readonly number[]): PlaylistBody[] {
  const out: PlaylistBody[] = [];
  let b: PlaylistBody | undefined = root;
  for (const i of indices) {
    if (!b) break;
    out.push(b);
    const e: Entry | undefined = b.entries[i];
    b = e?.kind === "embedded" ? e.embedded : undefined;
  }
  return out;
}

/**
 * The nested playlist as a file the runtime plays: its own settings, its parents' output when it has none, the file's
 * parameters, and its parents' playlist effects (wave-3 follow-up): each parent with effects, nearest first, wraps it in
 * a one-entry Layer carrying that parent's chain (and the automation of it), so it sounds as it does inside them. A level
 * with an output of its own leaves its parents' mix, so the parents above it don't wrap it (ADR 0345 levels).
 */
export function auditionAsset(body: PlaylistBody, output: string | null, parameters: readonly ParameterDef[], ancestors: readonly PlaylistBody[] = []): PlaylistAsset {
  let current: PlaylistBody = structuredClone(body);
  let leftMix = current.output !== null;
  for (let k = ancestors.length - 1; k >= 0 && !leftMix; k--) {
    const parent = ancestors[k]!;
    if (parent.effects.length > 0) {
      current = {
        ...emptyPlaylistBody("layer"),
        effects: structuredClone(parent.effects),
        automation: structuredClone(parent.automation.filter((a) => a.target.startsWith("fx:"))),
        entries: [{ kind: "embedded", embedded: current, ...defaultEntryUse() }],
      };
    }
    leftMix = parent.output !== null;
  }
  return { format: PLAYLIST_FORMAT, ...current, output: body.output ?? output, parameters: structuredClone([...parameters]) };
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
