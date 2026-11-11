/**
 * A segment's run: its stems as one group, primed and stamped together (ADR 0166 api-and-models §3.2 `SegmentRun`,
 * `PrimeJob`, §4.6; architecture §2.2, §3.1, §4.2).
 *
 * Owner: **P1** (W3), with `core/musicOps.ts` (the backend's side). Q2 wrote the skeleton.
 *
 * A run picks each track's alternative, decides decoded or streamed per clip (the stream-or-decode rule, §2.6), takes a
 * group id from the counter over 1..1023 that skips live ids, admits the group (`MusicBackend.admitGroup`), primes it
 * (`primeGroup`, one batch per group), watches `primedState`, and stamps it at the planner's time (`stampGroup`). Every
 * voice it starts is an ordinary voice tagged with its group.
 */
import type { AudioVoice, MusicGroupEvent, MusicGroupRequest } from "../backend";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";

/** The highest music group id (§3.2: ids 1..1023). */
export const MAX_MUSIC_GROUP_ID = 1023;

/**
 * How a run resolves a stem's clip (P1). The event runtime's clip starter is private to `eventRuntime.ts`, so whoever
 * owns `AudioSource.ts` provides this (P6/P7 wire it; tests set it). `facts` feeds the stream-or-decode rule (§2.6,
 * `musicValidate.stemMode`: up to 30 s decoded, longer streamed); unknown facts fall back to the import setting `stream`.
 */
export interface SegmentClipSource {
  /** The clip's URL. */
  url(path: string): string;
  /** The clip's import settings (ADR 0040): `volume` scales the stem, `stream` is the fallback mode. */
  settings(path: string): { readonly volume: number; readonly stream: boolean };
  /** A mixer bus name for a track's `bus` or the event's (empty or unknown: Master). */
  bus(output: string | undefined): string;
  /** The clip's facts (length, rate), or undefined when not yet probed. */
  facts(path: string): MusicClipFacts | undefined;
}

const DEFAULT_CLIP_SOURCE: SegmentClipSource = {
  url: (path) => path,
  settings: () => ({ volume: 1, stream: true }),
  bus: (output) => output ?? "",
  facts: () => undefined,
};
let clipSource: SegmentClipSource = DEFAULT_CLIP_SOURCE;

/** Set how runs resolve clips; null restores the default (URL = path, streamed, no facts). */
export function setSegmentClipSource(source: SegmentClipSource | null): void {
  clipSource = source ?? DEFAULT_CLIP_SOURCE;
}

/** @internal The clip source in use. */
export function segmentClipSource(): SegmentClipSource {
  return clipSource;
}

/** One stem of a run (§3.2 `StemRun`). */
export interface StemRun {
  /** The track's name (debug rows). */
  readonly track: string;
  /** Index of the picked alternative in the track's list (0 without alternatives). */
  readonly alternative: number;
  /** The clip's asset path. */
  readonly clip: string;
  /** Streamed (a music ring) or decoded (the arena). */
  readonly streamed: boolean;
  /** The member's voice once stamped; null before, or when it couldn't start. */
  voice: AudioVoice | null;
  /** Primed in the group's current epoch (decoded members count as primed). */
  primed: boolean;
}

/** Where a run is (architecture §2.2). */
export type SegmentRunState = "new" | "admitted" | "priming" | "stamped" | "playing" | "ending" | "cancelled";

/** One segment's run (§3.2 `SegmentRun`). P1 may add fields here. */
export interface SegmentRun {
  /** The segment node. */
  readonly node: MusicNodeRef;
  /** The player the run belongs to (P1: its counters, its instance). */
  readonly player: MusicPlayer;
  state: SegmentRunState;
  /** The music group id (1..1023), 0 until admitted. */
  group: number;
  readonly stems: StemRun[];
  /** Heard time (seconds) the group is stamped to start at (entry minus pre-entry), NaN until planned. */
  startAt: number;
  /** File frame the members start at (entry - pre-entry, or a loop or seek offset). */
  startFrame: number;
  /** Loop passes completed (P3). */
  loopsDone: number;
  /** The prime job while priming, else null. */
  prime: PrimeJob | null;
}

/** A group's priming (§3.2 `PrimeJob`). */
export interface PrimeJob {
  readonly group: number;
  /** Heard time (seconds) the prime was asked for. */
  readonly requestedAt: number;
  /** `performance.now()` ms when `primeGroup` was posted (for Ê, architecture §4.2). */
  readonly postedMs: number;
  /** Members primed in the current epoch, of `of`. */
  primed: number;
  readonly of: number;
  /** `performance.now()` ms of the poll that first saw every member primed; NaN until then. */
  readyMs: number;
}

/**
 * P1: a run for `node`: picks alternatives (seeded by the instance), resolves clips and the stream-or-decode rule. Does
 * not admit, prime or start anything. Null when the node has no playable track.
 */
export function createSegmentRun(player: MusicPlayer, node: MusicNodeRef, startFrame: number): SegmentRun | null {
  void player;
  void node;
  void startFrame;
  return null; // STUB(P1)
}

/** P1: the group request of a run (one member per stem, `play` requests on the event's bus, `world`, `group`). */
export function groupRequest(player: MusicPlayer, run: SegmentRun): MusicGroupRequest {
  return { instance: player.instance.group, group: run.group, members: [] }; // STUB(P1)
}

/** P1: a free group id from the counter over 1..1023 that skips live ids; 0 when every id is live. */
export function nextGroupId(isLive: (id: number) => boolean): number {
  void isLive;
  return 0; // STUB(P1)
}

/**
 * P1: admit and prime the run's group (`admitGroup`, `primeGroup` with the instance's protected paths). False when the
 * backend refused it (the planner reads the refusal from the run's state and the counters).
 */
export function primeRun(player: MusicPlayer, run: SegmentRun, f: MusicFrame): boolean {
  void player;
  void run;
  void f;
  return false; // STUB(P1)
}

/** P1: the run's primed state from the backend's last STATUS (updates `stems[].primed` and `prime`). True when every member is primed. */
export function pollPrimed(run: SegmentRun, f: MusicFrame): boolean {
  void run;
  void f;
  return false; // STUB(P1)
}

/** P1: stamp the primed group at `at` (heard seconds), with first in-voice fades if any; the members' voices are kept. */
export function stampRun(player: MusicPlayer, run: SegmentRun, at: number, f: MusicFrame): void {
  void player;
  void run;
  void at;
  void f;
  // STUB(P1)
}

/** P1: cancel the run's group (closes its rings, STOPs members already stamped); unknown or 0 groups are ignored. */
export function cancelRun(run: SegmentRun, f: MusicFrame): void {
  void run;
  void f;
  // STUB(P1)
}

/**
 * P1: stop every stem of the player with one in-voice fade stamped at now plus the lookahead (`handle.stop(fade)`,
 * §1.2: not grid-quantised, allowed in rhythm mode; R19: no music record is asap).
 */
export function stopPlayerRuns(player: MusicPlayer, fadeSeconds: number, f: MusicFrame): void {
  void player;
  void fadeSeconds;
  void f;
  // STUB(P1)
}

/**
 * P1 (P3 applies slips to anchors): the backend's group and member events (`MusicBackend.onGroupEvent`), delivered after
 * the status mirror is read. `musicSystem.ts` binds this once per backend.
 */
export function routeGroupEvent(e: MusicGroupEvent): void {
  void e;
  // STUB(P1)
}

/** @internal Tests: forget every live run and group id, reset the id counter to 1 and the clip source to the default. */
export function _resetSegmentRuns(): void {
  clipSource = DEFAULT_CLIP_SOURCE; // P1 also clears the live-run registry here
}
