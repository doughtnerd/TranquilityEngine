/**
 * Queue picks (ADR 0329 "Picks are made once per trigger"; the prototype's PL:877–881): which entry a Queue plays.
 *
 * - **Random:** a weighted draw that excludes the last `min(avoidRepeat, n − 1)` picks. Weight 0 (or below) means never;
 *   when avoid-repeat leaves only weight-0 entries the ban gives way, and with no positive weight nothing plays.
 * - **Shuffle:** draws from a deck that is reshuffled (Fisher–Yates) when empty; the first card of a new deck is never
 *   the last card of the old one when there is a choice.
 * - **Round robin:** the next entry, wrapping.
 *
 * The state is the caller's (the runtime keeps one per playlist per World, so picks persist across triggers); `rng`
 * gives numbers in [0, 1) (the World's seeded generator).
 *
 * Pure; no plugin, no DOM.
 */
import type { QueueSettings } from "./types";

/** One Queue's pick state. */
export interface PickState {
  /** The latest picks, newest last (at most `PICK_HISTORY`). */
  history: number[];
  /** Shuffle: the cards left in the deck, drawn from the end. */
  deck: number[];
  /** Round robin: the last index played (-1 before the first). */
  last: number;
}

/** How many picks a state remembers (avoid-repeat reaches back at most 5). */
export const PICK_HISTORY = 8;

export const newPickState = (): PickState => ({ history: [], deck: [], last: -1 });

/** The next entry index of a Queue of `weights.length` entries (−1 for none), updating `state` (a −1 is not remembered). */
export function pickEntry(q: Pick<QueueSettings, "pick" | "avoidRepeat">, weights: readonly number[], state: PickState, rng: () => number): number {
  const n = weights.length;
  if (n === 0) return -1;
  let i: number;
  switch (q.pick) {
    case "roundRobin": i = (state.last + 1) % n; break;
    case "shuffle": i = drawShuffle(n, state, rng); break;
    default: i = pickRandom(weights, state.history, q.avoidRepeat, rng); break;
  }
  if (i < 0) return i;
  state.last = i;
  state.history.push(i);
  if (state.history.length > PICK_HISTORY) state.history.splice(0, state.history.length - PICK_HISTORY);
  return i;
}

/** A weighted random index excluding the last `min(avoid, n − 1)` entries of `history`. */
export function pickRandom(weights: readonly number[], history: readonly number[], avoid: number, rng: () => number): number {
  const n = weights.length;
  if (n === 0) return -1;
  if (n === 1) return weights[0]! > 0 ? 0 : -1;
  const ban = Math.max(0, Math.min(Math.floor(avoid), n - 1));
  const banned = new Set(history.slice(history.length - ban));
  if (ban === 0) banned.clear();
  let total = 0;
  for (let i = 0; i < n; i++) if (!banned.has(i)) total += Math.max(0, weights[i]!);
  if (total <= 0) {
    // Weight 0 means never. When avoid-repeat banned every entry that may play, the ban gives way (a Queue never goes
    // silent because of it); with no positive weight at all nothing plays.
    if (banned.size === 0 || !weights.some((w) => w > 0)) return -1;
    return pickRandom(weights, history, 0, rng);
  }
  let r = rng() * total;
  let lastAllowed = -1;
  for (let i = 0; i < n; i++) {
    if (banned.has(i)) continue;
    const w = Math.max(0, weights[i]!);
    if (w <= 0) continue;
    lastAllowed = i;
    r -= w;
    if (r < 0) return i;
  }
  return lastAllowed;
}

/** The next card of a shuffled deck of `n`, reshuffling when it is empty (or when `n` changed). */
export function drawShuffle(n: number, state: PickState, rng: () => number): number {
  if (state.deck.length === 0 || state.deck.some((c) => c >= n)) {
    const deck = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    // Drawn from the end: keep the old deck's last card off the new deck's first draw.
    if (n > 1 && deck[n - 1] === state.history.at(-1)) [deck[n - 1], deck[0]] = [deck[0]!, deck[n - 1]!];
    state.deck = deck;
  }
  return state.deck.pop()!;
}
