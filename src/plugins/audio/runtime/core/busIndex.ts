// ADR 0171 amended by 0172 (M5, contract K0; plan seam; task Ma1): the core backend's bus indexing. K0 moved
// `configureBuses`, `busConfigWire`, `planBeds`, `replanBedsOnSettings` and the name → index map here from
// `coreBackend.ts`; Ma1 (W5) put them on the session slot table (`engine/audio/slotTable.ts`, api-and-models §6.3,
// architecture §4.7): **every consumer reads a bus's slot from the table**, never its position in `project.json`.
//
// - **The table** is reset at each configure (slot = project position, today's mapping: no wire byte changes until a live
//   edit) and edited by the live path (`liveMix.ts`): an add takes the first free slot, else the next index, and goes to
//   the core as one `BUS_SLOT` (append); an effect edit is one `BUS_SLOT` for its slot (the diff of `BUS_CONFIG`); a rename
//   keeps the slot and aliases the old name. Ma2 (W6): the structural edits (`structuralDip.ts`) move and tombstone slots
//   here; a tombstone keeps its slot (and its name in `names`, never in the map) until it recycles, its voices go to the
//   root with a per-voice dip, and BUS_CONFIG's replay carries it as a silent root.
// - **One map.** `busIndexByName` (name → slot, plus a live rename's old name) is the map the lane writer, automation,
//   presence's slots, the aux sends and the plays read; `names` is slot → name; the bed plan's parents and `BUS_CONFIG`'s
//   tree (`busConfigWire`, also the hard rebuild's replay) come from the table.
// - **Slot order.** The mixer keeps its running tree in slot order (`Mixer._applyLive` appends an added bus), so a
//   consumer that walks `mixer.busNames` by index walks slots.
import type { Mixer, ResolvedBus } from "../../../../engine/audio/mixer";
import { MAX_BUSES, type AudioSettings, type BusEffect } from "../../../../engine/audio/settings";
import { SlotTable, type SlotDeferred } from "../../../../engine/audio/slotTable";
import { BUS_ROOT, FadeLaw, SET_PARAMS_MASK_BUS, type BusConfigBuses, type BusConfigBusesEffects } from "../wire.generated";
import { VoiceState } from "./voiceTable";
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

/** A `BUS_SLOT` that rides a structural sequence: stamped at `at` with its `sequenceId` (C27). */
export interface SlotStamp {
  at: number;
  sequenceId: number;
}

/** What the bed plan reads of the settings: a live edit that leaves it alone plans nothing again. */
function bedKey(a: AudioSettings): string {
  return JSON.stringify([a.bed, a.buses.map((b) => [b.name, b.parent ?? null, b.bed ?? null, b.bedPriority ?? null])]);
}

/** What the bus index needs of the core backend. */
export interface BusIndexHost {
  readonly mixer: Mixer;
  readonly writer: Pick<CommandWriter, "busConfig" | "setParams" | "busSlot" | "fadeShaped">;
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
  /** The session slot table (Sm1): name → core slot for this Play session (§6.3). */
  readonly slots = new SlotTable((effects) => effects.map(wireEffect));
  /** The bus names by slot (root first), as configured and live-edited. */
  names: string[] = [];
  /** Name → slot (a live rename's old name too): the one map every consumer reads (architecture §4.7). Kept as one object. */
  readonly busIndexByName = new Map<string, number>();
  private readonly planParents = new Int16Array(MAX_BUSES);
  /** The settings object the beds were last planned from (E7: a settings change that keeps the bus names plans them again). */
  private bedsPlannedFrom: AudioSettings | null = null;

  constructor(private readonly host: BusIndexHost) {}

  /** The slot of bus `name` (through a live rename's alias), or -1. */
  slotOf(name: string): number {
    return this.busIndexByName.get(name) ?? -1;
  }

  /** ADR 0162 (C2, E7): plans the beds for the current tree and `audio.bed` / each bus's `bed` and `bedPriority`; BED_CONFIG goes with the next batch. */
  planBeds(mixer: Mixer): void {
    const settings = mixer.audioSettings;
    const parents = this.planParents;
    parents.fill(-1);
    const slots = this.slots.slots;
    for (let s = 0; s < slots.length && s < MAX_BUSES; s++) parents[s] = slots[s]!.parent;
    this.bedsPlannedFrom = settings;
    this.host.beds.plan(settings, this.names, parents);
  }

  /**
   * E7: `Engine.create` gave the mixer a new settings object and the bus names are the same, so the host reported no remap
   * and `configureBuses` didn't run. The bed settings (`bed.maxBeds`, a bus's `bed`, `bedPriority`) still apply to the
   * running core: plan the beds again. A changed tree is `configureBuses`' (the remap runs before the mixer's next update).
   * Ma1: after a live edit changed the table (`slots.version` > 0), a configure whose names the host saw as unchanged (an
   * undo back to the names the core started with) gets no remap either: the tree is configured again from the settings.
   */
  replanBedsOnSettings(): void {
    const settings = this.host.mixer.audioSettings;
    if (settings === this.bedsPlannedFrom) return;
    if (settings.buses.length !== this.names.length || settings.buses.some((b, i) => b.name !== this.names[i])) {
      if (this.slots.version > 0) this.configureBuses(this.host.mixer);
      return;
    }
    this.planBeds(this.host.mixer);
  }

  /**
   * Ma1: the live path changed the mixer's settings from `before` (already applied to the table): the beds are planned
   * again only when something they read moved (a bus's `bed` or `bedPriority`, `audio.bed`, the tree).
   */
  liveSettings(before: AudioSettings): void {
    const settings = this.host.mixer.audioSettings;
    if (this.bedsPlannedFrom !== before && this.bedsPlannedFrom !== settings) return;
    if (bedKey(before) === bedKey(settings)) this.bedsPlannedFrom = settings;
    else this.planBeds(this.host.mixer);
  }

  /** Rebuilds the core's bus tree: BUS_CONFIG, the table's per-bus limits, and every bus lane (the lane writer). */
  configureBuses(mixer: Mixer): void {
    const settings = mixer.audioSettings.buses;
    // Compaction (§6.3): slot = position in project.json, aliases cleared.
    this.slots.reset(mixer.audioSettings);
    this.syncNames();
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

  /** BUS_CONFIG's buses in slot order (the table's tree; also the hard rebuild's replay, A3.4a). */
  busConfigWire(mixer: Mixer = this.host.mixer): BusConfigBuses[] {
    return this.slots.configWire(mixer.audioSettings) as BusConfigBuses[];
  }

  // --- Ma1: the live path's edits of the table (`liveMix.ts`) ---

  /** A live add: the first free slot, else the next index (the table's `add`); `deferred` when none (R10, Ma3). */
  addBus(name: string, parent: string): number | SlotDeferred {
    const r = this.slots.add(name, parent);
    if (typeof r === "number") this.syncNames();
    return r;
  }

  /** A live rename: the slot is kept, the old name aliases it (no wire). */
  renameBus(from: string, to: string): void {
    this.slots.rename(from, to);
    this.syncNames();
  }

  /**
   * One `BUS_SLOT` (§4.2, R7), asap: bus `name`'s parent slot and effects from the mixer's settings. `fresh` for a slot
   * that was added (the core starts it zeroed with unity lanes). Returns the slot, or -1 for an unknown bus.
   */
  writeSlot(name: string, fresh = false, stamp?: SlotStamp): number {
    const s = this.slotOf(name);
    if (s < 0) return -1;
    const c = this.slotConfig(s);
    this.host.writer.busSlot({ ...c, fresh, ...(stamp ? { structural: true, sequenceId: stamp.sequenceId } : {}) }, stamp?.at);
    return s;
  }

  /** Slot `s`'s `BUS_SLOT` body now: a live bus's parent and effects (from the mixer's settings); a tombstone or a free slot is a silent root. */
  slotConfig(s: number): { slot: number; parent: number; effects: BusConfigBusesEffects[] } {
    const slot = this.slots.slots[s];
    if (!slot || slot.state !== "live") return { slot: s, parent: BUS_ROOT, effects: [] };
    const bus = this.host.mixer.audioSettings.buses.find((b) => b.name === slot.name);
    return { slot: s, parent: slot.parent < 0 ? BUS_ROOT : slot.parent, effects: (bus?.effects ?? []).map(wireEffect) };
  }

  // --- Ma2: the structural edits' side of the table (`structuralDip.ts`) ---

  /** A live re-parent (the table's `move`); its `BUS_SLOT` goes in the dip's sequence. Returns the bus's slot. */
  moveBus(name: string, parent: string): number {
    this.slots.move(name, parent);
    this.syncNames();
    return this.slotOf(name);
  }

  /**
   * A live removal: the bus and its descendants become tombstones (silent roots) whose recycle frame is set once their
   * dip is stamped (`settle`). Their names leave the map at once, so a new play under a removed name goes where an
   * unknown name goes. Returns the tombstoned slots, the removed bus first.
   */
  removeBus(name: string): number[] {
    const slots = this.slots.remove(name, Number.POSITIVE_INFINITY);
    this.syncNames();
    return slots;
  }

  /** The dip that tombstoned `slots` ends at `dipEndFrame`: they recycle `TOMBSTONE_TAIL_FRAMES` later (the table's `settle`). */
  settle(slots: readonly number[], dipEndFrame: number): void {
    this.slots.settle(slots, dipEndFrame);
  }

  /** R9: frees each tombstone past its recycle frame with no voice on it (`busLive`); returns the freed slots. */
  recycle(frame: number): number[] {
    const busLive = this.host.table.busLive;
    const freed = this.slots.recycle(frame, (s) => busLive[s] ?? 0);
    if (freed.length > 0) this.syncNames();
    return freed;
  }

  /** The root slot above live slot `s` (itself for a root; 0 when unknown). */
  rootOf(s: number): number {
    const slots = this.slots.slots;
    let b = s;
    for (let hops = 0; hops <= slots.length; hops++) {
      const p = slots[b]?.parent ?? -1;
      if (p < 0) return slots[b] ? b : 0;
      b = p;
    }
    return 0;
  }

  /**
   * The per-voice dip, main's side (§6.5), at the op: every live voice on one of `from` moves to slot `to` in the
   * table (its slot and the counts), the mixer's counts and presence, so selection and new plays see the end state at
   * once. Returns the moved voices' ids for `dipVoices`.
   */
  moveVoices(from: ReadonlySet<number>, to: number): number[] {
    const host = this.host;
    const t = host.table;
    const ids: number[] = [];
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] === VoiceState.FREE || !from.has(t.bus[i]!)) continue;
      const old = t.bus[i]!;
      t.bus[i] = to;
      if (t.busLive[old]! > 0) t.busLive[old]!--;
      t.busLive[to]!++;
      host.mixer.voiceEnded(this.names[old] ?? "");
      host.mixer.voiceStarted(this.names[to] ?? "");
      host.presence.voiceStopped(old, i);
      host.presence.voiceStarted(to, i);
      ids.push(((t.gen[i]! << 16) | i) >>> 0);
    }
    return ids;
  }

  /**
   * The per-voice dip on the core: for each of `ids` still live on slot `to` and held by the core, at `b` (a quantum
   * start where its old bus's dip is at 0, so nothing heard moves) its fade drops to 0 and its `SET_PARAMS bus` lands,
   * then it fades back in over `frames` from `b` (a stopping voice stays out and ends). Its old bus's dip is its
   * fade-out, so the sound never falls or rises faster than the dip ramp. Returns the voices written.
   */
  dipVoices(ids: readonly number[], to: number, b: number, frames: number, sampleRate: number): number {
    const host = this.host;
    const t = host.table;
    const w = host.writer;
    const seconds = frames / sampleRate;
    let n = 0;
    for (const id of ids) {
      const i = id & 0xffff;
      const state = t.state[i]!;
      if (state === VoiceState.FREE || t.gen[i] !== id >>> 16 || t.bus[i] !== to || !host.onCore(i)) continue;
      w.fadeShaped(id, 0, 0, FadeLaw.Linear, 0, b);
      w.setParams(id, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, to, 0, b);
      if (state !== VoiceState.STOPPING && state !== VoiceState.ENDING) w.fadeShaped(id, t.fadeGain[i]!, seconds, FadeLaw.Linear, 0, b);
      n++;
    }
    return n;
  }

  /** Each slot's `maxVoices` (0 unlimited) from the mixer's settings, into the voice table (the steal limit is main's). */
  writeLimits(): void {
    const settings = this.host.mixer.audioSettings.buses;
    this.host.table.setBusLimits(this.names.map((n) => settings.find((b) => b.name === n)?.maxVoices ?? 0));
  }

  /** `names` and `busIndexByName` from the table (live names by slot, then the aliases). */
  private syncNames(): void {
    const slots = this.slots.slots;
    this.names = slots.map((s) => s.name ?? "");
    const map = this.busIndexByName;
    map.clear();
    for (const [name, slot] of this.slots.byName) map.set(name, slot);
    for (const old of this.slots.aliases.keys()) {
      const s = this.slots.slotOf(old);
      if (s >= 0 && !map.has(old)) map.set(old, s);
    }
  }
}
