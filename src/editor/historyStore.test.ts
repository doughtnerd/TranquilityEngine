import { describe, expect, it } from "vitest";
import type { HistoryFile } from "./document";
import { HistoryStore, type SlotBackend } from "./historyStore";

/** A slot backend in memory, optionally tearing the next write (simulating a crash mid-write). */
function memorySlots(): SlotBackend & { slots: Record<string, string>; tearNext: boolean } {
  return {
    where: "memory",
    slots: {},
    tearNext: false,
    async read(slot) {
      return this.slots[slot] ?? null;
    },
    async write(slot, text) {
      if (this.tearNext) {
        this.tearNext = false;
        this.slots[slot] = text.slice(0, Math.floor(text.length / 2)); // half a file
        throw new Error("crashed mid-write");
      }
      this.slots[slot] = text;
    },
  };
}

/** What a store finds when slot `a` holds `text` and slot `b` is empty. */
const loadOne = (text: string | null) => new HistoryStore({ where: "memory", read: async (slot) => (slot === "a" ? text : null), write: async () => {} }).load();
/** The generation a slot's envelope says it holds. */
const generationIn = (text: string) => (JSON.parse(text) as { generation: number }).generation;

const historyOf = (n: number): HistoryFile => ({ format: "myco.history@1", scene: "s", root: 0, current: n, saved: 0, nextSeq: n + 1, states: [] });

describe("history slots (ADR 0027)", () => {
  it("rejects torn and tampered slots", async () => {
    expect(await loadOne(null)).toBeNull();
    expect(await loadOne('{"format":"myco.history-slot@1","gen')).toBeNull();
    const good = JSON.stringify({ format: "myco.history-slot@1", generation: 1, checksum: "x", history: historyOf(1) });
    expect(await loadOne(good)).toBeNull(); // wrong checksum
  });

  it("alternates between the two slots and loads the newest", async () => {
    const backend = memorySlots();
    const store = new HistoryStore(backend);
    await store.save(historyOf(1));
    await store.save(historyOf(2));
    await store.save(historyOf(3));
    expect(generationIn(backend.slots.a)).toBe(3);
    expect(generationIn(backend.slots.b)).toBe(2);
    expect((await new HistoryStore(backend).load())!.current).toBe(3);
  });

  it("a crash mid-write leaves the previous generation intact", async () => {
    const backend = memorySlots();
    const store = new HistoryStore(backend);
    await store.save(historyOf(1));
    await store.save(historyOf(2));
    backend.tearNext = true;
    await expect(store.save(historyOf(3))).rejects.toThrow(/mid-write/);
    expect(await loadOne(backend.slots.a)).toBeNull(); // the torn slot
    expect((await new HistoryStore(backend).load())!.current).toBe(2); // the other slot survives
  });

  it("keeps saving in alternation after loading", async () => {
    const backend = memorySlots();
    await new HistoryStore(backend).save(historyOf(1));
    const store = new HistoryStore(backend);
    await store.load();
    await store.save(historyOf(2));
    expect(generationIn(backend.slots.b)).toBe(2); // didn't overwrite generation 1
  });
});
