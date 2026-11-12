/**
 * The beat clock, design A (ADR 0166 api-and-models §1.1 `MusicEvent`, §1.4; architecture §4.5).
 *
 * Owner: **K1** (W8); K4 tests it on the spike's jitter traces. Q2 wrote the skeleton. K2 dispatches what it predicts
 * (`musicSystem.ts` `dispatchMusic`).
 *
 * Per instance and active pass: the anchor (`anchors.ts`), the tempo map's prefix sums and a per-kind index of the last
 * event fired. Each dispatch fires the events with heard time < `Audio.time` + Δ̄ past the last fired index; a kind with
 * more than one due fires once, for the latest, with `missed: n` (cues add `skippedCues`). Corrections from
 * `groupStarts` and playheads shift t0; indices never re-fire, so nothing doubles or skips.
 */
import type { MusicEvent, MusicKind } from "../../../../engine/audio/musicTypes";
import type { MusicPlayer } from "./musicSystem";

/** One kind's cursor. */
export interface BeatCursor {
  /** Index of the last event of this kind fired (beats or bars since the anchor; cues by order), -1 before any. */
  last: number;
}

/** The player's beat prediction state. K1 may add fields here. */
export interface BeatState {
  readonly beat: BeatCursor;
  readonly bar: BeatCursor;
  readonly cue: BeatCursor;
  /** Rhythm mode (Rh1): callbacks held during a recovery. */
  held: boolean;
}

/** K1: a fresh beat state (nothing fired yet). */
export function createBeatState(): BeatState {
  return { beat: { last: -1 }, bar: { last: -1 }, cue: { last: -1 }, held: false };
}

/**
 * K1: the due event of `kind` for this dispatch (heard time < `now` + `frameIntervalSeconds`, past the cursor), written
 * into `out` with `missed` and `skippedCues` filled, and the cursor advanced. False when none is due.
 */
export function predictDue(player: MusicPlayer, kind: MusicKind, now: number, frameIntervalSeconds: number, out: MusicEvent): boolean {
  void player;
  void kind;
  void now;
  void frameIntervalSeconds;
  void out;
  return false; // STUB(K1)
}

/** K1: re-seat the cursors after a seek, a transition or a recovery so the next dispatch neither doubles nor skips. */
export function resyncBeats(player: MusicPlayer, now: number): void {
  void player;
  void now;
  // STUB(K1)
}
