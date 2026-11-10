// "Create event from clips" (ADR 0158 §7): the pure half. The clip paths of the selected audio files become a new
// event, a `random` of one `clip` each (a footstep, a hit, a bark: several takes of one sound). The action in
// `editor/index.ts` writes the file (`project.createFile`, beside the first clip, named `fileName`).
import { emptyAudioEvent, type AudioEventAsset, type ClipNode, type EventNode, type NodeBase, type RandomNode } from "../../../engine/audio/eventFormat";

export interface EventFromClips {
  /** The event's base name, without `.audioevent.json`: what the clips share ("step" for step_01.ogg, step_02.ogg), else the first clip's name, else "New Event". */
  name: string;
  /** The new event, as `parseAudioEvent` would read it back (every field present). */
  event: AudioEventAsset;
}

/** Every `NodeBase` default, as a fresh object (no array is shared between nodes). */
const nodeBase = (): NodeBase => ({
  volume: 1, pitch: 1, volumeRandom: [0, 0], pitchRandom: [0, 0], delay: 0, automation: [], weight: 1, fade: 0,
});

/** The file name without its folder and its extension (the last dot). The stem keeps its case. */
const stemOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** The longest common prefix of `names`, with trailing digits, spaces, "_", "-" and "." removed. */
const sharedName = (names: readonly string[]): string => {
  let prefix = names[0] ?? "";
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\d _\-.]+$/, "");
};

/** The event's name from its clips (see `EventFromClips.name`). */
const eventName = (paths: readonly string[]): string => {
  const stems = paths.map(stemOf);
  const name = stems.length === 0 ? "" : stems.length === 1 ? stems[0] : sharedName(stems);
  return name === "" ? "New Event" : name;
};

/**
 * An event playing one of `clips` (project paths, as given: no `asset:` prefix) per play. The root is a `random`
 * (`mode: "step"`, `avoidRepeat` 1 when there are two or more clips, else 0, `weight` 1) with one `clip` child per
 * path in the order given, duplicates dropped; each node carries every `NodeBase` default (volume 1, pitch 1, no
 * randomness, no delay, no automation, `weight` 1, `fade` 0; clips: `loop` false, `startOffset` 0, `sustain` false).
 * Event fields: the defaults of `emptyAudioEvent()`, except `limit` `{ maxInstances: 4, steal: "oldest" }` and
 * `cooldown` 0.05 as in ADR 0158 §1's example. No clips: the root is still the empty `random`.
 */
export function createEventFromClips(clips: readonly string[]): EventFromClips {
  const paths = [...new Set(clips)];
  const children: EventNode[] = paths.map((clip): ClipNode => ({
    ...nodeBase(), type: "clip", clip, loop: false, startOffset: 0, sustain: false,
  }));
  const root: RandomNode = {
    ...nodeBase(), type: "random", children, avoidRepeat: paths.length >= 2 ? 1 : 0, mode: "step", gap: 0,
  };
  const event: AudioEventAsset = {
    ...emptyAudioEvent(),
    limit: { maxInstances: 4, steal: "oldest" },
    cooldown: 0.05,
    root,
  };
  return { name: eventName(paths), event };
}
