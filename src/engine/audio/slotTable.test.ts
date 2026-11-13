import { describe, expect, it } from "vitest";
import type { AudioSettings, BusEffect } from "./settings";
import { SLOT_CAPACITY, SLOT_ROOT, SlotTable, TOMBSTONE_TAIL_FRAMES } from "./slotTable";

type B = { name: string; parent?: string; effects?: BusEffect[] };

function settings(buses: B[]): AudioSettings {
  return { buses: buses.map((b) => ({ volume: 1, mute: false, effects: [], ...b })) } as unknown as AudioSettings;
}

const wire = (e: readonly BusEffect[]) => e.map((x) => ({ type: x.type === "reverb" ? 3 : 1, p: [] as number[] }));
const none = () => 0;

function table(buses: B[]): { t: SlotTable; s: AudioSettings } {
  const t = new SlotTable(wire);
  const s = settings(buses);
  t.reset(s);
  return { t, s };
}

const TREE: B[] = [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Sfx", parent: "Master", effects: [{ type: "reverb", send: 0.2 }] }, { name: "Ui", parent: "Sfx" }];

describe("SlotTable", () => {
  it("is today's mapping after reset, and the wire is today's", () => {
    const { t, s } = table(TREE);
    expect(t.version).toBe(0);
    expect(t.slotOf("Ui")).toBe(3);
    expect(t.configWire(s)).toEqual([
      { parent: SLOT_ROOT, effects: [] },
      { parent: 0, effects: [] },
      { parent: 0, effects: [{ type: 3, p: [] }] },
      { parent: 2, effects: [] },
    ]);
    expect(t.replay(s)).toEqual({ buses: t.configWire(s), tombstones: [] });
  });

  it("adds into the first free slot, else the next index", () => {
    const { t } = table(TREE);
    expect(t.add("Voice", "Master")).toBe(4);
    expect(t.version).toBe(1);
    expect(() => t.add("Voice", "Master")).toThrow();
    expect(() => t.add("X", "Nope")).toThrow();
  });

  it("tombstones a bus and its descendants as silent roots, and recycles after the tail with no voice", () => {
    const { t, s } = table(TREE);
    expect(t.remove("Sfx", 1000)).toEqual([2, 3]);
    expect(t.slots[2]).toMatchObject({ state: "tombstone", name: "Sfx", parent: -1, recycleAfterFrame: 1000 + TOMBSTONE_TAIL_FRAMES });
    expect(t.slotOf("Sfx")).toBe(-1);
    expect(t.configWire(s)).toEqual([
      { parent: SLOT_ROOT, effects: [] },
      { parent: 0, effects: [] },
      { parent: SLOT_ROOT, effects: [] },
      { parent: SLOT_ROOT, effects: [] },
    ]);
    expect(t.replay(s).tombstones).toEqual([2, 3]);
    expect(t.recycle(1000 + TOMBSTONE_TAIL_FRAMES - 1, none)).toEqual([]);
    expect(t.recycle(2000, (slot) => (slot === 3 ? 1 : 0))).toEqual([2]);
    expect(t.slots[2]).toMatchObject({ state: "free", name: null, gen: 1 });
    expect(t.slots[3]!.state).toBe("tombstone");
    const heard: [number, number][] = [];
    expect(t.recycle(2000, none, (slot, gen) => heard.push([slot, gen]))).toEqual([3]);
    expect(heard).toEqual([[3, 0]]);
    expect(t.configWire(s)).toHaveLength(2);
    expect(t.add("New", "Master")).toBe(2);
    expect(t.busRef(2)).toBe((1 << 8) | 2);
  });

  it("resurrects the same slots until they recycle", () => {
    const { t } = table(TREE);
    t.remove("Sfx", 0);
    expect(t.resurrect("Sfx")).toEqual([2, 3]);
    expect(t.slots[3]).toMatchObject({ state: "live", parent: 2 });
    expect(t.slotOf("Ui")).toBe(3);
    t.remove("Sfx", 0);
    t.recycle(1000, none);
    expect(t.resurrect("Sfx")).toBeNull();
  });

  it("renames in place and aliases the old name", () => {
    const { t, s } = table(TREE);
    const before = JSON.stringify(t.configWire(s));
    t.rename("Sfx", "Effects");
    t.rename("Effects", "Fx");
    expect(JSON.stringify(t.configWire(settings(TREE.map((b) => (b.name === "Sfx" ? { ...b, name: "Fx" } : b)))))).toBe(before);
    expect(t.slotOf("Sfx")).toBe(2);
    expect(t.slotOf("Effects")).toBe(2);
    expect(t.slotOf("Fx")).toBe(2);
    expect(t.aliases.get("Sfx")).toBe("Fx");
    t.add("Sfx", "Master");
    expect(t.slotOf("Sfx")).toBe(4);
  });

  it("moves a bus but not under itself", () => {
    const { t } = table(TREE);
    t.move("Ui", "Music");
    expect(t.slots[3]!.parent).toBe(1);
    expect(() => t.move("Sfx", "Sfx")).toThrow();
    t.move("Music", "Sfx");
    expect(() => t.move("Sfx", "Ui")).toThrow();
  });

  it("defers an add with no free slot and applies it at the recycle", () => {
    const buses: B[] = [{ name: "Master" }];
    for (let i = 1; i < SLOT_CAPACITY; i++) buses.push({ name: `b${i}`, parent: "Master" });
    const { t } = table(buses);
    t.remove("b5", 0);
    const r = t.add("late", "Master");
    expect(r).toEqual({ deferred: expect.stringContaining("late") });
    expect(t.deferred).toEqual([{ name: "late", parent: "Master" }]);
    const applied: [string, number][] = [];
    t.recycle(500, none, undefined, (n, s) => applied.push([n, s]));
    expect(applied).toEqual([["late", 5]]);
    expect(t.deferred).toEqual([]);
    expect(t.slotOf("late")).toBe(5);
    expect(t.slots[5]!.gen).toBe(1);
  });

  it("cancels a deferred add when it is removed", () => {
    const buses: B[] = [{ name: "Master" }];
    for (let i = 1; i < SLOT_CAPACITY; i++) buses.push({ name: `b${i}`, parent: "Master" });
    const { t } = table(buses);
    t.add("late", "Master");
    t.add("later", "late");
    expect(t.deferred).toHaveLength(2);
    expect(t.remove("late", 0)).toEqual([]);
    expect(t.deferred).toEqual([]);
  });

  it("reset compacts: positions, no aliases, version 0", () => {
    const { t, s } = table(TREE);
    t.rename("Ui", "Hud");
    t.remove("Music", 0);
    t.reset(s);
    expect(t.version).toBe(0);
    expect(t.aliases.size).toBe(0);
    expect(t.slots.map((x) => x.state)).toEqual(["live", "live", "live", "live"]);
    expect(t.replay(s).tombstones).toEqual([]);
  });
});
