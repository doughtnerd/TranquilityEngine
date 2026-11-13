// ADR 0171 amended by 0172 (Ma3; R10): the deferred-add queue against the real slot table and a fake mixer and writer:
// what `defer` answers and counts, what `retry` finishes (in the order asked, with the parent's current name), what it
// forgets (an add the table dropped, a bus the mixer already holds), and `clear`.
import { describe, expect, it } from "vitest";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { SLOT_CAPACITY, SlotTable } from "../../../../engine/audio/slotTable";
import { DeferredAdds, type DeferredAddsHost } from "./deferredAdds";

const add = (name: string, parent = "Master"): MixOp => ({ op: "addBus", name, parent });

/** A table full of buses (Master and 31 under it) with one removed, so adds wait for it to recycle. */
function rig() {
  const settings = { buses: [{ name: "Master" }, ...Array.from({ length: SLOT_CAPACITY - 1 }, (_, i) => ({ name: `B${i + 1}`, parent: "Master" }))] } as never;
  const table = new SlotTable();
  table.reset(settings);
  const model: string[] = table.slots.map((s) => s.name!);
  const names = () => table.slots.map((s) => s.name ?? "");
  const calls: string[] = [];
  const host: DeferredAddsHost = {
    mixer: () => ({ audioSettings: { buses: model.map((name) => ({ name })) }, _applyLive: (op: MixOp, slot?: number) => (calls.push(`apply ${op.op === "addBus" ? `${op.name}<${op.parent}` : "?"}@${slot}`), op.op === "addBus" && model.push(op.name), true) }) as never,
    buses: () => ({ slots: table, get names() { return names(); }, writeSlot: (n: string, fresh?: boolean) => (calls.push(`slot ${n} ${fresh}`), 0), writeLimits: () => calls.push("limits"), liveSettings: () => calls.push("live") }) as never,
    syncMix: () => calls.push("sync"),
  };
  const d = new DeferredAdds();
  d.bind(host);
  /** The queue's add as `LiveMix` does it: the table, then the deferral. */
  const ask = (op: MixOp) => {
    if (op.op !== "addBus") throw new Error("addBus only");
    const r = table.add(op.name, op.parent);
    return typeof r === "number" ? r : d.defer(op, r.deferred);
  };
  /** Frees every tombstone, as the dip does at its end, then retries. */
  const recycle = (frame = 1e9) => {
    const freed = table.recycle(frame, () => 0);
    if (freed.length > 0) d.retry(freed);
    return freed;
  };
  return { d, table, model, calls, ask, recycle };
}

describe("DeferredAdds (Ma3)", () => {
  it("defer answers ok with the message, counts once per name, and keeps the order asked", () => {
    const { d, table, ask } = rig();
    table.remove("B31", 0);
    expect(ask(add("A"))).toEqual({ ok: true, class: "direct", deferred: expect.stringMatching(/waits for a free bus slot/) });
    ask(add("B"));
    ask(add("A", "B1")); // the same add asked again (its parent changed): still one
    expect(d.count).toBe(2);
    expect(d.pending).toBe(2);
    expect(table.deferred.map((q) => [q.name, q.parent])).toEqual([["A", "B1"], ["B", "Master"]]);
  });

  it("retry finishes each add the table gave a slot, in order, with its slot's fresh BUS_SLOT, limits and one sync", () => {
    const { d, table, model, calls, ask, recycle } = rig();
    table.remove("B31", 0);
    table.remove("B30", 0);
    ask(add("A"));
    ask(add("B"));
    expect(recycle()).toEqual([30, 31]);
    expect(d.pending).toBe(0);
    expect(model.slice(-2)).toEqual(["A", "B"]);
    expect(calls).toEqual(["apply A<Master@30", "slot A true", "limits", "live", "apply B<Master@31", "slot B true", "limits", "live", "sync"]);
    expect(d.count).toBe(2);
  });

  it("one freed slot serves the oldest; the next recycle serves the next; a retry with nothing freed changes nothing", () => {
    const { d, table, model, ask, recycle } = rig();
    table.remove("B31", 0);
    ask(add("A"));
    ask(add("B"));
    expect(recycle()).toEqual([31]);
    expect(model).toContain("A");
    expect(model).not.toContain("B");
    expect(d.pending).toBe(1);
    d.retry([]);
    expect(d.pending).toBe(1);
    expect(model).not.toContain("B");
    table.remove("B30", 0);
    recycle();
    expect(model.slice(-2)).toEqual(["A", "B"]);
    expect(d.pending).toBe(0);
  });

  it("the parent is named as it is now (a rename while the add waited)", () => {
    const { d, table, calls, ask, recycle } = rig();
    table.remove("B31", 0);
    ask(add("A", "B1"));
    table.rename("B1", "Renamed");
    // The fake model must hold the new name too (the live path renames both).
    recycle();
    expect(calls[0]).toBe("apply A<Renamed@31");
    expect(d.pending).toBe(0);
  });

  it("an add the table dropped (its parent removed while it waited) is forgotten, never applied", () => {
    const { d, table, calls, ask, recycle } = rig();
    table.remove("B31", 0);
    ask(add("A", "B1"));
    table.remove("B1", 0); // the parent goes while A waits
    expect(d.pending).toBe(1);
    recycle();
    expect(calls).toEqual([]);
    expect(d.pending).toBe(0);
    expect(table.slotOf("A")).toBe(-1);
  });

  it("a bus the mixer already holds (a new session's configure read it from project.json) is not added twice", () => {
    const { d, table, model, calls, ask, recycle } = rig();
    table.remove("B31", 0);
    ask(add("A"));
    model.push("A"); // the next configure's settings include A
    recycle();
    expect(calls).toEqual([]);
    expect(model.filter((n) => n === "A")).toHaveLength(1);
    expect(d.pending).toBe(0);
  });

  it("clear forgets the queue (Stop); the count of adds deferred so far stays", () => {
    const { d, table, calls, ask, recycle } = rig();
    table.remove("B31", 0);
    ask(add("A"));
    expect(d.pending).toBe(1);
    d.clear();
    expect(d.pending).toBe(0);
    recycle();
    expect(calls).toEqual([]);
    expect(d.count).toBe(1);
  });

  it("unbound, defer still answers and retry and pending do nothing", () => {
    const d = new DeferredAdds();
    expect(d.defer(add("A"), "later")).toEqual({ ok: true, class: "direct", deferred: "later" });
    d.retry([1]);
    expect(d.pending).toBe(0);
    expect(d.count).toBe(1);
  });
});
