/**
 * The options of `Audio.play` (ADR 0343; first named by ADR 0158 §5, hence `EventOptions`): what a script, an
 * `AudioSource` or the Studio passes when it plays a playlist or a sample.
 */
import type { Curve } from "../../../../engine/core/curve";
import type { Vec3Like } from "../../../../engine/core/math";
import { warnOnce } from "../core/handle";

/** Options for `Audio.play`. */
export interface EventOptions {
  /** Linear gain multiplier, default 1. */
  volume?: number;
  /** Pitch ratio multiplier, default 1. */
  pitch?: number;
  /** Play at this world point (a spatial playlist; flat ones ignore it). */
  position?: Vec3Like;
  /** Override the playlist's bus. */
  bus?: string;
  /** Override the playlist's priority, 0..255. */
  priority?: number;
  /** Start at this audio-clock time (seconds, `Audio.time`'s base). */
  at?: number;
  /**
   * Start as if this many seconds had already played (ADR 0343, 0348: audition from a point, seek): a sequence starts
   * its playhead there; the samples a playlist starts with begin that far into their sound (a looping one wraps). Later
   * starts (a queue's next entry, a stinger) are unaffected. 0 or omitted: from the start; negative or non-finite:
   * ignored with one warning.
   */
  offset?: number;
  /** Initial values of the playlist's local parameters (labelled ones by label). */
  parameters?: Record<string, number | string>;
  /**
   * ADR 0162 §1.2 (D4): the playing `AudioSource`'s options, for a spatial playlist. The playlist's own `spatial` keys
   * win; these apply where it sets none. A flat playlist ignores them. Callers clamp.
   */
  occlusion?: boolean;
  dopplerLevel?: number;
  reverbSend?: number;
  reverbSendCurve?: Curve;
  /**
   * ADR 0347: distance overrides for a spatial playlist, metres. Its attenuation curves stretch from their own distances
   * to these (`stretchAttenuation`); either omitted keeps the attenuation's own. `AudioSource.minDistance`/`maxDistance`
   * reach the playlist this way. Flat playlists ignore them.
   */
  minDistance?: number;
  maxDistance?: number;
  /**
   * ADR 0354 §5: the line key a programmer line entry (`{ "line": null }`) plays (FMOD's programmer instrument); a
   * playlist without one ignores it. A line table's template playlist gets each line's key this way.
   */
  line?: string;
}

/** `EventOptions.offset` (and `OneShotOptions.offset`) checked: seconds ≥ 0, else 0 with one warning naming `where`. */
export function startOffsetOf(offset: unknown, where: string): number {
  if (offset === undefined) return 0;
  if (typeof offset === "number" && Number.isFinite(offset) && offset >= 0) return offset;
  warnOnce(`${where}:offset`, `${where}: offset must be a finite number of seconds, 0 or more; starting from the beginning.`);
  return 0;
}
