// "Create event from clips" (ADR 0158 §7): the pure half. The clip paths of the selected audio files become a new
// event, a `random` of one `clip` each (a footstep, a hit, a bark: several takes of one sound). The action in
// `editor/index.ts` writes the file (`project.createFile`, beside the first clip, named `fileName`).
import { AUDIO_EVENT_SUFFIX, type AudioEventAsset } from "../../../engine/audio/eventFormat";

export interface EventFromClips {
  /** The event's base name, without `.audioevent.json`: what the clips share ("step" for step_01.ogg, step_02.ogg), else the first clip's name, else "New Event". */
  name: string;
  /** The new event, as `parseAudioEvent` would read it back (every field present). */
  event: AudioEventAsset;
}

/**
 * An event playing one of `clips` (project paths, as given: no `asset:` prefix) per play. The root is a `random`
 * (`mode: "step"`, `avoidRepeat` 1 when there are two or more clips, else 0, `weight` 1) with one `clip` child per
 * path in the order given, duplicates dropped; each node carries every `NodeBase` default (volume 1, pitch 1, no
 * randomness, no delay, no automation, `weight` 1, `fade` 0; clips: `loop` false, `startOffset` 0, `sustain` false).
 * Event fields: the defaults of `emptyAudioEvent()`, except `limit` `{ maxInstances: 4, steal: "oldest" }` and
 * `cooldown` 0.05 as in ADR 0158 §1's example. No clips: the root is still the empty `random`.
 */
export function createEventFromClips(clips: readonly string[]): EventFromClips {
  void clips;
  void AUDIO_EVENT_SUFFIX;
  throw new Error("not implemented"); // L6.2a
}
