// The bed planner on main (ADR 0162; api-and-models §2.1 bed resolution, architecture §1 "Bed planner", §2.1; C2, S15,
// R1). Runs when the bus tree, `audio.bed.maxBeds`, a bus's `bed` or `bedPriority` changes (the core backend calls `plan`
// after BUS_CONFIG): resolves `own` / `parent` / `none` down the tree, gives the `own` buses with the highest
// `bedPriority` the core's bed slots (at most the `max_beds` laid out), keeps a slot's id while it keeps its host,
// sends BED_CONFIG, and warns which buses lost a bed. The panner pick reads `bedSlot` per bus; a hard rebuild replays
// BED_CONFIG right after BUS_CONFIG (C10's order).
//
// A5 fills this file and flips `bedInitParams` (`initParams.ts`). K4 (the skeleton): no slot is laid out (`max_beds` 0), so no
// bus has a bed and no BED_CONFIG is ever sent.
import type { AudioSettings } from "../../../../engine/audio/settings";
import { MAX_BUSES } from "../../../../engine/audio/settings";
import type { AudioBedDebug } from "../backend";
import { BED_SLOT_NONE, MAX_BEDS } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { ReplayBuilder } from "./replay";

/** @internal The bed planner's counters for `Audio.debug()` (C24). */
export interface BedCounters {
  bedSwitches: number;
  bedDenied: number;
}

/** @internal The bus → bed-slot map and each slot's host (constructed by the core backend). */
export class BedPlanner {
  readonly counters: BedCounters = { bedSwitches: 0, bedDenied: 0 };
  /** Per bus index: its bed slot, `BED_SLOT_NONE` without one. */
  readonly bedSlot = new Uint8Array(MAX_BUSES).fill(BED_SLOT_NONE);
  /** Per slot: its host bus index (`BED_HOST_NONE` when unused), `slotCount` valid. */
  readonly hostBus = new Uint16Array(MAX_BEDS);
  /** Slots in use. */
  slotCount = 0;

  constructor(
    private readonly writer: Pick<CommandWriter, "bedConfig">,
    /** The slots the core laid out (`max_beds`, 0..4). */
    readonly maxBeds: number,
  ) {}

  /**
   * Plans the beds for the tree last configured (`busNames` root first, `parents[b]` the parent's index or -1) and sends
   * BED_CONFIG when the plan changed. Call after BUS_CONFIG in the same batch. K4: with no slot laid out, nothing.
   */
  plan(settings: AudioSettings, busNames: readonly string[], parents: ArrayLike<number>): void {
    void settings;
    void busNames;
    void parents;
    void this.writer;
  }

  /** Bus `b`'s bed slot (`BED_SLOT_NONE` without one). */
  bedSlotOf(b: number): number {
    return b >= 0 && b < MAX_BUSES ? this.bedSlot[b]! : BED_SLOT_NONE;
  }

  /** A hard rebuild: BED_CONFIG for the current plan, right after BUS_CONFIG (C10). Nothing while no slot is used. */
  replay(b: ReplayBuilder): void {
    void b;
  }

  /** `AudioDebugInfo.beds` (§1.6); undefined while no bed is laid out (a backend without beds leaves it out). */
  debug(): AudioBedDebug[] | undefined {
    return undefined;
  }
}
