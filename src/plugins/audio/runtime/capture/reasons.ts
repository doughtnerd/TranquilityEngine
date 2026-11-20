// ADR 0260 (extends 0227; api-and-models §5.6): the capture's reason codes, by the sink's words, both ways. The event sink
// (`events.ts`) writes a word as its code; the reader turns a code back into the word, for an EVENT (`readCaptureEvent`) and
// for a KEYFRAME voice row (`readCaptureKeyframe`, by the row's state); and `reasonText` is the one place a word becomes
// the text the Profiler shows. No view keeps a table of codes.
import type {
  ProfileLoudnessControl, ProfileQueuedReason, ProfileRealReason, ProfileRefusedReason, ProfileStealReason, ProfileStopReason, ProfileVirtualReason,
} from "../mix/profileSink";
import type { CaptureVoiceState } from "./keyframeLayout";

/** EVENT `reason` codes (§5.6), by the sink's reason strings. */
export const STOP_REASON: Readonly<Record<ProfileStopReason, number>> = { ended: 1, stopped: 2, faded: 3, worldReleased: 4, failed: 5 };
export const STEAL_REASON: Readonly<Record<ProfileStealReason, number>> = { busMaxVoices: 1, globalLimit: 2, priority: 3 };
export const VIRTUAL_REASON: Readonly<Record<ProfileVirtualReason, number>> = { capDemoted: 1, belowAudibility: 2, paused: 3, worldInaudible: 4 };
export const REAL_REASON: Readonly<Record<ProfileRealReason, number>> = { promoted: 1, capRaised: 2 };
export const REFUSED_REASON: Readonly<Record<ProfileRefusedReason, number>> = { busFull: 1, poolFull: 2, neverFits: 3, loadFailed: 4, capRefused: 5 };
export const QUEUED_REASON: Readonly<Record<ProfileQueuedReason, number>> = { clipLoading: 1, streamPriming: 2 };
export const LOUDNESS_CONTROL_REASON: Readonly<Record<ProfileLoudnessControl, number>> = { reset: 1, pause: 2, resume: 3, target: 4 };
/** ladder: reason 2 `shed`, 3 `restored` (1 is §5.6's bare "step", not written by this sink). */
export const LADDER_REASON = { shed: 2, restored: 3 } as const;

/** The reason a voice row (keyframe or replayed) is in its state: the steal, virtual, real or queued word. */
export type CaptureVoiceReason = ProfileStealReason | ProfileVirtualReason | ProfileRealReason | ProfileQueuedReason;
/** Every reason word a capture carries. */
export type CaptureReason = CaptureVoiceReason | ProfileStopReason | ProfileRefusedReason;

/** The word of a code in `table`, or null for 0 (no reason) and a code this build doesn't know. */
function wordOf<W extends string>(table: Readonly<Record<W, number>>): (code: number) => W | null {
  const words = new Map<number, W>(Object.entries(table).map(([w, c]) => [c as number, w as W]));
  return (code) => words.get(code) ?? null;
}

export const stopReason = wordOf(STOP_REASON);
export const stealReason = wordOf(STEAL_REASON);
export const virtualReason = wordOf(VIRTUAL_REASON);
export const realReason = wordOf(REAL_REASON);
export const refusedReason = wordOf(REFUSED_REASON);
export const queuedReason = wordOf(QUEUED_REASON);
export const loudnessControlOf = wordOf(LOUDNESS_CONTROL_REASON);

/** A KEYFRAME voice row's reason code read by its state (the row carries the code of the event that put it there). */
export function voiceRowReason(state: CaptureVoiceState, code: number): CaptureVoiceReason | null {
  switch (state) {
    case "stolen": return stealReason(code);
    case "virtual": return virtualReason(code);
    case "playing": return realReason(code);
    case "waitingForData": return queuedReason(code);
    default: return null;
  }
}

/** Words whose text is not the word itself spelt out. */
const TEXT: Partial<Record<CaptureReason, string>> = { capDemoted: "demoted by the cap" };

/** The text the Profiler shows for a reason: "bus max voices" for `busMaxVoices`; empty for none. */
export function reasonText(reason: CaptureReason | null): string {
  if (reason === null) return "";
  return TEXT[reason] ?? reason.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
}
