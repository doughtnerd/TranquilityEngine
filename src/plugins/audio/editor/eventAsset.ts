// The `audioEvent` asset format and its reference handling (ADR 0158 §1, ADR 0148): reading and writing
// `*.audioevent.json` through the editor's asset documents, listing the clips an event names, and rewriting them when
// files move. The parser itself is the engine's (`engine/audio/eventFormat.ts`).
import type { AssetFormatContribution, AssetReferenceExtractor } from "../../../editor/sdk";
import type { AudioEventAsset } from "../../../engine/audio/eventFormat";

/**
 * The format registered with `registerAssetFormat` (id `"audioEvent"`): `parse` is `parseAudioEvent` (its problem
 * strings become `{ message }`; it never throws, `raw` undefined reads as an empty event), `format` is
 * `formatAudioEvent`.
 */
export const audioEventFormat: AssetFormatContribution<AudioEventAsset> = {
  id: "audioEvent",
  parse: (_raw, _path) => {
    throw new Error("not implemented"); // L6.2b
  },
  format: (_value) => {
    throw new Error("not implemented"); // L6.2b
  },
};

/**
 * Every clip path the event names, once each, in tree order, from any node at any depth including a `sustain` node's
 * `start`, `loop` and `end` slots. Paths as stored (no `asset:` prefix); empty paths are left out.
 */
export function eventClipPaths(_event: AudioEventAsset): string[] {
  throw new Error("not implemented"); // L6.2b
}

/**
 * A copy of `event` with every `clip` path found in `moves` (old path to new path, exact match) replaced; everything
 * else is shared or copied unchanged. The input is not modified. Used when files are renamed or moved (ADR 0148).
 */
export function renameEventClips(_event: AudioEventAsset, _moves: ReadonlyMap<string, string>): AudioEventAsset {
  throw new Error("not implemented"); // L6.2b
}

/**
 * The kind's `references` extractor (ADR 0148): for the text of an `*.audioevent.json`, the clip paths it names
 * (`eventClipPaths` of the parsed text; invalid JSON names nothing).
 */
export const audioEventReferences: AssetReferenceExtractor = {
  read: (_path, _text) => {
    throw new Error("not implemented"); // L6.2b
  },
};
