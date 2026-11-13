/**
 * Internal (ADR 0171 amended by 0172; api-and-models §6.3, architecture §2.3, §4.7): the session slot table, which maps a
 * bus name to its core slot for one Play session. `coreBackend` owns one instance. Until the first structural edit the
 * table is today's mapping (slot = position in `project.json`) and no wire byte changes; a removed bus is a tombstone (a
 * silent root) until it recycles, a rename keeps the slot and aliases the old name, an add with no free slot is deferred
 * (R10). Compaction is `reset(settings)` at the next configure.
 *
 * Pure: no plugin, no DOM. Contract K0 declares the shapes; task Sm1 filled the bodies; Ma2 adds the tombstone remap.
 *
 * Invariants (the property tests check them): every live slot has a live parent or is a root (`parent` -1); a tombstone
 * and a free slot have `parent` -1; `byName` maps exactly the live buses; a slot's `gen` only grows (mod 2^16) and only
 * when it recycles; `recycle` never frees a slot `liveVoicesOn` reports a voice on, nor one before its
 * `recycleAfterFrame`; `configWire()` has one entry per slot up to the last non-free one.
 */
import type { AudioSettings, BusEffect } from "./settings";

/** One slot's lifecycle state. */
export type SlotState = "free" | "live" | "tombstone";

/** One core bus slot (§6.3). */
export interface Slot {
  state: SlotState;
  /** The bus's name while live or a tombstone; null when free. */
  name: string | null;
  /** u16 generation, incremented when the slot recycles, so a capture's `busRef` never names two buses. */
  gen: number;
  /** Parent slot, -1 for a root (a tombstone is a silent root). */
  parent: number;
  /** Epoch frame after which a tombstone may recycle (its dip ended + `TOMBSTONE_TAIL_FRAMES`); 0 when not a tombstone. */
  recycleAfterFrame: number;
}

/**
 * One bus as `BUS_CONFIG` carries it (structurally the wire's `BusConfigBuses`, kept here so the engine imports no
 * plugin): the parent slot (`SLOT_ROOT` for a root) and the effects in wire form.
 */
export interface SlotConfigBus {
  parent: number;
  effects: { type: number; p: number[] }[];
}

/** `BUS_ROOT` of the wire: a root's parent in `configWire()`. */
export const SLOT_ROOT = 0xffff;

/** Frames a tombstone waits after its dip ended before it may recycle (R9: one quantum). */
export const TOMBSTONE_TAIL_FRAMES = 128;

/** The core's slot count (`MAX_BUSES`, `settings.ts`; repeated here so this module imports nothing at run time). Tombstones count. */
export const SLOT_CAPACITY = 32;

/** An add that found no free slot (R10): the edit is kept and retried at each recycle; the message says when it applies. */
export interface SlotDeferred { deferred: string }

/** An add waiting for a free slot (R10), in the order it was asked. */
export interface SlotDeferredAdd {
  name: string;
  /** The parent's name (kept current if the parent is renamed while the add waits). */
  parent: string;
}

/** Called for each slot `recycle` frees: the caller re-sends it as `fresh` on reuse and forgets per-slot state. */
export type SlotRecycled = (slot: number, oldGen: number) => void;

/** Called for each deferred add `recycle` applied: the name and the slot it took. */
export type SlotDeferredApplied = (name: string, slot: number) => void;

/** What a `remove` remembers so `resurrect` can undo it. */
interface RemovedGroup {
  /** The slots removed together, with the generation each had; the first is the removed bus. */
  members: { slot: number; gen: number; parent: number; parentGen: number }[];
  /** Aliases that pointed at a removed name, restored with it. */
  aliases: [string, string][];
}

/** The session slot table (§6.3). */
export class SlotTable {
  /** At most `MAX_BUSES` (32): tombstones count. */
  readonly slots: Slot[] = [];
  readonly byName = new Map<string, number>();
  /** Old name -> new, for held `Bus` handles after a rename (one warning on use). */
  readonly aliases = new Map<string, string>();
  /** Bumped by every structural op; stored in keyframes. */
  version = 0;

  /** Adds waiting for a slot, oldest first (R10). Retried by `recycle`; emptied by `reset`. */
  private readonly queue: SlotDeferredAdd[] = [];
  /** Tombstone slot -> the removal that made it. */
  private readonly removed = new Map<number, RemovedGroup>();

  /** `effectsOf(effects)` maps a bus's effects to wire form for `configWire` (the backend passes its `wireEffect`). */
  constructor(protected readonly effectsOf: (effects: readonly BusEffect[]) => { type: number; p: number[] }[] = () => []) {}

  /** The adds waiting for a free slot (R10), oldest first. */
  get deferred(): readonly SlotDeferredAdd[] {
    return this.queue;
  }

  /** Sm1: a new live bus under `parent`: the first free slot, else the next index; with none, `deferred` (R10). */
  add(name: string, parent: string): number | SlotDeferred {
    if (this.byName.has(name)) throw new Error(`Bus "${name}" already exists`);
    const parentSlot = this.liveSlot(parent);
    if (parentSlot < 0 && !this.queue.some((q) => q.name === parent)) throw new Error(`Unknown parent bus "${parent}"`);
    const slot = parentSlot < 0 ? -1 : this.place(name, parentSlot);
    if (slot >= 0) {
      this.version++;
      return slot;
    }
    const waiting = this.queue.find((q) => q.name === name);
    if (waiting) waiting.parent = parent;
    else this.queue.push({ name, parent });
    return { deferred: `Bus "${name}" waits for a free bus slot (a removed bus is still fading out); it applies as soon as one frees, normally within about 40 ms` };
  }

  /** Sm1: tombstones the bus and its descendants at `frame`; returns their slots. */
  remove(name: string, frame: number): number[] {
    const queued = this.queue.findIndex((q) => q.name === name);
    if (queued >= 0) {
      // Never got a slot: drop it and whatever was waiting under it.
      this.dropQueued(name);
      this.version++;
      return [];
    }
    const top = this.byName.get(name);
    if (top === undefined) throw new Error(`Unknown bus "${name}"`);
    if (this.slots[top]!.parent < 0) throw new Error(`The root bus "${name}" can't be removed`);
    const slots = [top, ...this.descendants(top)];
    const group: RemovedGroup = { members: [], aliases: [] };
    const names = new Set<string>();
    for (const s of slots) {
      const slot = this.slots[s]!;
      const parent = slot.parent;
      group.members.push({ slot: s, gen: slot.gen, parent, parentGen: parent >= 0 ? this.slots[parent]!.gen : 0 });
      names.add(slot.name!);
      this.byName.delete(slot.name!);
    }
    for (const [from, to] of [...this.aliases]) {
      if (names.has(to)) {
        group.aliases.push([from, to]);
        this.aliases.delete(from);
      }
    }
    for (const s of slots) {
      const slot = this.slots[s]!;
      slot.state = "tombstone";
      slot.parent = -1;
      slot.recycleAfterFrame = frame + TOMBSTONE_TAIL_FRAMES;
      this.removed.set(s, group);
    }
    this.version++;
    return slots;
  }

  /** Sm1: renames in place (no wire); the old name aliases the new one. */
  rename(from: string, to: string): void {
    if (from === to) return;
    const queued = this.queue.find((q) => q.name === from);
    if (queued) {
      if (this.byName.has(to) || this.queue.some((q) => q.name === to)) throw new Error(`Bus "${to}" already exists`);
      queued.name = to;
      for (const q of this.queue) if (q.parent === from) q.parent = to;
      this.version++;
      return;
    }
    const slot = this.byName.get(from);
    if (slot === undefined) throw new Error(`Unknown bus "${from}"`);
    if (this.byName.has(to) || this.queue.some((q) => q.name === to)) throw new Error(`Bus "${to}" already exists`);
    this.byName.delete(from);
    this.byName.set(to, slot);
    this.slots[slot]!.name = to;
    for (const q of this.queue) if (q.parent === from) q.parent = to;
    // The new name is a real bus: an old alias of that name no longer stands. Older aliases of `from` now point at `to`.
    this.aliases.delete(to);
    for (const [old, target] of this.aliases) if (target === from) this.aliases.set(old, to);
    this.aliases.set(from, to);
    this.version++;
  }

  /** Sm1: re-parents a live bus. */
  move(name: string, parent: string): void {
    const queued = this.queue.find((q) => q.name === name);
    if (queued) {
      if (!this.byName.has(parent) && !this.queue.some((q) => q.name === parent)) throw new Error(`Unknown parent bus "${parent}"`);
      queued.parent = parent;
      this.version++;
      return;
    }
    const slot = this.byName.get(name);
    if (slot === undefined) throw new Error(`Unknown bus "${name}"`);
    const parentSlot = this.byName.get(parent);
    if (parentSlot === undefined) throw new Error(`Unknown parent bus "${parent}"`);
    if (this.slots[slot]!.parent < 0) throw new Error(`The root bus "${name}" can't be moved`);
    if (parentSlot === slot || this.descendants(slot).includes(parentSlot)) throw new Error(`Bus "${name}" can't move under itself`);
    this.slots[slot]!.parent = parentSlot;
    this.version++;
  }

  /** Sm1: undoes a remove before the slot recycled: the same slot comes back live (and its descendants). Returns the slots, or null when it already recycled. */
  resurrect(name: string): number[] | null {
    if (this.byName.has(name)) return null;
    // The most recent removal of that name (the same name can be removed, re-added and removed again).
    let found = -1;
    for (const [s, group] of this.removed) {
      if (this.slots[s]!.name !== name || group.members[0]!.slot !== s) continue;
      if (found < 0 || this.slots[s]!.recycleAfterFrame >= this.slots[found]!.recycleAfterFrame) found = s;
    }
    if (found < 0) return null;
    const group = this.removed.get(found)!;
    // All or nothing: a member that recycled (or whose name is taken now), or a parent that is gone, makes it a new bus.
    for (const m of group.members) {
      const slot = this.slots[m.slot]!;
      if (slot.state !== "tombstone" || slot.gen !== m.gen || this.removed.get(m.slot) !== group) return null;
      if (this.byName.has(slot.name!) || this.queue.some((q) => q.name === slot.name)) return null;
    }
    const inGroup = new Set(group.members.map((m) => m.slot));
    for (const m of group.members) {
      if (inGroup.has(m.parent)) continue;
      const p = this.slots[m.parent];
      if (m.parent >= 0 && (!p || p.state !== "live" || p.gen !== m.parentGen)) return null;
    }
    for (const m of group.members) {
      const slot = this.slots[m.slot]!;
      slot.state = "live";
      slot.parent = m.parent;
      slot.recycleAfterFrame = 0;
      this.byName.set(slot.name!, m.slot);
      this.removed.delete(m.slot);
    }
    for (const [from, to] of group.aliases) if (!this.byName.has(from) && !this.aliases.has(from)) this.aliases.set(from, to);
    this.version++;
    return group.members.map((m) => m.slot);
  }

  /**
   * Sm1: frees each tombstone past its `recycleAfterFrame` with no live voice (`liveVoicesOn(slot) === 0`), bumping `gen` and calling `onRecycled`. Returns the freed slots.
   * Then each deferred add that now fits is applied in the order it was asked (`onApplied` hears each).
   */
  recycle(frame: number, liveVoicesOn: (slot: number) => number, onRecycled?: SlotRecycled, onApplied?: SlotDeferredApplied): number[] {
    const freed: number[] = [];
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s]!;
      if (slot.state !== "tombstone" || frame < slot.recycleAfterFrame || liveVoicesOn(s) > 0) continue;
      const oldGen = slot.gen;
      slot.state = "free";
      slot.name = null;
      slot.gen = (oldGen + 1) & 0xffff;
      slot.parent = -1;
      slot.recycleAfterFrame = 0;
      this.removed.delete(s);
      freed.push(s);
      onRecycled?.(s, oldGen);
    }
    if (freed.length > 0) {
      this.version++;
      this.retryDeferred(onApplied);
    }
    return freed;
  }

  /** Sm1: the live slot for a name, through `aliases`; -1 when unknown. */
  slotOf(name: string): number {
    return this.liveSlot(name);
  }

  /** Sm1: `BUS_CONFIG`'s buses in slot order; tombstones are silent roots, free slots are omitted past the last used one and silent roots before it. */
  configWire(settings: AudioSettings): SlotConfigBus[] {
    const effects = new Map<string, readonly BusEffect[]>();
    for (const b of settings.buses) effects.set(b.name, b.effects);
    let end = this.slots.length;
    while (end > 0 && this.slots[end - 1]!.state === "free") end--;
    const out: SlotConfigBus[] = [];
    for (let s = 0; s < end; s++) {
      const slot = this.slots[s]!;
      if (slot.state !== "live") {
        out.push({ parent: SLOT_ROOT, effects: [] });
        continue;
      }
      out.push({ parent: slot.parent < 0 ? SLOT_ROOT : slot.parent, effects: this.effectsOf(effects.get(slot.name!) ?? []) });
    }
    return out;
  }

  /** Sm1: the replay's configuration after a rebuild (R12): `configWire` plus each tombstone's dip held at 0. */
  replay(settings: AudioSettings): { buses: SlotConfigBus[]; tombstones: number[] } {
    const tombstones: number[] = [];
    this.slots.forEach((slot, s) => {
      if (slot.state === "tombstone") tombstones.push(s);
    });
    return { buses: this.configWire(settings), tombstones };
  }

  /** Sm1: `gen << 8 | slot`. */
  busRef(slot: number): number {
    const s = this.slots[slot];
    return (((s ? s.gen : 0) << 8) | (slot & 0xff)) >>> 0;
  }

  /** Sm1: at the next configure (compaction at Stop): slot = position in `project.json`, aliases cleared, version 0. */
  reset(settings: AudioSettings): void {
    this.slots.length = 0;
    this.byName.clear();
    this.aliases.clear();
    this.queue.length = 0;
    this.removed.clear();
    this.version = 0;
    const buses = settings.buses;
    const n = Math.min(buses.length, SLOT_CAPACITY);
    for (let i = 0; i < n; i++) {
      this.byName.set(buses[i]!.name, i);
    }
    for (let i = 0; i < n; i++) {
      const parent = buses[i]!.parent;
      // As today's `busConfigWire`: no parent is a root, an unknown one is slot 0.
      this.slots.push({ state: "live", name: buses[i]!.name, gen: 0, parent: parent === undefined ? -1 : (this.byName.get(parent) ?? 0), recycleAfterFrame: 0 });
    }
  }

  /** The live slot `name` names, directly or through `aliases` (a chain, guarded against a loop); -1 when none. */
  private liveSlot(name: string): number {
    let n = name;
    for (let hops = 0; hops <= this.aliases.size; hops++) {
      const s = this.byName.get(n);
      if (s !== undefined) return s;
      const next = this.aliases.get(n);
      if (next === undefined) return -1;
      n = next;
    }
    return -1;
  }

  /** Takes the first free slot, else the next index, for a new live bus; -1 when there is none. */
  private place(name: string, parent: number): number {
    let s = this.slots.findIndex((x) => x.state === "free");
    if (s < 0) {
      if (this.slots.length >= SLOT_CAPACITY) return -1;
      s = this.slots.length;
      this.slots.push({ state: "free", name: null, gen: 0, parent: -1, recycleAfterFrame: 0 });
    }
    const slot = this.slots[s]!;
    slot.state = "live";
    slot.name = name;
    slot.parent = parent;
    slot.recycleAfterFrame = 0;
    this.byName.set(name, s);
    // A name that was an old alias is a real bus again.
    this.aliases.delete(name);
    return s;
  }

  /** The live slots below `slot`, in slot order. */
  private descendants(slot: number): number[] {
    const set = new Set<number>([slot]);
    const out: number[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      for (let s = 0; s < this.slots.length; s++) {
        const x = this.slots[s]!;
        if (x.state === "live" && !set.has(s) && set.has(x.parent)) {
          set.add(s);
          out.push(s);
          grew = true;
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** Drops a waiting add and every waiting add below it. */
  private dropQueued(name: string): void {
    const gone = new Set([name]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const q of this.queue) if (!gone.has(q.name) && gone.has(q.parent)) (gone.add(q.name), (grew = true));
    }
    for (let i = this.queue.length - 1; i >= 0; i--) if (gone.has(this.queue[i]!.name)) this.queue.splice(i, 1);
  }

  /** Applies each waiting add that fits, oldest first; one whose parent is gone for good is dropped, one whose parent still waits stays. */
  private retryDeferred(onApplied?: SlotDeferredApplied): void {
    for (let progress = true; progress && this.queue.length > 0; ) {
      progress = false;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i]!;
        const parent = this.byName.get(q.parent);
        if (parent === undefined) {
          if (!this.queue.some((o) => o.name === q.parent)) {
            this.queue.splice(i, 1);
            i--;
          }
          continue;
        }
        if (this.byName.has(q.name)) {
          this.queue.splice(i, 1);
          i--;
          continue;
        }
        const slot = this.place(q.name, parent);
        if (slot < 0) return;
        this.queue.splice(i, 1);
        this.version++;
        onApplied?.(q.name, slot);
        progress = true;
        i--;
      }
    }
  }
}
