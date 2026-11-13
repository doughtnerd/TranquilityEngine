/**
 * Seeded property tests for the session slot table (ADR 0171 amended by 0172; api-and-models §6.3, architecture §4.7).
 *
 * Each seed runs a random op sequence against a `SlotTable` and a model of the live buses, the deferred queue and the
 * removals that resurrect can undo. After every op the invariants are checked. A failure names the seed and the op log.
 */
import { describe, expect, it } from "vitest";
import type { AudioSettings, BusEffect } from "./settings";
import { SLOT_CAPACITY, SLOT_ROOT, SlotTable, TOMBSTONE_TAIL_FRAMES } from "./slotTable";

type Fx = readonly BusEffect[];
interface ListBus { name: string; parent: string | null; effects: Fx }
interface ModelBus { parent: string | null; effects: Fx }
interface Queued { name: string; parent: string; effects: Fx }
/** A bus a remove tombstoned. Its parent is kept by slot and generation: a rename keeps the slot (§6.3). */
interface Member { name: string; slot: number; parentSlot: number; parentGen: number; effects: Fx }
interface Group { members: Member[]; dead: boolean }
interface Model { live: Map<string, ModelBus>; queue: Queued[]; latest: Map<string, Group> }

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const OPS = 120;
const POOL = Array.from({ length: 48 }, (_, i) => `n${i}`);

const stats = { deferred: 0, recycled: 0, applied: 0, resurrected: 0, resets: 0, invalid: 0 };

/** mulberry32: a small seeded PRNG, written here so the test adds no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wire form of a bus's effects: each reverb is type 3 with its send in `p`. */
function effectsOf(effects: readonly BusEffect[]): { type: number; p: number[] }[] {
  return effects.map((e) => ({ type: 3, p: [Math.round((e as unknown as { send: number }).send * 100)] }));
}

function toSettings(list: ListBus[]): AudioSettings {
  const buses = list.map((b) => ({ name: b.name, volume: 1, mute: false, effects: b.effects, ...(b.parent === null ? {} : { parent: b.parent }) }));
  return { buses } as unknown as AudioSettings;
}

/** The project as settings: the live buses, then the deferred adds (they stay in project.json). */
function listOf(m: Model): ListBus[] {
  return [
    ...[...m.live].map(([name, b]) => ({ name, parent: b.parent, effects: b.effects })),
    ...m.queue.map((q) => ({ name: q.name, parent: q.parent, effects: q.effects })),
  ];
}

function runSeed(seed: number): void {
  const rng = mulberry32(seed);
  const int = (n: number) => Math.floor(rng() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const log: string[] = [];
  const t = new SlotTable(effectsOf);
  const m: Model = { live: new Map(), queue: [], latest: new Map() };
  let frame = 1000;

  const fx = (): Fx => (rng() < 0.5 ? [] : ([{ type: "reverb", send: Math.round(rng() * 100) / 100 }] as unknown as Fx));
  const liveNames = () => [...m.live.keys()];
  const queuedNames = () => m.queue.map((q) => q.name);
  const allNames = () => [...liveNames(), ...queuedNames()];
  const isRoot = (n: string) => m.live.get(n)!.parent === null;
  const freshName = (): string | undefined => {
    const taken = allNames();
    const free = POOL.filter((n) => !taken.includes(n));
    return free.length > 0 ? pick(free) : undefined;
  };
  const descendantsOf = (n: string): string[] => {
    const set = new Set<string>([n]);
    const out: string[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      for (const [x, b] of m.live) {
        if (!set.has(x) && b.parent !== null && set.has(b.parent)) {
          set.add(x);
          out.push(x);
          grew = true;
        }
      }
    }
    return out;
  };
  const full = () => t.slots.length === SLOT_CAPACITY && t.slots.every((s) => s.state !== "free");
  const snapshot = () => JSON.stringify({ slots: t.slots, version: t.version, deferred: t.deferred, aliases: [...t.aliases], byName: [...t.byName] });

  /** Expected result of `resurrect(name)`: the group's members when the undo still applies, else null. */
  const expectResurrect = (name: string): Member[] | null => {
    if (m.live.has(name)) return null;
    const g = m.latest.get(name);
    if (!g || g.dead) return null;
    const groupSlots = new Set(g.members.map((x) => x.slot));
    for (const x of g.members) if (m.live.has(x.name) || m.queue.some((q) => q.name === x.name)) return null;
    for (const x of g.members) {
      if (x.parentSlot < 0 || groupSlots.has(x.parentSlot)) continue;
      const p = t.slots[x.parentSlot];
      if (!p || p.state !== "live" || p.gen !== x.parentGen) return null;
    }
    return g.members;
  };

  /** The name a resurrected member's parent has now (a renamed parent keeps its slot). */
  const parentNameOf = (x: Member): string | null => (x.parentSlot < 0 ? null : t.slots[x.parentSlot]!.name);

  /** Invariants 1, 3 and 4, and that the model and the table agree on names and the queue. */
  const check = (): void => {
    const list = listOf(m);
    const s = toSettings(list);
    const wire = t.configWire(s);
    let end = t.slots.length;
    while (end > 0 && t.slots[end - 1]!.state === "free") end--;
    expect(wire).toHaveLength(end);
    for (let i = 0; i < end; i++) {
      const x = t.slots[i]!;
      if (x.state !== "live") {
        expect(wire[i]).toEqual({ parent: SLOT_ROOT, effects: [] });
        continue;
      }
      const b = m.live.get(x.name!);
      expect(b).toBeDefined();
      if (b === undefined) continue;
      if (b.parent === null) {
        expect(x.parent).toBe(-1);
      } else {
        expect(x.parent).toBeGreaterThanOrEqual(0);
        expect(t.slots[x.parent]!.state).toBe("live");
        expect(t.slots[x.parent]!.name).toBe(b.parent);
      }
      expect(wire[i]).toEqual({ parent: x.parent < 0 ? SLOT_ROOT : x.parent, effects: effectsOf(b.effects) });
    }
    const tombstones: number[] = [];
    t.slots.forEach((x, i) => {
      if (x.state === "tombstone") tombstones.push(i);
    });
    expect(t.replay(s)).toEqual({ buses: wire, tombstones });
    expect(t.slots.length).toBeLessThanOrEqual(SLOT_CAPACITY);
    expect([...t.byName.keys()].sort()).toEqual(liveNames().sort());
    expect(t.byName.size).toBe(liveNames().length);
    t.slots.forEach((x, i) => {
      if (x.state === "live") expect(t.byName.get(x.name!)).toBe(i);
    });
    for (const n of liveNames()) expect(t.slotOf(n)).toBe(t.byName.get(n));
    expect(t.deferred.map((q) => [q.name, q.parent])).toEqual(m.queue.map((q) => [q.name, q.parent]));
  };

  /** Invariant 6: right after a reset the table is today's mapping, slot = project position. */
  const resetTo = (list: ListBus[]): void => {
    const s = toSettings(list);
    t.reset(s);
    m.latest.clear();
    m.queue = [];
    m.live = new Map(list.map((b) => [b.name, { parent: b.parent, effects: b.effects }]));
    stats.resets++;
    expect(t.version).toBe(0);
    expect(t.aliases.size).toBe(0);
    expect(t.deferred).toEqual([]);
    expect(t.slots).toHaveLength(list.length);
    list.forEach((b, i) => {
      expect(t.slots[i]).toMatchObject({ state: "live", name: b.name, gen: 0, recycleAfterFrame: 0 });
      expect(t.slotOf(b.name)).toBe(i);
    });
    expect(t.configWire(s)).toEqual(list.map((b) => ({ parent: b.parent === null ? SLOT_ROOT : list.findIndex((x) => x.name === b.parent), effects: effectsOf(b.effects) })));
  };

  const doAdd = (): string => {
    const name = freshName();
    if (!name) return "add: skipped (pool full)";
    const parent = pick(allNames());
    const parentLive = m.live.has(parent);
    const effects = fx();
    const firstFree = t.slots.findIndex((x) => x.state === "free");
    const len = t.slots.length;
    const res = t.add(name, parent);
    if (typeof res === "number") {
      expect(parentLive).toBe(true);
      expect(res).toBe(firstFree >= 0 ? firstFree : len);
      expect(t.slots[res]).toMatchObject({ state: "live", name });
      m.live.set(name, { parent, effects });
      return `add ${name} under ${parent} -> slot ${res}`;
    }
    expect(res.deferred).toContain(name);
    if (parentLive) expect(full()).toBe(true);
    m.queue.push({ name, parent, effects });
    stats.deferred++;
    return `add ${name} under ${parent} -> deferred`;
  };

  const doRemove = (): string => {
    const removable = [...liveNames().filter((n) => !isRoot(n)), ...queuedNames()];
    if (removable.length === 0) return "remove: skipped";
    const name = pick(removable);
    if (m.queue.some((q) => q.name === name)) {
      const gone = new Set([name]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const q of m.queue) {
          if (!gone.has(q.name) && gone.has(q.parent)) {
            gone.add(q.name);
            grew = true;
          }
        }
      }
      expect(t.remove(name, frame)).toEqual([]);
      m.queue = m.queue.filter((q) => !gone.has(q.name));
      return `remove queued ${name} (with ${gone.size - 1} below)`;
    }
    const members = [name, ...descendantsOf(name)];
    const info: Member[] = members.map((n) => {
      const b = m.live.get(n)!;
      const ps = b.parent === null ? -1 : t.slotOf(b.parent);
      return { name: n, slot: t.slotOf(n), parentSlot: ps, parentGen: ps >= 0 ? t.slots[ps]!.gen : 0, effects: b.effects };
    });
    const got = t.remove(name, frame);
    expect([...got].sort((a, b) => a - b)).toEqual(info.map((x) => x.slot).sort((a, b) => a - b));
    expect(got[0]).toBe(info[0]!.slot);
    for (const x of info) expect(t.slots[x.slot]).toMatchObject({ state: "tombstone", parent: -1, recycleAfterFrame: frame + TOMBSTONE_TAIL_FRAMES });
    for (const n of members) m.live.delete(n);
    m.latest.set(name, { members: info, dead: false });
    return `remove ${name} (with ${members.length - 1} below) at frame ${frame}`;
  };

  const doRename = (): string => {
    const names = allNames();
    const from = pick(names);
    const to = freshName();
    if (!to) return "rename: skipped (pool full)";
    const wasLive = m.live.has(from);
    const slot = t.slotOf(from);
    t.rename(from, to);
    if (wasLive) {
      const b = m.live.get(from)!;
      m.live.delete(from);
      m.live.set(to, b);
      for (const x of m.live.values()) if (x.parent === from) x.parent = to;
      expect(t.slotOf(to)).toBe(slot);
      expect(t.slotOf(from)).toBe(slot);
    }
    const q = m.queue.find((x) => x.name === from);
    if (q) q.name = to;
    for (const x of m.queue) if (x.parent === from) x.parent = to;
    return `rename ${from} -> ${to}${wasLive ? ` (slot ${slot})` : " (queued)"}`;
  };

  const doMove = (): string => {
    const name = pick(allNames());
    if (m.queue.some((q) => q.name === name)) {
      const parent = pick(liveNames());
      t.move(name, parent);
      m.queue.find((q) => q.name === name)!.parent = parent;
      return `move queued ${name} under ${parent}`;
    }
    if (isRoot(name)) return "move: skipped (root)";
    const blocked = new Set([name, ...descendantsOf(name)]);
    const candidates = liveNames().filter((x) => !blocked.has(x));
    if (candidates.length === 0) return "move: skipped";
    const parent = pick(candidates);
    t.move(name, parent);
    m.live.get(name)!.parent = parent;
    return `move ${name} under ${parent}`;
  };

  const doResurrect = (): string => {
    const name = pick([...m.latest.keys(), ...allNames()]);
    const expected = expectResurrect(name);
    const got = t.resurrect(name);
    if (expected === null) {
      expect(got).toBeNull();
      return `resurrect ${name}: null`;
    }
    expect([...got!].sort((a, b) => a - b)).toEqual(expected.map((x) => x.slot).sort((a, b) => a - b));
    m.latest.delete(name);
    for (const x of expected) m.live.set(x.name, { parent: parentNameOf(x), effects: x.effects });
    stats.resurrected++;
    return `resurrect ${name}: slots ${got!.join(",")}`;
  };

  const doRecycle = (): string => {
    const voices = new Map<number, number>();
    for (let s = 0; s < t.slots.length; s++) if (rng() < 0.3) voices.set(s, 1 + int(2));
    const before = t.slots.map((x) => ({ ...x }));
    const beforeQueue = m.queue.map((q) => ({ ...q }));
    const recycled: [number, number][] = [];
    const applied: [string, number][] = [];
    const freed = t.recycle(
      frame,
      (s) => voices.get(s) ?? 0,
      (s, oldGen) => recycled.push([s, oldGen]),
      (n, s) => applied.push([n, s]),
    );

    // Invariant 2: only eligible tombstones free, and only their gen moves.
    for (let s = 0; s < before.length; s++) {
      const b = before[s]!;
      const eligible = b.state === "tombstone" && frame >= b.recycleAfterFrame && (voices.get(s) ?? 0) === 0;
      expect(freed.includes(s)).toBe(eligible);
      expect(t.slots[s]!.gen).toBe(eligible ? (b.gen + 1) & 0xffff : b.gen);
    }
    expect(recycled).toEqual(freed.map((s) => [s, before[s]!.gen]));
    // A deferred add may take a freed slot in the same recycle (applied below); any other freed slot stays free.
    for (const s of freed) {
      if (applied.some(([, slot]) => slot === s)) expect(t.slots[s]).toMatchObject({ state: "live", gen: (before[s]!.gen + 1) & 0xffff });
      else expect(t.slots[s]).toMatchObject({ state: "free", name: null, parent: -1, recycleAfterFrame: 0 });
    }
    stats.recycled += freed.length;
    for (const g of m.latest.values()) if (g.members.some((x) => freed.includes(x.slot))) g.dead = true;

    // Invariant 5: deferred adds apply in the order asked, through onApplied; a removed one never applies.
    const readyAtStart = beforeQueue.filter((q) => m.live.has(q.parent)).map((q) => q.name);
    const appliedNames = applied.map(([n]) => n);
    const readyApplied = appliedNames.filter((n) => readyAtStart.includes(n));
    expect(readyApplied).toEqual(readyAtStart.slice(0, readyApplied.length));
    for (const [n, slot] of applied) {
      const q = beforeQueue.find((x) => x.name === n);
      expect(q).toBeDefined();
      if (q === undefined) continue;
      expect(m.live.has(q.parent)).toBe(true);
      expect(t.slotOf(n)).toBe(slot);
      expect(t.slots[slot]).toMatchObject({ state: "live", name: n });
      m.live.set(n, { parent: q.parent, effects: q.effects });
      stats.applied++;
    }
    const remaining = t.deferred.map((q) => ({ name: q.name, parent: q.parent }));
    const remainingNames = remaining.map((q) => q.name);
    let j = 0;
    for (const q of beforeQueue) if (j < remainingNames.length && remainingNames[j] === q.name) j++;
    expect(j).toBe(remainingNames.length);
    for (const q of beforeQueue) {
      if (appliedNames.includes(q.name) || remainingNames.includes(q.name)) continue;
      expect(m.live.has(q.parent)).toBe(false);
      expect(remainingNames.includes(q.parent)).toBe(false);
    }
    for (const q of remaining) if (m.live.has(q.parent)) expect(full()).toBe(true);
    m.queue = remaining.map((q) => ({ ...q, effects: beforeQueue.find((b) => b.name === q.name)!.effects }));
    return `recycle at frame ${frame}: freed [${freed.join(",")}], applied [${appliedNames.join(",")}]`;
  };

  const doReset = (): string => {
    const list = listOf(m);
    if (list.length > SLOT_CAPACITY) return "reset: skipped (over capacity)";
    resetTo(list);
    return `reset to ${list.length} buses`;
  };

  /** Invalid ops throw and leave the table as it was. Each is built only from names the model knows are invalid. */
  const invalid = (): string => {
    const live = liveNames();
    const roots = live.filter(isRoot);
    const nonRoot = live.filter((n) => !isRoot(n));
    const cases: { what: string; run: () => unknown }[] = [];
    const a = pick(live);
    cases.push({ what: `add live "${a}"`, run: () => t.add(a, pick(live)) });
    const fresh = freshName();
    if (fresh) cases.push({ what: `add "${fresh}" under unknown parent`, run: () => t.add(fresh, "ghost") });
    cases.push({ what: "remove unknown", run: () => t.remove("ghost", frame) });
    cases.push({ what: "rename unknown", run: () => t.rename("ghost", "ghost2") });
    const all = allNames();
    if (all.length >= 2) {
      const b = pick(all);
      const c = pick(all.filter((x) => x !== b));
      cases.push({ what: `rename "${b}" to existing "${c}"`, run: () => t.rename(b, c) });
    }
    if (roots.length > 0) {
      const r = pick(roots);
      cases.push({ what: `remove root "${r}"`, run: () => t.remove(r, frame) });
      cases.push({ what: `move root "${r}"`, run: () => t.move(r, pick(live)) });
    }
    if (nonRoot.length > 0) {
      const x = pick(nonRoot);
      cases.push({ what: `move "${x}" under itself`, run: () => t.move(x, x) });
      const d = descendantsOf(x);
      if (d.length > 0) {
        const y = pick(d);
        cases.push({ what: `move "${x}" under its descendant "${y}"`, run: () => t.move(x, y) });
      }
    }
    const c = pick(cases);
    const before = snapshot();
    expect(c.run).toThrow();
    expect(snapshot()).toBe(before);
    stats.invalid++;
    return `invalid (throws): ${c.what}`;
  };

  // Start from a random tree of up to 8 buses with one or more roots.
  const initN = 1 + int(8);
  const initList: ListBus[] = [];
  for (let i = 0; i < initN; i++) {
    const parent = i === 0 || rng() < 0.3 ? null : POOL[int(i)]!;
    initList.push({ name: POOL[i]!, parent, effects: fx() });
  }
  resetTo(initList);

  try {
    let prev = t.version;
    check();
    for (let step = 0; step < OPS; step++) {
      frame += int(200);
      const r = rng();
      const what =
        r < 0.08 ? invalid() : r < 0.3 ? doAdd() : r < 0.4 ? doRemove() : r < 0.5 ? doRename() : r < 0.6 ? doMove() : r < 0.72 ? doResurrect() : r < 0.97 ? doRecycle() : doReset();
      log.push(`${step}: ${what}`);
      if (!what.startsWith("reset to")) expect(t.version).toBeGreaterThanOrEqual(prev);
      prev = t.version;
      check();
    }
  } catch (e) {
    throw new Error(`seed ${seed} failed. Op log:\n${log.join("\n")}\n${(e as Error).message}`);
  }
}

describe("SlotTable properties (seeded)", () => {
  it.each(SEEDS)("seed %i keeps every invariant", (seed) => {
    runSeed(seed);
  });

  it("exercises deferral, recycle, deferred apply, resurrect, reset and invalid ops across the seeds", () => {
    expect(stats.deferred).toBeGreaterThan(0);
    expect(stats.recycled).toBeGreaterThan(0);
    expect(stats.applied).toBeGreaterThan(0);
    expect(stats.resurrected).toBeGreaterThan(0);
    expect(stats.resets).toBeGreaterThan(0);
    expect(stats.invalid).toBeGreaterThan(0);
  });

  it("wraps a slot's gen modulo 65536 on recycle", () => {
    const t = new SlotTable(effectsOf);
    t.reset(toSettings([{ name: "Master", parent: null, effects: [] }, { name: "A", parent: "Master", effects: [] }]));
    t.remove("A", 0);
    t.slots[1]!.gen = 0xffff;
    expect(t.recycle(TOMBSTONE_TAIL_FRAMES, () => 0)).toEqual([1]);
    expect(t.slots[1]!.gen).toBe(0);
  });
});
