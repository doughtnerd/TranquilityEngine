import { describe, expect, it } from "vitest";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import { LoudnessHub } from "../../runtime/mix/loudnessHub";
import { createCompareModel } from "./compareModel";
import { createMonitorModel, type MonitorBus } from "./monitorModel";
import { createSessionModel, formatTarget, type SessionHost } from "./sessionModel";

/** A clock the test advances; the model never reads any other. */
function makeClock() {
  let t = 100;
  return { now: () => t, advance: (s: number) => { t += s; } };
}

function setup(over: { audio?: Parameters<typeof createSessionModel>[0]["audio"] } = {}) {
  const clock = makeClock();
  const calls: string[] = [];
  const host: SessionHost = {
    reset: (w) => calls.push(`reset ${w}`),
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    setTarget: (n) => calls.push(`setTarget ${n}`),
  };
  const model = createSessionModel({ host, clock: clock.now, ...over });
  return { model, clock, calls };
}

describe("session controls", () => {
  it("elapsed counts the injected clock from construction", () => {
    const { model, clock } = setup();
    expect(model.elapsed).toBe(0);
    clock.advance(2.5);
    expect(model.elapsed).toBe(2.5);
  });

  it("pause freezes elapsed and resume continues it; paused time is excluded", () => {
    const { model, clock, calls } = setup();
    clock.advance(3);
    model.pause();
    expect(model.paused).toBe(true);
    clock.advance(10);
    expect(model.elapsed).toBe(3);
    model.resume();
    expect(model.paused).toBe(false);
    clock.advance(1);
    expect(model.elapsed).toBe(4);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("pause and resume are idempotent (one host call each) and togglePause flips", () => {
    const { model, calls } = setup();
    model.pause(); model.pause();
    model.resume(); model.resume();
    model.togglePause(); model.togglePause();
    expect(calls).toEqual(["pause", "resume", "pause", "resume"]);
  });

  const RESETS: Array<[LoudnessResetWhat, boolean]> = [["all", true], ["integrated", true], ["maxPeak", false]];
  for (const [what, zeroes] of RESETS) {
    it(`reset("${what}") ${zeroes ? "restarts" : "leaves"} elapsed and goes to the host`, () => {
      const { model, clock, calls } = setup();
      clock.advance(5);
      model.reset(what);
      clock.advance(1);
      expect(model.elapsed).toBe(zeroes ? 1 : 6);
      expect(calls).toEqual([`reset ${what}`]);
    });
  }

  it("reset defaults to all, and a reset while paused keeps it paused at 0", () => {
    const { model, clock, calls } = setup();
    clock.advance(4);
    model.pause();
    model.reset();
    expect(calls).toEqual(["pause", "reset all"]);
    expect(model.paused).toBe(true);
    expect(model.elapsed).toBe(0);
    model.resume();
    clock.advance(2);
    expect(model.elapsed).toBe(2);
  });

  describe("reset on Play (loudnessResetOnPlay), a case per option", () => {
    it("true: elapsed restarts", () => {
      const { model, clock } = setup();
      clock.advance(7);
      model.notePlay(true);
      expect(model.elapsed).toBe(0);
      clock.advance(1);
      expect(model.elapsed).toBe(1);
    });

    it("false: elapsed carries across the Play, and a new Engine clock does not lose or add time", () => {
      const { model, clock } = setup();
      clock.advance(7);
      model.notePlay(false);
      expect(model.elapsed).toBe(7);
      clock.advance(2);
      expect(model.elapsed).toBe(9);
    });

    it("false: a pause carries across the Play", () => {
      const { model, clock } = setup();
      clock.advance(2);
      model.pause();
      model.notePlay(false);
      clock.advance(5);
      expect(model.paused).toBe(true);
      expect(model.elapsed).toBe(2);
    });
  });
});

describe("the target picker", () => {
  it("lists the design's two default platforms, the first selected", () => {
    const { model } = setup();
    expect(model.targets().map((t) => [t.name, t.integrated, t.tolerance, t.truePeak, t.selected])).toEqual([
      ["console", -24, 2, -1, true],
      ["mobile", -18, 2, -1, false],
    ]);
    expect(model.targets()[0].label).toBe("-24 LUFS ±2 LU, -1 dBTP");
    expect(model.target).toBe("console");
  });

  it("lists the project's own targets, in order", () => {
    const audio = parseAudioSettings({
      loudnessTargets: [{ name: "tv", integrated: -27, tolerance: 1, truePeak: -2 }, { name: "web", integrated: -16 }],
    }).settings;
    const { model } = setup({ audio });
    expect(model.targets().map((t) => t.name)).toEqual(["tv", "web"]);
    expect(model.target).toBe("tv");
    expect(formatTarget(model.targets()[1])).toBe("-16 LUFS ±2 LU, -1 dBTP");
  });

  it("a pick for each entry is exactly one host call and marks it selected (never a commit: the host has no way to)", () => {
    const { model, calls } = setup();
    for (const name of ["mobile", "console"]) {
      calls.length = 0;
      expect(model.pickTarget(name)).toBe(true);
      expect(calls).toEqual([`setTarget ${name}`]);
      expect(model.target).toBe(name);
      expect(model.targets().filter((t) => t.selected).map((t) => t.name)).toEqual([name]);
    }
  });

  it("an unknown name does nothing", () => {
    const { model, calls } = setup();
    expect(model.pickTarget("nope")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.target).toBe("console");
  });

  it("a live edit of the table keeps the pick if its entry survives, else falls back to the first", () => {
    const { model } = setup();
    model.pickTarget("mobile");
    model.setAudio(parseAudioSettings({ loudnessTargets: [{ name: "tv", integrated: -27 }, { name: "mobile", integrated: -17 }] }).settings);
    expect(model.target).toBe("mobile");
    expect(model.targets().find((t) => t.name === "mobile")!.integrated).toBe(-17);
    model.setAudio(parseAudioSettings({ loudnessTargets: [{ name: "tv", integrated: -27 }] }).settings);
    expect(model.target).toBe("tv");
  });

  it("follows the hub when a script changes it", () => {
    const { model } = setup();
    model.syncTarget("mobile");
    expect(model.target).toBe("mobile");
    model.syncTarget("nope");
    expect(model.target).toBe("mobile");
    model.syncTarget(null);
    expect(model.target).toBe("console");
  });

  it("sets the real hub's target", () => {
    const hub = new LoudnessHub();
    hub.configure({ available: true, root: "Master", buses: [{ name: "Master", parent: null, slot: 0, metered: false }] });
    const model = createSessionModel({ host: { setTarget: (n) => { hub.target = n; } }, clock: () => 0 });
    model.pickTarget("mobile");
    expect(hub.target).toBe("mobile");
    expect(hub.busLoudness("Master")!.target!.name).toBe("mobile");
  });
});

describe("taint marks cleared by the session (6.6), through the monitor and Compare models and the real hub", () => {
  const BUSES: MonitorBus[] = [
    { name: "Master" }, { name: "Sfx", parent: "Master" }, { name: "Voice", parent: "Sfx" }, { name: "Music", parent: "Master" },
  ];
  const METERED = ["Master", "Sfx", "Voice"];

  function rig() {
    const hub = new LoudnessHub();
    hub.configure({
      available: true,
      root: "Master",
      buses: [
        { name: "Master", parent: null, slot: 0, metered: false },
        { name: "Sfx", parent: "Master", slot: 1, metered: true },
        { name: "Voice", parent: "Sfx", slot: 2, metered: true },
        { name: "Music", parent: "Master", slot: 3, metered: false },
      ],
    });
    const monitor = createMonitorModel({
      host: {
        noteMonitorMute: (b) => hub.noteMonitorMute(b),
        noteMonitorSolo: () => hub.noteMonitorSolo(),
        setMonitorActive: (on) => hub.setMonitorActive(on),
      },
      metered: METERED,
    });
    monitor.setBuses(BUSES, METERED);
    const compare = createCompareModel({ host: { apply: () => ({ ok: true, class: "direct" }), setCompare: (on) => hub.setCompare(on) }, current: () => parseAudioSettings({}).settings });
    const clock = makeClock();
    const session = createSessionModel({
      clock: clock.now,
      marks: [monitor, compare],
      host: { reset: (w) => { for (const b of METERED) hub.busLoudness(b)!.reset(w); } },
    });
    const hubTainted = () => METERED.filter((b) => hub.busLoudness(b)!.tainted);
    return { hub, monitor, compare, session, hubTainted };
  }

  it("a monitor mute of Voice taints exactly Voice, Sfx and Master in the model and the hub; Reset clears both", () => {
    const r = rig();
    r.monitor.setMute("Voice", true);
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx", "Voice"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx", "Voice"]);
    r.session.reset("all");
    expect(r.monitor.taintedMeters()).toEqual([]);
    expect(r.hubTainted()).toEqual([]);
    expect(r.monitor.isMuted("Voice")).toBe(true); // the control itself stays on
  });

  it("a mute of Sfx leaves Voice (a descendant) clean; reset(integrated) clears, reset(maxPeak) doesn't", () => {
    const r = rig();
    r.monitor.setMute("Sfx", true);
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx"]);
    r.session.reset("maxPeak");
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx"]);
    r.session.reset("integrated");
    expect(r.monitor.taintedMeters()).toEqual([]);
    expect(r.hubTainted()).toEqual([]);
  });

  it("a monitor solo and Compare taint every meter; Reset clears every mark", () => {
    const r = rig();
    r.monitor.setSolo("Voice", true);
    expect(r.monitor.taintedMeters()).toEqual(METERED);
    expect(r.hubTainted()).toEqual(METERED);
    r.compare.begin(parseAudioSettings({}).settings);
    r.compare.toggle();
    expect(r.compare.tainted).toBe(true);
    r.session.reset();
    expect(r.monitor.taintedMeters()).toEqual([]);
    expect(r.compare.tainted).toBe(false);
    expect(r.hubTainted()).toEqual([]);
  });

  it("Play: loudnessResetOnPlay true clears the marks (hub.play resets its meters), false keeps them", () => {
    const keep = rig();
    keep.monitor.setSolo("Sfx", true);
    keep.session.notePlay(false);
    expect(keep.monitor.taintedMeters()).toEqual(METERED);

    const clear = rig();
    clear.monitor.setSolo("Sfx", true);
    clear.session.notePlay(true);
    clear.hub.play();
    expect(clear.monitor.taintedMeters()).toEqual([]);
    expect(clear.hubTainted()).toEqual([]);
  });

  it("a mark made after a reset taints afresh", () => {
    const r = rig();
    r.monitor.setMute("Voice", true);
    r.session.reset();
    r.monitor.setMute("Sfx", true);
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx"]);
  });
});
