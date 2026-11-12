/**
 * The pure playlist order (api-and-models §2.3 `playlist`). Leaf **L-P4a** un-skips these cases and fills
 * `createOrder`, `nextIndex`, `peekIndex`. Every case is seeded; "drain" means calling `nextIndex` until it returns -1
 * (use finite `rounds`) or a fixed number of times (forever).
 */
import { describe, it } from "vitest";
// import { createOrder, nextIndex, peekIndex } from "./playlistOrder";

describe("playlistOrder: sequence", () => {
  it.skip("L-P4a: sequence visits items 0..n-1 in order, then ends (-1) after `rounds` 1", () => {});
  it.skip("L-P4a: sequence with rounds 3 repeats the whole list three times, then -1 forever", () => {});
  it.skip("L-P4a: rounds 0 or absent means forever (1,000 calls never return -1)", () => {});
  it.skip("L-P4a: an empty item list returns -1 at once", () => {});
});

describe("playlistOrder: plays", () => {
  it.skip("L-P4a: an item with plays 3 is returned three times in a row before the next item", () => {});
  it.skip("L-P4a: plays default 1; plays counts toward a round (round ends after the last item's last play)", () => {});
  it.skip("L-P4a: in random mode a picked item's plays are all played before the next pick", () => {});
});

describe("playlistOrder: random", () => {
  it.skip("L-P4a: random picks are weighted (weights 1:9 over 5,000 picks land within 3% of 10% / 90%)", () => {});
  it.skip("L-P4a: avoidRepeat 1 never returns the same item twice in a row (plays aside)", () => {});
  it.skip("L-P4a: avoidRepeat n never repeats any of the last n picks; clamped to items - 1", () => {});
  it.skip("L-P4a: one item with avoidRepeat 3 still plays (the clamp leaves 0)", () => {});
  it.skip("L-P4a: random with rounds 2 over n items ends after 2n picks (a round is n picks)", () => {});
});

describe("playlistOrder: shuffle", () => {
  it.skip("L-P4a: each round of a shuffle is a permutation: every item exactly once", () => {});
  it.skip("L-P4a: avoidRepeat n keeps the first n items of a new round off the last n of the previous round (where items allow)", () => {});
  it.skip("L-P4a: shuffle with plays repeats each item's plays in a row inside the bag", () => {});
  it.skip("L-P4a: shuffle with rounds 2 ends after two bags", () => {});
});

describe("playlistOrder: determinism and peek", () => {
  it.skip("L-P4a: the same seed and items give the same sequence; different seeds differ (random and shuffle)", () => {});
  it.skip("L-P4a: peekIndex equals the next nextIndex and does not advance (call it 3 times, then nextIndex)", () => {});
  it.skip("L-P4a: peekIndex agrees with nextIndex at every step across a whole run, including bag refills and round ends", () => {});
  it.skip("L-P4a: peekIndex at the end of the list is -1 and leaves the state unchanged", () => {});
});
