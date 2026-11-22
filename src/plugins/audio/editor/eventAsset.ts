// The retired audio event asset (`*.audioevent.json`, ADR 0158 §1, replaced by playlists, ADR 0329): the editor lists an
// old file as "old format: migrate" and keeps its clips counted as used (ADR 0148), so deleting a clip an unmigrated event
// still names warns. Nothing reads it to play or edit; the parse is the migration's (`engine/audio/migrate/legacy/`).
import type { AssetReferences } from "../../../editor/sdk";
import { eventClips, parseAudioEvent } from "../../../engine/audio/migrate/legacy/eventFormat";

/**
 * The kind's `references` (ADR 0148): for the text of an `*.audioevent.json`, the clip paths it names (every clip path of
 * the parsed event, once each, in tree order, sustain slots included and empty paths left out; invalid JSON names
 * nothing). No `rewrite`: an event is JSON, so a move rewrites its clip paths like any JSON file's reference strings
 * (ADR 0302, 0314).
 */
export const audioEventReferences: AssetReferences = {
  read: (_path, text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return eventClips(parseAudioEvent(parsed).value);
  },
};
