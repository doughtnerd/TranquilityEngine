/**
 * Playlists (ADR 0166 api-and-models §2.3 `playlist`, §3.2 cursors and shuffle bags; architecture §2.1).
 *
 * Owner: **P4** (W5), with the pure order in `playlistOrder.ts` (leaf L-P4a). Q2 wrote the skeleton.
 *
 * Sequence, random, shuffle, `avoidRepeat`, `plays`, `rounds`, nesting; the natural advance at the exit cue; the next
 * item is always primed ahead (a long run never shows an unprimed start).
 */
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import type { PlaylistOrder } from "./playlistOrder";

/** One playlist container's cursor (nesting keeps one per playlist node). P4 may add fields here. */
export interface PlaylistCursor {
  readonly node: MusicNodeRef;
  readonly order: PlaylistOrder;
  /** Index of the playing item in the node's item list, -1 before the first. */
  item: number;
  /** Plays of the playing item so far (its `plays` count). */
  plays: number;
  /** Rounds completed. */
  rounds: number;
}

/** A player's playlist state: the cursors from the root playlist down. */
export interface PlaylistState {
  readonly cursors: PlaylistCursor[];
}

/** P4: the playlist state for a root (or nested) playlist node, seeded per instance; null when `node` isn't a playlist. */
export function createPlaylistState(node: MusicNodeRef, seed: number): PlaylistState | null {
  void node;
  void seed;
  return null; // STUB(P4)
}

/** P4: the item after the playing one (descending into nested containers), or null at the end of the last round. */
export function peekNext(state: PlaylistState): MusicNodeRef | null {
  void state;
  return null; // STUB(P4)
}

/** P4, step 9: keep the next item primed; at the playing segment's exit cue, advance the cursor (natural advance). */
export function tickPlaylist(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(P4)
}
