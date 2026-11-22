/**
 * ADR 0320: the voices a music player keeps sounding, in one walk.
 *
 * The event instance (`events/eventRuntime.ts`) reads its music's voices through this module only: its getters (`panner`,
 * `occlusion`, `reason`, `hasVoices`, `voiceCount`, `playing`) and controls (`fade`, `pause`, `resume`) walk the list
 * `soundingMusicVoices` appends, beside its own 0158 voices. The music decides what sounds (ADR 0248's one-way seam);
 * each sub-state's owner contributes its own voices: the playing and successor runs' stems here, stingers
 * (`stingers.ts` `stingerVoices`, R5), loop tails and ringing outgoing runs (`loopTail.ts` `loopTailVoices`, R4a). A new
 * kind of music voice is added here once, and every instance read and control sees it.
 */
import type { AudioVoice } from "../backend";
import type { MusicPlayer } from "./musicSystem";
import { musicPending } from "./musicPlayer";
import { stingersQueued, stingerVoices } from "./stingers";
import { loopTailVoices } from "./loopTail";
import type { SegmentRun } from "./segmentRun";

function stemVoices(run: SegmentRun | null, out: AudioVoice[]): void {
  if (run) for (const s of run.stems) if (s.voice) out.push(s.voice);
}

/** Appends every voice the player keeps sounding (stems of its run and successor in track order, stingers, tails) to `out`. */
export function soundingMusicVoices(player: MusicPlayer, out: AudioVoice[]): void {
  stemVoices(player.run, out);
  stemVoices(player.next, out);
  stingerVoices(player, out);
  loopTailVoices(player, out);
}

/**
 * Whether the music still sounds or is about to, given its sounding voices (`voices`, as `soundingMusicVoices` wrote
 * them): before its first group, while a group primes or a transition is pending (`musicPending`), while a stinger waits
 * for its point, or while any of its voices plays. A refused or stopped player is over.
 */
export function musicSounds(player: MusicPlayer, voices: readonly AudioVoice[]): boolean {
  if (musicPending(player)) return true;
  if (player.state === "stopped" || player.state === "refused") return false;
  if (stingersQueued(player)) return true;
  for (const v of voices) if (v.playing) return true;
  return false;
}
