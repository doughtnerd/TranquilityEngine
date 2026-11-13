// ADR 0171 amended by 0172 (M5, contract K0; plan seam): the core backend's bus gain writer. K0 moved today's
// `applyMix` (BUS_MIX: each bus's own gain and snapshot low-pass), selection's effective-gain inputs and the MASTER
// writes here from `coreBackend.ts`, unchanged, so the M5 tasks replace them without touching the backend:
// - Wa2 (W2, contract H1, a planned stub replacement): `applyMix`'s body becomes one asap `BUS_RAMP` per bus on the
//   `runtime` lane (gain) and the `snapshot` lane (low-pass), today's targets, bit-identical by R3 (interim (H1), replaced by Mx2);
// - Mx2 (W3): the per-lane writer (`rampLane`), master through `BUS_RAMP` on `BUS_MASTER_OUT`, the hidden-tab mute,
//   selection's audibility from the lane product.
import type { ResolvedBus } from "../../../../engine/audio/mixer";
import { BUS_LP_OFF_HZ, BUS_RAMP_MASK_GAIN, BUS_RAMP_MASK_LP_HZ, LANE_RUNTIME, LANE_SNAPSHOT } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { ClockMap } from "./clock";
import type { BusLaneRamp } from "../backend";

/** The core's bus count (`MAX_BUS` in `coreBackend.ts`). */
const MAX_BUS = 32;

/** What the lane writer needs of the core backend. */
export interface LaneWriterHost {
  readonly writer: Pick<CommandWriter, "busRampFrames" | "master">;
  readonly clockMap: Pick<ClockMap, "rampFrames">;
  /** Bus name → index, as last configured (`busIndex.ts`). */
  readonly busIndexByName: ReadonlyMap<string, number>;
  /** Selection's bus factor, by bus index (`Selection.busGain`). */
  readonly busGain: Float32Array;
  /** ADR 0162 (A5, S3): re-fold the sharing chain's snapshot low-pass after the cutoffs changed. */
  refreshSharedLowpass(): void;
}

export class LaneWriter {
  /** M2 F3: selection's bus factor inputs, by bus index: effective gain without automation, parent, automated gain, chain product. */
  readonly selBase = new Float64Array(MAX_BUS).fill(1);
  readonly selParent = new Int16Array(MAX_BUS).fill(-1);
  readonly selAuto = new Float64Array(MAX_BUS).fill(1);
  private readonly selChain = new Float64Array(MAX_BUS).fill(1);
  selCount = 0;
  /** Each bus's snapshot cutoff as last sent on the snapshot lane (`BUS_LP_OFF_HZ`: none), for the sharing chain's fold. */
  readonly snapLp = new Float32Array(MAX_BUS).fill(BUS_LP_OFF_HZ);

  constructor(private readonly host: LaneWriterHost) {}

  /**
   * The resolved buses to the core: per bus, one asap `BUS_RAMP` on the `runtime` lane (its own gain; the core multiplies
   * down the tree) and one on the `snapshot` lane (its low-pass), both over today's ramp length (`ClockMap.rampFrames`).
   * Interim (H1), replaced by Mx2's per-lane writer. Bit-identical with the `BUS_MIX` it replaces by R3 (an asap ramp on a
   * lone lane uses `Ramp::next`'s arithmetic; identity lanes are skipped).
   */
  applyMix(buses: readonly ResolvedBus[]): void {
    const n = Math.min(buses.length, MAX_BUS);
    const frames = this.host.clockMap.rampFrames();
    const writer = this.host.writer;
    for (let b = 0; b < n; b++) {
      const gain = buses[b]!.gain;
      const lpHz = buses[b]!.snapshotLowpass ?? BUS_LP_OFF_HZ;
      this.snapLp[b] = lpHz;
      // Selection's audibility uses the effective gain down the tree (A3.1), without bus automation (below).
      const g = buses[b]!.effectiveGain;
      this.selBase[b] = Number.isFinite(g) && g > 0 ? g : 0;
      const p = buses[b]!.parent;
      this.selParent[b] = p === null ? -1 : (this.host.busIndexByName.get(p) ?? -1);
      writer.busRampFrames(b, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, gain, BUS_LP_OFF_HZ, frames);
      writer.busRampFrames(b, LANE_SNAPSHOT, BUS_RAMP_MASK_LP_HZ, 1, lpHz, frames);
    }
    this.selCount = n;
    this.refreshBusGain();
    this.host.refreshSharedLowpass();
  }

  /**
   * M2 F3: selection's bus factor: the mixer's effective gain times each bus's automated gain (selection's no-gap
   * estimate, `CoreAutomation.publishSelection`) and its ancestors', root first. Run where either input changes.
   */
  refreshBusGain(): void {
    const busGain = this.host.busGain;
    const chain = this.selChain;
    for (let b = 0; b < this.selCount; b++) {
      const p = this.selParent[b]!;
      const own = this.selAuto[b]!;
      const c = p >= 0 && p < b ? chain[p]! * own : own;
      chain[b] = c;
      const g = this.selBase[b]! * c;
      busGain[b] = Number.isFinite(g) && g > 0 ? g : 0;
    }
  }

  /** MASTER: the output gain `volume` (muted: 0) over `rampFrames` (the volume and mute setters, the hidden-tab mute). */
  master(volume: number, muted: boolean, rampFrames: number): void {
    this.host.writer.master(volume, muted, rampFrames);
  }

  /** Mx2: one `BUS_RAMP` on a main-written lane (§4.2). Not called until then. */
  rampLane(_r: BusLaneRamp): void {
    throw new Error("Mx2");
  }
}
