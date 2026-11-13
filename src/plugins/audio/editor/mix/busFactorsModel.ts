// The profiler's bus factors view model (design 0171 api-and-models §7; ADR 0172 §1.3): each bus's seven gain lanes at the
// cursor's keyframe, their product (the bus's own effective gain), the factors not at unity, dB for each, and the product
// up the tree. Pure: no DOM, types-only imports.
//
// The keyframe's bus row (§5.5) holds `[value, target]` for the five main-written lanes (authored, runtime, snapshot,
// monitor, dip) and one last-reported value each for the core-owned `duck` and `automation`. Those two have no target on
// the wire, so their target here equals their value.

import type { KeyframeBus, KeyframePayload } from "../../runtime/capture/format";

/** The seven lanes in wire order (`LANE_AUTHORED` 0 … `LANE_AUTOMATION` 6; `Lane` in `engine/audio/mixer.ts`). */
export const FACTOR_LANES = ["authored", "runtime", "snapshot", "monitor", "dip", "duck", "automation"] as const;
export type FactorLane = (typeof FACTOR_LANES)[number];

/** Keyframe bus flag bits (§5.5): authored mute, runtime mute, tombstone. */
const FLAG_AUTHORED_MUTE = 1 << 0;
const FLAG_RUNTIME_MUTE = 1 << 1;
const FLAG_TOMBSTONE = 1 << 4;

/** One lane's factor on one bus. */
export interface BusFactor {
  lane: FactorLane;
  /** The lane's linear gain now (0 when its mute flag is set, for `authored` and `runtime`). */
  value: number;
  /** Where the lane is heading (equals `value` for `duck` and `automation`). */
  target: number;
  /** `value` is exactly 1. */
  unity: boolean;
  /** `value` in dB: 20 log10, `-Infinity` for a value of 0 or less, never NaN. */
  db: number;
}

/** One bus's seven factors and what they multiply to. */
export interface BusFactors {
  slot: number;
  gen: number;
  /** The seven factors, in `FACTOR_LANES` order. */
  factors: readonly BusFactor[];
  /** The product of the seven values: the bus's own effective gain. */
  product: number;
  productDb: number;
  /** The lanes whose value is not 1, in lane order. */
  nonUnity: readonly FactorLane[];
  /** The slot is a tombstone (a removed bus kept silent). */
  tombstone: boolean;
}

/** Linear gain to dB: `-Infinity` for 0, negatives and NaN; never NaN. */
export function gainToDb(gain: number): number {
  if (!(gain > 0)) return -Infinity;
  return 20 * Math.log10(gain);
}

/** A dB figure for display: "-inf dB" for silence, else one decimal ("-6.0 dB"). */
export function formatDb(db: number): string {
  if (db === -Infinity || Number.isNaN(db)) return "-inf dB";
  if (db === Infinity) return "+inf dB";
  return `${db.toFixed(1)} dB`;
}

/** Build one bus's factors from its keyframe row. */
export function busFactors(bus: KeyframeBus): BusFactors {
  const raw = (lane: number, which: 0 | 1): number => {
    const v = bus.lanes[lane * 2 + which];
    return v === undefined || Number.isNaN(v) ? 1 : v;
  };
  const muted = [bus.flags & FLAG_AUTHORED_MUTE, bus.flags & FLAG_RUNTIME_MUTE];
  const factors: BusFactor[] = FACTOR_LANES.map((lane, i) => {
    let value: number;
    let target: number;
    if (i < 5) {
      const mute = i < 2 && muted[i] !== 0;
      value = mute ? 0 : raw(i, 0);
      target = mute ? 0 : raw(i, 1);
    } else {
      const v = i === 5 ? bus.duck : bus.automation;
      value = Number.isNaN(v) ? 1 : v;
      target = value;
    }
    return { lane, value, target, unity: value === 1, db: gainToDb(value) };
  });
  let product = 1;
  for (const f of factors) product *= f.value;
  return {
    slot: bus.slot,
    gen: bus.gen,
    factors,
    product,
    productDb: gainToDb(product),
    nonUnity: factors.filter((f) => !f.unity).map((f) => f.lane),
    tombstone: (bus.flags & FLAG_TOMBSTONE) !== 0,
  };
}

/** Every bus row of a keyframe, in the keyframe's order. */
export function keyframeBusFactors(keyframe: Pick<KeyframePayload, "buses">): BusFactors[] {
  return keyframe.buses.map(busFactors);
}

/** A bus's product times its ancestors' (the level reaching the output from it). */
export interface BusTreeGain {
  slot: number;
  /** The bus's own product. */
  own: number;
  /** `own` times every ancestor's own product, up to the root. */
  tree: number;
  treeDb: number;
}

/**
 * Tree products. `parents` maps a slot to its parent's slot (null or absent for a root); a slot missing from `factors`
 * counts as unity. A cycle (never valid) stops at the repeated slot instead of looping.
 */
export function treeProducts(
  factors: readonly BusFactors[],
  parents: ReadonlyMap<number, number | null> | readonly (number | null)[],
): BusTreeGain[] {
  const own = new Map<number, number>();
  for (const f of factors) own.set(f.slot, f.product);
  const parentOf = (slot: number): number | null => {
    const p = parents instanceof Map ? parents.get(slot) : (parents as readonly (number | null)[])[slot];
    return p === undefined ? null : p;
  };
  return factors.map((f) => {
    let tree = f.product;
    const seen = new Set<number>([f.slot]);
    for (let p = parentOf(f.slot); p !== null && !seen.has(p); p = parentOf(p)) {
      seen.add(p);
      tree *= own.get(p) ?? 1;
    }
    return { slot: f.slot, own: f.product, tree, treeDb: gainToDb(tree) };
  });
}
