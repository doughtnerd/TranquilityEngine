/**
 * `handle.music` and the `Audio` clock members of ADR 0166 (api-and-models §1.2, §1.3; architecture §4.5).
 *
 * Owners: **Q2** (skeleton); **P7** (W5) fills the M4a members: the per-frame snapshot behind the getters, `nextGrid`,
 * `audioHorizon` and `audioTimeAt`; **K3** (W8) fills `positionAt` and `judgedOffset`. `seek` delegates to
 * `music/seek.ts` (R7), `handle.trigger` to `music/stingers.ts` (R5), `handle.onMusic` to `musicSystem.ts` (K5).
 *
 * `handle.music` is `undefined`, never an empty object, for a non-music event (`musicHandleOf`). The getters share one
 * snapshot per display frame, recomputed on first read, with no allocation after it; none of them calls the core.
 */
import type { GridPoint, GridSpec, MusicHandle, MusicPositionAt, MusicSeekResult } from "../../../../engine/audio/musicTypes";
import { audioBackend } from "../backend";
import { getCalibration } from "./calibration";
import { playerOf, type MusicPlayer } from "./musicSystem";
import { seekMusic } from "./seek";

/** The public `handle.music` over one player. One object per instance, made with the player. */
class PlayerMusicHandle implements MusicHandle {
  constructor(private readonly player: MusicPlayer) {}

  // STUB(P7): the getters read a per-frame snapshot of the player (segment run, anchor, grid); until then, the state of
  // music that has not started.
  get segment(): string | null { return null; }
  get bar(): number { return 1; }
  get beat(): number { return 1; }
  get beatFraction(): number { return 0; }
  get tempo(): number { return 0; }
  get beatsPerBar(): number { return 0; }
  get beatUnit(): number { return 0; }
  get time(): number { return audioBackend().time; }
  get transition(): { to: string; time: number } | null { return null; }

  nextGrid(spec: GridSpec): GridPoint | null {
    return nextGrid(this.player, spec);
  }

  positionAt(performanceTime: number): MusicPositionAt {
    return positionAt(this.player, performanceTime);
  }

  seek(to: string): MusicSeekResult {
    return seekMusic(this.player, to);
  }
}

/** `createMusicPlayer` (musicSystem.ts) makes the player's handle here. */
export function createMusicHandle(player: MusicPlayer): MusicHandle {
  return new PlayerMusicHandle(player);
}

/** `handle.music` (`Audio.ts`): the instance's music handle, or undefined when it isn't (or is no longer) music. */
export function musicHandleOf(instance: object): MusicHandle | undefined {
  return playerOf(instance)?.handle;
}

/**
 * P7: the next grid point of `spec` after this frame's `Audio.time`; for a pending change the points after
 * `transition.time` are the incoming segment's. Null when not playing.
 */
export function nextGrid(player: MusicPlayer, spec: GridSpec): GridPoint | null {
  void player;
  void spec;
  return null; // STUB(P7)
}

/**
 * K3: map an input timestamp (`performance.now()` ms, as `event.timeStamp`) to the music: `Audio.timeAt` of it, then the
 * segment, bar, beat and nearest beat at that heard time; `offset` is signed (positive: late), `judged` is
 * `judgedOffset(offset)`. `segment` null when the music is not playing at that instant.
 */
export function positionAt(player: MusicPlayer, performanceTime: number): MusicPositionAt {
  void player;
  void performanceTime;
  return { segment: null, bar: 0, beat: 0, beatFraction: 0, nearestBeatTime: 0, offset: 0, judged: 0 }; // STUB(K3)
}

/** K3: `MusicPositionAt.judged`: the raw offset less `Audio.calibration` (R18: calibration is applied only here). */
export function judgedOffset(offset: number): number {
  return offset - getCalibration(); // STUB(K3): verify and test
}

/**
 * P7: `Audio.horizon`: the earliest heard time a stamped start is exact for a decoded clip (now + lookahead). A backend
 * without `horizon` (the Babylon fallback): `Audio.time`.
 */
export function audioHorizon(): number {
  const b = audioBackend();
  return b.horizon?.() ?? b.time; // Q2 delegation; P7 owns and tests it
}

/**
 * P7: `Audio.timeAt(performanceTime)`: the raw heard time of a `performance.now()` instant (ms); calibration is never
 * applied (R18). `Audio.time` before the clock has an estimate, and on a backend without a heard clock.
 */
export function audioTimeAt(performanceTime: number): number {
  const b = audioBackend();
  return b.timeAt?.(performanceTime) ?? b.time; // Q2 delegation; P7 owns and tests it
}
