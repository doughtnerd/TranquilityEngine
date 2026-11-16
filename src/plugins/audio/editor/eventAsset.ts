// The `audioEvent` asset format and its reference handling (ADR 0158 §1, ADR 0148): reading and writing
// `*.audioevent.json` through the editor's asset documents, and listing the clips an event names. The parser itself is the engine's (`engine/audio/eventFormat.ts`).
import type { AssetFormatContribution, AssetReferenceExtractor } from "../../../editor/sdk";
import {
  eventClips,
  formatAudioEvent,
  parseAudioEvent,
  type AudioEventAsset,
} from "../../../engine/audio/eventFormat";

/**
 * The format registered with `registerAssetFormat` (id `"audioEvent"`): `parse` is `parseAudioEvent` (its problem
 * strings become `{ message }`; it never throws, `raw` undefined reads as an empty event), `format` is
 * `formatAudioEvent`.
 */
export const audioEventFormat: AssetFormatContribution<AudioEventAsset> = {
  id: "audioEvent",
  parse: (raw, _path) => {
    const read = parseAudioEvent(raw);
    return { value: read.value, problems: read.problems.map((message) => ({ message })) };
  },
  format: (value) => formatAudioEvent(value),
};

/**
 * The kind's `references` extractor (ADR 0148): for the text of an `*.audioevent.json`, the clip paths it names
 * (every clip path of the parsed event, once each, in tree order, sustain slots included and empty paths left out;
 * invalid JSON names nothing).
 */
export const audioEventReferences: AssetReferenceExtractor = {
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
