// The `audioEvent` asset format and its reference handling (ADR 0158 §1, ADR 0148): reading and writing
// `*.audioevent.json` through the editor's asset documents, listing the clips an event names, and rewriting them when
// files move. The parser itself is the engine's (`engine/audio/eventFormat.ts`).
import type { AssetFormatContribution, AssetReferenceExtractor } from "../../../editor/sdk";
import {
  eventClips,
  formatAudioEvent,
  parseAudioEvent,
  type AudioEventAsset,
  type EventNode,
  type SustainNode,
} from "../../../engine/audio/eventFormat";
import type { MusicNode, SegmentNode } from "../../../engine/audio/musicFormat";

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
 * Every clip path the event names, once each, in tree order, from any node at any depth including a `sustain` node's
 * `start`, `loop` and `end` slots. Paths as stored (no `asset:` prefix); empty paths are left out.
 */
export function eventClipPaths(event: AudioEventAsset): string[] {
  return eventClips(event);
}

/** A copy of `node` with its clip paths renamed per `moves`; nodes without a match are shared, never mutated. */
function renameNode(node: EventNode, moves: ReadonlyMap<string, string>): EventNode {
  switch (node.type) {
    case "clip": {
      const to = moves.get(node.clip);
      return to === undefined ? node : { ...node, clip: to };
    }
    case "sustain": {
      const out: SustainNode = { ...node, loop: renameNode(node.loop, moves) };
      if (node.start) out.start = renameNode(node.start, moves);
      if (node.end) out.end = renameNode(node.end, moves);
      return out;
    }
    default:
      return { ...node, children: node.children.map((child) => renameNode(child, moves)) };
  }
}

/**
 * A copy of `event` with every `clip` path found in `moves` (old path to new path, exact match) replaced; everything
 * else is shared or copied unchanged. The input is not modified. Used when files are renamed or moved (ADR 0148).
 */
export function renameEventClips(event: AudioEventAsset, moves: ReadonlyMap<string, string>): AudioEventAsset {
  const renamed: AudioEventAsset = { ...event, root: renameNode(event.root, moves) };
  // ADR 0166 (decision D6): a music event's tree is in `musicRoot`; its tracks' clips and alternatives move too.
  if (event.musicRoot) renamed.musicRoot = renameMusicNode(event.musicRoot, moves);
  return renamed;
}

const moved = (path: string, moves: ReadonlyMap<string, string>): string => moves.get(path) ?? path;

function renameMusicSegment(seg: SegmentNode, moves: ReadonlyMap<string, string>): SegmentNode {
  return { ...seg, tracks: seg.tracks.map((t) => ({ ...t, clip: moved(t.clip, moves), alternatives: t.alternatives.map((a) => moved(a, moves)) })) };
}

function renameMusicNode(node: MusicNode, moves: ReadonlyMap<string, string>): MusicNode {
  if (node.type === "segment") return renameMusicSegment(node, moves);
  return { ...node, children: node.children.map((c) => renameMusicNode(c, moves)), library: node.library.map((l) => renameMusicSegment(l, moves)) };
}

/**
 * The kind's `references` extractor (ADR 0148): for the text of an `*.audioevent.json`, the clip paths it names
 * (`eventClipPaths` of the parsed text; invalid JSON names nothing).
 */
export const audioEventReferences: AssetReferenceExtractor = {
  read: (_path, text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return eventClipPaths(parseAudioEvent(parsed).value);
  },
};
