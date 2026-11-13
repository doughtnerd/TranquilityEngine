// ADR 0171 amended by 0172 (M5, contract K0; plan seam): the core backend's bus gain writer. K0 moved today's
// `applyMix` (BUS_MIX: each bus's own gain and snapshot low-pass), selection's effective-gain inputs and the MASTER
// writes here from `coreBackend.ts`, unchanged, so the M5 tasks replace them without touching the backend:
// - Wa2 (W2, contract H1, a planned stub replacement): `applyMix`'s body becomes one asap `BUS_RAMP` per bus on the
//   `runtime` lane (gain) and the `snapshot` lane (low-pass), today's targets, bit-identical by R3;
// - Mx2 (W3): the per-lane writer (`rampLane`), master through `BUS_RAMP` on `BUS_MASTER_OUT`, the hidden-tab mute,
//   selection's audibility from the lane product.
import type { ResolvedBus } from "../../../../engine/audio/mixer";
import { BUS_LP_OFF_HZ, type BusMixBuses } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { ClockMap } from "./clock";
import type { BusLaneRamp } from "../backend";

/** The core's bus count (`MAX_BUS` in `coreBackend.ts`). */
const MAX_BUS = 32;

/** What the lane writer needs of the core backend. */
export interface LaneWriterHost {
  readonly writer: Pick<CommandWriter, "busMix" | "master">;
  readonly clockMap: Pick<ClockMap, "rampFrames">;
  /** Bus name → index, as last configured (`busIndex.ts`). */
  readonly busIndexByName: ReadonlyMap<string, number>;
  /** Selection's bus factor, by bus index (`Selection.busGain`). */
  readonly busGain: Float32Array;
  /** ADR 0162 (A5, S3): re-fold the sharing chain's snapshot low-pass after the cutoffs changed. */
  refreshSharedLowpass(): void;
}

export class LaneWriter {
  private readonly mixPool: BusMixBuses[] = [];
  private readonly mixView: BusMixBuses[] = [];
  /** M2 F3: selection's bus factor inputs, by bus index: effective gain without automation, parent, automated gain, chain product. */
  readonly selBase = new Float64Array(MAX_BUS).fill(1);
  readonly selParent = new Int16Array(MAX_BUS).fill(-1);
  readonly selAuto = new Float64Array(MAX_BUS).fill(1);
  private readonly selChain = new Float64Array(MAX_BUS).fill(1);
  selCount = 0;
  /** Each bus's snapshot cutoff as last sent in BUS_MIX (`BUS_LP_OFF_HZ`: none), for the sharing chain's fold. */
  readonly snapLp = new Float32Array(MAX_BUS).fill(BUS_LP_OFF_HZ);

  constructor(private readonly host: LaneWriterHost) {
    for (let i = 0; i < MAX_BUS; i++) this.mixPool.push({ gain: 1, lpHz: BUS_LP_OFF_HZ });
  }

  /** BUS_MIX from the resolved buses: each bus's own gain (the core multiplies down the tree) and snapshot low-pass. */
  applyMix(buses: readonly ResolvedBus[]): void {
    const view = this.mixView;
    view.length = 0;
    const n = Math.min(buses.length, MAX_BUS);
    for (let b = 0; b < n; b++) {
      const item = this.mixPool[b]!;
      item.gain = buses[b]!.gain;
      item.lpHz = buses[b]!.snapshotLowpass ?? BUS_LP_OFF_HZ;
      this.snapLp[b] = item.lpHz;
      view.push(item);
      // Selection's audibility uses the effective gain down the tree (A3.1), without bus automation (below).
      const g = buses[b]!.effectiveGain;
      this.selBase[b] = Number.isFinite(g) && g > 0 ? g : 0;
      const p = buses[b]!.parent;
      this.selParent[b] = p === null ? -1 : (this.host.busIndexByName.get(p) ?? -1);
    }
    this.selCount = n;
    this.refreshBusGain();
    this.host.writer.busMix(view, this.host.clockMap.rampFrames());
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
