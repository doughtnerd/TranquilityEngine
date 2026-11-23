// A playlist's sound caption (ADR 0357 §4, §6): `caption { key, minGap }`, a string key in the captions table and the
// seconds within which the same caption isn't repeated. The Playlists inspector's Caption field edits it, refused or
// next (0313). Pure.
import { PLAYLIST_LIMITS } from "../../../engine/audio/playlist/format";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { isStringKey } from "../../../engine/localisation/strings/format";
import type { EditResult } from "../../../editor/sdk/editResult";

/** Set the caption (an empty key removes it); `minGap` keeps its value when not given. */
export function setCaption(b: PlaylistBody, key: string, minGap?: number): EditResult<PlaylistBody> {
  const k = key.trim();
  if (k === "") {
    if (!b.caption) return { next: b };
    const { caption: _gone, ...rest } = b;
    return { next: rest };
  }
  if (!isStringKey(k)) return { refused: `"${k}" isn't a string key (letters, digits, _ . -)` };
  const gap = minGap ?? b.caption?.minGap ?? 0;
  if (!(gap >= 0 && gap <= PLAYLIST_LIMITS.captionGap)) return { refused: `the gap is 0 to ${PLAYLIST_LIMITS.captionGap} seconds` };
  return { next: { ...b, caption: { key: k, minGap: gap } } };
}

/** The text a new caption key starts with in the captions table: its words in brackets (`cc.door_slams` → `[door slams]`). */
export const captionPlaceholder = (key: string): string => `[${(key.split(".").pop() ?? key).replace(/[_-]+/g, " ").trim()}]`;
