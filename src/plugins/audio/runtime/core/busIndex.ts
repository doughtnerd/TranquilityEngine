// ADR 0171 amended by 0172 (M5, contract K0; plan seam): the core backend's bus indexing. K0 moved `configureBuses`,
// `busConfigWire`, `planBeds`, `replanBedsOnSettings` and the name → index map here from `coreBackend.ts`, unchanged:
// today a bus's core index is its position in `project.json`. Ma1 (W5) makes every consumer read the slot from the
// session slot table (`engine/audio/slotTable.ts`, architecture §4.7); Ma2 (W6) adds tombstones to the remap.
import type { Mixer, ResolvedBus } from "../../../../engine/audio/mixer";
import { MAX_BUSES, type AudioSettings, type BusEffect } from "../../../../engine/audio/settings";
import { BUS_ROOT, SET_PARAMS_MASK_BUS, type BusConfigBuses, type BusConfigBusesEffects } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { BedPlanner } from "./beds";
import type { CoreAutomation } from "./coreAutomation";
import type { StatusMirror } from "./mirror";
import type { VoiceTable } from "./voiceTable";
import type { Presence } from "./presence";

/** Maps a `BusEffect` to its wire record (§4.2 BUS_CONFIG: q in dB, p unused = 0). */
export function wireEffect(e: BusEffect): BusConfigBusesEffects {
  const p = [0, 0, 0, 0, 0, 0, 0];
  switch (e.type) {
    case "lowpass":
      p[0] = e.frequency;
      p[1] = e.q;
      return { type: 0, p };
    case "highpass":
      p[0] = e.frequency;
      p[1] = e.q;
      return { type: 1, p };
    case "compressor":
      p[0] = e.threshold;
      p[1] = e.knee;
      p[2] = e.ratio;
      p[3] = e.attack;
      p[4] = e.release;
      return { type: 2, p };
    case "reverb":
      p[0] = e.send;
      return { type: 3, p };
  }
}

/** What the bus index needs of the core backend. */
export interface BusIndexHost {
  readonly mixer: Mixer;
  readonly writer: Pick<CommandWriter, "busConfig" | "setParams">;
  readonly beds: Pick<BedPlanner, "plan">;
  readonly automation: Pick<CoreAutomation, "onBusesConfigured">;
  readonly mirror: Pick<StatusMirror, "resetPeaks">;
  readonly table: VoiceTable;
  readonly presence: Presence;
  /** Whether slot `i` has a voice on the core (its PLAY went out). */
  onCore(i: number): boolean;
  /** The backend's `applyMix` (the lane writer, behind the disposed check). */
  applyMix(buses: readonly ResolvedBus[]): void;
  /** A configure forgets the backend's last-bus lookup cache and resets selection's automated bus gains. */
  busesReset(): void;
}

export class BusIndex {
  /** The bus names by index (root first), as last configured. */
  names: string[] = [];
  readonly busIndexByName = new Map<string, number>();
  private readonly planParents = new Int16Array(MAX_BUSES);
  /** The settings object the beds were last planned from (E7: a settings change that keeps the bus names plans them again). */
  private bedsPlannedFrom: AudioSettings | null = null;

  constructor(private readonly host: BusIndexHost) {}

  /** ADR 0162 (C2, E7): plans the beds for the current tree and `audio.bed` / each bus's `bed` and `bedPriority`; BED_CONFIG goes with the next batch. */
  planBeds(mixer: Mixer): void {
    const settings = mixer.audioSettings;
    const buses = settings.buses;
    const parents = this.planParents;
    parents.fill(-1);
    for (let b = 0; b < buses.length && b < MAX_BUSES; b++) {
      const parent = buses[b]!.parent;
      parents[b] = parent === undefined ? -1 : (this.busIndexByName.get(parent) ?? 0);
    }
    this.bedsPlannedFrom = settings;
    this.host.beds.plan(settings, this.names, parents);
  }

  /**
   * E7: `Engine.create` gave the mixer a new settings object and the bus names are the same, so the host reported no remap
   * and `configureBuses` didn't run. The bed settings (`bed.maxBeds`, a bus's `bed`, `bedPriority`) still apply to the
   * running core: plan the beds again. A changed tree is `configureBuses`' (the remap runs before the mixer's next update).
   */
  replanBedsOnSettings(): void {
    const settings = this.host.mixer.audioSettings;
    if (settings === this.bedsPlannedFrom || settings.buses.length !== this.names.length || settings.buses.some((b, i) => b.name !== this.names[i])) return;
    this.planBeds(this.host.mixer);
  }

  /** Rebuilds the core's bus tree: BUS_CONFIG, the table's per-bus limits, and every bus lane (the lane writer). */
  configureBuses(mixer: Mixer): void {
    const settings = mixer.audioSettings.buses;
    this.names = settings.map((b) => b.name);
    this.busIndexByName.clear();
    this.names.forEach((n, i) => this.busIndexByName.set(n, i));
    this.host.busesReset();
    this.host.writer.busConfig(this.busConfigWire(mixer));
    // ADR 0162 (K4, C2): the bed plan for the new tree, BED_CONFIG right after BUS_CONFIG (none while no bed is laid out).
    this.planBeds(mixer);
    // ADR 0158: bus bindings follow their buses to the new indices.
    this.host.automation.onBusesConfigured();
    // The mixer's counts restart at 0 when it is reconfigured; the table knows every live voice (virtual and locked
    // included), so ducking keeps counting them across a remap. Peaks reported for the old indices are dropped.
    this.names.forEach((n, i) => mixer._setVoiceCount(n, this.host.table.busLive[i]!));
    this.host.mirror.resetPeaks();
    this.host.table.setBusLimits(settings.map((b) => b.maxVoices ?? 0));
    // A remap (A0.8) has already moved the table's voices to the new tree's indices; the core's
    // voices still carry the old ones, so each voice on the core is re-routed (after BUS_CONFIG, in
    // the same batch).
    const t = this.host.table;
    for (let i = 0; i < t.capacity; i++) {
      if (!this.host.onCore(i)) continue;
      this.host.writer.setParams(((t.gen[i]! << 16) | i) >>> 0, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, t.bus[i]!);
    }
    // ADR 0171 (K0): presence ducking's rules and mask for the new tree (Dp1; a no-op until then).
    this.host.presence.configured(mixer, t.busLive);
    this.host.applyMix(mixer.resolveAll());
  }

  /** BUS_CONFIG's buses for the tree last configured, root first (also the hard rebuild's replay, A3.4a). */
  busConfigWire(mixer: Mixer = this.host.mixer): BusConfigBuses[] {
    return mixer.audioSettings.buses.map((b) => ({
      parent: b.parent === undefined ? BUS_ROOT : (this.busIndexByName.get(b.parent) ?? 0),
      effects: b.effects.map(wireEffect),
    }));
  }
}
