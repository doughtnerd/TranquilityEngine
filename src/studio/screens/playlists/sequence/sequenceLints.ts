// Which of a playlist's lints the Playlist panel's warning list shows, and in which words (UI pass W-3, owner decision
// 4). The Sequence timeline shows its own: an unbound loop on the clip's chip, a tail without an Exit marker in the
// Inspector, and "follows" on the chip and in the Inspector only for a clip chained over another on its own track
// (`clipFollows`). Overlapping Sync clips on parallel tracks (music stems that start together) are all Sync to the
// sequence clock, so their overlap is never a warning. The rest are listed with clips named as the timeline names them
// (their sample or playlist), never by their ids. Pure.
import type { PlaylistLint, PlaylistLintCode } from "../../../../engine/audio/playlist/lint";
import type { Clip, PlaylistBody } from "../../../../engine/audio/playlist/types";
import { clipName } from "./TimelineClip";

/** Lints the timeline draws itself (never in the list above it). */
const ON_THE_TIMELINE: ReadonlySet<PlaylistLintCode> = new Set(["overlappingSyncLoops", "unboundLoop", "tailWithoutExit"]);

/** Every clip id in the sequences of `body` (at any depth of embedded playlists), with the clip. */
function clipsById(body: PlaylistBody, out = new Map<string, Clip>()): Map<string, Clip> {
  for (const t of body.sequence?.tracks ?? []) {
    for (const c of t.clips) {
      if (!out.has(c.id)) out.set(c.id, c);
      if (c.playlist && typeof c.playlist === "object") clipsById(c.playlist, out);
    }
  }
  for (const e of body.entries) if (e.kind === "embedded") clipsById(e.embedded, out);
  return out;
}

/**
 * The lines of the warning list for the body shown (its lints, `openLints`): every lint but
 * the overlap of Sync clips (never a warning, decision 4) and, for a sequence, those its timeline shows; quoted clip
 * ids become the clips' names.
 */
export function warningLines(lints: readonly PlaylistLint[], body: PlaylistBody): string[] {
  const clips = clipsById(body);
  const seq = body.type === "sequence";
  return lints
    .filter((l) => l.code !== "overlappingSyncLoops" && !(seq && ON_THE_TIMELINE.has(l.code)))
    .map((l) => l.message.replace(/\b([Cc]lips?) "([^"]+)"/g, (whole, word: string, id: string) => {
      const c = clips.get(id);
      return c ? `${word} ${clipName(c)}` : whole;
    }));
}

