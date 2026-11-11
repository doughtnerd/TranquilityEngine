// ADR 0162 A5: the bed resolution table (api-and-models §2.1 and §9: maxBeds, priority, ties, losers, root default,
// `none`), the planner's sends (BED_CONFIG on change, once more when the last bed goes, never without a slot laid out),
// stable slot ids, the replay record, the sharing chain's snapshot low-pass and the debug rows.
import { describe, expect, it } from "vitest";
import { parseAudioSettings, type AudioSettings, type BusBed } from "../../../../engine/audio/settings";
import { BED_HOST_NONE, BED_SLOT_NONE, BUS_LP_OFF_HZ, readBedConfig } from "../wire.generated";
import { BedPlanner, resolveBeds } from "./beds";
import { ReplayBuilder } from "./replay";

interface Spec {
  name: string;
  parent?: string;
  bed?: BusBed;
  bedPriority?: number;
}

/** The inputs `resolveBeds` takes for a list of buses, root first (the defaults of `busBed` / `busBedPriority` applied). */
function tree(buses: Spec[]) {
  const names = buses.map((b) => b.name);
  return {
    busCount: buses.length,
    parents: buses.map((b) => (b.parent === undefined ? -1 : names.indexOf(b.parent))),
    modes: buses.map((b, i) => b.bed ?? (i === 0 ? "own" : "parent")) as BusBed[],
    priorities: buses.map((b, i) => b.bedPriority ?? (i === 0 ? 255 : 128)),
  };
}

const NONE = BED_SLOT_NONE;
const slots = (r: { bedSlot: Uint8Array }): number[] => [...r.bedSlot];

describe("resolveBeds (the §2.1 / §9 bed resolution table)", () => {
  const MASTER: Spec = { name: "Master" };
  const flat = [MASTER, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }, { name: "Ambience", parent: "Master" }];

  it("maxBeds 0: no beds, nothing denied, even for buses asking own", () => {
    const r = resolveBeds({ ...tree([MASTER, { name: "A", parent: "Master", bed: "own" }]), maxBeds: 0 });
    expect(slots(r)).toEqual([NONE, NONE]);
    expect(r.slotCount).toBe(0);
    expect(r.denied).toEqual([]);
    expect([...r.hostBus]).toEqual([BED_HOST_NONE, BED_HOST_NONE, BED_HOST_NONE, BED_HOST_NONE]);
  });

  it("the root defaults to own: every parent bus shares Master's bed", () => {
    const r = resolveBeds({ ...tree(flat), maxBeds: 2 });
    expect(slots(r)).toEqual([0, 0, 0, 0]);
    expect(r.hostBus[0]).toBe(0);
    expect(r.slotCount).toBe(1);
    expect(r.denied).toEqual([]);
    expect(r.implicitRoot).toBe(false);
  });

  it("an own bus below the root hosts a second bed; its children share it, the rest share Master's", () => {
    const buses = [MASTER, { name: "Ambience", parent: "Master", bed: "own" as const, bedPriority: 200 }, { name: "Birds", parent: "Ambience" }, { name: "SFX", parent: "Master" }];
    const r = resolveBeds({ ...tree(buses), maxBeds: 2 });
    expect(slots(r)).toEqual([0, 1, 1, 0]); // Master (255) gets slot 0, Ambience (200) slot 1
    expect([...r.hostBus.subarray(0, 2)]).toEqual([0, 1]);
    expect(r.winners).toEqual([0, 1]);
  });

  it("sorts by bedPriority first, so a child can outrank the root", () => {
    const buses = [{ name: "Master", bedPriority: 100 }, { name: "Ambience", parent: "Master", bed: "own" as const, bedPriority: 200 }, { name: "SFX", parent: "Master" }];
    const r = resolveBeds({ ...tree(buses), maxBeds: 1 });
    expect(r.winners).toEqual([1]); // no rule hard-codes "Master first" (R8)
    expect(r.denied).toEqual([0]);
    // Master lost: it asked own and has no hosted ancestor, so it is flat; SFX shares Master's parent chain: nothing above it
    expect(slots(r)).toEqual([NONE, 0, NONE]);
  });

  it("breaks priority ties by depth, then index (the shallowest bus wins at the default 128)", () => {
    const buses = [
      { name: "Master", bed: "parent" as const },
      { name: "A", parent: "Master", bed: "own" as const },
      { name: "A1", parent: "A", bed: "own" as const },
      { name: "B", parent: "Master", bed: "own" as const },
    ];
    const r = resolveBeds({ ...tree(buses), maxBeds: 2 });
    expect(r.winners).toEqual([1, 3]); // A and B (depth 1, by index) beat A1 (depth 2)
    expect(r.denied).toEqual([2]);
    expect(slots(r)).toEqual([NONE, 0, 0, 1]); // A1 lost and shares A's bed
  });

  it("losers share the nearest hosted ancestor's bed; with none they are flat", () => {
    const buses = [
      { name: "Master", bed: "parent" as const },
      { name: "A", parent: "Master", bed: "own" as const, bedPriority: 200 },
      { name: "B", parent: "Master", bed: "own" as const, bedPriority: 100 },
      { name: "B1", parent: "B" },
    ];
    const r = resolveBeds({ ...tree(buses), maxBeds: 1 });
    expect(r.winners).toEqual([1]);
    expect(r.denied).toEqual([2]);
    expect(slots(r)).toEqual([NONE, 0, NONE, NONE]); // B lost, B1 shares B: no hosted ancestor, flat
  });

  it("none is flat, but its parent-mode descendants still reach a hosted ancestor above it", () => {
    const buses = [MASTER, { name: "UI", parent: "Master", bed: "none" as const }, { name: "UIFx", parent: "UI" }, { name: "SFX", parent: "Master" }];
    const r = resolveBeds({ ...tree(buses), maxBeds: 2 });
    expect(slots(r)).toEqual([0, NONE, 0, 0]);
  });

  it("an own bus asking nothing special below a none root: the root is none, so only asked beds exist", () => {
    const buses = [{ name: "Master", bed: "none" as const }, { name: "SFX", parent: "Master" }];
    const r = resolveBeds({ ...tree(buses), maxBeds: 2 });
    expect(slots(r)).toEqual([NONE, NONE]);
    expect(r.slotCount).toBe(0);
    expect(r.implicitRoot).toBe(false);
  });

  it("when nobody asks own and maxBeds > 0 the root is granted slot 0 implicitly", () => {
    const buses = [{ name: "Master", bed: "parent" as const }, { name: "SFX", parent: "Master" }];
    const r = resolveBeds({ ...tree(buses), maxBeds: 2 });
    expect(r.implicitRoot).toBe(true);
    expect(slots(r)).toEqual([0, 0]);
    expect(r.hostBus[0]).toBe(0);
  });

  it("never gives out more slots than maxBeds (clamped to 4)", () => {
    const buses: Spec[] = [MASTER];
    for (let k = 1; k <= 6; k++) buses.push({ name: `B${k}`, parent: "Master", bed: "own", bedPriority: 200 - k });
    const r = resolveBeds({ ...tree(buses), maxBeds: 9 });
    expect(r.winners).toHaveLength(4);
    expect(r.denied).toHaveLength(3);
    expect(r.slotCount).toBe(4);
    expect(new Set(Array.from(r.hostBus)).size).toBe(4);
    expect(resolveBeds({ ...tree(buses), maxBeds: 2 }).winners).toEqual([0, 1]);
  });

  it("a host keeps its slot id across a replan; new hosts take the lowest free slot", () => {
    const buses = [MASTER, { name: "A", parent: "Master", bed: "own" as const, bedPriority: 200 }, { name: "B", parent: "Master", bed: "own" as const, bedPriority: 100 }];
    const first = resolveBeds({ ...tree(buses), maxBeds: 3 });
    expect([...first.hostBus.subarray(0, 3)]).toEqual([0, 1, 2]);
    // B now outranks A and the root: ranks change, slots don't
    buses[2]!.bedPriority = 255;
    buses[1]!.bedPriority = 10;
    const second = resolveBeds({ ...tree(buses), maxBeds: 3, previousHosts: first.hostBus });
    expect([...second.hostBus.subarray(0, 3)]).toEqual([0, 1, 2]);
    // A is dropped (maxBeds 2): its slot goes, Master and B keep theirs
    const third = resolveBeds({ ...tree(buses), maxBeds: 2, previousHosts: second.hostBus });
    expect(third.winners).toEqual([0, 2]);
    expect(third.hostBus[0]).toBe(0);
    expect(third.hostBus[1]).toBe(2); // B moves into the free slot 1, since slot 2 is past maxBeds
    expect(third.slotCount).toBe(2);
  });

  it("holes: a host whose old slot is the only one used keeps it, and slotCount covers it", () => {
    const first = resolveBeds({ ...tree([MASTER, { name: "A", parent: "Master", bed: "own" as const, bedPriority: 200 }]), maxBeds: 2 });
    expect([...first.hostBus.subarray(0, 2)]).toEqual([0, 1]);
    const r = resolveBeds({ ...tree([{ name: "Master", bed: "none" as const }, { name: "A", parent: "Master", bed: "own" as const }]), maxBeds: 2, previousHosts: [-1, 1, -1, -1] });
    expect(r.hostBus[1]).toBe(1);
    expect(r.hostBus[0]).toBe(BED_HOST_NONE);
    expect(r.slotCount).toBe(2);
  });

  it("is robust to a bad tree (self or out-of-range parents, NaN priority)", () => {
    const r = resolveBeds({ busCount: 3, parents: [-1, 1, 9], modes: ["own", "parent", "own"], priorities: [Number.NaN, 5, 5], maxBeds: 2 });
    expect(r.winners).toHaveLength(2);
    expect(r.bedSlot).toHaveLength(3);
  });
});

/** A planner over a recording writer, with settings built from the specs. */
function planner(buses: Spec[], maxBeds: number, laidOut = 4) {
  const sent: { bedSlot: number[]; hostBus: number[] }[] = [];
  const warnings: string[] = [];
  const p = new BedPlanner({ bedConfig: (bedSlot, hostBus) => sent.push({ bedSlot: Array.from(bedSlot), hostBus: Array.from(hostBus) }) }, laidOut, (m) => warnings.push(m));
  const settingsFor = (list: Spec[], max: number): AudioSettings => parseAudioSettings({ buses: list, bed: { maxBeds: max } }).settings;
  const plan = (list: Spec[] = buses, max = maxBeds) => {
    const settings = settingsFor(list, max);
    const names = settings.buses.map((b) => b.name);
    p.plan(settings, names, settings.buses.map((b) => (b.parent === undefined ? -1 : names.indexOf(b.parent))));
  };
  return { p, sent, warnings, plan };
}

describe("BedPlanner", () => {
  const buses: Spec[] = [{ name: "Master" }, { name: "Ambience", parent: "Master", bed: "own", bedPriority: 200 }, { name: "SFX", parent: "Master" }];

  it("sends nothing while no slot is laid out (max_beds 0), whatever the settings say", () => {
    const { p, sent, plan } = planner(buses, 4, 0);
    plan();
    expect(sent).toEqual([]);
    expect(p.slotCount).toBe(0);
    expect(p.bedSlotOf(0)).toBe(NONE);
    expect(p.debug()).toBeUndefined();
  });

  it("sends BED_CONFIG with the plan, and sends again after every BUS_CONFIG while a bed exists", () => {
    const { p, sent, plan } = planner(buses, 2);
    plan();
    expect(sent).toEqual([{ bedSlot: [0, 1, 0], hostBus: [0, 1] }]);
    expect(p.bedSlotOf(1)).toBe(1);
    plan(); // the tree was configured again
    expect(sent).toHaveLength(2);
  });

  it("follows a bus edit: a bus asks own, another stops, and the last bed going sends an empty config once", () => {
    const { sent, plan } = planner(buses, 2);
    plan();
    plan([{ name: "Master" }, { name: "Ambience", parent: "Master", bed: "parent" }, { name: "SFX", parent: "Master", bed: "own", bedPriority: 220 }]);
    expect(sent.at(-1)).toEqual({ bedSlot: [0, 0, 1], hostBus: [0, 2] }); // Master keeps slot 0; SFX (index 2) takes the slot Ambience freed
    plan(buses, 0); // maxBeds 0: every bed freed
    expect(sent.at(-1)).toEqual({ bedSlot: [NONE, NONE, NONE], hostBus: [] });
    const n = sent.length;
    plan(buses, 0);
    expect(sent).toHaveLength(n); // nothing more to say
  });

  it("keeps a host's slot id across a replan that moves its bus index", () => {
    const { sent, plan } = planner(buses, 2);
    plan();
    // Ambience moves to index 2 (a bus inserted before it)
    plan([{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Ambience", parent: "Master", bed: "own", bedPriority: 200 }]);
    expect(sent.at(-1)).toEqual({ bedSlot: [0, 0, 1], hostBus: [0, 2] });
  });

  it("limits slots to what the core laid out", () => {
    const { p, plan } = planner(buses, 4, 1);
    plan();
    expect(p.slotCount).toBe(1);
    expect(p.hostBus[0]).toBe(0);
  });

  it("warns once per change which buses lost a bed, and names the winners", () => {
    const { p, warnings, plan } = planner(buses, 1);
    plan();
    expect(p.counters.bedDenied).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Master"');
    expect(warnings[0]).toContain('"Ambience"');
    plan(); // same plan: no second warning
    expect(warnings).toHaveLength(1);
    expect(p.deniedBuses()).toEqual([{ bus: "Ambience", reason: expect.stringContaining("outranked by") }]);
  });

  it("counts the buses that moved slot in a replan", () => {
    const { p, plan } = planner(buses, 2);
    plan();
    expect(p.counters.bedSwitches).toBe(0); // the first plan moves nothing
    plan(buses, 1); // Ambience (200) loses to Master (255): it moves from slot 1 into Master's
    expect(p.counters.bedSwitches).toBe(1);
  });

  it("replays the plan as one BED_CONFIG record, and nothing without a bed", () => {
    const { p, plan } = planner(buses, 2);
    const post = (b: ReplayBuilder): DataView[] => {
      const out: ArrayBuffer[] = [];
      b.post({ post: (m) => void out.push(m), nextSeq: () => 0 }, 0, false);
      return out.map((m) => new DataView(m));
    };
    const empty = new ReplayBuilder();
    p.replay(empty);
    expect(empty.count).toBe(0);
    plan();
    const b = new ReplayBuilder();
    p.replay(b);
    expect(b.count).toBe(1);
    const [m] = post(b);
    const rec = readBedConfig(m!, 32);
    expect(Array.from(rec.bedSlot)).toEqual([0, 1, 0]);
    expect(Array.from(rec.hostBus)).toEqual([0, 1]);
  });

  it("folds the sharing chain's snapshot low-pass: the lowest from the bus up to, excluding, the host", () => {
    const tall: Spec[] = [{ name: "Master" }, { name: "Mid", parent: "Master" }, { name: "Leaf", parent: "Mid" }, { name: "Other", parent: "Master", bed: "none" }];
    const { p, plan } = planner(tall, 2);
    plan();
    const lp = [800, 3000, 1200, 500]; // Master (the host: excluded), Mid, Leaf, Other (flat)
    expect(p.foldLowpass(lp)).toBe(true);
    expect(p.chainLowpass[0]).toBe(BUS_LP_OFF_HZ); // the host's own snapshot is the core's
    expect(p.chainLowpass[1]).toBe(3000);
    expect(p.chainLowpass[2]).toBe(1200);
    expect(p.chainLowpass[3]).toBe(BUS_LP_OFF_HZ);
    expect(p.foldLowpass(lp)).toBe(false);
    lp[1] = 20000; // off
    expect(p.foldLowpass(lp)).toBe(true);
    expect(p.chainLowpass[1]).toBe(BUS_LP_OFF_HZ);
    expect(p.chainLowpass[2]).toBe(1200);
  });

  it("reports the rows: beds[] (host, sharing, denied, voices, cost) and each bus's bed, host and loss", () => {
    const { p, plan } = planner([{ name: "Master" }, { name: "Ambience", parent: "Master", bed: "own", bedPriority: 200 }, { name: "Birds", parent: "Ambience" }, { name: "SFX", parent: "Master" }], 1);
    plan();
    // Ambience (200) lost to Master (255): it shares Master's bed
    const rows = p.debug({ bedCount: 1, bedBus: [0], bedVoiceCount: [7], bedWork: [25000] });
    expect(rows).toEqual([{ slot: 0, bus: "Master", sharing: ["Ambience", "Birds", "SFX"], denied: [{ bus: "Ambience", reason: expect.any(String) }], voices: 7, clips: 0, costUs: 25 }]);
    expect(p.busDebug(0)).toEqual({ bed: "own", bedHost: "Master", bedLost: false });
    expect(p.busDebug(1)).toEqual({ bed: "own", bedHost: "Master", bedLost: true });
    expect(p.busDebug(2)).toEqual({ bed: "parent", bedHost: "Master", bedLost: false });
  });
});
