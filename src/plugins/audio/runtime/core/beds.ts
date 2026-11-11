// The bed planner on main (ADR 0162; api-and-models §2.1 bed resolution, architecture §1 "Bed planner", §2.1; C2, S15,
// R1, R8). Runs when the bus tree, `audio.bed.maxBeds`, a bus's `bed` or `bedPriority` changes (the core backend calls
// `plan` after BUS_CONFIG): `resolveBeds` (below, pure) resolves `own` / `parent` / `none` down the tree, gives the `own`
// buses with the highest `bedPriority` the core's bed slots (at most the `max_beds` laid out), keeps a slot's id while it
// keeps its host, and the planner sends BED_CONFIG and warns which buses lost a bed. The panner pick reads `bedSlot` per
// bus; a hard rebuild replays BED_CONFIG right after BUS_CONFIG (C10's order).
//
// The sharing chain: a voice on bus B mixed into the bed of an ancestor host A skips the buffers of B and of every bus
// between B and A, so those buses' snapshot low-passes no longer reach it through the core. `foldLowpass` computes, per
// bus, the lowest of them (B up to, excluding, A); the backend writes it into the voice's low-pass (`LowpassBy.SNAPSHOT`,
// S3, architecture §4.3). The core folds the gains.
//
// A bed exists only where the core laid out a slot (`max_beds`, from `bedInitParams`): with 0 laid out nothing here
// plans, sends or reports, exactly as M2.
import type { AudioSettings, BusBed } from "../../../../engine/audio/settings";
import { busBed, busBedPriority, MAX_BUSES } from "../../../../engine/audio/settings";
import type { AudioBedDebug } from "../backend";
import { ASAP, BED_HOST_NONE, BED_SLOT_NONE, BUS_LP_OFF_HZ, LP_TOP, MAX_BEDS, writeBedConfig } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { ReplayBuilder } from "./replay";

/** @internal The bed planner's counters for `Audio.debug()` (C24). */
export interface BedCounters {
  /** Buses whose bed slot changed in a replan (each starts the core's 45 ms dual-encode crossfade). */
  bedSwitches: number;
  /** Buses that asked for their own bed in the current plan and were outranked. */
  bedDenied: number;
}

/** @internal What `resolveBeds` takes: the tree and each bus's bed setting. */
export interface BedResolveInput {
  /** Buses, root first (at most `MAX_BUSES` are read). */
  readonly busCount: number;
  /** Per bus: its parent's index, -1 for the root. */
  readonly parents: ArrayLike<number>;
  /** Per bus: `own`, `parent` or `none` (the defaults applied). */
  readonly modes: ArrayLike<BusBed>;
  /** Per bus: 0..255, higher wins a slot (the defaults applied). */
  readonly priorities: ArrayLike<number>;
  /** The slots available: `min(audio.bed.maxBeds, max_beds laid out)`, 0..4. 0: no beds. */
  readonly maxBeds: number;
  /** Per slot: the host bus index of the plan being replaced (-1 or `BED_HOST_NONE` for none), so a host keeps its slot id. */
  readonly previousHosts?: ArrayLike<number>;
}

/** @internal What `resolveBeds` returns (BED_CONFIG's two arrays plus who won and lost). */
export interface BedResolution {
  /** Per bus (`busCount` long): its bed slot, `BED_SLOT_NONE` (0xFF) without one. */
  readonly bedSlot: Uint8Array;
  /** Per slot (`MAX_BEDS` long): its host bus, `BED_HOST_NONE` for an unused slot. */
  readonly hostBus: Uint16Array;
  /** Slots in use as BED_CONFIG sends them: the highest used slot + 1 (holes read `BED_HOST_NONE`). */
  slotCount: number;
  /** The hosts, in rank order (the best first). */
  readonly winners: number[];
  /** The buses that asked `own` and were outranked, in rank order: they share the nearest hosted ancestor's bed, if any. */
  readonly denied: number[];
  /** True when nobody asked `own` and the root was granted slot 0 implicitly. */
  implicitRoot: boolean;
}

/**
 * The bed resolution (api-and-models §2.1, architecture §2.1; R8). Pure.
 *
 * 1. Candidates are the buses asking `own`, sorted by `bedPriority` (higher first), then depth (shallower first), then
 *    index. The first `maxBeds` host a bed; the rest are **denied** and share like `parent` buses. The root defaults to
 *    `own` priority 255 (a setting default, `busBed` / `busBedPriority`), so at the default priority 128 ties go to the
 *    shallowest bus; nothing hard-codes "Master first".
 * 2. When nobody asks `own`, `maxBeds > 0` and the root isn't `none`, the root is granted slot 0 implicitly.
 * 3. A `parent` bus, or a denied `own` bus, feeds the nearest hosted ancestor's slot; with no hosted ancestor it is flat
 *    (the core pans it equal-power). A `none` bus is flat itself; its own `parent` descendants still reach a hosted
 *    ancestor above it.
 * 4. A slot keeps its id while its host keeps hosting (`previousHosts`), so decoder state survives a replan; new hosts
 *    take the lowest free slot in rank order.
 * 5. `maxBeds` 0: no beds, nothing denied (the setting turned them off).
 */
export function resolveBeds(input: BedResolveInput): BedResolution {
  const n = Math.max(0, Math.min(Math.floor(input.busCount), MAX_BUSES));
  const maxBeds = Math.max(0, Math.min(Math.floor(input.maxBeds) || 0, MAX_BEDS));
  const bedSlot = new Uint8Array(n).fill(BED_SLOT_NONE);
  const hostBus = new Uint16Array(MAX_BEDS).fill(BED_HOST_NONE);
  const res: BedResolution = { bedSlot, hostBus, slotCount: 0, winners: [], denied: [], implicitRoot: false };
  if (n === 0 || maxBeds === 0) return res;

  const parentOf = (b: number): number => {
    const p = input.parents[b];
    return p !== undefined && Number.isInteger(p) && p >= 0 && p < n && p !== b ? p : -1;
  };
  const depth = new Int32Array(n);
  for (let b = 0; b < n; b++) {
    let d = 0;
    for (let p = parentOf(b); p >= 0 && d <= n; p = parentOf(p)) d++;
    depth[b] = d;
  }
  const priorityOf = (b: number): number => {
    const v = input.priorities[b];
    return v !== undefined && Number.isFinite(v) ? v : 128;
  };

  const candidates: number[] = [];
  for (let b = 0; b < n; b++) if (input.modes[b] === "own") candidates.push(b);
  if (candidates.length === 0 && input.modes[0] !== "none") {
    candidates.push(0);
    res.implicitRoot = true;
  }
  candidates.sort((a, b) => priorityOf(b) - priorityOf(a) || depth[a]! - depth[b]! || a - b);
  for (let k = 0; k < candidates.length; k++) (k < maxBeds ? res.winners : res.denied).push(candidates[k]!);

  // Slot ids: a host keeps the slot it had, the others take the lowest free one in rank order.
  const slotOfHost = new Int16Array(n).fill(-1);
  const taken = [false, false, false, false];
  const previous = input.previousHosts;
  if (previous) {
    for (let s = 0; s < maxBeds && s < previous.length; s++) {
      const host = previous[s]!;
      if (host >= 0 && host < n && host !== BED_HOST_NONE && res.winners.includes(host) && slotOfHost[host] < 0) {
        slotOfHost[host] = s;
        taken[s] = true;
      }
    }
  }
  for (const w of res.winners) {
    if (slotOfHost[w]! >= 0) continue;
    let s = 0;
    while (s < maxBeds && taken[s]) s++;
    slotOfHost[w] = s;
    taken[s] = true;
  }
  for (const w of res.winners) {
    const s = slotOfHost[w]!;
    hostBus[s] = w;
    if (s + 1 > res.slotCount) res.slotCount = s + 1;
  }

  // Every bus: its own slot if it hosts, else (unless `none`) the nearest hosted ancestor's.
  for (let b = 0; b < n; b++) {
    if (slotOfHost[b]! >= 0) {
      bedSlot[b] = slotOfHost[b]!;
      continue;
    }
    if (input.modes[b] === "none") continue;
    for (let p = parentOf(b), guard = 0; p >= 0 && guard <= n; p = parentOf(p), guard++) {
      if (slotOfHost[p]! >= 0) {
        bedSlot[b] = slotOfHost[p]!;
        break;
      }
    }
  }
  return res;
}

const pad4 = (n: number): number => (n + 3) & ~3;

/** @internal The bus → bed-slot map and each slot's host (constructed by the core backend). */
export class BedPlanner {
  readonly counters: BedCounters = { bedSwitches: 0, bedDenied: 0 };
  /** Per bus index: its bed slot, `BED_SLOT_NONE` without one. */
  readonly bedSlot = new Uint8Array(MAX_BUSES).fill(BED_SLOT_NONE);
  /** Per slot: its host bus index (`BED_HOST_NONE` when unused), `slotCount` valid. */
  readonly hostBus = new Uint16Array(MAX_BEDS).fill(BED_HOST_NONE);
  /** Slots in use. */
  slotCount = 0;
  /** Per bus: the lowest snapshot low-pass from it up to, excluding, its bed's host, Hz (`BUS_LP_OFF_HZ`: none). */
  readonly chainLowpass = new Float32Array(MAX_BUSES).fill(BUS_LP_OFF_HZ);
  /** Buses in the last plan. */
  busCount = 0;

  private names: string[] = [];
  private modes: BusBed[] = [];
  private parents = new Int16Array(MAX_BUSES).fill(-1);
  private denied: { bus: number; reason: string }[] = [];
  /** The slots BED_CONFIG last told the core about (0 until the first plan that has a bed). */
  private sentSlots = 0;

  constructor(
    private readonly writer: Pick<CommandWriter, "bedConfig">,
    /** The slots the core laid out (`max_beds`, 0..4). */
    readonly maxBeds: number,
    /** The one warning when buses lose their bed (default `console.warn`). */
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {}

  /**
   * Plans the beds for the tree last configured (`busNames` root first, `parents[b]` the parent's index or -1) and sends
   * BED_CONFIG after BUS_CONFIG: whenever a bed exists, and once more when the last one goes (so the core frees them).
   * With no slot laid out, or none planned and none sent, nothing.
   */
  plan(settings: AudioSettings, busNames: readonly string[], parents: ArrayLike<number>): void {
    const limit = Math.min(this.maxBeds, settings.bed.maxBeds);
    if (limit <= 0 && this.sentSlots === 0) {
      this.clearPlan();
      return;
    }
    const n = Math.min(busNames.length, MAX_BUSES);
    const modes: BusBed[] = [];
    const priorities: number[] = [];
    const parentIdx: number[] = [];
    for (let b = 0; b < n; b++) {
      modes.push(busBed(settings, busNames[b]!));
      priorities.push(busBedPriority(settings, busNames[b]!));
      parentIdx.push(parents[b] ?? -1);
    }
    // The old hosts by name, as indices in the new tree (a bus moved in the tree keeps its slot).
    const previousHosts: number[] = [];
    for (let s = 0; s < MAX_BEDS; s++) {
      const old = s < this.slotCount ? this.hostBus[s]! : BED_HOST_NONE;
      previousHosts.push(old === BED_HOST_NONE ? -1 : busNames.indexOf(this.names[old] ?? ""));
    }
    const oldSlot = Uint8Array.from(this.bedSlot);
    const oldNames = this.names;
    const hadBeds = this.slotCount > 0;
    const oldDenied = this.denied.map((d) => oldNames[d.bus]).join(",");
    const res = resolveBeds({ busCount: n, parents: parentIdx, modes, priorities, maxBeds: limit, previousHosts });

    this.names = busNames.slice(0, n);
    this.modes = modes;
    this.parents.fill(-1);
    for (let b = 0; b < n; b++) this.parents[b] = parentIdx[b]!;
    this.busCount = n;
    this.bedSlot.fill(BED_SLOT_NONE);
    this.bedSlot.set(res.bedSlot);
    this.hostBus.set(res.hostBus);
    this.slotCount = res.slotCount;

    // The buses that moved to another slot (or into or out of one) start a crossfade in the core.
    if (hadBeds) {
      for (let b = 0; b < n; b++) {
        const at = oldNames.indexOf(this.names[b]!);
        const was = at >= 0 ? oldSlot[at]! : BED_SLOT_NONE;
        if (was !== res.bedSlot[b]) this.counters.bedSwitches++;
      }
    }

    this.denied = res.denied.map((bus) => ({ bus, reason: this.reasonFor(res.winners, limit) }));
    this.counters.bedDenied = this.denied.length;
    if (this.denied.length > 0 && oldDenied !== this.denied.map((d) => this.names[d.bus]).join(",")) {
      this.warn(`[myco] audio: ${this.denied.map((d) => `bus "${this.names[d.bus]}"`).join(", ")} asked for a bed of its own and didn't get one (${this.denied[0]!.reason}); it shares the nearest hosted ancestor's bed.`);
    }

    if (this.slotCount > 0 || this.sentSlots > 0) {
      this.writer.bedConfig(this.bedSlot.subarray(0, n), this.hostBus.subarray(0, this.slotCount));
      this.sentSlots = this.slotCount;
    }
  }

  private clearPlan(): void {
    if (this.slotCount === 0 && this.denied.length === 0 && this.busCount === 0) return;
    this.bedSlot.fill(BED_SLOT_NONE);
    this.hostBus.fill(BED_HOST_NONE);
    this.slotCount = 0;
    this.denied = [];
    this.counters.bedDenied = 0;
  }

  private reasonFor(winners: readonly number[], limit: number): string {
    const names = winners.map((w) => `"${this.names[w]}"`).join(", ");
    return `outranked by ${names} for the ${limit} bed slot${limit === 1 ? "" : "s"}`;
  }

  /** Bus `b`'s bed slot (`BED_SLOT_NONE` without one). */
  bedSlotOf(b: number): number {
    return b >= 0 && b < MAX_BUSES ? this.bedSlot[b]! : BED_SLOT_NONE;
  }

  /** The host bus index of bus `b`'s bed, or -1 without one. */
  hostOf(b: number): number {
    const s = this.bedSlotOf(b);
    return s === BED_SLOT_NONE || s >= MAX_BEDS || this.hostBus[s] === BED_HOST_NONE ? -1 : this.hostBus[s]!;
  }

  /**
   * The sharing chain's snapshot low-pass (S3, architecture §4.3): for each bus `b` mixed into a bed it doesn't host,
   * the lowest `snapshotLp[k]` over the buses from `b` up to, excluding, the host (Hz; `LP_TOP` and above is no
   * low-pass). Fills `chainLowpass` (`BUS_LP_OFF_HZ`: none, also for a bus without a bed or hosting its own) and
   * returns true when any value changed.
   */
  foldLowpass(snapshotLp: ArrayLike<number>, busCount: number = this.busCount): boolean {
    const out = this.chainLowpass;
    let changed = false;
    for (let b = 0; b < MAX_BUSES; b++) {
      let lowest = BUS_LP_OFF_HZ;
      const host = b < busCount ? this.hostOf(b) : -1;
      if (host >= 0 && host !== b) {
        for (let k = b, guard = 0; k >= 0 && k !== host && guard < MAX_BUSES; k = this.parents[k]!, guard++) {
          const hz = snapshotLp[k];
          if (hz !== undefined && hz < LP_TOP && hz < lowest) lowest = hz;
        }
      }
      if (out[b] !== Math.fround(lowest)) {
        out[b] = lowest;
        changed = true;
      }
    }
    return changed;
  }

  /** A hard rebuild: BED_CONFIG for the current plan, right after BUS_CONFIG (C10). Nothing while no slot is used. */
  replay(b: ReplayBuilder): void {
    if (this.slotCount === 0) return;
    const n = this.busCount;
    const bedSlot = this.bedSlot.subarray(0, n);
    const hostBus = this.hostBus.subarray(0, this.slotCount);
    b.record(20 + pad4(n) + pad4(2 * this.slotCount), (view, off) => writeBedConfig(view, off, { voiceId: 0, frameOffset: ASAP, bedSlot, hostBus }));
  }

  /**
   * `AudioDebugInfo.beds` (§1.6); undefined while no bed is laid out (a backend without beds leaves it out). The core's
   * STATUS `beds` section (host bus, voices, work units per active slot) fills `voices` and `costUs` (a work unit is
   * about a nanosecond, C18); `clips` is B5's.
   */
  debug(status?: { readonly bedCount: number; readonly bedBus: ArrayLike<number>; readonly bedVoiceCount: ArrayLike<number>; readonly bedWork: ArrayLike<number> }): AudioBedDebug[] | undefined {
    if (this.maxBeds <= 0) return undefined;
    const rows: AudioBedDebug[] = [];
    for (let s = 0; s < this.slotCount; s++) {
      const host = this.hostBus[s]!;
      if (host === BED_HOST_NONE) continue;
      const sharing: string[] = [];
      for (let b = 0; b < this.busCount; b++) if (this.bedSlot[b] === s && b !== host) sharing.push(this.names[b]!);
      // A denied bus is listed on the bed it falls back to.
      const denied = this.denied.filter((d) => this.bedSlot[d.bus] === s).map((d) => ({ bus: this.names[d.bus]!, reason: d.reason }));
      let voices = 0;
      let work = 0;
      for (let k = 0; status && k < status.bedCount; k++) {
        if (status.bedBus[k] === host) {
          voices = status.bedVoiceCount[k]!;
          work = status.bedWork[k]!;
        }
      }
      rows.push({ slot: s, bus: this.names[host]!, sharing, denied, voices, clips: 0, costUs: work / 1000 });
    }
    return rows;
  }

  /** `AudioDebugInfo.buses[b]`'s bed fields: the setting, the bus whose bed it mixes into (null: none), and whether it asked for its own and lost. */
  busDebug(b: number): { bed: BusBed; bedHost: string | null; bedLost: boolean } {
    const host = this.hostOf(b);
    return {
      bed: this.modes[b] ?? "parent",
      bedHost: host >= 0 ? (this.names[host] ?? null) : null,
      bedLost: this.denied.some((d) => d.bus === b),
    };
  }

  /** The buses (names) that lost their bed and why, for the editor (E3). */
  deniedBuses(): readonly { bus: string; reason: string }[] {
    return this.denied.map((d) => ({ bus: this.names[d.bus]!, reason: d.reason }));
  }
}
