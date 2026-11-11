// The zone manager on main (ADR 0162; api-and-models §3.2 "Zone registry", architecture §2.2, §3.3; C5, S1, R4, R11,
// R14, R17). Per frame, in the listener's World only, after Doppler and before occlusion: the live `AudioReverbZone`s
// with cached world volumes (capacity 64, extras inert with a warning), each voice's weight per zone and its send
// (`reverbSend` × the send curve, clamped to 4, × volume × weight × wet factor; with `zoneWeights.ts`) staged into
// `voiceFx`; energy per zone, ranking, the active set re-planned every 4 frames with 1.5x hysteresis for 500 ms;
// ZONE_CONFIG when the slot table changes or the listener's weight moves (`sharedReturnGain` = 1 − the listener's total
// weight); IR load and preparation through the `ZoneIrService` (`zoneIr.ts`, C2b). A hard rebuild replays ZONE_CONFIG
// last in the header (C10's order) and asks the service to prepare every wanted kernel again at the new rate.
//
// C5 fills this file and flips `zoneInitParams` (`initParams.ts`). K4 (the skeleton): no slot is laid out, so there are no zones,
// no sends and no ZONE_CONFIG.
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { AudioZoneDebug, ZoneIrService } from "../backend";
import type { CommandWriter } from "./commandWriter";
import type { StatusMirror } from "./mirror";
import type { ReplayBuilder } from "./replay";
import type { ListenerFrame, SpatialVoiceView } from "./spatial";
import type { VoiceFx } from "./voiceFx";

/** @internal [API §3.2]: live zones per World before extras go inert. */
export const MAX_ZONES_PER_WORLD = 64;

/** @internal The zone manager's counters for `Audio.debug()` (§1.6, C24). */
export interface ZoneCounters {
  zonesFaded: number;
  irFailures: number;
  irTruncated: number;
  irPrepares: number;
  kernelRefused: number;
}

/** @internal What the zone manager is built on (the core backend passes its own). */
export interface ZoneManagerDeps {
  readonly writer: Pick<CommandWriter, "zoneConfig">;
  /** Where sends are staged (SET_VOICE_FX). */
  readonly fx: VoiceFx;
  /** IR preparation (C2b's `zoneIr.ts`). */
  readonly irs: ZoneIrService;
  /** STATUS `zones` and `zoneEvents` (slot states, refusals). */
  readonly mirror: StatusMirror;
  /** The slots the core laid out (`max_zone_slots`, 0..4) and the longest IR in seconds. */
  readonly maxZoneSlots: number;
  readonly zoneMaxSeconds: number;
}

/** @internal The scene's zones, voice sends, the slot table and IR states (constructed by the core backend). */
export class ZoneManager {
  readonly counters: ZoneCounters = { zonesFaded: 0, irFailures: 0, irTruncated: 0, irPrepares: 0, kernelRefused: 0 };

  constructor(readonly deps: ZoneManagerDeps) {}

  /**
   * The frame step (C5): zones of `frame.world`, weights and sends for `view`'s voices into `deps.fx`, the active set,
   * ZONE_CONFIG on change. K4: nothing.
   */
  run(frame: ListenerFrame, view: SpatialVoiceView, settings: Pick<AudioSettings, "zones">): void {
    void frame;
    void view;
    void settings;
  }

  /** Slot `i` was freed: its weights go (its sends go with `voiceFx.forget`). */
  forget(i: number): void {
    void i;
  }

  /** A hard rebuild: ZONE_CONFIG with every wanted slot, last in the header (C10; the core holds a slot until its kernel is resident). K4: nothing. */
  replay(b: ReplayBuilder): void {
    void b;
  }

  /** The context's rate changed (a rebuild into a new context): every wanted kernel is prepared again at `rate`. */
  contextReplaced(rate: number): void {
    this.deps.irs.reprepareAll?.(rate);
  }

  /** `AudioDebugInfo.zones` (§1.6); undefined while no zone slot is laid out. */
  debug(): AudioZoneDebug[] | undefined {
    return undefined;
  }

  dispose(): void {
    this.deps.irs.dispose?.();
  }
}
