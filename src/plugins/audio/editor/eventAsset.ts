// The `audioEvent` asset format and its reference handling (ADR 0158 §1, ADR 0148): reading and writing
// `*.audioevent.json` through the editor's asset documents, and listing the clips an event names. The parser itself is the engine's (`engine/audio/eventFormat.ts`).
import type { AssetFormat, AssetReferences } from "../../../editor/sdk";
import {
  emptyAudioEvent,
  eventClips,
  formatAudioEvent,
  parseAudioEvent,
  type AudioEventAsset,
} from "../../../engine/audio/eventFormat";

/**
 * The `audioEvent` kind's format (ADR 0233): `parse` is `parseAudioEvent` (its problem strings become `{ message }`;
 * it never throws, `raw` undefined reads as an empty event), `format` is `formatAudioEvent`, and a new event is
 * `emptyAudioEvent()` (a layer with no children, which plays nothing) to fill in the Event editor.
 */
export const audioEventFormat: AssetFormat<AudioEventAsset> = {
  parse: (raw, _path) => {
    const read = parseAudioEvent(raw);
    return { value: read.value, problems: read.problems.map((message) => ({ message })) };
  },
  format: (value) => formatAudioEvent(value),
  empty: emptyAudioEvent,
};

/**
 * The kind's `references` (ADR 0148): for the text of an `*.audioevent.json`, the clip paths it names
 * (every clip path of the parsed event, once each, in tree order, sustain slots included and empty paths left out;
 * invalid JSON names nothing). No `rewrite`: an event is JSON, so a move rewrites its clip paths through its asset
 * document like any JSON file's reference strings (ADR 0302, 0314).
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
