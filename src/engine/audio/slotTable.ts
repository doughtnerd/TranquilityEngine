/**
 * Internal (ADR 0171 amended by 0172; api-and-models §6.3, architecture §2.3, §4.7): the session slot table, which maps a
 * bus name to its core slot for one Play session. `coreBackend` owns one instance. Until the first structural edit the
 * table is today's mapping (slot = position in `project.json`) and no wire byte changes; a removed bus is a tombstone (a
 * silent root) until it recycles, a rename keeps the slot and aliases the old name, an add with no free slot is deferred
 * (R10). Compaction is `reset(settings)` at the next configure.
 *
 * Pure: no plugin, no DOM. Contract K0 declares the shapes; task Sm1 fills the bodies (each stub throws "Sm1"); Ma2
 * adds the tombstone remap.
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

/** An add that found no free slot (R10): the edit is kept and retried at each recycle; the message says when it applies. */
export interface SlotDeferred { deferred: string }

/** Called for each slot `recycle` frees: the caller re-sends it as `fresh` on reuse and forgets per-slot state. */
export type SlotRecycled = (slot: number, oldGen: number) => void;

/** The session slot table (§6.3). */
export class SlotTable {
  /** At most `MAX_BUSES` (32): tombstones count. */
  readonly slots: Slot[] = [];
  readonly byName = new Map<string, number>();
  /** Old name -> new, for held `Bus` handles after a rename (one warning on use). */
  readonly aliases = new Map<string, string>();
  /** Bumped by every structural op; stored in keyframes. */
  version = 0;

  /** `effectsOf(effects)` maps a bus's effects to wire form for `configWire` (the backend passes its `wireEffect`). */
  constructor(protected readonly effectsOf: (effects: readonly BusEffect[]) => { type: number; p: number[] }[] = () => []) {}

  /** Sm1: a new live bus under `parent`: the first free slot, else the next index; with none, `deferred` (R10). */
  add(_name: string, _parent: string): number | SlotDeferred {
    throw new Error("Sm1");
  }
  /** Sm1: tombstones the bus and its descendants at `frame`; returns their slots. */
  remove(_name: string, _frame: number): number[] {
    throw new Error("Sm1");
  }
  /** Sm1: renames in place (no wire); the old name aliases the new one. */
  rename(_from: string, _to: string): void {
    throw new Error("Sm1");
  }
  /** Sm1: re-parents a live bus. */
  move(_name: string, _parent: string): void {
    throw new Error("Sm1");
  }
  /** Sm1: undoes a remove before the slot recycled: the same slot comes back live (and its descendants). Returns the slots, or null when it already recycled. */
  resurrect(_name: string): number[] | null {
    throw new Error("Sm1");
  }
  /** Sm1: frees each tombstone past its `recycleAfterFrame` with no live voice (`liveVoicesOn(slot) === 0`), bumping `gen` and calling `onRecycled`. Returns the freed slots. */
  recycle(_frame: number, _liveVoicesOn: (slot: number) => number, _onRecycled?: SlotRecycled): number[] {
    throw new Error("Sm1");
  }
  /** Sm1: the live slot for a name, through `aliases`; -1 when unknown. */
  slotOf(_name: string): number {
    throw new Error("Sm1");
  }
  /** Sm1: `BUS_CONFIG`'s buses in slot order; tombstones are silent roots, free slots are omitted past the last used one and silent roots before it. */
  configWire(_settings: AudioSettings): SlotConfigBus[] {
    throw new Error("Sm1");
  }
  /** Sm1: the replay's configuration after a rebuild (R12): `configWire` plus each tombstone's dip held at 0. */
  replay(_settings: AudioSettings): { buses: SlotConfigBus[]; tombstones: number[] } {
    throw new Error("Sm1");
  }
  /** Sm1: `gen << 8 | slot`. */
  busRef(_slot: number): number {
    throw new Error("Sm1");
  }
  /** Sm1: at the next configure (compaction at Stop): slot = position in `project.json`, aliases cleared, version 0. */
  reset(_settings: AudioSettings): void {
    throw new Error("Sm1");
  }
}
