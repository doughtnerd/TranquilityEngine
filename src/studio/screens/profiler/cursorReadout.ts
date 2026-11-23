// The Profiler's "At cursor" panel and the bus tracks' lane breakdown (ADR 0348; the prototype's `cursorRows` and the
// floating "Music −16.0 dB / authored −10.0 / duck −6.0" at the playhead): what each bus gives at the cursor, from the
// keyframe in force (`busFactors`, the editor profiler's model), with the reasons it is not at its authored level in
// words ("ducked", "dip", "snapshot", "muted", "script", "automation", "monitor"). Pure.
import { busFactors, type BusFactors, type FactorLane } from "../../../plugins/audio/editor/mix/busFactorsModel";
import { formatDb } from "../../../plugins/audio/editor/dbScale";
import type { CaptureKeyframe, CaptureNames } from "../../../plugins/audio/runtime/capture/reader";

/** The word for a lane that moves a bus off its authored level. */
const LANE_REASON: Readonly<Record<Exclude<FactorLane, "authored">, string>> = {
  runtime: "script",
  snapshot: "snapshot",
  monitor: "monitor",
  dip: "dip",
  duck: "ducked",
  automation: "automation",
};

export interface BusReadout {
  readonly slot: number;
  readonly name: string;
  /** What the bus gives (the product of its lanes), dB. */
  readonly db: number;
  /** The authored lane alone, dB. */
  readonly authoredDb: number;
  /** The lanes off unity other than authored, with their dB, in lane order. */
  readonly lanes: readonly { readonly lane: FactorLane; readonly reason: string; readonly db: number }[];
  /** Muted (authored or script mute: the product is silence). */
  readonly muted: boolean;
  readonly removed: boolean;
}

/** One bus's readout from its factors. */
export function busReadout(f: BusFactors, name: string): BusReadout {
  const authored = f.factors.find((x) => x.lane === "authored")!;
  const lanes = f.factors.filter((x) => x.lane !== "authored" && !x.unity).map((x) => ({ lane: x.lane, reason: x.value === 0 ? "muted" : LANE_REASON[x.lane as Exclude<FactorLane, "authored">], db: x.db }));
  return { slot: f.slot, name, db: f.productDb, authoredDb: authored.db, lanes, muted: f.product === 0, removed: f.tombstone };
}

/** Every bus of the keyframe in force at viewport time `t` (axis `origin + t` for the names), by slot; empty without one. */
export function busReadouts(keyframe: Pick<CaptureKeyframe, "buses"> | null, names: CaptureNames, at: number): BusReadout[] {
  if (!keyframe) return [];
  return keyframe.buses.map((b) => busReadout(busFactors(b), names.bus(b.slot, at))).sort((a, b) => a.slot - b.slot);
}

/** The reasons as one short phrase ("ducked, dip"), or "" at its authored level. */
export const reasonsText = (r: BusReadout): string => (r.muted ? "muted" : [...new Set(r.lanes.map((l) => l.reason))].join(", "));

/** The breakdown the bus track floats at the cursor: `Music −16.0 dB / authored −10.0 / duck −6.0`. */
export function breakdownText(r: BusReadout): string {
  const parts = [`${r.name} ${formatDb(r.db)}`, `authored ${formatDb(r.authoredDb).replace(" dB", "")}`];
  for (const l of r.lanes) parts.push(`${l.lane} ${formatDb(l.db).replace(" dB", "")}`);
  return parts.join(" / ");
}
