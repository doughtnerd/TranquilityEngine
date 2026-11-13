// ADR 0171 amended by 0172 (M5, contract K0; plan seam; task Ma3): live bus additions that found no free core slot (R10,
// api-and-models §6.3, architecture §4.7). The edit stays in `project.json` (the editor's draft); the mixer's running
// model does not hold the bus until it has a slot. The slot table (`slotTable.ts`) keeps the waiting adds in order and
// takes a freed slot for the oldest at the same `recycle` that frees it; this queue keeps the op each one came from, so
// the main-side half of the add (the mixer's model, the slot's `BUS_SLOT` as `fresh`, the voice limits, the bed plan
// and the lanes) is done at that moment, exactly as for an add that found a slot at once. A fifth effect on a bus is not
// queued: it answers `restartRequired` ("applies at the next Play", `liveMix.ts`).
//
// - `LiveMix.apply` hands an add the table deferred to `defer`; `LiveMix` binds this to the backend's closures.
// - `retry` runs at every tombstone recycle (`LiveMix` wraps the dip's `recycle`, so the per-frame update, a structural
//   op and a live add all reach it) and finishes each queued add whose slot the table has taken. An add the table
//   dropped (its parent was removed while it waited) or that the mixer's model already holds (a new session's configure
//   read it from `project.json`) is forgotten.
// - `clear` forgets the queue (Stop, the next configure); `count` is the adds deferred so far, `pending` those waiting.
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";
import type { Mixer } from "../../../../engine/audio/mixer";
import type { BusIndex } from "./busIndex";

/** What finishing a deferred add needs of the backend (closures read it lazily). */
export interface DeferredAddsHost {
  mixer(): Pick<Mixer, "_applyLive" | "audioSettings">;
  buses(): Pick<BusIndex, "slots" | "names" | "writeSlot" | "writeLimits" | "liveSettings">;
  /** The backend's mixer-change work, now (bed plan, presence's rules, the lanes). */
  syncMix(): void;
}

export class DeferredAdds {
  /** Live adds deferred so far (`Audio.debug().mix.liveDeferred`). */
  count = 0;

  private host: DeferredAddsHost | null = null;
  /** The waiting adds by (trimmed) name, in the order they were asked (a `Map` keeps insertion order). */
  private readonly ops = new Map<string, MixOp>();

  /** `LiveMix` hands the backend's closures over. */
  bind(host: DeferredAddsHost): void {
    this.host = host;
  }

  /** An add that found no free slot: kept, answers `deferred` with the message (the edit is saved, so this is not a refusal). */
  defer(op: MixOp, message: string): ApplyResult {
    if (op.op === "addBus") {
      const name = op.name.trim();
      // The same name asked again while it waits is the same add (the table updates its parent); counted once.
      if (!this.ops.has(name)) this.count++;
      this.ops.set(name, op);
    }
    return { ok: true, class: "direct", deferred: message };
  }

  /**
   * A recycle freed `slots` (the table already gave the oldest waiting adds whatever fit): each queued add that now
   * holds a slot is finished, in the order asked. Idempotent: with nothing queued it does nothing.
   */
  retry(_slots: readonly number[]): void {
    const host = this.host;
    if (!host || this.ops.size === 0) return;
    const mixer = host.mixer();
    const buses = host.buses();
    const table = buses.slots;
    const waiting = new Set(table.deferred.map((q) => q.name));
    let applied = false;
    for (const [name, op] of [...this.ops]) {
      if (waiting.has(name)) continue;
      this.ops.delete(name);
      const slot = table.byName.get(name);
      // Dropped by the table (its parent went), or a session that configured the bus already holds it.
      if (slot === undefined || op.op !== "addBus" || mixer.audioSettings.buses.some((b) => b.name === name)) continue;
      const parent = table.slots[slot]!.parent;
      const before = mixer.audioSettings;
      // The parent as it is named now (it may have been renamed while the add waited).
      mixer._applyLive({ ...op, name, parent: parent >= 0 ? (buses.names[parent] ?? op.parent) : op.parent }, slot);
      buses.writeSlot(name, true);
      buses.writeLimits();
      buses.liveSettings(before);
      applied = true;
    }
    if (applied) host.syncMix();
  }

  /** Whether a live add named `name` is waiting for a slot (a child added under it queues behind it rather than falling back to the root). */
  waits(name: string): boolean {
    return this.ops.has(name);
  }

  /** Forget the queue (Stop, the next configure). The count of adds deferred so far stays. */
  clear(): void {
    this.ops.clear();
  }

  /** Ops waiting for a slot (the table's queue, less any this session no longer owns). */
  get pending(): number {
    const host = this.host;
    if (!host || this.ops.size === 0) return 0;
    const waiting = new Set(host.buses().slots.deferred.map((q) => q.name));
    let n = 0;
    for (const name of this.ops.keys()) if (waiting.has(name)) n++;
    return n;
  }
}
