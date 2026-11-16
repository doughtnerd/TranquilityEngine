// ADR 0166 R4b: a loop region's `while` condition against a parameter's value (api-and-models §2.3). `regions.ts` reads it
// at each commit point.
import type { RegionCondition } from "../../../../engine/audio/musicFormat";

/**
 * Whether `cond` holds for the parameter value `value`; null when it can't be read (no such parameter, or the comparison
 * doesn't fit the value's kind).
 */
export function conditionHolds(cond: RegionCondition, value: number | string | undefined): boolean | null {
  if (value === undefined) return null;
  if ("is" in cond) return String(value) === cond.is;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return "atLeast" in cond ? value >= cond.atLeast : value < cond.below;
}
