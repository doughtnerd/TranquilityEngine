import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type LoudnessTarget } from "../../../../engine/audio/settings";
import { LOUD_FLAG_RESET, LOUD_OUTPUT_TAP, type StatusBlock } from "../wire.generated";
import { LoudnessHub, type LoudnessHubConfig, type LoudnessSuspension } from "./loudnessHub";

const NEG = Number.NEGATIVE_INFINITY;
const energyFor = (lufs: number): number => 10 ** ((lufs + 0.691) / 10);

interface Item { slot: number; firstSeq: number; energies: number[]; truePeak?: number; gatedQuanta?: number; flags?: number }

function status(items: Item[], loudShed = 0): StatusBlock {
  const energies: number[] = [];
  const loudBuses = items.map((i) => {
    energies.push(...i.energies);
    return { slot: i.slot, flags: i.energies.length | (i.flags ?? 0), firstSeq: i.firstSeq, truePeak: i.truePeak ?? 0, gatedQuanta: i.gatedQuanta ?? 0 };
  });
  return { loudShed, loudBuses, loudEnergies: energies } as unknown as StatusBlock;
}

const TARGETS: LoudnessTarget[] = [
  { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
  { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
];

const config = (over: Partial<LoudnessHubConfig> = {}): LoudnessHubConfig => ({
  available: true,
  root: "Master",
  buses: [
    { name: "Master", parent: null, slot: 0, metered: false },
    { name: "Music", parent: "Master", slot: 1, metered: false },
    { name: "Sfx", parent: "Master", slot: 2, metered: true },
    { name: "Voice", parent: "Sfx", slot: 3, metered: true },
    { name: "Deep", parent: "Voice", slot: 4, metered: false },
  ],
  targets: TARGETS,
  ...over,
});

function makeHub(over: Partial<LoudnessHubConfig> = {}): LoudnessHub {
  const hub = new LoudnessHub();
  hub.configure(config(over));
  return hub;
}

/** Feeds `n` sub-blocks at `lufs` to the slot, continuing from `*seq`. */
function play(hub: LoudnessHub, seqs: Map<number, number>, slot: number, lufs: number, n = 40, extra: Partial<Item> = {}): void {
  const first = seqs.get(slot) ?? 0;
  hub.feed(status([{ slot, firstSeq: first, energies: new Array(n).fill(energyFor(lufs)), ...extra }]));
  seqs.set(slot, first + n);
}

const SLOT_OF: Record<string, number> = { Master: LOUD_OUTPUT_TAP, Music: 1, Sfx: 2, Voice: 3 };
const METERED = ["Master", "Sfx", "Voice"] as const;

afterEach(() => vi.restoreAllMocks());

describe("targets and Audio.loudnessTarget", () => {
  it("defaults to the first entry; the default targets apply when the project has none", () => {
    expect(makeHub().target).toBe("console");
    const hub = makeHub({ targets: undefined });
    expect(hub.target).toBe("console"); // the owner's default list
    expect(hub.busLoudness("Voice")!.target!.integrated).toBe(-24);
  });

  it("reads goal, tolerance and ceiling into target; deviation = integrated - goal", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    play(hub, seqs, 3, -24);
    const t = hub.busLoudness("Voice")!.target!;
    expect(t.name).toBe("console");
    expect(t.integrated).toBe(-24);
    expect(t.tolerance).toBe(2);
    expect(t.truePeak).toBe(-1);
    expect(t.deviation).toBeCloseTo(0, 1);
    expect(t.state).toBe("ok");
  });

  it.each([
    [-24, "ok"],
    [-22.5, "ok"],
    [-25.5, "ok"],
    [-20, "high"],
    [-28, "low"],
  ])("state at %d LUFS against -24 +/- 2 is %s", (lufs, state) => {
    const hub = makeHub();
    play(hub, new Map(), 3, lufs);
    expect(hub.busLoudness("Voice")!.target!.state).toBe(state);
  });

  it("switching the target re-judges the same reading in place (same object) and is not a reset", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    play(hub, new Map(), 3, -24);
    const t = v.target!;
    const elapsed = v.elapsed;
    hub.target = "mobile";
    expect(hub.target).toBe("mobile");
    expect(v.target).toBe(t);
    expect(t.name).toBe("mobile");
    expect(t.state).toBe("low");
    expect(v.elapsed).toBe(elapsed);
    expect(v.integrated).toBeGreaterThan(NEG);
  });

  it("an unknown name is ignored with one warning; the target stays", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hub = makeHub();
    hub.target = "nope";
    expect(hub.target).toBe("console");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("null selects the first entry", () => {
    const hub = makeHub();
    hub.target = "mobile";
    hub.target = null;
    expect(hub.target).toBe("console");
  });

  it("a change re-sends the true-peak gate (ceiling - 6 dB) and a repeat does not", () => {
    const hub = makeHub({ targets: [{ name: "a", integrated: -24, tolerance: 2, truePeak: -1 }, { name: "b", integrated: -18, tolerance: 2, truePeak: -3 }] });
    const gates: number[] = [];
    hub.setGateSink((g) => gates.push(g));
    expect(hub.tpGateDbfs).toBe(-7);
    hub.target = "b";
    hub.target = "b";
    expect(gates).toEqual([-9]);
  });

  it("peakOver is maxTruePeak > the ceiling", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    play(hub, seqs, 3, -24, 10, { truePeak: 0.5 }); // -6 dBTP
    const v = hub.busLoudness("Voice")!;
    expect(v.maxTruePeak).toBeCloseTo(-6.02, 1);
    expect(v.target!.peakOver).toBe(false);
    play(hub, seqs, 3, -24, 1, { truePeak: 1.2 }); // +1.6 dBTP
    expect(v.target!.peakOver).toBe(true);
    v.reset("maxPeak");
    expect(v.target!.peakOver).toBe(false);
  });

  it("truePeakBound is lowerBound when quanta were gated and the reading is below the ceiling, until a peak reset", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    const v = hub.busLoudness("Voice")!;
    play(hub, seqs, 3, -24, 4, { truePeak: 0.1, gatedQuanta: 5 }); // baseline
    expect(v.truePeakBound).toBe("exact");
    play(hub, seqs, 3, -24, 4, { truePeak: 0.1, gatedQuanta: 9 });
    expect(v.truePeakBound).toBe("lowerBound");
    play(hub, seqs, 3, -24, 1, { truePeak: 1.5, gatedQuanta: 9 }); // over the ceiling: a breach is never missed
    expect(v.truePeakBound).toBe("exact");
    v.reset("maxPeak");
    expect(v.truePeakBound).toBe("exact");
  });
});

describe("taint and suspension per control (ADR 0172 §1.9, decision 5)", () => {
  function steady(hub: LoudnessHub): void {
    const seqs = new Map<number, number>();
    for (const n of METERED) play(hub, seqs, SLOT_OF[n], -24);
  }
  const states = (hub: LoudnessHub): string[] => METERED.map((n) => hub.busLoudness(n)!.target!.state);
  const tainted = (hub: LoudnessHub): boolean[] => METERED.map((n) => hub.busLoudness(n)!.tainted);

  it("baseline: nothing tainted, every check running", () => {
    const hub = makeHub();
    steady(hub);
    expect(tainted(hub)).toEqual([false, false, false]);
    expect(states(hub)).toEqual(["ok", "ok", "ok"]);
  });

  it("a monitor mute of a metered bus taints it, its ancestors and master, not siblings", () => {
    const hub = makeHub();
    steady(hub);
    hub.noteMonitorMute("Voice");
    expect(tainted(hub)).toEqual([true, true, true]); // Master, Sfx (its parent), Voice
    const hub2 = makeHub();
    steady(hub2);
    hub2.noteMonitorMute("Sfx");
    expect(tainted(hub2)).toEqual([true, true, false]); // Voice is below Sfx: untouched
  });

  it("a monitor mute of an unmetered bus taints the metered ancestors and master", () => {
    const hub = makeHub();
    steady(hub);
    hub.noteMonitorMute("Deep"); // Deep -> Voice -> Sfx -> Master
    expect(tainted(hub)).toEqual([true, true, true]);
    const hub2 = makeHub();
    steady(hub2);
    hub2.noteMonitorMute("Music"); // Music -> Master only
    expect(tainted(hub2)).toEqual([true, false, false]);
  });

  it("a monitor solo taints every meter", () => {
    const hub = makeHub();
    steady(hub);
    hub.noteMonitorSolo();
    expect(tainted(hub)).toEqual([true, true, true]);
  });

  it("Compare taints every meter when it turns on", () => {
    const hub = makeHub();
    steady(hub);
    hub.setCompare(true);
    expect(tainted(hub)).toEqual([true, true, true]);
  });

  it("a monitor control alone suspends the check without tainting; it resumes when released", () => {
    const hub = makeHub();
    steady(hub);
    hub.setMonitorActive(true);
    expect(states(hub)).toEqual(["suspended", "suspended", "suspended"]);
    expect(tainted(hub)).toEqual([false, false, false]);
    hub.setMonitorActive(false);
    expect(states(hub)).toEqual(["ok", "ok", "ok"]);
  });

  it.each<[string, (h: LoudnessHub, on: boolean) => void, LoudnessSuspension]>([
    ["MASTER not 1", (h, on) => h.setMasterNotUnity(on), "masterNotUnity"],
    ["a script, authored or hidden-tab mute", (h, on) => h.setMuted(on), "mutes"],
    ["Compare", (h, on) => h.setCompare(on), "compare"],
    ["a monitor control", (h, on) => h.setMonitorActive(on), "monitor"],
  ])("%s suspends the target check", (_label, set) => {
    const hub = makeHub();
    steady(hub);
    set(hub, true);
    expect(hub.isSuspended).toBe(true);
    expect(states(hub)).toEqual(["suspended", "suspended", "suspended"]);
    // The readings keep running under suspension.
    expect(hub.busLoudness("Voice")!.integrated).toBeCloseTo(-24, 1);
    set(hub, false);
    expect(hub.isSuspended).toBe(false);
    expect(states(hub)).toEqual(["ok", "ok", "ok"]);
  });

  it("MASTER not 1 and mutes suspend but do NOT taint", () => {
    const hub = makeHub();
    steady(hub);
    hub.setMasterNotUnity(true);
    hub.setMuted(true);
    expect(tainted(hub)).toEqual([false, false, false]);
    expect(states(hub)).toEqual(["suspended", "suspended", "suspended"]);
  });

  it("suspension is a union: it lifts only when every condition clears", () => {
    const hub = makeHub();
    steady(hub);
    hub.setMuted(true);
    hub.setMasterNotUnity(true);
    hub.setMuted(false);
    expect(states(hub)[0]).toBe("suspended");
    hub.setMasterNotUnity(false);
    expect(states(hub)[0]).toBe("ok");
  });

  it("suspended wins over waiting", () => {
    const hub = makeHub();
    hub.setMuted(true);
    expect(hub.busLoudness("Voice")!.target!.state).toBe("suspended");
  });

  it("tainted and incomplete stay set until reset('all') or reset('integrated'); reset('maxPeak') keeps them", () => {
    const hub = makeHub();
    steady(hub);
    const v = hub.busLoudness("Voice")!;
    hub.noteMonitorMute("Voice");
    hub.epoch(); // a rebuild gap sets incomplete
    expect(v.tainted).toBe(true);
    expect(v.incomplete).toBe(true);
    v.reset("maxPeak");
    expect(v.tainted && v.incomplete).toBe(true);
    v.reset("integrated");
    expect(v.tainted || v.incomplete).toBe(false);
    hub.noteMonitorSolo();
    expect(v.tainted).toBe(true);
    v.reset("all");
    expect(v.tainted).toBe(false);
  });
});

describe("reset on Play", () => {
  it("loudnessResetOnPlay true (the default): play() resets every meter, flags included", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    for (const n of METERED) play(hub, seqs, SLOT_OF[n], -24);
    hub.noteMonitorSolo();
    hub.play();
    for (const n of METERED) {
      const l = hub.busLoudness(n)!;
      expect(l.integrated, n).toBe(NEG);
      expect(l.elapsed, n).toBe(0);
      expect(l.tainted, n).toBe(false);
      expect(l.maxTruePeak, n).toBe(NEG);
    }
  });

  it("loudnessResetOnPlay false: play() leaves the readings", () => {
    const hub = makeHub({ resetOnPlay: false });
    play(hub, new Map(), 3, -24);
    const before = hub.busLoudness("Voice")!.integrated;
    hub.play();
    expect(hub.busLoudness("Voice")!.integrated).toBe(before);
  });
});

describe("the shedding ladder (loudShed) and script pause", () => {
  it("loudShed 1 pauses every meter with pausedBy 'ladder'; giving it back resumes and sets incomplete", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    play(hub, seqs, 3, -24);
    const v = hub.busLoudness("Voice")!;
    const elapsed = v.elapsed;
    hub.feed(status([{ slot: 3, firstSeq: seqs.get(3)!, energies: [] }], 1));
    expect(v.paused).toBe(true);
    expect(v.pausedBy).toBe("ladder");
    expect(v.incomplete).toBe(false);
    hub.feed(status([{ slot: 3, firstSeq: seqs.get(3)! + 5, energies: [energyFor(-10)] }], 1)); // discarded
    expect(v.elapsed).toBe(elapsed);
    expect(v.incomplete).toBe(false); // a jump while paused is not a loss
    hub.feed(status([{ slot: 3, firstSeq: seqs.get(3)! + 6, energies: [] }], 0));
    expect(v.paused).toBe(false);
    expect(v.pausedBy).toBeNull();
    expect(v.incomplete).toBe(true);
  });

  it("a script pause stops metering with pausedBy 'script' and a script resume does not set incomplete", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    const v = hub.busLoudness("Voice")!;
    play(hub, seqs, 3, -24, 10);
    v.pause();
    expect(v.paused).toBe(true);
    expect(v.pausedBy).toBe("script");
    play(hub, seqs, 3, -10, 10);
    expect(v.elapsed).toBeCloseTo(1, 6);
    v.resume();
    expect(v.paused).toBe(false);
    expect(v.pausedBy).toBeNull();
    expect(v.incomplete).toBe(false);
  });

  it("the ladder and a script pause together: the ladder is reported, and the meter stays paused until both end", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    v.pause();
    hub.feed(status([], 1));
    expect(v.pausedBy).toBe("ladder");
    v.resume();
    expect(v.paused).toBe(true);
    hub.feed(status([], 0));
    expect(v.paused).toBe(false);
    expect(v.incomplete).toBe(true);
  });
});

describe("feeding", () => {
  it("routes each item to its slot, in loudBuses order, with energies bus-major", () => {
    const hub = makeHub();
    hub.feed(status([
      { slot: 3, firstSeq: 0, energies: new Array(4).fill(energyFor(-20)) },
      { slot: LOUD_OUTPUT_TAP, firstSeq: 0, energies: new Array(4).fill(energyFor(-30)) },
      { slot: 2, firstSeq: 0, energies: new Array(4).fill(energyFor(-40)) },
    ]));
    expect(hub.busLoudness("Voice")!.momentary).toBeCloseTo(-20, 6);
    expect(hub.busLoudness("Master")!.momentary).toBeCloseTo(-30, 6);
    expect(hub.busLoudness("Sfx")!.momentary).toBeCloseTo(-40, 6);
  });

  it("an item for a slot that is not metered is skipped without shifting the next item's energies", () => {
    const hub = makeHub();
    hub.feed(status([
      { slot: 9, firstSeq: 0, energies: new Array(4).fill(energyFor(-50)) },
      { slot: 3, firstSeq: 0, energies: new Array(4).fill(energyFor(-20)) },
    ]));
    expect(hub.busLoudness("Voice")!.momentary).toBeCloseTo(-20, 6);
  });

  it("a sequence jump counts as lost and sets incomplete; a repeat feed continues", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    play(hub, seqs, 3, -24, 10);
    const v = hub.busLoudness("Voice")!;
    hub.feed(status([{ slot: 3, firstSeq: 50, energies: [energyFor(-24)] }]));
    expect(v.incomplete).toBe(true);
  });

  it("the core's reset flag restarts the feed like an EPOCH: sequence reseeded, histograms kept, incomplete set", () => {
    const hub = makeHub();
    const seqs = new Map<number, number>();
    play(hub, seqs, 3, -24, 40);
    const v = hub.busLoudness("Voice")!;
    const before = v.integrated;
    hub.feed(status([{ slot: 3, firstSeq: 0, energies: new Array(4).fill(energyFor(-24)), flags: LOUD_FLAG_RESET }]));
    expect(v.incomplete).toBe(true);
    expect(v.integrated).toBeGreaterThan(NEG);
    expect(Math.abs(v.integrated - before)).toBeLessThan(0.2);
  });

  it("epoch() keeps integrated and the maxima, marks incomplete, and restarts the window", () => {
    const hub = makeHub();
    play(hub, new Map(), 3, -24, 40);
    const v = hub.busLoudness("Voice")!;
    const i = v.integrated;
    const mm = v.maxMomentary;
    hub.epoch();
    expect(v.integrated).toBe(i);
    expect(v.maxMomentary).toBe(mm);
    expect(v.momentary).toBe(NEG);
    expect(v.incomplete).toBe(true);
  });
});

describe("stability and allocation", () => {
  it("BusLoudness and target objects are allocated once: the same objects across feeds, resets and a target switch", () => {
    const hub = makeHub();
    const objs = METERED.map((n) => hub.busLoudness(n)!);
    const targets = objs.map((o) => o.target);
    const seqs = new Map<number, number>();
    for (let i = 0; i < 20; i++) for (const n of METERED) play(hub, seqs, SLOT_OF[n], -24, 5);
    hub.target = "mobile";
    objs.forEach((o) => o.reset("all"));
    hub.play();
    METERED.forEach((n, i) => {
      expect(hub.busLoudness(n)).toBe(objs[i]);
      expect(objs[i].target).toBe(targets[i]);
    });
  });

  it("Bus.loudness through a real mixer is the same stable object before and after the hub registers, and tracks the hub", () => {
    const mixer = new Mixer(defaultAudioSettings());
    const before = mixer.bus("Master").loudness;
    expect(before.metered).toBe(false);
    const hub = new LoudnessHub();
    hub.configure({ available: true, root: "Master", buses: [{ name: "Master", parent: null, slot: 0, metered: false }], targets: TARGETS });
    hub.attach(mixer);
    expect(mixer.bus("Master").loudness).toBe(before);
    expect(before.metered).toBe(true);
    hub.feed(status([{ slot: LOUD_OUTPUT_TAP, firstSeq: 0, energies: new Array(4).fill(energyFor(-23)) }]));
    expect(before.momentary).toBeCloseTo(-23, 6);
  });

  it("feed allocates nothing: heap growth over 20,000 blocks stays within noise", () => {
    const hub = makeHub();
    const blocks: StatusBlock[] = [];
    for (let k = 0; k < 8; k++) {
      blocks.push(status(METERED.map((n) => ({ slot: SLOT_OF[n], firstSeq: k, energies: [energyFor(-24)] }))));
    }
    let seq = 0;
    const run = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const b = blocks[i & 7];
        for (const it of b.loudBuses) it.firstSeq = seq;
        seq++;
        hub.feed(b);
      }
    };
    run(2000);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    run(20000);
    gc?.();
    const grown = process.memoryUsage().heapUsed - before;
    // 20,000 blocks x 3 meters: an allocation per block (say 32 B) would be ~2 MB; allow generous noise.
    expect(grown).toBeLessThan(3_000_000);
  });

  it("configure keeps the state of meters that stay and drops removed ones to the inert reading", () => {
    const hub = makeHub();
    play(hub, new Map(), 3, -24);
    const v = hub.busLoudness("Voice")!;
    const i = v.integrated;
    hub.configure(config({ buses: config().buses.map((b) => (b.name === "Sfx" ? { ...b, metered: false } : b)) }));
    expect(hub.busLoudness("Voice")).toBe(v);
    expect(v.integrated).toBe(i);
    expect(hub.busLoudness("Sfx")).toBeNull();
    hub.configure(config({ buses: config().buses.map((b) => (b.name === "Voice" ? { ...b, metered: false } : b)) }));
    expect(hub.busLoudness("Voice")).toBeNull();
  });

  it("configure keeps the selected target when it survives, else falls back to the first", () => {
    const hub = makeHub();
    hub.target = "mobile";
    hub.configure(config());
    expect(hub.target).toBe("mobile");
    hub.configure(config({ targets: [{ name: "only", integrated: -16, tolerance: 1, truePeak: -2 }] }));
    expect(hub.target).toBe("only");
    expect(hub.busLoudness("Voice")!.target!.integrated).toBe(-16);
  });
});
