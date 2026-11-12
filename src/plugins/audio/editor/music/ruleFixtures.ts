// Ed7: containers the rule tests share. A music switch `s` over segments a, b, c (values "1", "2", "3"), a library with a
// bridge, and the given raw transitions; parse it through the real event reader so every default is filled.
import { parseAudioEvent, type AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";

export type Raw = Record<string, unknown>;

const VALUES: Record<string, string> = { a: "1", b: "2", c: "3" };

export function segmentRaw(id: string, extra: Raw = {}): Raw {
  return { type: "segment", id, value: VALUES[id], tracks: [{ name: "t", clip: `music/${id}.ogg` }], ...extra };
}

export function eventOf(root: Raw): AudioEventAsset {
  return parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root }).value;
}

/** The container `s` (children a, b, c; library `riser`) with `transitions`; a playlist when `type` says so. */
export function switchEvent(transitions: Raw[], over: { children?: Raw[]; library?: Raw[]; type?: string } = {}): AudioEventAsset {
  const type = over.type ?? "musicSwitch";
  return eventOf({
    type, id: "s", ...(type === "musicSwitch" ? { parameter: "state", default: "1" } : {}),
    children: over.children ?? [segmentRaw("a"), segmentRaw("b"), segmentRaw("c")],
    library: over.library ?? [segmentRaw("riser", { value: undefined })],
    transitions,
  });
}

export const containerOf = (e: AudioEventAsset): MusicContainerNode => e.musicRoot as MusicContainerNode;
