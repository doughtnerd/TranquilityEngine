import { describe, expect, it } from "vitest";
import { applyOpToSettings, deepEqual, diffOps, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { LoudnessHub } from "../../runtime/mix/loudnessHub";
import { createCompareModel, type CompareHost } from "./compareModel";

const audio = (over: Record<string, unknown> = {}): AudioSettings =>
  parseAudioSettings({
    buses: [
      { name: "Master" },
      { name: "Sfx", parent: "Master", volume: 0.8, meter: "loudness" },
      { name: "Music", parent: "Master", volume: 1 },
      { name: "Ui", parent: "Sfx" },
    ],
    snapshots: [{ name: "Calm", buses: { Music: { volume: 0.5 } } }],
    ...over,
  }).settings;

/** The mix the Engine plays, driven by the same op semantics the mixer uses; the calls are recorded. */
function rig(initial: AudioSettings) {
  const project = { audio: structuredClone(initial) };
  const live = { audio: structuredClone(initial) };
  const log: string[] = [];
  const origins: string[] = [];
  const ops: MixOp[] = [];
  const host: CompareHost = {
    apply(op, origin) {
      origins.push(origin);
      ops.push(op);
      const next = applyOpToSettings(live.audio, op);
      const ok = next !== live.audio;
      live.audio = next;
      log.push(`apply ${op.op}`);
      return { ok, class: "direct" } as ApplyResult;
    },
    flushNow: () => log.push("flushNow"),
    marker: (t) => log.push(`marker ${t}`),
    setCompare: (on) => log.push(`setCompare ${on}`),
  };
  const model = createCompareModel({ host, current: () => project.audio });
  return { project, live, log, origins, ops, model };
}

/** Edit the project the way the panel does while Play runs (the Engine gets it through the op log). */
function edit(r: ReturnType<typeof rig>, ...edits: MixOp[]) {
  for (const op of edits) {
    r.project.audio = applyOpToSettings(r.project.audio, op);
    r.live.audio = applyOpToSettings(r.live.audio, op);
  }
}

const EDITS: MixOp[] = [
  { op: "setBus", bus: "Sfx", key: "volume", value: 0.3 },
  { op: "setBus", bus: "Music", key: "mute", value: true },
  { op: "addBus", name: "Voice", parent: "Master" },
  { op: "moveBus", bus: "Ui", parent: "Music" },
  { op: "addEffect", bus: "Sfx", index: 0, effect: { type: "lowpass", frequency: 4000, q: 1 } },
  { op: "setSnapshot", index: 0, bus: "Sfx", key: "volume", value: 0.4 },
  { op: "setTarget", index: 0, target: { name: "tv", integrated: -27, tolerance: 1, truePeak: -2 }, insert: true },
];

describe("Compare with Play start", () => {
  it("is unavailable before Play and after Stop; toggling does nothing", () => {
    const r = rig(audio());
    expect(r.model.available).toBe(false);
    expect(r.model.toggle()).toBeNull();
    r.model.begin(r.project.audio);
    expect(r.model.available).toBe(true);
    r.model.end();
    expect(r.model.available).toBe(false);
    expect(r.model.toggle()).toBeNull();
    expect(r.log).toEqual([]);
  });

  it("switching to the saved mix applies it live: ops in order with origin compare, one flush, one marker, no write", () => {
    const r = rig(audio());
    r.model.begin(r.project.audio);
    const saved = structuredClone(r.project.audio);
    edit(r, ...EDITS);
    const edited = structuredClone(r.project.audio);
    expect(r.model.differs()).toBe(true);

    const swap = r.model.toggle()!;
    expect(swap.active).toBe(true);
    expect(r.model.active).toBe(true);
    expect(r.model.locked).toBe(true);
    expect(diffOps(r.live.audio, saved).ops).toEqual([]);
    expect(swap.ops.length).toBeGreaterThan(5);
    expect(swap.failed).toBe(0);
    expect(r.origins.every((o) => o === "compare")).toBe(true);
    expect(r.log[0]).toBe("setCompare true");
    expect(r.log.filter((l) => l === "flushNow")).toHaveLength(1);
    expect(r.log.filter((l) => l.startsWith("marker"))).toHaveLength(1);
    expect(r.log.at(-1)!.startsWith("marker")).toBe(true);
    expect(r.log.at(-2)).toBe("flushNow");
    // The project is untouched: the edited mix stays the saved project, the model never writes.
    expect(deepEqual(r.project.audio, edited)).toBe(true);
  });

  it("switching back restores the edited mix exactly (diffOps of the result against the edited settings is empty)", () => {
    const r = rig(audio());
    r.model.begin(r.project.audio);
    edit(r, ...EDITS);
    const edited = structuredClone(r.project.audio);
    r.model.toggle();
    const back = r.model.toggle()!;
    expect(back.active).toBe(false);
    expect(r.model.active).toBe(false);
    expect(r.model.locked).toBe(false);
    expect(diffOps(r.live.audio, edited)).toEqual({ ops: [], restartRequired: [] });
    expect(deepEqual(r.live.audio, edited)).toBe(true);
    expect(r.log.at(-1)).toBe("setCompare false");
    expect(r.log.filter((l) => l.startsWith("marker"))).toHaveLength(2);
  });

  it("restores exactly for each edit class on its own", () => {
    for (const op of EDITS) {
      const r = rig(audio());
      r.model.begin(r.project.audio);
      edit(r, op);
      const edited = structuredClone(r.project.audio);
      r.model.toggle();
      expect(diffOps(r.live.audio, r.project.audio).ops.length > 0 || deepEqual(r.live.audio, edited)).toBe(true);
      r.model.toggle();
      expect(diffOps(r.live.audio, edited).ops, op.op).toEqual([]);
    }
  });

  it("with no edits the swap applies nothing, and differs() is false", () => {
    const r = rig(audio());
    r.model.begin(r.project.audio);
    expect(r.model.differs()).toBe(false);
    const swap = r.model.toggle()!;
    expect(swap.ops).toEqual([]);
    expect(r.origins).toEqual([]);
    expect(r.model.active).toBe(true);
  });

  it("keys with no live path are reported, not swapped", () => {
    const r = rig(audio());
    r.model.begin(r.project.audio);
    edit(r, EDITS[0]);
    r.project.audio = { ...r.project.audio, rhythmMode: true };
    const swap = r.model.toggle()!;
    expect(swap.restartRequired).toEqual(["rhythmMode"]);
    expect(swap.ops).toHaveLength(1);
  });

  it("counts an op the mixer refused", () => {
    const r = rig(audio());
    r.model.begin(r.project.audio);
    edit(r, EDITS[0]);
    const model = createCompareModel({
      host: { apply: () => ({ ok: false, class: "none", restartRequired: "no live audio backend" }) },
      current: () => r.project.audio,
    });
    model.begin(audio());
    const swap = model.toggle()!;
    expect(swap.failed).toBe(swap.ops.length);
    expect(swap.failed).toBe(1);
  });

  it("restores the mix it saw when Compare turned on, whatever the project holds by then", () => {
    const r = rig(audio());
    r.model.begin(r.project.audio);
    edit(r, EDITS[0]);
    const edited = structuredClone(r.project.audio);
    r.model.toggle();
    r.project.audio = applyOpToSettings(r.project.audio, EDITS[1]); // an outside edit slips past the lock
    r.model.toggle();
    expect(diffOps(r.live.audio, edited).ops).toEqual([]);
  });

  describe("across a Play start", () => {
    it("a Compare in force ends without applying or marking, and the snapshot is the new Play's start", () => {
      const r = rig(audio());
      r.model.begin(r.project.audio);
      edit(r, EDITS[0]);
      r.model.toggle();
      r.log.length = 0;
      // Play again: the new Engine is built from the project (the edited mix).
      r.live.audio = structuredClone(r.project.audio);
      r.model.begin(r.project.audio);
      expect(r.model.active).toBe(false);
      expect(r.model.locked).toBe(false);
      expect(r.log).toEqual(["setCompare false"]);
      expect(r.model.differs()).toBe(false);
      // The new snapshot is the edited mix; a further edit compares against it, not against the first Play.
      edit(r, EDITS[2]);
      const swap = r.model.toggle()!;
      expect(swap.ops).toEqual([{ op: "removeBus", bus: "Voice" }]);
      expect(diffOps(r.live.audio, applyOpToSettings(r.project.audio, { op: "removeBus", bus: "Voice" })).ops).toEqual([]);
    });

    it("an idle snapshot is replaced by the next Play's, with no hub call", () => {
      const r = rig(audio());
      r.model.begin(r.project.audio);
      edit(r, EDITS[0]);
      r.model.begin(r.project.audio);
      expect(r.log).toEqual([]);
      expect(r.model.differs()).toBe(false);
    });

    it("Stop ends an active Compare (hub told once) and drops the snapshot", () => {
      const r = rig(audio());
      r.model.begin(r.project.audio);
      edit(r, EDITS[0]);
      r.model.toggle();
      r.log.length = 0;
      r.model.end();
      expect(r.log).toEqual(["setCompare false"]);
      expect(r.model.active).toBe(false);
      expect(r.model.available).toBe(false);
    });

    it("the snapshot is a clone: editing the object handed to begin changes nothing", () => {
      const r = rig(audio());
      const handed = r.project.audio;
      r.model.begin(handed);
      handed.buses[1].volume = 0.1;
      r.live.audio = structuredClone(handed);
      const swap = r.model.toggle()!;
      expect(swap.ops).toEqual([{ op: "setBus", bus: "Sfx", key: "volume", value: 0.8 }]);
    });
  });

  describe("taint (R20), driven through the real hub", () => {
    function hubRig() {
      const hub = new LoudnessHub();
      hub.configure({
        available: true,
        root: "Master",
        buses: [
          { name: "Master", parent: null, slot: 0, metered: false },
          { name: "Sfx", parent: "Master", slot: 1, metered: true },
          { name: "Music", parent: "Master", slot: 2, metered: false },
        ],
      });
      const r = rig(audio());
      const model = createCompareModel({
        host: { apply: () => ({ ok: true, class: "direct" }), setCompare: (on) => hub.setCompare(on) },
        current: () => r.project.audio,
      });
      return { hub, model, r };
    }

    it("turning Compare on taints every meter and suspends the target; off keeps the marks and ends the suspension", () => {
      const { hub, model, r } = hubRig();
      model.begin(r.project.audio);
      const meters = ["Master", "Sfx"];
      expect(meters.map((m) => hub.busLoudness(m)!.tainted)).toEqual([false, false]);
      model.toggle();
      expect(meters.map((m) => hub.busLoudness(m)!.tainted)).toEqual([true, true]);
      expect(hub.isSuspended).toBe(true);
      model.toggle();
      expect(hub.isSuspended).toBe(false);
      expect(meters.map((m) => hub.busLoudness(m)!.tainted)).toEqual([true, true]);
      expect(model.tainted).toBe(true);
    });

    it("the model's mark clears with the meters' reset, as 6.6 says", () => {
      const { hub, model, r } = hubRig();
      model.begin(r.project.audio);
      model.toggle();
      model.toggle();
      model.noteReset("maxPeak");
      expect(model.tainted).toBe(true);
      model.noteReset("all", "Sfx");
      expect(model.taintedFor("Sfx")).toBe(false);
      expect(model.taintedFor("Master")).toBe(true);
      hub.busLoudness("Sfx")!.reset("all");
      expect(hub.busLoudness("Sfx")!.tainted).toBe(false);
      model.noteReset("integrated");
      expect(model.tainted).toBe(false);
    });

    it("a Play with loudnessResetOnPlay clears the mark, one without keeps it", () => {
      const { model, r } = hubRig();
      model.begin(r.project.audio);
      model.toggle();
      model.notePlay(false);
      expect(model.tainted).toBe(true);
      model.notePlay(true);
      expect(model.tainted).toBe(false);
    });
  });
});
