// A KEYFRAME bus row's lanes (api-and-models §5.5), read from main's mixer the same way on both backends (ADR 0179): the
// core's keyframe source (`core/keyframeSource.ts`, pooled rows over the session slot table) and the Babylon fallback's
// `keyframe()` (fresh rows over the mixer's own slots). Values come from `Mixer.laneGain`, targets from the lane's
// `Ramp.to` (a muted lane's target is 0), the duck and automation lanes' values, and the four gate bits. No allocation.
// The bits are `capture/keyframeLayout.ts`'s (ADR 0230): a value import of `capture/format.ts` would pull the lazy recorder
// chunk's codecs into every game.
import type { KeyframeBus } from "../capture/format";
import { KeyframeBusFlag } from "../capture/keyframeLayout";
import { Lane, type Mixer } from "../../../../engine/audio/mixer";

/** What the row reads of the mixer. */
export type KeyframeLaneMixer = Pick<Mixer, "_lanes" | "laneGain">;

function setLane(L: number[], k: number, m: KeyframeLaneMixer, name: string, lane: 0 | 1 | 2 | 3 | 4, to: number): void {
  L[2 * k] = Math.fround(m.laneGain(name, lane));
  L[2 * k + 1] = Math.fround(to);
}

/**
 * Writes bus `name`'s five main-written lanes (value and target), its duck and automation values into `row`, and returns
 * its gate bits; -1 (the row untouched) when the mixer holds no lanes for `name`.
 */
export function writeKeyframeBusLanes(row: KeyframeBus, m: KeyframeLaneMixer, name: string): number {
  const lanes = m._lanes(name);
  if (!lanes) return -1;
  const L = row.lanes as number[];
  setLane(L, 0, m, name, Lane.authored, lanes.authoredMute ? 0 : lanes.authored.to);
  setLane(L, 1, m, name, Lane.runtime, lanes.runtimeMute ? 0 : lanes.runtime.to);
  setLane(L, 2, m, name, Lane.snapshot, lanes.snapshot.to);
  setLane(L, 3, m, name, Lane.monitor, m.laneGain(name, Lane.monitor));
  setLane(L, 4, m, name, Lane.dip, lanes.dip.to);
  row.duck = Math.fround(m.laneGain(name, Lane.duck));
  row.automation = Math.fround(m.laneGain(name, Lane.automation));
  return (lanes.authoredMute ? KeyframeBusFlag.authoredMute : 0) | (lanes.runtimeMute ? KeyframeBusFlag.runtimeMute : 0)
    | (lanes.monitorMute ? KeyframeBusFlag.monitorMute : 0) | (lanes.monitorSolo ? KeyframeBusFlag.monitorSolo : 0);
}
