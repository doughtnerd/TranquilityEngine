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

/** An order's state (opaque to callers). */
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
  /** `random`: the picks made in the current round. */
  picks: number;
  /** `shuffle`: the last picks of the bag, kept for the next round's seam (at most the clamped `avoidRepeat`). */
  readonly last: number[];
}

/** The mulberry32 increment (its state advances by this each step). */
const MULBERRY_STEP = 0x6d2b79f5;

/** The next value in [0, 1) from mulberry32, advancing `order.rng` in place. */
function nextRandom(order: PlaylistOrder): number {
  order.rng = (order.rng + MULBERRY_STEP) >>> 0;
  let t = order.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The clamped `avoidRepeat`: 0 to items - 1. */
function avoidLimit(order: PlaylistOrder): number {
  const avoid = Math.floor(order.options.avoidRepeat ?? 0);
  return Math.max(0, Math.min(avoid, order.items.length - 1));
}

/** True once the list has no items or its `rounds` are done. Permanent: the round count never falls. */
function isEnded(order: PlaylistOrder): boolean {
  const rounds = order.options.rounds ?? 0;
  return order.items.length === 0 || (rounds > 0 && order.round >= rounds);
}

/** An item's plays per pick (at least 1). */
function playsOf(order: PlaylistOrder, index: number): number {
  return Math.max(1, order.items[index].plays ?? 1);
}

/** `random`: one weighted pick, excluding the recent picks in `memory`. Always leaves at least one candidate. */
function pickWeighted(order: PlaylistOrder): number {
  const recent = order.memory;
  const weightOf = (i: number): number => order.items[i].weight ?? 1;
  let total = 0;
  for (let i = 0; i < order.items.length; i++) {
    if (!recent.includes(i)) total += weightOf(i);
  }
  const target = nextRandom(order) * total;
  let acc = 0;
  let fallback = -1;
  for (let i = 0; i < order.items.length; i++) {
    if (recent.includes(i)) continue;
    acc += weightOf(i);
    fallback = i;
    if (target < acc) return i;
  }
  return fallback;
}

/**
 * `shuffle`: a new bag, a Fisher-Yates permutation of every item. The first `min(avoid, n - avoid)` items are moved off
 * the previous bag's last `avoid` picks, where the item count allows.
 */
function fillBag(order: PlaylistOrder): void {
  const n = order.items.length;
  const bag: number[] = [];
  for (let i = 0; i < n; i++) bag.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(order) * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const k = avoidLimit(order);
  const m = Math.min(k, n - k);
  for (let p = 0; p < m; p++) {
    if (!order.last.includes(bag[p])) continue;
    let q = p + 1;
    while (order.last.includes(bag[q])) q++;
    [bag[p], bag[q]] = [bag[q], bag[p]];
  }
  order.memory.length = 0;
  order.memory.push(...bag);
}

/** Advance the order by one call. Mutates `order`; `peekIndex` runs it on a copy. */
function step(order: PlaylistOrder): number {
  const n = order.items.length;
  if (isEnded(order)) return -1;
  if (order.playsLeft > 0) {
    order.playsLeft--;
    return order.current;
  }
  const k = avoidLimit(order);
  let idx: number;
  switch (order.options.mode) {
    case "sequence": {
      if (order.current === n - 1) {
        order.round++;
        if (isEnded(order)) return -1;
      }
      idx = (order.current + 1) % n;
      break;
    }
    case "random": {
      if (order.picks === n) {
        order.round++;
        order.picks = 0;
        if (isEnded(order)) return -1;
      }
      idx = pickWeighted(order);
      order.picks++;
      if (k > 0) {
        order.memory.push(idx);
        if (order.memory.length > k) order.memory.shift();
      }
      break;
    }
    case "shuffle": {
      if (order.memory.length === 0) {
        if (order.current !== -1) {
          order.round++;
          if (isEnded(order)) return -1;
        }
        fillBag(order);
      }
      idx = order.memory.shift() as number;
      if (k > 0) {
        order.last.push(idx);
        if (order.last.length > k) order.last.shift();
      }
      break;
    }
  }
  order.current = idx;
  order.playsLeft = playsOf(order, idx) - 1;
  return idx;
}

/** A new order over `items`. */
export function createOrder(items: readonly PlaylistOrderItem[], options: PlaylistOrderOptions): PlaylistOrder {
  return {
    items,
    options,
    rng: options.seed >>> 0,
    round: 0,
    playsLeft: 0,
    current: -1,
    memory: [],
    picks: 0,
    last: [],
  };
}

/** The next item index (advancing the state), or -1 when the list has ended (`rounds` done, or no items). */
export function nextIndex(order: PlaylistOrder): number {
  return step(order);
}

/** The index `nextIndex` would return, without advancing (for priming the next item). */
export function peekIndex(order: PlaylistOrder): number {
  return step({ ...order, memory: [...order.memory], last: [...order.last] });
}
