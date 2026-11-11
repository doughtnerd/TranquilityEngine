/**
 * A playlist's item order, pure and seeded (ADR 0166 api-and-models §2.3 `playlist`; Wwise's playlist modes).
 *
 * Owner: **P4**'s leaf **L-P4a** (W5). Q2 wrote the skeleton. No engine state: a seed in, indices out, so the order is
 * testable on its own and repeatable per instance.
 *
 * Modes: `sequence` (in order), `random` (independent picks by weight, `avoidRepeat` the last n), `shuffle` (a bag:
 * every item once per round, `avoidRepeat` across a round's seam). `plays` repeats an item; `rounds` (0: forever) ends
 * the list.
 */

/** The playlist modes (§2.3). */
export type PlaylistMode = "sequence" | "random" | "shuffle";

/** One item as the order sees it. */
export interface PlaylistOrderItem {
  /** Relative weight for `random` (default 1, > 0). */
  readonly weight?: number;
  /** Times the item plays in a row when picked (default 1). */
  readonly plays?: number;
}

/** What `createOrder` takes. */
export interface PlaylistOrderOptions {
  readonly mode: PlaylistMode;
  /** `random` and `shuffle`: don't repeat any of the last n items (clamped to items - 1). Default 0. */
  readonly avoidRepeat?: number;
  /** Rounds before the list ends; 0 or absent: forever. */
  readonly rounds?: number;
  /** The seed (per instance, `worldSeed`-mixed by the caller). */
  readonly seed: number;
}

/** An order's state (opaque to callers). L-P4a may add fields here. */
export interface PlaylistOrder {
  readonly items: readonly PlaylistOrderItem[];
  readonly options: PlaylistOrderOptions;
  /** The generator's state. */
  rng: number;
  /** Rounds completed. */
  round: number;
  /** Plays left of the current item. */
  playsLeft: number;
  /** The current item, -1 before the first. */
  current: number;
  /** `shuffle`: the round's remaining bag; `random`: the recent picks. */
  readonly memory: number[];
}

/** L-P4a: a new order over `items`. */
export function createOrder(items: readonly PlaylistOrderItem[], options: PlaylistOrderOptions): PlaylistOrder {
  return { items, options, rng: options.seed >>> 0, round: 0, playsLeft: 0, current: -1, memory: [] }; // STUB(L-P4a): mode setup
}

/** L-P4a: the next item index (advancing the state), or -1 when the list has ended (`rounds` done, or no items). */
export function nextIndex(order: PlaylistOrder): number {
  void order;
  return -1; // STUB(L-P4a)
}

/** L-P4a: the index `nextIndex` would return, without advancing (for priming the next item). */
export function peekIndex(order: PlaylistOrder): number {
  void order;
  return -1; // STUB(L-P4a)
}
