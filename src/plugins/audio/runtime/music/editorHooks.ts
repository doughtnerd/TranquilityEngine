/**
 * @internal Hooks the editor's segment-view transport calls on a playing music event (F-14, F-15). They are not part of the
 * public API: `src/myco.ts` doesn't export them, `handle.music` doesn't have them, and neither writes to the event file.
 *
 * - `auditionStems`: solo and mute of the segment panel, as the set of stems that sound (`stems.ts`'s `setAudibleStems`).
 * - `startAtSegment`: start the event's playlist at a later segment instead of its first, before the first plan tick.
 *
 * Both take the `MusicHandle` the public handle exposes (`handle.music`) and find the player behind it.
 */
import type { MusicHandle } from "../../../../engine/audio/musicTypes";
import { musicPlayers, type MusicNodeRef, type MusicPlayer } from "./musicSystem";
import { createPlaylistState, type PlaylistCursor } from "./playlist";
import { nextIndex } from "./playlistOrder";
import { setAudibleStems } from "./stems";
import { startPositions } from "./startPosition";

const playerOfHandle = (music: MusicHandle): MusicPlayer | null => musicPlayers().find((p) => p.handle === music) ?? null;

/**
 * Only the stems named in `audible` of segment `segment` sound; null: every stem does. Fades over `fadeSeconds`. Returns
 * false when `music` is not a playing music handle. A segment stamped later takes the set at once.
 */
export function auditionStems(music: MusicHandle, segment: string, audible: readonly string[] | null, fadeSeconds = 0.02): boolean {
  const player = playerOfHandle(music);
  if (!player) return false;
  setAudibleStems(player, audible, audible === null ? null : segment, fadeSeconds);
  return true;
}

interface Step { readonly node: MusicNodeRef; readonly index: number }

/** The playlists from `node` down to the segment `id`, with the item index taken in each; null when it isn't under a playlist chain. */
function pathTo(node: MusicNodeRef, id: string): Step[] | null {
  if (node.id === id) return [];
  if (node.type !== "playlist") return null;
  const children = (node as unknown as { children?: MusicNodeRef[] }).children ?? [];
  for (let i = 0; i < children.length; i++) {
    const rest = pathTo(children[i]!, id);
    if (rest) return [{ node, index: i }, ...rest];
  }
  return null;
}

/** Most draws taken looking for an item in a random order. */
const MAX_DRAWS = 4096;

/**
 * Start the playlist at segment `segmentId` (found at any depth of playlists): the cursors are set to the state just
 * before that item, so the first plan starts it and the playlist goes on from there by its own rules. Must be called
 * before the music's first plan tick (right after `Audio.play`). True when the segment is the one that will start;
 * false when it isn't under the root's playlists (a switch's child, say), the music already started, or a random order
 * never draws it. The playlist's order for the items passed over is consumed, as if they had played.
 */
export function startAtSegment(music: MusicHandle, segmentId: string): boolean {
  const player = playerOfHandle(music);
  if (!player || player.run || player.planned) return false;
  const path = pathTo(player.root, segmentId);
  if (!path) return false;
  if (path.length === 0) return true;
  const state = player.playlist;
  if (!state || state.current !== null || state.cursors.length !== 1) return false;

  const cursors: PlaylistCursor[] = [];
  let cursor = state.cursors[0]!;
  for (let level = 0; level < path.length; level++) {
    const target = path[level]!.index;
    const last = level === path.length - 1;
    let found: PlaylistCursor | null = null;
    for (let draws = 0; draws < MAX_DRAWS && !found; draws++) {
      const before = structuredClone(cursor.order);
      const idx = nextIndex(cursor.order);
      if (idx < 0) return false;
      if (idx !== target) continue;
      // The last level stays one draw short, so the planner's advance lands on the item; the others are committed to it.
      found = last ? { ...cursor, order: before } : { ...cursor, item: idx, plays: cursor.order.playsLeft, rounds: cursor.order.round, entered: cursor.entered + 1 };
    }
    if (!found) return false;
    cursors.push(found);
    if (!last) {
      const nested = createPlaylistState(path[level + 1]!.node, cursor.seed + found.entered);
      if (!nested) return false;
      cursor = nested.cursors[0]!;
    }
  }
  state.cursors.splice(0, state.cursors.length, ...cursors);
  state.peek = null;
  return true;
}

/**
 * F-41: start the music at `position` (`"bar:beat:tick"`) of its first segment instead of at the file's start: the first
 * plan starts the group there, so there is no start followed by a seek. Call it right after `Audio.play` (and
 * `startAtSegment`), before the first plan tick. False when the music already started or isn't a music handle.
 */
export function startAtPosition(music: MusicHandle, position: string): boolean {
  const player = playerOfHandle(music);
  if (!player || player.run || player.planned) return false;
  startPositions.set(player, position);
  return true;
}
