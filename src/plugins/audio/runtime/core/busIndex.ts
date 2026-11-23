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
// - **Slot, not position.** `mixer.busNames` is the project's buses (a removed bus leaves it at once, an added one is
//   appended), so after a live remove or an add into a recycled slot a bus's position there is not its slot: every
//   consumer reads the slot from this map or `BusLanes.slot` (G7c). The mixer holds a tombstone's state by slot
//   (`Mixer._tombstoneLanes`) until the slot recycles, for the replay's dip lane.
// - **Live effects (ADR 0344).** A slot's effects on the wire are the mixer's live effects (`Mixer._busEffects`): the
//   authored chain with the main thread's values in (snapshot overrides, effect automation). Each mixer change (`replanBedsOnSettings`, which the backend runs on every one)
//   writes one `BUS_SLOT` for each slot whose live parameter values moved (`syncEffects`); a change of the chain itself
//   (an effect added, removed or moved) is the live ops' (`liveMix.ts`, the structural dip), never this.
// - **Sends (ADR 0344, ABI 4.7).** A return is a bus of the mixer's view with a slot like any other; a bus's post-fader
//   sends into returns are the mixer's live sends (`Mixer._busSends`: each level with its automation, muted while the
//   bus is muted). Each mixer change writes one `BUS_SENDS` (replace-all for the slot) for each slot whose sends moved
//   (`syncSends`): a level ramps over `SEND_RAMP_MS`, a mute is `BUS_SEND_MUTED` (the send ramps to 0 and keeps its
//   level). After `BUS_CONFIG` every configured slot's sends are written again (the core keeps a kept slot's old ones);
//   a fresh `BUS_SLOT` starts with none; the hard rebuild's replay sends them after `BUS_CONFIG` (`replaySends`).
import type { LiveBusSend, Mixer, ResolvedBus } from "../../../../engine/audio/mixer";
import { DRAG_RAMP_MS } from "../../../../engine/audio/mixer";
import { MAX_BUSES, type AudioSettings, type BusEffect } from "../../../../engine/audio/settings";
import { SlotTable, type SlotDeferred } from "../../../../engine/audio/slotTable";
import { effectSpec } from "../../../../engine/audio/effects/catalogue";
import type { CoreEffectType } from "../../../../engine/audio/busCapability";
import { ASAP, BUS_FX_HELD_SHIFT, BUS_ROOT, BUS_SEND_MUTED, FadeLaw, MAX_BUS_SENDS, SET_PARAMS_MASK_BUS, writeBusSends, type BusConfigBuses, type BusConfigBusesEffects, type BusSendsSends } from "../wire.generated";
import type { ReplayBuilder } from "./replay";
import { VoiceState } from "./voiceTable";
import { busFxType, EFFECT_RECORD_PARAMS, fxParams, SIDECHAIN_KEY_PARAM } from "./effectKinds";
import type { CommandWriter } from "./commandWriter";
import type { BedPlanner } from "./beds";
import type { CoreAutomation } from "./coreAutomation";
import type { StatusMirror } from "./mirror";
import type { VoiceTable } from "./voiceTable";
import type { Presence } from "./presence";

/**
 * Maps a `BusEffect` to its wire record (§4.2 BUS_CONFIG: q in dB, p unused = 0). A catalogue effect (ADR 0345, ABI 4.6)
 * is `BUS_FX_CATALOGUE` plus its kind (`effectKinds.ts`), its parameters in the catalogue's order; a sidechain
 * compressor's key bus goes in `p[3]` as its slot (`slotOf`; -1, no key, when it names no bus). ABI 4.8: the parameters
 * a snapshot override holds (`held`) set the type's bits 16-31, so the core's automation leaves them. ABI 5.0: 16 parameters; a
 * registered plugin effect is `BUS_FX_CATALOGUE + FX_PLUGIN_BASE + e` (`effectKinds.ts`).
 */
/** ABI 4.8: the held bits of a catalogue effect (bit i: the type's parameter i, named in `held`, waits out its automation; 16 bits from ABI 5.0). */
function heldMask(type: CoreEffectType | string, held: readonly string[] | undefined): number {
  if (!held || held.length === 0) return 0;
  let mask = 0;
  effectSpec(type as CoreEffectType).params.forEach((q, i) => { if (i < EFFECT_RECORD_PARAMS && held.includes(q.name)) mask |= 1 << i; });
  return mask;
}

export function wireEffect(e: BusEffect, slotOf: (name: string) => number = () => -1): BusConfigBusesEffects {
  const p = new Array<number>(EFFECT_RECORD_PARAMS).fill(0);
  switch (e.type) {
    case "fx": {
      const q = fxParams(e.fx, e.params, EFFECT_RECORD_PARAMS);
      if (e.fx === "sidechainCompressor") q[SIDECHAIN_KEY_PARAM] = e.key ? slotOf(e.key) : -1;
      return { type: (busFxType(e.fx) | (heldMask(e.fx, e.held) << BUS_FX_HELD_SHIFT)) >>> 0, p: q };
    }
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
  readonly writer: Pick<CommandWriter, "busConfig" | "setParams" | "busSlot" | "fadeShaped" | "busSends" | "sampleRate">;
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
  /** ADR 0176: live slot `i` moves to bus `to` on main (the table's bus and counts, the mixer's counts, presence; `voices.moveBus`). */
  moveVoice(i: number, to: number): void;
}

export class BusIndex {
  /** The session slot table (Sm1): name → core slot for this Play session (§6.3). */
  readonly slots = new SlotTable((effects) => effects.map((e) => wireEffect(e, (n) => this.slotOf(n))));
  /** The bus names by slot (root first), as configured and live-edited. */
  names: string[] = [];
  /** Name → slot (a live rename's old name too): the one map every consumer reads (architecture §4.7). Kept as one object. */
  readonly busIndexByName = new Map<string, number>();
  private readonly planParents = new Int16Array(MAX_BUSES);
  /** The settings object the beds were last planned from (E7: a settings change that keeps the bus names plans them again). */
  private bedsPlannedFrom: AudioSettings | null = null;
  /** ADR 0344: the live effects each slot's last `BUS_SLOT` (or `BUS_CONFIG`) carried, by slot. */
  private sentEffects: (readonly BusEffect[] | undefined)[] = [];
  /**
   * ADR 0344: what each slot's last `BUS_SENDS` carried, by slot, as a key (`to` slot, level, muted per send; "" none,
   * null unknown: the next `syncSends` writes the slot whatever it holds).
   */
  private sentSends: (string | null)[] = new Array<string | null>(MAX_BUSES).fill("");
  /** ADR 0344: the sends each slot's last `BUS_SENDS` carried, by slot (for a removed send's fade, `withFadingSends`). */
  private sentWire: (readonly BusSendsSends[] | undefined)[] = [];

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
    this.syncEffects();
    this.syncSends();
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
    // ADR 0344: every configured slot's sends, after BUS_CONFIG (a slot it kept keeps the sends it had on the core, so a
    // slot that had some is written again, empty or not).
    for (let s = 0; s < this.sentSends.length; s++) if (this.sentSends[s] !== "") this.sentSends[s] = null;
    this.syncSends();
    this.host.applyMix(mixer.resolveAll());
  }

  /**
   * ADR 0344 (ABI 4.7): slot `s`'s sends as the wire takes them, from the mixer's live sends (`_busSends`): each into a
   * return's slot (a send to a bus with no slot, or to itself, is left out until it has one), at most `MAX_BUS_SENDS`.
   * A tombstone or a free slot has none.
   */
  private wireSends(s: number): BusSendsSends[] {
    const slot = this.slots.slots[s];
    const live: readonly LiveBusSend[] = slot && slot.state === "live" && slot.name !== null ? (this.host.mixer._busSends(slot.name) ?? []) : [];
    if (live.length === 0) return [];
    const frames = Math.round((DRAG_RAMP_MS / 1000) * this.host.writer.sampleRate);
    const out: BusSendsSends[] = [];
    for (const send of live) {
      const to = this.slotOf(send.to);
      if (to < 0 || to === s || out.length >= MAX_BUS_SENDS) continue;
      out.push({ to, flags: send.muted ? BUS_SEND_MUTED : 0, level: send.level, frames });
    }
    return out;
  }

  /** A slot's sends as `sentSends` keys them. */
  private static sendsKey(sends: readonly BusSendsSends[]): string {
    let k = "";
    for (const x of sends) k += `${x.to}:${x.level}:${x.flags};`;
    return k;
  }

  /**
   * `sends` with each send slot `s` last carried and no longer has kept as muted (the core drops a send missing from a
   * `BUS_SENDS` at once, a click; a muted one ramps to 0 over its frames and costs nothing once silent), while there is
   * room and its return still holds that slot. Not after a configure (the slots may have moved).
   */
  private withFadingSends(s: number, sends: BusSendsSends[]): BusSendsSends[] {
    const prev = this.sentSends[s] === null ? undefined : this.sentWire[s];
    if (!prev || prev.length === 0) return sends;
    const returns = this.host.mixer.returnNames;
    for (const p of prev) {
      if (sends.length >= MAX_BUS_SENDS) break;
      if (sends.some((x) => x.to === p.to) || !returns.includes(this.names[p.to] ?? "")) continue;
      sends.push({ ...p, flags: p.flags | BUS_SEND_MUTED });
    }
    return sends;
  }

  /**
   * ADR 0344: one `BUS_SENDS` (asap) for each slot whose sends moved since its last write: a send added, removed (kept
   * muted while it fades, `withFadingSends`) or retargeted (its return moved slot), a level (a live edit or its
   * automation; ramped over `DRAG_RAMP_MS`), a mute.
   */
  syncSends(): void {
    const configured = this.slots.slots.length;
    for (let s = 0; s < MAX_BUSES; s++) {
      if (s >= configured) {
        // A slot past the configured ones: BUS_CONFIG silenced it and cleared its state on the core.
        this.sentSends[s] = "";
        this.sentWire[s] = undefined;
        continue;
      }
      const sends = this.withFadingSends(s, this.wireSends(s));
      const key = BusIndex.sendsKey(sends);
      if (key === this.sentSends[s]) continue;
      this.host.writer.busSends(s, sends);
      this.sentSends[s] = key;
      this.sentWire[s] = sends;
    }
  }

  /**
   * ADR 0344: the rebuild's sends (after RESET and BUS_CONFIG, asap): every slot's sends now, which become what the core
   * holds (a slot that had some is written empty too, for a core that kept them).
   */
  replaySends(b: ReplayBuilder): void {
    for (let s = 0; s < MAX_BUSES; s++) {
      const sends = s < this.slots.slots.length ? this.wireSends(s) : [];
      if (sends.length === 0 && this.sentSends[s] === "") continue;
      if (s < this.slots.slots.length) b.record(16 + 12 * sends.length, (view, off) => writeBusSends(view, off, { voiceId: s, frameOffset: ASAP, sends }));
      this.sentSends[s] = BusIndex.sendsKey(sends);
      this.sentWire[s] = sends;
    }
  }

  /** BUS_CONFIG's buses in slot order (the table's tree, each bus's live effects; also the hard rebuild's replay, A3.4a). */
  busConfigWire(mixer: Mixer = this.host.mixer): BusConfigBuses[] {
    const settings = mixer.audioSettings;
    const live = settings.buses.map((b) => ({ ...b, effects: (mixer._busEffects(b.name) ?? b.effects) as BusEffect[] }));
    this.sentEffects = this.slots.slots.map((slot) => (slot.state === "live" ? live.find((b) => b.name === slot.name)?.effects : undefined));
    return this.slots.configWire({ ...settings, buses: live }) as BusConfigBuses[];
  }

  /**
   * ADR 0344: one `BUS_SLOT` for each live slot whose live effects moved since its last write, when only their values
   * did (the same effect types in the same order): a snapshot override, an automation value, a send following its
   * return. A different chain waits for the live op that changes it (its `BUS_SLOT` goes through `writeSlot`).
   */
  syncEffects(): void {
    const mixer = this.host.mixer;
    const slots = this.slots.slots;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]!;
      if (slot.state !== "live" || slot.name === null) continue;
      const live = mixer._busEffects(slot.name);
      const sent = this.sentEffects[s];
      if (!live || live === sent || !sent) continue;
      if (live.length !== sent.length || live.some((e, i) => e.type !== sent[i]!.type)) continue;
      if (live.every((e, i) => JSON.stringify(e) === JSON.stringify(sent[i]))) { this.sentEffects[s] = live; continue; }
      this.writeSlot(slot.name);
    }
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
    // A fresh slot starts with no sends on the core (ADR 0344); the next `syncSends` gives it its own.
    if (fresh) {
      this.sentSends[s] = "";
      this.sentWire[s] = undefined;
    }
    return s;
  }

  /** Slot `s`'s `BUS_SLOT` body now: a live bus's parent and effects (from the mixer's settings); a tombstone or a free slot is a silent root. */
  slotConfig(s: number): { slot: number; parent: number; effects: BusConfigBusesEffects[] } {
    const slot = this.slots.slots[s];
    if (!slot || slot.state !== "live") return { slot: s, parent: BUS_ROOT, effects: [] };
    const bus = this.host.mixer.audioSettings.buses.find((b) => b.name === slot.name);
    // ADR 0344: the live effects (the authored chain with the main thread's values in).
    const effects = (bus ? this.host.mixer._busEffects(bus.name) : undefined) ?? bus?.effects ?? [];
    this.sentEffects[s] = effects;
    return { slot: s, parent: slot.parent < 0 ? BUS_ROOT : slot.parent, effects: effects.map((e) => wireEffect(e, (n) => this.slotOf(n))) };
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
   * The per-voice dip, main's side (§6.5), at the op: every live voice on one of `from` moves to slot `to` (`host.moveVoice`: the
   * table's slot and counts, the mixer's counts and presence), so selection and new plays see the end state at
   * once. Returns the moved voices' ids for `dipVoices`.
   */
  moveVoices(from: ReadonlySet<number>, to: number): number[] {
    const host = this.host;
    const t = host.table;
    const ids: number[] = [];
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] === VoiceState.FREE || !from.has(t.bus[i]!)) continue;
      host.moveVoice(i, to);
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
